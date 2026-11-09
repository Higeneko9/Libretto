import hashlib
import json
import random
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .comfy import ComfyClient
from .compiler import compile_graph, find_generate_node
from .config import LB_Settings
from .libraries import DEFAULT_LIBRARY, Libraries
from .library import Library, slugify
from .profiles import load_workflow_template
from .scene_snaps import SceneSnaps
from .store import RunStore
from .workflow import apply_output_prefix, build_workflow

MAX_SEED = 2**53
PARAM_KEYS = ["width", "height", "steps", "cfg", "sampler", "scheduler", "denoise", "checkpoint"]


def _duration(status: dict, run: dict, finished: str) -> float | None:
    """Seconds the workflow took: ComfyUI's own timestamps when present, else our observed times."""
    stamps = {m[0]: m[1].get("timestamp") for m in status.get("messages", []) if len(m) == 2 and isinstance(m[1], dict)}
    start, end = stamps.get("execution_start"), stamps.get("execution_success")
    if start is not None and end is not None and end >= start:
        return round((end - start) / 1000, 2)
    begin = run.get("started_at") or run.get("created_at")
    try:
        return round((datetime.fromisoformat(finished) - datetime.fromisoformat(begin)).total_seconds(), 2)
    except (TypeError, ValueError):
        return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_output_prefix(raw: str | None, graph: dict, profile_id: str) -> str | None:
    raw = (raw or "").strip().replace("\\", "/")
    if not raw:
        return None
    raw = (
        raw.replace("{scene}", slugify(graph.get("name") or "scene"))
        .replace("{profile}", profile_id)
        .replace("{date}", f"{datetime.now():%Y-%m-%d}")
    )
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw) or ".." in raw.split("/"):
        raise ValueError("output folder/prefix must be relative to the ComfyUI output folder (no '..' or drive letters)")
    return raw


class Generator:
    def __init__(
        self,
        settings: LB_Settings,
        libraries: Libraries,
        profiles: dict[str, dict],
        comfy: ComfyClient,
        store: RunStore,
        scene_snaps: SceneSnaps | None = None,
    ):
        self.scene_snaps = scene_snaps
        self.settings = settings
        self.libraries = libraries
        self.profiles = profiles
        self.comfy = comfy
        self.store = store
        self._state_lock = threading.Lock()
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None

    def library_for(self, graph: dict) -> Library:
        try:
            return self.libraries.get(graph.get("library") or DEFAULT_LIBRARY)
        except FileNotFoundError:
            raise ValueError(f"unknown library: {graph.get('library')}")

    # ---- paths -------------------------------------------------------
    def snapshot_dir(self, run_id: str) -> Path:
        return self.settings.SnapshotsRoot / run_id

    def read_snapshot(self, run_id: str) -> dict:
        path = self.snapshot_dir(run_id) / "snapshot.json"
        if not path.exists():
            raise FileNotFoundError(run_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_snapshot(self, snapshot: dict) -> None:
        folder = self.snapshot_dir(snapshot["id"])
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "snapshot.json").write_text(json.dumps(snapshot, indent=2, ensure_ascii=False), encoding="utf-8")

    # ---- collection state --------------------------------------------
    def _state_path(self) -> Path:
        return self.settings.DataRoot / "collection_state.json"

    def _load_state(self) -> dict:
        path = self._state_path()
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def _save_state(self, state: dict) -> None:
        self.settings.DataRoot.mkdir(parents=True, exist_ok=True)
        self._state_path().write_text(json.dumps(state), encoding="utf-8")

    # ---- environment / hashes ----------------------------------------
    def _environment(self) -> dict:
        try:
            stats = self.comfy.system_stats()
        except Exception as exc:  # environment capture is best-effort
            return {"error": str(exc)}
        system = stats.get("system", {})
        return {
            "comfyui_version": system.get("comfyui_version"),
            "python_version": system.get("python_version"),
            "pytorch_version": system.get("pytorch_version"),
            "devices": [d.get("name") for d in stats.get("devices", [])],
        }

    def _model_hash(self, kind: str, name: str) -> str | None:
        root = self.settings.ModelsRoot
        if root is None or not name:
            return None
        path = (root / kind / name).resolve()
        if root.resolve() not in path.parents or not path.is_file():
            return None
        cache_path = self.settings.DataRoot / "hash_cache.json"
        cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
        key = f"{kind}/{name}"
        stat = path.stat()
        entry = cache.get(key)
        if entry and entry["size"] == stat.st_size and entry["mtime"] == stat.st_mtime:
            return entry["sha256"]
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        cache[key] = {"size": stat.st_size, "mtime": stat.st_mtime, "sha256": digest.hexdigest()}
        self.settings.DataRoot.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache), encoding="utf-8")
        return digest.hexdigest()

    def _models(self, checkpoint: str | None, loras: list[dict]) -> dict:
        return {
            "checkpoint": {"name": checkpoint, "sha256": self._model_hash("checkpoints", checkpoint or "")},
            "loras": [
                {**lora, "sha256": self._model_hash("loras", lora["name"])} for lora in loras
            ],
        }

    # ---- generation ---------------------------------------------------
    def _seed_for(self, locked: bool, base: int, index: int, rng: random.Random) -> int:
        if locked and base is not None and int(base) >= 0:
            return int(base) + index
        return rng.randrange(MAX_SEED)

    def _record_scene_snap(self, scene_id: str | None, graph: dict) -> dict | None:
        if not scene_id or self.scene_snaps is None:
            return None
        try:
            item = self.scene_snaps.record(scene_id, graph)
        except (OSError, ValueError):  # an automatic snapshot must never block generating
            return None
        return {"id": scene_id, "version": item["version"]}

    def _update_scene_snap_thumbnail(self, snapshot: dict, images: list[str]) -> None:
        scene = snapshot.get("scene")
        if not scene or not images or self.scene_snaps is None:
            return
        try:
            data = (self.snapshot_dir(snapshot["id"]) / "images" / images[0]).read_bytes()
            self.scene_snaps.set_thumbnail(scene["id"], scene["version"], data)
        except (OSError, ValueError, FileNotFoundError):  # snapshot deleted/evicted meanwhile, or unreadable image
            pass

    def generate(self, graph: dict, scene_id: str | None = None) -> list[dict]:
        generate_node = find_generate_node(graph)
        options = generate_node.get("data", {})
        profile_id = options.get("profile")
        if profile_id not in self.profiles:
            raise ValueError(f"unknown profile: {profile_id}")
        profile = self.profiles[profile_id]
        library = self.library_for(graph)
        template = load_workflow_template(self.settings.ProfilesRoot, self.settings.UserProfilesRoot, profile)
        defaults = profile.get("defaults", {})
        params = {k: options.get(k) if options.get(k) not in (None, "") else defaults.get(k) for k in PARAM_KEYS}
        output_prefix = resolve_output_prefix(options.get("output_prefix"), graph, profile_id)
        output_dir = (options.get("output_dir") or "").strip() or None
        environment = self._environment()
        rng = random.SystemRandom()
        runs: list[dict] = []
        scene = self._record_scene_snap(scene_id, graph)

        with self._state_lock:
            state = self._load_state()
            for index in range(max(1, int(options.get("batch", 1)))):
                seed = self._seed_for(bool(options.get("seed_locked")), options.get("seed", -1), index, rng)
                pick_seed = self._seed_for(bool(options.get("pick_locked")), options.get("pick_seed", -1), index, rng)
                compiled = compile_graph(graph, library, profile, pick_seed, state)
                positive = options.get("override_positive") or compiled.positive
                negative = options.get("override_negative") or compiled.negative
                run_params = {**params, "seed": seed}
                workflow = build_workflow(template, profile, positive, negative, run_params, compiled.loras)
                if output_prefix:
                    apply_output_prefix(workflow, output_prefix)
                snapshot = {
                    "id": f"{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}",
                    "created_at": _now(),
                    "profile": profile_id,
                    "graph": graph,
                    "output": {"prefix": output_prefix, "dir": output_dir},
                    "params": run_params,
                    "pick_seed": pick_seed,
                    "picks": compiled.picks,
                    "prompt": {"positive": positive, "negative": negative},
                    "loras": compiled.loras,
                    "models": self._models(run_params.get("checkpoint"), compiled.loras),
                    "environment": environment,
                    "workflow": workflow,
                    "parent_id": None,
                    "scene": scene,
                    "prompt_id": None,
                    "images": [],
                }
                runs.append(self._queue(snapshot))
            self._save_state(state)
        if scene and runs and self.scene_snaps is not None:
            try:
                self.scene_snaps.set_run(scene["id"], scene["version"], runs[-1]["id"])
            except (OSError, FileNotFoundError):
                pass
        return runs

    def requeue(self, run_id: str) -> dict:
        """Re-queue the exact workflow stored in a snapshot."""
        original = self.read_snapshot(run_id)
        snapshot = {
            **original,
            "id": f"{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}",
            "created_at": _now(),
            "parent_id": run_id,
            "prompt_id": None,
            "images": [],
        }
        return self._queue(snapshot)

    def cancel(self, run_id: str | None = None) -> list[str]:
        """Cancel one active run, or all of them. Only touches prompts Libretto queued."""
        runs = [r for r in self.store.active() if run_id in (None, r["id"])]
        ids = {r["prompt_id"] for r in runs if r["prompt_id"]}
        if ids:
            running = {entry[1] for entry in self.comfy.queue_state().get("queue_running", [])}
            if ids - running:
                self.comfy.delete_queued(sorted(ids - running))
            if ids & running:
                self.comfy.interrupt()
        for r in runs:
            self.store.update(r["id"], status="cancelled")
        return [r["id"] for r in runs]

    def _queue(self, snapshot: dict) -> dict:
        client_id = uuid.uuid4().hex
        try:
            prompt_id = self.comfy.queue_prompt(snapshot["workflow"], client_id)
            status, error = "queued", None
        except Exception as exc:
            prompt_id, status, error = None, "error", str(exc)
        snapshot["prompt_id"] = prompt_id
        self._write_snapshot(snapshot)
        run = {
            "id": snapshot["id"],
            "created_at": snapshot["created_at"],
            "status": status,
            "prompt_id": prompt_id,
            "profile": snapshot["profile"],
            "seed": snapshot["params"].get("seed"),
            "positive": snapshot["prompt"]["positive"],
            "parent_id": snapshot.get("parent_id"),
        }
        self.store.insert(run)
        if error:
            self.store.update(run["id"], error=error)
        return self.store.get(run["id"])

    # ---- progress -----------------------------------------------------
    def poll_once(self) -> None:
        for run in self.store.active():
            try:
                self._poll_run(run)
            except Exception as exc:
                self.store.update(run["id"], status="error", error=str(exc))

    def _poll_run(self, run: dict) -> None:
        history = self.comfy.history(run["prompt_id"])
        if history is None:
            queue = self.comfy.queue_state()
            running = {entry[1] for entry in queue.get("queue_running", [])}
            if run["prompt_id"] in running and run["status"] != "running":
                self.store.update(run["id"], status="running", started_at=_now())
            return
        status = history.get("status", {})
        if status.get("status_str") == "error":
            self.store.update(run["id"], status="error", error=json.dumps(status.get("messages", []))[:2000])
            return
        images = self._save_outputs(run["id"], history.get("outputs", {}))
        finished = _now()
        duration = _duration(status, run, finished)
        snapshot = self.read_snapshot(run["id"])
        snapshot["images"] = images
        snapshot["timing"] = {"started_at": run.get("started_at"), "finished_at": finished, "duration_s": duration}
        self._write_snapshot(snapshot)
        self._update_scene_snap_thumbnail(snapshot, images)
        copy_error = self._copy_to_output_dir(run["id"], images, (snapshot.get("output") or {}).get("dir"))
        self.store.update(
            run["id"],
            status="done",
            images=images,
            finished_at=finished,
            duration_s=duration,
            **({"error": copy_error} if copy_error else {}),
        )

    def _copy_to_output_dir(self, run_id: str, images: list[str], target: str | None) -> str | None:
        if not target or not images:
            return None
        try:
            folder = Path(target).expanduser()
            folder.mkdir(parents=True, exist_ok=True)
            for name in images:
                shutil.copy2(self.snapshot_dir(run_id) / "images" / name, folder / name)
        except OSError as exc:
            return f"images generated, but copying to {target} failed: {exc}"
        return None

    def _save_outputs(self, run_id: str, outputs: dict) -> list[str]:
        folder = self.snapshot_dir(run_id) / "images"
        folder.mkdir(parents=True, exist_ok=True)
        saved = []
        for node_output in outputs.values():
            for image in node_output.get("images", []):
                if image.get("type") != "output":
                    continue
                data = self.comfy.view(image["filename"], image.get("subfolder", ""), image["type"])
                name = Path(image["filename"]).name
                (folder / name).write_bytes(data)
                saved.append(name)
        return saved

    def start_worker(self, interval: float = 1.0) -> None:
        def loop() -> None:
            while not self._stop.wait(interval):
                try:
                    self.poll_once()
                except Exception:
                    pass

        self._worker = threading.Thread(target=loop, daemon=True, name="libretto-poller")
        self._worker.start()

    def stop_worker(self) -> None:
        self._stop.set()
