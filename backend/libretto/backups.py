from __future__ import annotations

import io
import json
import re
import shutil
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

_ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}(-[0-9]+)?$")
SECTIONS = ("libraries", "scenes", "profiles")
HISTORY_SECTION = "snapshots"
RUNS_FILE = "runs.json"
MANIFEST = "manifest.json"
FORMAT_VERSION = 1


def _now() -> datetime:
    return datetime.now().replace(microsecond=0)


class Backups:
    """Zip snapshots of everything the user creates (libraries, scenes, profiles, optionally run history)."""

    def __init__(
        self,
        root: Path,
        roots: dict[str, Path],
        snapshots_root: Path,
        runs_export: Callable[[], list[dict]],
        runs_import: Callable[[list[dict], bool], int],
    ):
        self.root = root
        self.roots = roots  # section name -> folder on disk
        self.snapshots_root = snapshots_root
        self._runs_export = runs_export
        self._runs_import = runs_import

    def _path(self, backup_id: str) -> Path:
        if not _ID_RE.match(backup_id):
            raise ValueError(f"invalid backup id: {backup_id}")
        return self.root / f"{backup_id}.zip"

    @staticmethod
    def _files(folder: Path):
        if folder.is_dir():
            for path in sorted(folder.rglob("*")):
                if path.is_file():
                    yield path

    def create(self, note: str = "", include_history: bool = False, kind: str = "manual") -> dict:
        self.root.mkdir(parents=True, exist_ok=True)
        stamp = _now()
        backup_id = stamp.strftime("%Y%m%d-%H%M%S")
        suffix = 1
        while self._path(backup_id).exists():
            suffix += 1
            backup_id = f"{stamp.strftime('%Y%m%d-%H%M%S')}-{suffix}"
        counts = {name: sum(1 for _ in self._files(folder)) for name, folder in self.roots.items()}
        runs = self._runs_export() if include_history else []
        manifest = {
            "version": FORMAT_VERSION,
            "created_at": stamp.isoformat(),
            "note": note.strip(),
            "kind": kind,
            "includes_history": include_history,
            "counts": {**counts, "runs": len(runs)},
        }
        tmp = self._path(backup_id).with_suffix(".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(MANIFEST, json.dumps(manifest, indent=2))
            for name, folder in self.roots.items():
                for file in self._files(folder):
                    archive.write(file, f"{name}/{file.relative_to(folder).as_posix()}")
            if include_history:
                archive.writestr(RUNS_FILE, json.dumps(runs))
                for file in self._files(self.snapshots_root):
                    archive.write(file, f"{HISTORY_SECTION}/{file.relative_to(self.snapshots_root).as_posix()}")
        tmp.replace(self._path(backup_id))
        return self.get(backup_id)

    def _manifest(self, path: Path) -> dict:
        try:
            with zipfile.ZipFile(path) as archive:
                return json.loads(archive.read(MANIFEST))
        except (zipfile.BadZipFile, KeyError, json.JSONDecodeError):
            raise ValueError("not a Libretto backup")

    def get(self, backup_id: str) -> dict:
        path = self._path(backup_id)
        if not path.exists():
            raise FileNotFoundError(backup_id)
        return {"id": backup_id, "size": path.stat().st_size, **self._manifest(path)}

    def list(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        found = []
        for path in self.root.glob("*.zip"):
            if _ID_RE.match(path.stem):
                try:
                    found.append(self.get(path.stem))
                except ValueError:
                    continue
        return sorted(found, key=lambda b: b["id"], reverse=True)

    def file(self, backup_id: str) -> Path:
        path = self._path(backup_id)
        if not path.exists():
            raise FileNotFoundError(backup_id)
        return path

    def delete(self, backup_id: str) -> None:
        self.file(backup_id).unlink()

    def import_zip(self, data: bytes, note: str = "") -> dict:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                manifest = json.loads(archive.read(MANIFEST))
        except (zipfile.BadZipFile, KeyError, json.JSONDecodeError):
            raise ValueError("not a Libretto backup")
        if manifest.get("version", 0) > FORMAT_VERSION:
            raise ValueError("backup was made by a newer version of Libretto")
        self.root.mkdir(parents=True, exist_ok=True)
        stamp = _now()
        backup_id = stamp.strftime("%Y%m%d-%H%M%S")
        suffix = 1
        while self._path(backup_id).exists():
            suffix += 1
            backup_id = f"{stamp.strftime('%Y%m%d-%H%M%S')}-{suffix}"
        manifest["kind"] = "imported"
        if note.strip():
            manifest["note"] = note.strip()
        # rewrite the manifest only, copying every other member unchanged
        tmp = self._path(backup_id).with_suffix(".tmp")
        with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as target:
            for member in source.infolist():
                if member.filename == MANIFEST:
                    target.writestr(MANIFEST, json.dumps(manifest, indent=2))
                else:
                    target.writestr(member, source.read(member))
        tmp.replace(self._path(backup_id))
        return self.get(backup_id)

    def _target(self, name: str) -> Path | None:
        """Map a zip member to a destination, refusing anything outside the managed folders."""
        parts = name.split("/")
        if len(parts) < 2 or any(p in ("", ".", "..") for p in parts) or ":" in name or name.startswith("/"):
            return None
        section, rest = parts[0], parts[1:]
        base = self.roots.get(section) if section in SECTIONS else None
        if section == HISTORY_SECTION:
            base = self.snapshots_root
        if base is None:
            return None
        target = base.joinpath(*rest)
        try:
            target.resolve().relative_to(base.resolve())
        except ValueError:
            return None
        return target

    def restore(self, backup_id: str, mode: str = "merge", include_history: bool = True) -> dict:
        """Restore a backup. "merge" overwrites/adds files and keeps anything else; "replace" makes the folders match exactly.

        A safety backup of the current state is taken first, so a restore can itself be undone.
        """
        if mode not in ("merge", "replace"):
            raise ValueError("mode must be merge or replace")
        path = self.file(backup_id)
        manifest = self._manifest(path)
        history = include_history and bool(manifest.get("includes_history"))
        safety = self.create(f"Before restoring {backup_id}", include_history=history, kind="pre-restore")
        restored = {name: 0 for name in SECTIONS}
        restored["snapshots"] = 0
        with zipfile.ZipFile(path) as archive:
            if mode == "replace":
                for name, folder in self.roots.items():
                    shutil.rmtree(folder, ignore_errors=True)
                    folder.mkdir(parents=True, exist_ok=True)
            for member in archive.infolist():
                if member.is_dir() or member.filename in (MANIFEST, RUNS_FILE):
                    continue
                if member.filename.split("/")[0] == HISTORY_SECTION and not history:
                    continue
                target = self._target(member.filename)
                if target is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(member))
                key = member.filename.split("/")[0]
                restored[key] = restored.get(key, 0) + 1
            runs = 0
            if history and RUNS_FILE in archive.namelist():
                runs = self._runs_import(json.loads(archive.read(RUNS_FILE)), mode == "replace")
        return {"restored": restored, "runs": runs, "safety_backup": safety["id"]}

    def auto_backup(self, keep: int = 10, min_age: timedelta = timedelta(hours=24)) -> dict | None:
        """Take a daily automatic backup (settings only) and prune old automatic ones."""
        existing = self.list()
        latest_auto = next((b for b in existing if b.get("kind") == "auto"), None)
        if latest_auto and _now() - datetime.fromisoformat(latest_auto["created_at"]) < min_age:
            return None
        if not any(any(self._files(folder)) for folder in self.roots.values()):
            return None
        created = self.create("Automatic backup", kind="auto")
        autos = [b for b in self.list() if b.get("kind") == "auto"]
        for old in autos[keep:]:
            self.delete(old["id"])
        return created
