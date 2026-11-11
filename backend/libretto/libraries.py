from __future__ import annotations

import io
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath

import yaml

from . import categories as cats
from .ids import new_id
from .i18n import normalize_names
from .library import Library
from .tags import TAGS_FILE

DEFAULT_LIBRARY = "default"
META_FILE = "library.yaml"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_FILE_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]*\.(yaml|webp)$")
MAX_IMPORT_BYTES = 300 * 1024 * 1024


def _check_id(library_id: str) -> None:
    if not _ID_RE.match(library_id or ""):
        raise ValueError(f"invalid library name: {library_id!r}")


class Libraries:
    """A set of independent preset libraries, one folder each under `root`."""

    def __init__(self, root: Path, seed: Path | None = None):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        if not any(p.is_dir() for p in self.root.iterdir()):
            if seed is not None and seed.is_dir():
                shutil.copytree(seed, self.root / DEFAULT_LIBRARY)
            else:
                (self.root / DEFAULT_LIBRARY).mkdir()

    def _path(self, library_id: str) -> Path:
        _check_id(library_id)
        return self.root / library_id

    def get(self, library_id: str) -> Library:
        path = self._path(library_id)
        if not path.is_dir():
            raise FileNotFoundError(library_id)
        return Library(path)

    def _meta(self, path: Path) -> dict:
        meta = path / META_FILE
        return (yaml.safe_load(meta.read_text(encoding="utf-8")) or {}) if meta.exists() else {}

    def _name(self, path: Path) -> str:
        """Original name; libraries made before names existed show their folder name."""
        name = str(self._meta(path).get("name") or "").strip()
        return name or path.name

    def _write_name(self, path: Path, name: str, names: dict | None = None) -> None:
        data = {"name": name}
        cleaned = normalize_names(names)
        if cleaned:
            data["names"] = cleaned
        (path / META_FILE).write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")

    def _unique_name(self, name: str, ignore_id: str | None = None, *, auto_suffix: bool = False) -> str:
        name = (name or "").strip()
        if not name:
            raise ValueError("library name is required")
        taken = {self._name(p).casefold() for p in self._library_dirs() if p.name != ignore_id}
        candidate, n = name, 0
        while candidate.casefold() in taken:
            if not auto_suffix:
                raise ValueError(f"library already exists: {name}")
            n += 1
            candidate = f"{name} ({n})"
        return candidate

    def _library_dirs(self) -> list[Path]:
        return sorted(p for p in self.root.iterdir() if p.is_dir() and _ID_RE.match(p.name))

    def _new_id(self) -> str:
        return new_id("l", lambda c: (self.root / c).exists())

    def name_of(self, library_id: str) -> str:
        return self._name(self._path(library_id))

    def list(self) -> list[dict]:
        result = []
        for path in self._library_dirs():
            library = Library(path)
            result.append({
                "id": path.name,
                "name": self._name(path),
                "names": normalize_names(self._meta(path).get("names")),
                "counts": {c["id"]: sum(1 for _ in (path / c["folder"]).glob("*.yaml")) for c in library.categories()},
            })
        return result

    def create(self, name: str, copy_from: str | None = None) -> dict:
        name = self._unique_name(name)
        library_id = self._new_id()
        path = self._path(library_id)
        if copy_from:
            shutil.copytree(self._path(copy_from), path, ignore=shutil.ignore_patterns(".trash"))
        else:
            path.mkdir()
        self._write_name(path, name)
        return {"id": library_id, "name": name}

    def rename(self, library_id: str, name: str, names: dict | None = None) -> dict:
        path = self._path(library_id)
        if not path.is_dir():
            raise FileNotFoundError(library_id)
        name = self._unique_name(name, library_id)
        self._write_name(path, name, names)
        return {"id": library_id, "name": name, "names": normalize_names(names)}

    def delete(self, library_id: str) -> None:
        if library_id == DEFAULT_LIBRARY:
            raise ValueError("the default library cannot be deleted")
        path = self._path(library_id)
        if not path.is_dir():
            raise FileNotFoundError(library_id)
        shutil.rmtree(path)

    def export_zip(self, library_id: str) -> bytes:
        path = self._path(library_id)
        if not path.is_dir():
            raise FileNotFoundError(library_id)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            metadata = {
                "id": library_id,
                "name": self._name(path),
                "names": normalize_names(self._meta(path).get("names")),
            }
            archive.writestr(META_FILE, yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False))
            library = Library(path)
            if library.categories_path.exists():
                archive.write(library.categories_path, cats.CATEGORIES_FILE)
            if library.tags.path.exists():
                archive.write(library.tags.path, TAGS_FILE)
            for config in library.categories():
                folder = path / config["folder"]
                for file in sorted(folder.glob("*")) if folder.exists() else []:
                    if file.is_file() and _FILE_RE.match(file.name):
                        archive.write(file, f"{config['folder']}/{file.name}")
        return buffer.getvalue()

    def import_zip(self, name: str, data: bytes) -> dict:
        name = self._unique_name(name, auto_suffix=True)
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise ValueError("not a zip file")
        entries = []
        categories_bytes = None
        tags_bytes = None
        metadata = {}
        total = 0
        for info in archive.infolist():
            if info.is_dir():
                continue
            parts = PurePosixPath(info.filename).parts
            if parts in ((cats.CATEGORIES_FILE,), (TAGS_FILE,), (META_FILE,)):
                total += info.file_size
                if total > MAX_IMPORT_BYTES:
                    raise ValueError("zip is too large")
                if parts == (cats.CATEGORIES_FILE,):
                    categories_bytes = archive.read(info)
                elif parts == (TAGS_FILE,):
                    tags_bytes = archive.read(info)
                else:
                    try:
                        metadata = yaml.safe_load(archive.read(info))
                    except yaml.YAMLError as exc:
                        raise ValueError("invalid library metadata") from exc
                    if not isinstance(metadata, dict):
                        raise ValueError("library metadata must be a mapping")
                continue
            if len(parts) != 2 or not _ID_RE.match(parts[0]) or not _FILE_RE.match(parts[1]):
                continue
            total += info.file_size
            entries.append((info, parts))
        if not entries:
            raise ValueError("zip contains no library files")
        if total > MAX_IMPORT_BYTES:
            raise ValueError("zip is too large")
        archived_id = metadata.get("id")
        if archived_id is not None and (not isinstance(archived_id, str) or not _ID_RE.fullmatch(archived_id)):
            raise ValueError("invalid library id in archive")
        library_id = archived_id if archived_id is not None and not self._path(archived_id).exists() else self._new_id()
        path = self._path(library_id)
        path.mkdir()
        try:
            for info, (folder, filename) in entries:
                target = path / folder
                target.mkdir(exist_ok=True)
                (target / filename).write_bytes(archive.read(info))
            if categories_bytes:
                (path / cats.CATEGORIES_FILE).write_bytes(categories_bytes)
            if tags_bytes:
                (path / TAGS_FILE).write_bytes(tags_bytes)
            self._write_name(path, name, metadata.get("names"))
        except Exception:
            shutil.rmtree(path, ignore_errors=True)
            raise
        return {"id": library_id, "name": name}

    def copy_items(self, source_id: str, target_id: str, items: list[dict]) -> list[dict]:
        """Copy presets and thumbnails with fresh opaque ids, within or between libraries."""
        source, target = self.get(source_id), self.get(target_id)
        copied = []
        for item in items:
            category, preset_id = item["category"], item["id"]
            preset = source.get(category, preset_id)
            target.ensure_category(source.category(category))
            name = target.unique_name(category, preset["name"])
            new_id = target.new_preset_id(category)
            source_dir, target_dir = source._dir(category), target._dir(category)
            target_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source._file(category, preset_id), target._file(category, new_id))
            for tag_id in preset["labels"]:
                target.tags.ensure_from(source.tags, tag_id)
            if name != preset["name"]:
                path = target._file(category, new_id)
                stored = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                stored["name"] = name
                path.write_text(yaml.safe_dump(stored, allow_unicode=True, sort_keys=False), encoding="utf-8")
            for thumb in [*source_dir.glob(f"{preset_id}.webp"), *source_dir.glob(f"{preset_id}.*.webp")]:
                shutil.copy2(thumb, target_dir / (new_id + thumb.name[len(preset_id):]))
            copied.append({"category": category, "id": new_id, "from": preset_id})
        return copied
