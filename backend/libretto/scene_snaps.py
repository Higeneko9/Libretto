from __future__ import annotations

import hashlib
import io
import json
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

from .scenes import _check as _check_scene_id

THUMB_SIZE = 256
DEFAULT_MAX = 30
MIN_MAX = 1
MAX_MAX = 1000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _strip_run_options(graph: dict) -> dict:
    """Copy of the graph without per-click options (batch count) that aren't part of the scene's content."""
    nodes = []
    for node in graph.get("nodes") or []:
        if node.get("type") == "generate":
            node = {**node, "data": {k: v for k, v in (node.get("data") or {}).items() if k != "batch"}}
        nodes.append(node)
    return {**graph, "nodes": nodes}


def graph_hash(graph: dict) -> str:
    """Hash of everything that affects what a graph generates.

    Ignores selection, measured sizes, the last collection pick shown on a node, the scene name and the batch count.
    Node positions only matter when the prompt is ordered by canvas position.
    """
    nodes = _strip_run_options(graph)["nodes"]
    by_position = any(
        n.get("type") == "generate" and (n.get("data") or {}).get("order_mode") == "position" for n in nodes
    )
    canon_nodes = []
    for node in sorted(nodes, key=lambda n: str(n.get("id"))):
        data = {k: v for k, v in (node.get("data") or {}).items() if k != "lastPick"}
        entry = {"id": node.get("id"), "type": node.get("type"), "data": data}
        if by_position:
            entry["position"] = node.get("position")
        canon_nodes.append(entry)
    canon = {
        "nodes": canon_nodes,
        "edges": sorted([e.get("source"), e.get("target")] for e in graph.get("edges") or []),
        "library": graph.get("library"),
        "scene_prompt": graph.get("scene_prompt") or "",
        "scene_negative": graph.get("scene_negative") or "",
    }
    text = json.dumps(canon, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class SceneSnaps:
    """Automatic, versioned snapshots of a scene's graph taken each time Generate is pressed.

    Per scene: `index.json` (metadata only, so listing and hash lookup never read graphs),
    `v<N>.json` (the graph) and `v<N>.webp` (thumbnail of the generated image).
    Least-recently-used snapshots are evicted past the limit; kept snapshots never are.
    """

    def __init__(self, root: Path, default_max: int = DEFAULT_MAX):
        self.root = root
        self.default_max = default_max
        self._lock = threading.RLock()

    # ---- paths / index -------------------------------------------------
    def _dir(self, scene_id: str) -> Path:
        _check_scene_id(scene_id)
        return self.root / scene_id

    def _graph_file(self, scene_id: str, version: int) -> Path:
        return self._dir(scene_id) / f"v{int(version)}.json"

    def _thumb_file(self, scene_id: str, version: int) -> Path:
        return self._dir(scene_id) / f"v{int(version)}.webp"

    def _load(self, scene_id: str) -> dict:
        path = self._dir(scene_id) / "index.json"
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        return {"next_version": 1, "max": None, "items": []}

    def _save(self, scene_id: str, index: dict) -> None:
        folder = self._dir(scene_id)
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / "index.json.tmp"
        tmp.write_text(json.dumps(index, indent=1), encoding="utf-8")
        tmp.replace(folder / "index.json")

    def _limit(self, index: dict) -> int:
        return index.get("max") or self.default_max

    @staticmethod
    def _find(index: dict, version: int) -> dict:
        for item in index["items"]:
            if item["version"] == version:
                return item
        raise FileNotFoundError(f"v{version}")

    def _remove_files(self, scene_id: str, version: int) -> None:
        self._graph_file(scene_id, version).unlink(missing_ok=True)
        self._thumb_file(scene_id, version).unlink(missing_ok=True)

    def _evict(self, scene_id: str, index: dict, protect: int | None) -> None:
        limit = self._limit(index)
        while len(index["items"]) > limit:
            candidates = [i for i in index["items"] if not i["keep"] and i["version"] != protect]
            if not candidates:
                return  # everything left is kept (or just used): allow exceeding the limit
            oldest = min(candidates, key=lambda i: (i["last_used_at"], i["version"]))
            index["items"].remove(oldest)
            self._remove_files(scene_id, oldest["version"])

    # ---- public API ----------------------------------------------------
    def list(self, scene_id: str) -> dict:
        with self._lock:
            index = self._load(scene_id)
            items = sorted(index["items"], key=lambda i: (i.get("generated_at") or i["created_at"], i["version"]), reverse=True)
            return {"max": self._limit(index), "default_max": self.default_max, "items": items}

    def record(self, scene_id: str, graph: dict, run_id: str | None = None) -> dict:
        """Snapshot the graph unless an identical one is stored; either way the entry becomes most recently used."""
        digest = graph_hash(graph)
        with self._lock:
            index = self._load(scene_id)
            item = next((i for i in index["items"] if i["hash"] == digest), None)
            now = _now()
            if item is None:
                version = index["next_version"]
                index["next_version"] = version + 1
                item = {
                    "version": version,
                    "hash": digest,
                    "created_at": now,
                    "last_used_at": now,
                    "keep": False,
                    "thumb_at": None,
                    "generated_at": now,
                    "run_id": run_id,
                }
                index["items"].append(item)
                new = True
            else:
                item["last_used_at"] = now
                item["generated_at"] = now  # list order: most recently generated first
                item["run_id"] = run_id or item.get("run_id")
                new = False
            self._dir(scene_id).mkdir(parents=True, exist_ok=True)
            # refresh the stored graph so reuse also picks up layout-only changes
            self._graph_file(scene_id, item["version"]).write_text(json.dumps(_strip_run_options(graph), ensure_ascii=False), encoding="utf-8")
            self._evict(scene_id, index, protect=item["version"])
            self._save(scene_id, index)
            return {**item, "new": new}

    def set_run(self, scene_id: str, version: int, run_id: str) -> None:
        with self._lock:
            index = self._load(scene_id)
            self._find(index, version)["run_id"] = run_id
            self._save(scene_id, index)

    def set_thumbnail(self, scene_id: str, version: int, image_bytes: bytes) -> None:
        with self._lock:
            index = self._load(scene_id)
            item = self._find(index, version)
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            image.thumbnail((THUMB_SIZE, THUMB_SIZE))
            image.save(self._thumb_file(scene_id, version), "WEBP", quality=85)
            item["thumb_at"] = _now()
            self._save(scene_id, index)

    def thumbnail_path(self, scene_id: str, version: int) -> Path:
        with self._lock:
            self._find(self._load(scene_id), version)
        path = self._thumb_file(scene_id, version)
        if not path.exists():
            raise FileNotFoundError(f"v{version}")
        return path

    def apply(self, scene_id: str, version: int) -> dict:
        """Return a snapshot's graph and mark it most recently used."""
        with self._lock:
            index = self._load(scene_id)
            item = self._find(index, version)
            path = self._graph_file(scene_id, version)
            if not path.exists():
                raise FileNotFoundError(f"v{version}")
            item["last_used_at"] = _now()
            self._save(scene_id, index)
            return json.loads(path.read_text(encoding="utf-8"))

    def set_keep(self, scene_id: str, version: int, keep: bool) -> dict:
        with self._lock:
            index = self._load(scene_id)
            item = self._find(index, version)
            item["keep"] = bool(keep)
            self._evict(scene_id, index, protect=version)
            self._save(scene_id, index)
            return item

    def set_name(self, scene_id: str, version: int, name: str) -> dict:
        """Give a snapshot a friendly name; an empty name goes back to the plain version number."""
        with self._lock:
            index = self._load(scene_id)
            item = self._find(index, version)
            item["name"] = name.strip()[:80]
            self._save(scene_id, index)
            return item

    def delete(self, scene_id: str, version: int) -> None:
        with self._lock:
            index = self._load(scene_id)
            item = self._find(index, version)
            index["items"].remove(item)
            self._remove_files(scene_id, version)
            self._save(scene_id, index)

    def set_max(self, scene_id: str, limit: int) -> dict:
        if not MIN_MAX <= limit <= MAX_MAX:
            raise ValueError(f"limit must be between {MIN_MAX} and {MAX_MAX}")
        with self._lock:
            index = self._load(scene_id)
            index["max"] = limit
            self._evict(scene_id, index, protect=None)
            self._save(scene_id, index)
        return self.list(scene_id)

    def delete_scene(self, scene_id: str) -> None:
        with self._lock:
            shutil.rmtree(self._dir(scene_id), ignore_errors=True)
