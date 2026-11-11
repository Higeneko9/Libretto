from __future__ import annotations

import io
import re
import shutil

import yaml
from PIL import Image

from . import categories as cats
from .ids import new_id
from .i18n import normalize_names
from .tags import TAGS_FILE, TagStore

THUMB_SIZE = 256
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_TAG_ID_RE = re.compile(r"^t-[0-9a-f]{8}$")


def _check_id(preset_id: str | None) -> None:
    if preset_id is not None and not _ID_RE.match(preset_id):
        raise ValueError(f"invalid preset id: {preset_id}")


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "preset"


class Library:
    def __init__(self, root: Path):
        self.root = root
        self._categories: list | None = None
        self.tags = TagStore(root / TAGS_FILE)

    def normalize_labels(self, labels, locale: str | None = None) -> list[str]:
        """Tag ids for a list of ids or tag-name paths; unknown names create tags (named under `locale`)."""
        result = []
        for label in labels or []:
            text = str(label).strip()
            if _TAG_ID_RE.match(text) and not self.tags.exists(text):
                continue  # dangling reference to a removed tag
            if text:
                tag_id = self.tags.resolve(text, locale)
                if tag_id not in result:
                    result.append(tag_id)
        return result

    @property
    def categories_path(self) -> Path:
        return self.root / cats.CATEGORIES_FILE

    def categories(self) -> list:
        if self._categories is None:
            self._categories = cats.load(self.categories_path)
        return self._categories

    def category_ids(self) -> list:
        return [c["id"] for c in self.categories()]

    def category(self, category: str) -> dict:
        """Config of a category in this library; unknown ids raise."""
        for c in self.categories():
            if c["id"] == category:
                return c
        raise ValueError(f"unknown category: {category}")

    def category_info(self, category: str) -> dict:
        """Like `category` but falls back to defaults, for nodes whose category this library lacks."""
        return cats.resolve(self.categories(), category)

    def set_categories(self, items: list, purge: bool = False) -> list:
        """Replace the category list. A removed category that still has presets is refused unless `purge`, which moves its folder to the trash."""
        new = cats.validate_list(items, self.categories())
        kept = {c["id"] for c in new}
        removed = []
        for old in self.categories():
            if old["id"] not in kept:
                folder = self.root / old["folder"]
                count = sum(1 for _ in folder.glob("*.yaml")) if folder.exists() else 0
                if count and not purge:
                    raise ValueError(f"category {old['label']} still has {count} presets")
                if folder.exists():
                    removed.append(folder)
        cats.save(self.categories_path, new)
        self._categories = new
        for folder in removed:
            target = self.root / ".trash" / "categories" / folder.name
            shutil.rmtree(target, ignore_errors=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(folder), str(target))
        return new

    def ensure_category(self, config: dict) -> None:
        """Add a category (from another library) when this library lacks it."""
        if any(c["id"] == config["id"] for c in self.categories()):
            return
        taken = {c["folder"] for c in self.categories()}
        entry = {**config, "locked": False}
        if entry["folder"] in taken:
            entry["folder"] = entry["id"]
        self.set_categories([*self.categories(), entry])

    def _dir(self, category: str) -> Path:
        return self.root / self.category(category)["folder"]

    def _file(self, category: str, preset_id: str) -> Path:
        _check_id(preset_id)
        return self._dir(category) / f"{preset_id}.yaml"

    def thumb_path(self, category: str, preset_id: str, profile: str | None = None) -> Path:
        _check_id(preset_id)
        _check_id(profile)
        suffix = f".{profile}" if profile else ""
        return self._dir(category) / f"{preset_id}{suffix}.webp"

    def list(self, category: str) -> list[dict]:
        folder = self._dir(category)
        if not folder.exists():
            return []
        items = [self.get(category, p.stem) for p in sorted(folder.glob("*.yaml"))]
        return sorted(items, key=lambda i: (str(i.get("name", "")).casefold(), i["id"]))

    def get(self, category: str, preset_id: str) -> dict:
        path = self._file(category, preset_id)
        if not path.exists():
            raise FileNotFoundError(preset_id)
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        labels = self.normalize_labels(data.get("labels"))
        if labels != list(data.get("labels") or []):
            # presets written before tags had ids still hold plain text: convert once, in place
            data["labels"] = labels
            path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
        data["labels"] = labels
        data["id"] = preset_id
        data["category"] = category
        data["has_thumbnail"] = self.thumb_path(category, preset_id).exists()
        data["thumbnail_profiles"] = sorted(
            p.name[len(preset_id) + 1 : -len(".webp")]
            for p in self._dir(category).glob(f"{preset_id}.*.webp")
        )
        return data

    def _names(self, category: str) -> dict[str, str]:
        folder = self._dir(category)
        names = {}
        for path in folder.glob("*.yaml") if folder.exists() else []:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            names[path.stem] = str(data.get("name", path.stem))
        return names

    def unique_name(self, category: str, name: str, exclude_id: str | None = None) -> str:
        """Names are unique per category, case-insensitively; a clash becomes "name (1)"."""
        taken = {n.casefold() for i, n in self._names(category).items() if i != exclude_id}
        candidate, n = name, 0
        while candidate.casefold() in taken:
            n += 1
            candidate = f"{name} ({n})"
        return candidate

    def create(self, category: str, data: dict, locale: str | None = None) -> dict:
        name = self.unique_name(category, str(data.get("name") or "").strip() or "preset")
        return self.save(category, {**data, "name": name}, self.new_preset_id(category), locale)

    def new_preset_id(self, category: str) -> str:
        existing = {i.casefold() for i in self._names(category)}
        return new_id("p", lambda candidate: candidate in existing)

    def update(self, category: str, preset_id: str, data: dict, locale: str | None = None) -> dict:
        self.get(category, preset_id)
        name = self.unique_name(category, str(data.get("name") or "").strip() or preset_id, preset_id)
        return self.save(category, {**data, "name": name}, preset_id, locale)

    def save(self, category: str, data: dict, preset_id: str | None = None, locale: str | None = None) -> dict:
        preset_id = preset_id or data.get("id") or slugify(data.get("name", ""))
        path = self._file(category, preset_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        stored = {
            "name": data.get("name", preset_id),
            "keywords": data.get("keywords", ""),
            "description": data.get("description", ""),
            "negative": data.get("negative", ""),
            "labels": self.normalize_labels(data.get("labels"), locale),
            "weight": float(data.get("weight", 1.0)),
        }
        if data.get("lora"):
            stored["lora"] = data["lora"]
        names = normalize_names(data.get("names"))
        if names:
            stored["names"] = names
        if data.get("thumbnail_source"):
            stored["thumbnail_source"] = data["thumbnail_source"]
        path.write_text(yaml.safe_dump(stored, allow_unicode=True, sort_keys=False), encoding="utf-8")
        return self.get(category, preset_id)

    def delete_tag(self, tag_id: str) -> None:
        """Remove a tag from the library and from every preset that uses it (its children move up a level)."""
        self.tags.get(tag_id)
        for category in self.categories():
            folder = self.root / category["folder"]
            for path in folder.glob("*.yaml") if folder.exists() else []:
                data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                if tag_id in (data.get("labels") or []):
                    data["labels"] = [x for x in data["labels"] if x != tag_id]
                    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
        self.tags.delete(tag_id)

    def _trash_dir(self, category: str, preset_id: str) -> Path:
        _check_id(preset_id)
        return self.root / ".trash" / self._dir(category).name / preset_id

    def _files(self, category: str, preset_id: str) -> list[Path]:
        folder = self._dir(category)
        return [folder / f"{preset_id}.yaml", *folder.glob(f"{preset_id}.webp"), *folder.glob(f"{preset_id}.*.webp")]

    def delete(self, category: str, preset_id: str) -> None:
        """Moves the preset and its thumbnails to the library's trash so the delete can be undone."""
        path = self._file(category, preset_id)
        if not path.exists():
            raise FileNotFoundError(preset_id)
        trash = self._trash_dir(category, preset_id)
        shutil.rmtree(trash, ignore_errors=True)
        trash.mkdir(parents=True)
        for file in self._files(category, preset_id):
            if file.exists():
                shutil.move(str(file), trash / file.name)

    def restore(self, category: str, preset_id: str) -> dict:
        trash = self._trash_dir(category, preset_id)
        if not (trash / f"{preset_id}.yaml").exists():
            raise FileNotFoundError(preset_id)
        if self._file(category, preset_id).exists():
            raise ValueError(f"preset already exists: {preset_id}")
        self._dir(category).mkdir(parents=True, exist_ok=True)
        for file in trash.iterdir():
            shutil.move(str(file), self._dir(category) / file.name)
        trash.rmdir()
        return self.get(category, preset_id)

    def set_thumbnail(
        self,
        category: str,
        preset_id: str,
        image_bytes: bytes,
        profile: str | None = None,
        source: dict | None = None,
    ) -> Path:
        self._file(category, preset_id)
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        image.thumbnail((THUMB_SIZE, THUMB_SIZE))
        path = self.thumb_path(category, preset_id, profile)
        image.save(path, "WEBP", quality=85)
        if source:
            preset = self.get(category, preset_id)
            preset["thumbnail_source"] = source
            self.save(category, preset, preset_id)
        return path

    def import_wildcard(self, category: str, text: str) -> list[dict]:
        created = []
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            created.append(
                self.save(category, {"name": line, "keywords": line, "description": line}, self.new_preset_id(category))
            )
        return created
