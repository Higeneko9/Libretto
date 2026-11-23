from __future__ import annotations

import copy
import errno
import json
import re
import shutil
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .i18n import normalize_names
from .ids import new_id

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
OUTPUT_LAYOUTS = ("workflow", "show_scene", "show_act_scene")


def relative_output_path(path: str) -> str:
    path = path.strip().replace("\\", "/").strip("/")
    if not path or re.match(r"^[A-Za-z]:", path) or any(part in ("", ".", "..") for part in path.split("/")):
        raise ValueError("output root must be a non-empty relative path without '.' or '..'")
    if any(re.search(r'[<>:"|?*\x00-\x1f]', part) for part in path.split("/")):
        raise ValueError("output root contains invalid path characters")
    return path


def _output_root(value: dict, local: bool = False) -> dict:
    if not isinstance(value, dict) or type(value.get("enabled")) is not bool or not isinstance(value.get("path"), str):
        raise ValueError("invalid output root setting")
    path = value["path"].strip()
    if value["enabled"]:
        if local:
            if not Path(path).expanduser().is_absolute():
                raise ValueError("local output root must be an absolute path")
        else:
            if path.startswith(("/", "\\")):
                raise ValueError("ComfyUI output root must be relative")
            path = relative_output_path(path)
    return {"enabled": value["enabled"], "path": path}


def _check(scene_id: str) -> None:
    if not isinstance(scene_id, str) or not _ID_RE.fullmatch(scene_id):
        raise ValueError(f"invalid scene id: {scene_id!r}")


class Scenes:
    """A scene is a saved node graph (its own library, prompt additions and nodes), one JSON file each."""

    def __init__(self, root: Path, seed: Path | None = None, shows_root: Path | None = None,
                 snapshots_root: Path | None = None):
        self.root = root
        self.shows_root = shows_root if shows_root is not None else root.parent / "shows"
        self.snapshots_root = snapshots_root
        self._lock = threading.RLock()
        self._undo: list[tuple[dict, dict]] = []
        self._redo: list[tuple[dict, dict]] = []
        self._revision = 0
        self._history_id = uuid.uuid4().hex
        # only a brand-new data folder gets the sample scenes, so deleting them stays deleted
        if seed is not None and seed.is_dir() and not root.exists():
            shutil.copytree(seed, root)

    def _file(self, scene_id: str) -> Path:
        _check(scene_id)
        matches = [p for p in [self.root / f"{scene_id}.json", *self.shows_root.glob(f"*/{scene_id}.scene.json")] if p.is_file()]
        if len(matches) > 1:
            raise ValueError(f"duplicate scene id: {scene_id}")
        return matches[0] if matches else self.root / f"{scene_id}.json"

    def get(self, scene_id: str) -> dict:
        with self._lock:
            path = self._file(scene_id)
            if not path.exists():
                raise FileNotFoundError(scene_id)
            return json.loads(path.read_text(encoding="utf-8"))

    def list(self) -> list[dict]:
        with self._lock:
            return self._list()

    def _list(self) -> list[dict]:
        shows = {s["id"]: s for s in self.list_shows()}
        scenes = []
        ids = set()
        for path in [*self.root.glob("*.json"), *self.shows_root.glob("*/*.scene.json")]:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                if path.parent != self.root:
                    raise ValueError(f"cannot read scene file: {path.name}") from exc
                continue
            if path.parent != self.root and (not isinstance(data, dict) or data.get("id") != path.name.removesuffix(".scene.json")):
                raise ValueError(f"scene id does not match filename: {path.name}")
            if data.get("order") is not None and type(data["order"]) is not int:
                raise ValueError(f"invalid scene order: {path.name}")
            if data["id"] in ids:
                raise ValueError(f"duplicate scene id: {data['id']}")
            ids.add(data["id"])
            show_id = path.parent.name if path.parent != self.root else None
            act_id = None
            if show_id:
                if show_id not in shows:
                    raise ValueError(f"missing outline for show: {show_id}")
                act_id = next(
                    (i["id"] for i in shows[show_id]["items"] if i["kind"] == "act" and data["id"] in i["scene_ids"]),
                    None,
                )
            scenes.append(
                {
                    "id": data["id"],
                    "name": data.get("name", data["id"]),
                    "names": data.get("names") or {},
                    "updated_at": data.get("updated_at", ""),
                    # shipped example scenes carry a `starter` number: they open as tabs, in that order, on a first run
                    "starter": data.get("starter"),
                    "show_id": show_id,
                    "act_id": act_id,
                    "order": data.get("order"),
                }
            )
        return sorted(scenes, key=lambda s: s["updated_at"], reverse=True)

    def _write(self, scene: dict, record: bool = True) -> dict:
        scene["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._commit({self._file(scene["id"]): scene}, record=record)
        return scene

    def create(self, name: str, graph: dict | None = None, show_id: str | None = None, act_id: str | None = None) -> dict:
        with self._lock:
            scene_id = new_id("s", lambda candidate: self._file(candidate).exists())
            if act_id and not show_id:
                raise ValueError("an act must belong to a show")
            if show_id:
                with self._changes() as changes:
                    show = self.get_show(show_id)
                    if act_id:
                        self._act(show, act_id)["scene_ids"].append(scene_id)
                    else:
                        show["items"].append({"kind": "scene", "id": scene_id})
                    scene = {"id": scene_id, "name": name or "Scene", "graph": graph or {"nodes": [], "edges": []},
                             "updated_at": datetime.now(timezone.utc).isoformat()}
                    changes[self.shows_root / show_id / f"{scene_id}.scene.json"] = scene
                    changes[self._outline(show_id)] = show
                return scene
            scene = {"id": scene_id, "name": name or "Scene", "graph": graph or {"nodes": [], "edges": []}}
            ordered = [s["order"] for s in self._list() if not s["show_id"] and s["order"] is not None]
            if ordered:
                scene["order"] = min(ordered) - 1
            return self._write(scene)

    def update(self, scene_id: str, name: str | None = None, graph: dict | None = None, names: dict | None = None) -> dict:
        with self._lock:
            return self._update(scene_id, name, graph, names)

    def _update(self, scene_id: str, name: str | None, graph: dict | None, names: dict | None) -> dict:
        scene = self.get(scene_id)
        if name is not None:
            scene["name"] = name
        self._set_names(scene, names)
        if graph is not None:
            scene["graph"] = graph
        return self._write(scene, record=name is not None or names is not None)

    def delete(self, scene_id: str) -> None:
        with self._lock:
            path = self._file(scene_id)
            if not path.exists():
                raise FileNotFoundError(scene_id)
            changes = {path: None}
            if path.parent != self.root:
                show = self.get_show(path.parent.name)
                self._remove_scene(show, scene_id)
                changes[self._outline(show["id"])] = show
            self._commit(changes)

    def _outline(self, show_id: str) -> Path:
        _check(show_id)
        return self.shows_root / show_id / "show-outline.json"

    def get_show(self, show_id: str) -> dict:
        path = self._outline(show_id)
        with self._lock:
            if not path.is_file():
                raise FileNotFoundError(show_id)
            show = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(show, dict) or show.get("version") != 1 or show.get("id") != show_id or not isinstance(show.get("items"), list) or not isinstance(show.get("name"), str):
                raise ValueError(f"invalid show outline: {show_id}")
            if "order" in show and type(show["order"]) is not int:
                raise ValueError(f"invalid show order: {show_id}")
            if show.get("output_layout", "workflow") not in OUTPUT_LAYOUTS:
                raise ValueError(f"invalid show output layout: {show_id}")
            for key, local in (("output_comfy_root", False), ("output_local_root", True)):
                if key in show:
                    _output_root(show[key], local)
            seen = set()
            for item in show["items"]:
                if not isinstance(item, dict):
                    raise ValueError("invalid outline item")
                _check(item.get("id"))
                if item["id"] in seen or item.get("kind") not in ("act", "scene"):
                    raise ValueError(f"invalid or duplicate outline item: {item['id']}")
                seen.add(item["id"])
                if item["kind"] == "act":
                    if not isinstance(item.get("name"), str) or not isinstance(item.get("scene_ids"), list):
                        raise ValueError("invalid act")
                    for scene_id in item["scene_ids"]:
                        _check(scene_id)
                        if scene_id in seen:
                            raise ValueError(f"duplicate outline item: {scene_id}")
                        seen.add(scene_id)
            return show

    def list_shows(self) -> list[dict]:
        with self._lock:
            shows = [self.get_show(p.parent.name) for p in sorted(self.shows_root.glob("*/show-outline.json"))]
            return sorted(shows, key=lambda s: s.get("order", 0))

    @contextmanager
    def _changes(self):
        """Serialize edits and roll back ordinary I/O failures across affected files."""
        with self._lock:
            changes = {}
            yield changes
            self._commit(changes)

    def _scene_id(self, path: Path) -> str | None:
        if path.parent == self.root and path.suffix == ".json":
            return path.stem
        if path.parent.parent == self.shows_root and path.name.endswith(".scene.json"):
            return path.name.removesuffix(".scene.json")
        return None

    def _metadata(self, path: Path, content: bytes | None):
        if content is not None and self._scene_id(path):
            return {k: v for k, v in json.loads(content).items() if k not in ("graph", "updated_at")}
        return content

    def history(self) -> dict:
        with self._lock:
            return {"undo": len(self._undo), "redo": len(self._redo), "revision": self._revision, "history_id": self._history_id}

    def clear_history(self) -> None:
        with self._lock:
            self._undo.clear()
            self._redo.clear()
            self._revision += 1

    def step_history(self, redo: bool, revision: int, history_id: str | None = None) -> dict:
        with self._lock:
            if revision != self._revision or (history_id is not None and history_id != self._history_id):
                raise ValueError("Show Outline history changed; refresh the outline and try again")
            source, target = (self._redo, self._undo) if redo else (self._undo, self._redo)
            if not source:
                raise ValueError("nothing to redo" if redo else "nothing to undo")
            expected, desired = source[-1]
            changes = {}
            for path, content in desired.items():
                current = path.read_bytes() if path.exists() else None
                scene_id = self._scene_id(path)
                deleting_snapshot = content is None and self.snapshots_root is not None and path.is_relative_to(self.snapshots_root)
                if not deleting_snapshot and self._metadata(path, current) != self._metadata(path, expected[path]):
                    raise ValueError(f"cannot restore Show Outline: {path.name} changed on disk")
                if scene_id:
                    actual = self._file(scene_id)
                    expected_path = next((p for p, data in expected.items() if self._scene_id(p) == scene_id and data is not None), None)
                    if actual.exists() and actual != expected_path:
                        raise ValueError(f"cannot restore Show Outline: scene {scene_id} has another location")
                    if content is not None and expected_path is not None:
                        # Reorganizing must not roll back edits made in the scene editor.
                        live = self.get(scene_id)
                        restored = json.loads(content)
                        for key in ("graph", "updated_at"):
                            if key in live:
                                restored[key] = live[key]
                            else:
                                restored.pop(key, None)
                        content = json.dumps(restored, indent=2, ensure_ascii=False).encode("utf-8") + b"\n"
                if path.name == "show-outline.json" and content is None:
                    if any(desired.get(p, b"") is not None for p in path.parent.glob("*.scene.json")):
                        raise ValueError("cannot remove a show containing scenes added outside this history")
                changes[path] = content
            for path, content in changes.items():
                if content is not None and self._scene_id(path) and path.parent != self.root:
                    outline = path.parent / "show-outline.json"
                    if changes.get(outline, b"" if outline.exists() else None) is None:
                        raise ValueError("cannot restore a scene whose show is missing")
            previous, following = self._commit(changes, record=False)
            source.pop()
            target.append((following, previous))
            self._revision += 1
            return self.history()

    def _commit(self, changes: dict, record: bool = True) -> tuple[dict, dict]:
        changes = dict(changes)
        if self.snapshots_root is not None:
            remaining = {self._scene_id(p) for p, data in changes.items() if data is not None}
            for path, data in list(changes.items()):
                scene_id = self._scene_id(path)
                if data is None and scene_id and scene_id not in remaining:
                    for snapshot in (self.snapshots_root / scene_id).rglob("*"):
                        if snapshot.is_file():
                            changes[snapshot] = None
        previous = {p: p.read_bytes() if p.exists() else None for p in changes}
        following = {
            p: data if data is None or isinstance(data, bytes) else
            (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
            for p, data in changes.items()
        }
        changed = record and any(self._metadata(p, previous[p]) != self._metadata(p, data) for p, data in following.items())
        try:
            for path, data in following.items():
                if data is None:
                    path.unlink(missing_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    temp = path.with_suffix(path.suffix + ".tmp")
                    try:
                        temp.write_bytes(data)
                        temp.replace(path)
                    finally:
                        temp.unlink(missing_ok=True)
            for path, data in following.items():
                if data is None and previous[path] is not None and path.name == "show-outline.json" and path.parent.parent == self.shows_root:
                    try:
                        path.parent.rmdir()
                    except OSError as exc:
                        if exc.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                            raise
        except OSError:
            for path, content in previous.items():
                if content is None:
                    path.unlink(missing_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
            raise
        if changed:
            self._undo.append((following, previous))
            del self._undo[:-100]
            self._redo.clear()
            self._revision += 1
        return previous, following

    @staticmethod
    def _set_names(item: dict, names: dict | None) -> None:
        if names is not None:
            cleaned = normalize_names(names)
            if cleaned:
                item["names"] = cleaned
            else:
                item.pop("names", None)

    def create_show(self, name: str, names: dict | None = None) -> dict:
        with self._changes() as changes:
            show_id = new_id("show", lambda i: (self.shows_root / i).exists())
            order = max((s.get("order", 0) for s in self.list_shows()), default=-1) + 1
            show = {"version": 1, "id": show_id, "name": self._name(name), "items": [], "order": order}
            self._set_names(show, names)
            changes[self._outline(show_id)] = show
        return show

    def place_show(self, show_id: str, index: int) -> dict:
        with self._changes() as changes:
            show = self.get_show(show_id)
            shows = [s for s in self.list_shows() if s["id"] != show_id]
            self._insert(shows, show, index)
            for position, item in enumerate(shows):
                if item.get("order") != position:
                    item["order"] = position
                    changes[self._outline(item["id"])] = item
        return show

    def move_outline(self, items: list[dict], target: dict, position: str, revision: int, history_id: str | None = None) -> dict:
        with self._changes() as changes:
            if revision != self._revision or (history_id is not None and history_id != self._history_id):
                raise ValueError("Show Outline history changed; refresh the outline and try again")
            shows = self.list_shows()
            raw_shows = {s["id"]: copy.deepcopy(s) for s in shows}
            show_by_id = {s["id"]: s for s in shows}
            scene_by_id = {s["id"]: s for s in self._list()}
            standalone = sorted((s["id"] for s in scene_by_id.values() if not s["show_id"]),
                                key=lambda sid: scene_by_id[sid]["order"] or 0)
            for show in shows:
                listed = {sid for item in show["items"] for sid in
                          (item["scene_ids"] if item["kind"] == "act" else [item["id"]])}
                show["items"].extend({"kind": "scene", "id": s["id"]} for s in scene_by_id.values()
                                     if s["show_id"] == show["id"] and s["id"] not in listed)
            original = {s["id"]: copy.deepcopy(s) for s in shows}

            def validate(ref: dict, container: bool = False):
                kind, item_id = ref["kind"], ref.get("id")
                if kind in ("all", "standalone") and container and item_id is None:
                    return
                _check(item_id)
                if kind == "show" and item_id in show_by_id:
                    return
                if kind == "act" and ref.get("show_id") in show_by_id:
                    self._act(show_by_id[ref["show_id"]], item_id)
                    return
                if kind == "scene" and item_id in scene_by_id:
                    scene = scene_by_id[item_id]
                    if scene["show_id"] == ref.get("show_id") and scene["act_id"] == ref.get("act_id"):
                        return
                raise ValueError("outline changed; refresh the outline and try again")

            if not items:
                raise ValueError("no outline items selected")
            validate(target, True)
            for item in items:
                validate(item)
            keys = [(i["kind"], i["id"]) for i in items]
            if len(set(keys)) != len(keys):
                raise ValueError("duplicate outline selection")
            selected = set(keys)
            selected_shows = {i["id"] for i in items if i["kind"] == "show"}
            selected_acts = {(i["show_id"], i["id"]) for i in items if i["kind"] == "act"}

            def covered(ref: dict) -> bool:
                return ((ref["kind"], ref.get("id")) in selected
                        or ref.get("show_id") in selected_shows
                        or (ref.get("show_id"), ref.get("act_id")) in selected_acts)

            if covered(target):
                raise ValueError("cannot move an item into its own selection")
            moving = [i for i in items if not (
                i["kind"] != "show" and i.get("show_id") in selected_shows
                or i["kind"] == "scene" and (i.get("show_id"), i.get("act_id")) in selected_acts)]
            kinds = {i["kind"] for i in moving}
            if "show" in kinds and len(kinds) != 1:
                raise ValueError("shows and other items cannot share a destination")

            if target["kind"] == "all" and position == "inside" and kinds == {"show"}:
                destination = shows
            elif target["kind"] == "show" and position in ("before", "after") and kinds == {"show"}:
                destination = shows
            elif target["kind"] == "standalone" and position == "inside" and kinds == {"scene"}:
                destination = standalone
            elif target["kind"] == "show" and position == "inside" and "show" not in kinds:
                destination = show_by_id[target["id"]]["items"]
            elif target["kind"] == "act" and position == "inside" and kinds == {"scene"}:
                destination = self._act(show_by_id[target["show_id"]], target["id"])["scene_ids"]
            elif target["kind"] in ("act", "scene") and position in ("before", "after") and "show" not in kinds:
                if target["kind"] == "act":
                    destination = show_by_id[target["show_id"]]["items"]
                elif target["act_id"]:
                    destination = self._act(show_by_id[target["show_id"]], target["act_id"])["scene_ids"]
                elif target["show_id"]:
                    destination = show_by_id[target["show_id"]]["items"]
                else:
                    destination = standalone
                if "act" in kinds and (target["kind"] == "scene" and (not target["show_id"] or target["act_id"])):
                    raise ValueError("acts must belong directly to a show")
            else:
                raise ValueError("invalid outline destination")

            moved = []
            scene_destinations = {}
            for item in moving:
                kind, item_id = item["kind"], item["id"]
                if kind == "show":
                    value = show_by_id[item_id]
                    shows.remove(value)
                elif kind == "act":
                    source = show_by_id[item["show_id"]]
                    value = self._act(source, item_id)
                    for sid in value["scene_ids"]:
                        if sid not in scene_by_id or scene_by_id[sid]["show_id"] != item["show_id"]:
                            raise ValueError(f"cannot move act: scene {sid} is missing from the show")
                    source["items"].remove(value)
                else:
                    value = item_id
                    if item["act_id"]:
                        self._act(show_by_id[item["show_id"]], item["act_id"])["scene_ids"].remove(item_id)
                    elif item["show_id"]:
                        source = show_by_id[item["show_id"]]["items"]
                        source.remove(next(i for i in source if i["kind"] == "scene" and i["id"] == item_id))
                    else:
                        standalone.remove(item_id)
                moved.append((item, value))

            if position == "inside":
                index = len(destination)
            else:
                anchor = target["id"]
                index = next((n for n, value in enumerate(destination)
                              if (value if isinstance(value, str) else value["id"]) == anchor), -1)
                if index < 0:
                    raise ValueError("outline destination changed; refresh the outline and try again")
                index += position == "after"
            for offset, (item, value) in enumerate(moved):
                if item["kind"] == "scene" and destination is not standalone and destination is not shows:
                    if target["kind"] == "show" or target["kind"] == "act" and position != "inside" or (
                            target["kind"] == "scene" and target["show_id"] and not target["act_id"]):
                        value = {"kind": "scene", "id": value}
                destination.insert(index + offset, value)
                if item["kind"] == "scene":
                    scene_destinations[item["id"]] = (
                        None if destination is standalone else target["id"] if target["kind"] == "show" else target["show_id"])
                elif item["kind"] == "act":
                    dest_show = target["id"] if target["kind"] == "show" else target["show_id"]
                    scene_destinations.update({sid: dest_show for sid in value["scene_ids"]})

            for sid, dest_show in scene_destinations.items():
                source_path = self._file(sid)
                dest_path = self.shows_root / dest_show / f"{sid}.scene.json" if dest_show else self.root / f"{sid}.json"
                if source_path != dest_path:
                    changes[source_path] = None
                    changes[dest_path] = source_path.read_bytes()
            if any(not scene_by_id[sid]["show_id"] or dest is None for sid, dest in scene_destinations.items()):
                for order, sid in enumerate(standalone):
                    scene = self.get(sid)
                    if scene.get("order") != order or sid in scene_destinations:
                        scene["order"] = order
                        changes[self.root / f"{sid}.json"] = scene
            for order, show in enumerate(shows):
                if kinds == {"show"} and show.get("order") != order:
                    show["order"] = order
                if show != original[show["id"]]:
                    if show["items"] == original[show["id"]]["items"]:
                        show = {**raw_shows[show["id"]], "order": show["order"]}
                    changes[self._outline(show["id"])] = show
        return self.history()

    @staticmethod
    def _name(name: str) -> str:
        if not name.strip():
            raise ValueError("name must not be empty")
        return name.strip()

    def rename_show(self, show_id: str, name: str, names: dict | None = None) -> dict:
        with self._changes() as changes:
            show = self.get_show(show_id)
            show["name"] = self._name(name)
            self._set_names(show, names)
            changes[self._outline(show_id)] = show
        return show

    def set_output_layout(self, show_id: str, layout: str, comfy_root: dict | None = None,
                          local_root: dict | None = None) -> dict:
        if layout not in OUTPUT_LAYOUTS:
            raise ValueError("invalid show output layout")
        roots = {key: _output_root(value, local) for key, value, local in (
            ("output_comfy_root", comfy_root, False), ("output_local_root", local_root, True)) if value is not None}
        with self._changes() as changes:
            show = self.get_show(show_id)
            if layout == "workflow":
                show.pop("output_layout", None)
            else:
                show["output_layout"] = layout
            show.update(roots)
            changes[self._outline(show_id)] = show
        return show

    @staticmethod
    def _output_name(name: str, fallback: str) -> str:
        # Preserve Unicode, but keep names literal and portable to Windows/ComfyUI.
        part = re.sub(r'[<>:"/\\|?*%{}\x00-\x1f]', "-", name.strip())
        part = re.sub(r"[-\s]+", "-", part).strip(" .-").lower() or fallback
        if re.fullmatch(r"(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?", part):
            part = "_" + part
        return part

    def output_preview(self, show_id: str, layout: str | None = None) -> dict:
        with self._lock:
            show = self.get_show(show_id)
            layout = layout if layout is not None else show.get("output_layout", "workflow")
            if layout not in OUTPUT_LAYOUTS:
                raise ValueError("invalid show output layout")
            scenes = {s["id"]: s for s in self._list() if s["show_id"] == show_id}
            listed = {sid for item in show["items"] for sid in (item["scene_ids"] if item["kind"] == "act" else [item["id"]])}
            items = [*show["items"], *({"kind": "scene", "id": sid} for sid in scenes if sid not in listed)]
            root = self._output_name(show["name"], show_id)
            examples = []
            act_index = direct_index = global_index = 0
            for item in items:
                is_act = item["kind"] == "act"
                if is_act:
                    act_index += 1
                else:
                    direct_index += 1
                for index, sid in enumerate(item["scene_ids"] if is_act else [item["id"]], 1):
                    global_index += 1
                    if sid not in scenes:
                        continue
                    scene = scenes[sid]
                    parts = [root]
                    number = global_index
                    if layout == "show_act_scene":
                        number = index if is_act else direct_index
                        if is_act:
                            parts.append(f"{act_index:02}-{self._output_name(item['name'], item['id'])}")
                    parts.append(f"{number:02}-{self._output_name(scene['name'], sid)}")
                    examples.append({"scene_id": sid, "name": scene["name"],
                                     "prefix": None if layout == "workflow" else "/".join(parts)})
            return {"examples": examples}

    def output_prefix(self, scene_id: str) -> str | None:
        with self._lock:
            path = self._file(scene_id)
            # Unsaved and standalone scenes retain the workflow's existing behavior.
            if path.parent == self.root:
                return None
            show = self.get_show(path.parent.name)
            if show.get("output_layout", "workflow") == "workflow":
                return None
            return next(item["prefix"] for item in self.output_preview(show["id"])["examples"]
                        if item["scene_id"] == scene_id)

    def output_settings(self, scene_id: str) -> tuple[dict | None, str | None]:
        with self._lock:
            path = self._file(scene_id)
            if path.parent == self.root:
                return None, None
            return self.get_show(path.parent.name), self.output_prefix(scene_id)

    @staticmethod
    def _act(show: dict, act_id: str) -> dict:
        _check(act_id)
        act = next((i for i in show["items"] if i["kind"] == "act" and i["id"] == act_id), None)
        if act is None:
            raise FileNotFoundError(act_id)
        return act

    def create_act(self, show_id: str, name: str, names: dict | None = None) -> dict:
        with self._changes() as changes:
            show = self.get_show(show_id)
            act = {"kind": "act", "id": new_id("act", lambda i: any(a["id"] == i for s in self.list_shows() for a in s["items"])), "name": self._name(name), "scene_ids": []}
            self._set_names(act, names)
            show["items"].append(act)
            changes[self._outline(show_id)] = show
        return act

    def rename_act(self, show_id: str, act_id: str, name: str, names: dict | None = None) -> dict:
        with self._changes() as changes:
            show = self.get_show(show_id)
            act = self._act(show, act_id)
            act["name"] = self._name(name)
            self._set_names(act, names)
            changes[self._outline(show_id)] = show
        return act

    @staticmethod
    def _remove_scene(show: dict, scene_id: str) -> None:
        show["items"] = [i for i in show["items"] if not (i["kind"] == "scene" and i["id"] == scene_id)]
        for item in show["items"]:
            if item["kind"] == "act":
                item["scene_ids"] = [i for i in item["scene_ids"] if i != scene_id]

    @staticmethod
    def _insert(items: list, item, index: int | None) -> None:
        if index is not None and not 0 <= index <= len(items):
            raise ValueError("invalid destination position")
        items.insert(len(items) if index is None else index, item)

    def _include_unlisted_scenes(self, show: dict) -> None:
        listed = {sid for i in show["items"] for sid in (i["scene_ids"] if i["kind"] == "act" else [i["id"]])}
        for scene in self._list():
            if scene["show_id"] == show["id"] and scene["id"] not in listed:
                show["items"].append({"kind": "scene", "id": scene["id"]})

    def _order_standalone(self, changes: dict, scene: dict, index: int) -> None:
        items = [s for s in self._list() if not s["show_id"] and s["id"] != scene["id"]]
        items.sort(key=lambda s: s["order"] if s["order"] is not None else 0)
        self._insert(items, scene, index)
        for position, item in enumerate(items):
            data = scene if item["id"] == scene["id"] else self.get(item["id"])
            if data.get("order") != position:
                data["order"] = position
                changes[self.root / f"{data['id']}.json"] = data

    def place_scene(self, scene_id: str, show_id: str | None = None, act_id: str | None = None,
                    index: int | None = None, copy_scene: bool = False, name: str | None = None) -> dict:
        with self._changes() as changes:
            return self._place_scene(changes, scene_id, show_id, act_id, index, copy_scene, name)

    def _place_scene(self, changes: dict, scene_id: str, show_id: str | None, act_id: str | None,
                     index: int | None, copy_scene: bool, name: str | None) -> dict:
        source_path = self._file(scene_id)
        scene = self.get(scene_id)
        if act_id and not show_id:
            raise ValueError("an act must belong to a show")
        target = None
        if show_id:
            outline = self._outline(show_id)
            target = changes.get(outline) or self.get_show(show_id)
            self._include_unlisted_scenes(target)
        if not copy_scene and source_path.parent != self.root:
            source_id = source_path.parent.name
            source_outline = self._outline(source_id)
            source = target if source_id == show_id else (changes.get(source_outline) or self.get_show(source_id))
            self._remove_scene(source, scene_id)
            changes[source_outline] = source
        if copy_scene:
            scene = copy.deepcopy(scene)
            scene["id"] = new_id("s", lambda i: self._file(i).exists() or any(p.name == f"{i}.scene.json" for p in changes))
            scene.pop("starter", None)
        if name is not None:
            scene["name"] = self._name(name)
            if copy_scene:
                scene.pop("names", None)
        dest_id = scene["id"]
        if target is not None:
            if act_id:
                self._insert(self._act(target, act_id)["scene_ids"], dest_id, index)
            else:
                self._insert(target["items"], {"kind": "scene", "id": dest_id}, index)
            changes[self._outline(show_id)] = target
        dest = self.shows_root / show_id / f"{dest_id}.scene.json" if show_id else self.root / f"{dest_id}.json"
        if not copy_scene and dest != source_path:
            changes[source_path] = None
        if copy_scene:
            scene["updated_at"] = datetime.now(timezone.utc).isoformat()
        if copy_scene or name is not None:
            changes[dest] = scene
        elif dest != source_path:
            changes[dest] = source_path.read_bytes()
        if not show_id and index is not None:
            self._order_standalone(changes, scene, index)
        return scene

    def place_act(self, source_id: str, act_id: str, show_id: str | None, index: int | None = None,
                  copy_act: bool = False, name: str | None = None) -> dict:
        if not show_id:
            raise ValueError("an act must belong to a show")
        with self._changes() as changes:
            source = self.get_show(source_id)
            target = source if source_id == show_id else self.get_show(show_id)
            self._include_unlisted_scenes(target)
            act = copy.deepcopy(self._act(source, act_id))
            if not copy_act:
                source["items"] = [i for i in source["items"] if i["id"] != act_id]
            else:
                act["id"] = new_id("act", lambda i: any(a["id"] == i for s in self.list_shows() for a in s["items"]))
            if name is not None:
                act["name"] = self._name(name)
                if copy_act:
                    act.pop("names", None)
            scene_ids = act["scene_ids"]
            act["scene_ids"] = []
            self._insert(target["items"], act, index)
            changes[self._outline(source_id)] = source
            changes[self._outline(show_id)] = target
            for sid in scene_ids:
                self._place_scene(changes, sid, show_id, act["id"], None, copy_act, None)
        return act

    def delete_group(self, show_id: str, act_id: str | None = None) -> None:
        with self._changes() as changes:
            show = self.get_show(show_id)
            if act_id:
                act = self._act(show, act_id)
                if act["scene_ids"]:
                    raise ValueError("move or delete the act's scenes first")
                show["items"].remove(act)
                changes[self._outline(show_id)] = show
            else:
                if show["items"] or any(self._outline(show_id).parent.glob("*.scene.json")):
                    raise ValueError("move or delete the show's contents first")
                changes[self._outline(show_id)] = None

    def delete_hierarchy(self, show_id: str, act_id: str | None = None,
                         expected_scene_ids: list[str] | None = None,
                         expected_act_ids: list[str] | None = None) -> None:
        with self._changes() as changes:
            show = self.get_show(show_id)
            outline = self._outline(show_id)
            if act_id:
                act = self._act(show, act_id)
                scene_ids = act["scene_ids"]
                show["items"].remove(act)
                changes[outline] = show
            else:
                # Include scene files not yet listed in the outline, as the explorer does.
                scene_ids = [s["id"] for s in self._list() if s["show_id"] == show_id]
                referenced = {sid for item in show["items"] for sid in
                              (item["scene_ids"] if item["kind"] == "act" else [item["id"]])}
                if referenced - set(scene_ids):
                    raise ValueError("cannot delete hierarchy: show contains missing scenes")
                changes[outline] = None
            act_ids = [act_id] if act_id else [item["id"] for item in show["items"] if item["kind"] == "act"]
            if ((expected_scene_ids is not None and set(scene_ids) != set(expected_scene_ids)) or
                    (expected_act_ids is not None and set(act_ids) != set(expected_act_ids))):
                raise ValueError("hierarchy changed; refresh the outline and confirm deletion again")
            for scene_id in scene_ids:
                path = self._file(scene_id)
                if not path.is_file() or path.parent != outline.parent:
                    raise ValueError(f"cannot delete hierarchy: scene {scene_id} is missing from the show")
                changes[path] = None
