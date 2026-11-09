from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from .i18n import normalize_names
from .ids import new_id

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def _check(scene_id: str) -> None:
    if not _ID_RE.match(scene_id or ""):
        raise ValueError(f"invalid scene id: {scene_id!r}")


class Scenes:
    """A scene is a saved node graph (its own library, prompt additions and nodes), one JSON file each."""

    def __init__(self, root: Path, seed: Path | None = None):
        self.root = root
        # only a brand-new data folder gets the sample scenes, so deleting them stays deleted
        if seed is not None and seed.is_dir() and not root.exists():
            shutil.copytree(seed, root)

    def _file(self, scene_id: str) -> Path:
        _check(scene_id)
        return self.root / f"{scene_id}.json"

    def get(self, scene_id: str) -> dict:
        path = self._file(scene_id)
        if not path.exists():
            raise FileNotFoundError(scene_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def list(self) -> list[dict]:
        if not self.root.exists():
            return []
        scenes = []
        for path in self.root.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            scenes.append(
                {
                    "id": data["id"],
                    "name": data.get("name", data["id"]),
                    "names": data.get("names") or {},
                    "updated_at": data.get("updated_at", ""),
                    # shipped example scenes carry a `starter` number: they open as tabs, in that order, on a first run
                    "starter": data.get("starter"),
                }
            )
        return sorted(scenes, key=lambda s: s["updated_at"], reverse=True)

    def _write(self, scene: dict) -> dict:
        self.root.mkdir(parents=True, exist_ok=True)
        scene["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._file(scene["id"]).write_text(json.dumps(scene, indent=2, ensure_ascii=False), encoding="utf-8")
        return scene

    def create(self, name: str, graph: dict | None = None) -> dict:
        scene_id = new_id("s", lambda candidate: self._file(candidate).exists())
        return self._write({"id": scene_id, "name": name or "Scene", "graph": graph or {"nodes": [], "edges": []}})

    def update(self, scene_id: str, name: str | None = None, graph: dict | None = None, names: dict | None = None) -> dict:
        scene = self.get(scene_id)
        if name is not None:
            scene["name"] = name
        if names is not None:
            cleaned = normalize_names(names)
            if cleaned:
                scene["names"] = cleaned
            else:
                scene.pop("names", None)
        if graph is not None:
            scene["graph"] = graph
        return self._write(scene)

    def delete(self, scene_id: str) -> None:
        path = self._file(scene_id)
        if not path.exists():
            raise FileNotFoundError(scene_id)
        path.unlink()
