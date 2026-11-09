from __future__ import annotations

import functools
import os
import threading
from pathlib import Path

import yaml

from .i18n import normalize_locale
from .ids import new_id
from .tag_names import BUNDLED, bundled_names

TAGS_FILE = "tags.yaml"
_LOCK = threading.RLock()


def _mutating(method):
    # requests run in parallel threads: serialise read-modify-write and start from what is on disk
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with _LOCK:
            self._tags = None
            return method(self, *args, **kwargs)

    return wrapper


def _clean(names: dict) -> dict[str, str]:
    result = {}
    for locale, text in (names or {}).items():
        text = str(text or "").strip()
        if text:
            result[normalize_locale(str(locale))] = text
    return result


class TagStore:
    """A library's tags: opaque ids with per-locale display names and an optional parent (nesting).

    Presets and collection filters reference tag ids, so renaming or translating a tag never breaks a link.
    """

    def __init__(self, path: Path):
        self.path = path
        self._tags: dict[str, dict] | None = None
        self._seeded: list[str] = []

    def _load(self) -> dict[str, dict]:
        if self._tags is None:
            with _LOCK:
                data = yaml.safe_load(self.path.read_text(encoding="utf-8")) or {} if self.path.exists() else {}
                tags: dict[str, dict] = {}
                for tag_id, raw in (data.get("tags") or {}).items():
                    names = _clean((raw or {}).get("names", {}))
                    if names:
                        tags[str(tag_id)] = {"names": names, "parent": (raw or {}).get("parent") or None}
                self._tags = tags
                self._seeded = [str(x) for x in (data.get("seeded_locales") or [])]
                self._seed_bundled_names()
        return self._tags

    def _seed_bundled_names(self) -> None:
        """Once per language, add the bundled translations to tags that already exist; later edits are never overridden."""
        todo = [loc for loc in BUNDLED if loc not in self._seeded]
        if not todo or not self._tags:
            return
        for tag in self._tags.values():
            for locale, text in bundled_names(tag["names"]).items():
                if locale in todo:
                    tag["names"][locale] = text
        self._seeded.extend(todo)
        self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        payload = {"tags": self._tags, "seeded_locales": sorted(self._seeded)}
        tmp.write_text(yaml.safe_dump(payload, allow_unicode=True, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.path)

    def list(self) -> list[dict]:
        return [{"id": i, **t} for i, t in sorted(self._load().items())]

    def get(self, tag_id: str) -> dict:
        tags = self._load()
        if tag_id not in tags:
            raise FileNotFoundError(tag_id)
        return {"id": tag_id, **tags[tag_id]}

    def exists(self, tag_id: str) -> bool:
        return tag_id in self._load()

    def children(self, parent: str | None) -> list[str]:
        return [i for i, t in self._load().items() if t["parent"] == parent]

    def _named(self, parent: str | None, name: str) -> str | None:
        wanted = name.strip().casefold()
        for tag_id in self.children(parent):
            if any(n.casefold() == wanted for n in self._load()[tag_id]["names"].values()):
                return tag_id
        return None

    def find(self, label: str) -> str | None:
        """Tag id for an id or a "parent/child" name path (any locale, case-insensitive); None when unknown."""
        if label in self._load():
            return label
        parent = None
        for part in (p.strip() for p in label.split("/") if p.strip()):
            parent = self._named(parent, part)
            if parent is None:
                return None
        return parent

    @staticmethod
    def _new_names(name: str, locale: str | None) -> dict[str, str]:
        names = {normalize_locale(locale): name}
        return {**bundled_names(names), **names}

    def resolve(self, label: str, locale: str | None = None) -> str:
        """Like `find`, but creates missing tags; new names are stored under `locale` ("und" when unknown)."""
        # known tags are by far the common case (every preset read): no lock and no reload from disk
        found = self.find(label)
        if found:
            return found
        return self._create(label, locale)

    @_mutating
    def _create(self, label: str, locale: str | None) -> str:
        found = self.find(label)
        if found:
            return found
        parts = [p.strip() for p in label.split("/") if p.strip()]
        if not parts:
            raise ValueError("tag name is required")
        parent = None
        for part in parts:
            existing = self._named(parent, part)
            if existing is None:
                existing = new_id("t", lambda c: c in self._load())
                self._load()[existing] = {"names": self._new_names(part, locale), "parent": parent}
            parent = existing
        self._save()
        return parent

    @_mutating
    def rename(self, tag_id: str, locale: str | None, name: str) -> dict:
        """Set the display name for one locale; other locales are untouched."""
        tag = self.get(tag_id)
        name = (name or "").strip()
        if not name or "/" in name:
            raise ValueError("tag name is required and cannot contain '/'")
        clash = self._named(tag["parent"], name)
        if clash and clash != tag_id:
            raise ValueError(f"tag already exists: {name}")
        self._load()[tag_id]["names"][normalize_locale(locale)] = name
        self._save()
        return self.get(tag_id)

    @_mutating
    def remove_name(self, tag_id: str, locale: str | None) -> dict:
        tag = self.get(tag_id)
        key = normalize_locale(locale)
        if key not in tag["names"] or len(tag["names"]) == 1:
            raise ValueError("a tag needs at least one name")
        del self._load()[tag_id]["names"][key]
        self._save()
        return self.get(tag_id)

    def descendants(self, tag_id: str) -> set[str]:
        """The tag itself plus everything nested below it."""
        result, stack = set(), [tag_id]
        while stack:
            current = stack.pop()
            if current not in result:
                result.add(current)
                stack.extend(self.children(current))
        return result

    @_mutating
    def move(self, tag_id: str, parent: str | None) -> dict:
        tag = self.get(tag_id)
        if parent is not None and (not self.exists(parent) or parent in self.descendants(tag_id)):
            raise ValueError("invalid parent tag")
        names = tag["names"].values()
        if any(self._named(parent, n) not in (None, tag_id) for n in names):
            raise ValueError("a tag with this name already exists there")
        self._load()[tag_id]["parent"] = parent
        self._save()
        return self.get(tag_id)

    @_mutating
    def delete(self, tag_id: str) -> str | None:
        """Remove a tag; its children move up to its parent. Returns that parent."""
        tag = self.get(tag_id)
        for child in self.children(tag_id):
            self._load()[child]["parent"] = tag["parent"]
        del self._load()[tag_id]
        self._save()
        return tag["parent"]

    @_mutating
    def ensure_from(self, other: TagStore, tag_id: str) -> None:
        """Copy a tag (and its ancestors) from another library, keeping the id so it stays the same tag."""
        chain, current = [], tag_id
        while current and not self.exists(current):
            chain.append(other.get(current))
            current = chain[-1]["parent"]
        for tag in reversed(chain):
            self._load()[tag["id"]] = {"names": dict(tag["names"]), "parent": tag["parent"]}
        if chain:
            self._save()

    def expand(self, label: str) -> set[str]:
        """Ids matched by a collection filter label: the tag and its descendants (empty when the tag is unknown)."""
        found = self.find(label)
        return self.descendants(found) if found else set()
