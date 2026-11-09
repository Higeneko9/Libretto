import re

import yaml

from .i18n import UNDETERMINED, normalize_names, pick_name

CATEGORIES_FILE = "categories.yaml"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

# Behaviour hangs off the kind, never off a category's id or label.
#   group_head: other nodes can belong to it (a character); its items are grouped with their members
#   attribute:  describes one member of a group (hair, costume, pose ...)
#   situation:  like attribute, may later belong to several group heads
#   scene:      applies to the whole image (location, lighting, view, style ...)
#   custom:     plain list of prompt text
KINDS = {
    "group_head": {"can_belong": False, "color": "#e5739b"},
    "attribute": {"can_belong": True, "color": "#c98a5a"},
    "situation": {"can_belong": True, "color": "#f0b45c"},
    "scene": {"can_belong": False, "color": "#5cc08a"},
    "custom": {"can_belong": False, "color": "#9aa0ad"},
}
FIELDS = ("id", "names", "label", "kind", "color", "folder", "locked", "can_belong", "has_color", "template")

# Bundled Japanese names for the built-in categories, applied to libraries that only have the English label.
JA_JP = {
    "style": "スタイル", "character": "キャラクター", "hair": "髪型", "costume": "衣装", "pose": "ポーズ",
    "emotion": "表情", "props": "小道具", "situation": "シチュエーション", "location": "ロケーション",
    "lighting": "ライティング", "view": "視点",
}


def _cat(id, label, kind, color, folder, **extra):
    names = {"en-US": label, **({"ja-JP": JA_JP[id]} if id in JA_JP else {})}
    return {"id": id, "names": names, "label": label, "kind": kind, "color": color, "folder": folder, "locked": True,
            "can_belong": KINDS[kind]["can_belong"], "has_color": False, "template": "{text}", **extra}


DEFAULT_CATEGORIES = [
    _cat("style", "Style", "scene", "#b07cf0", "styles"),
    _cat("character", "Character", "group_head", "#e5739b", "characters"),
    _cat("hair", "Hair", "attribute", "#c98a5a", "hairstyles", has_color=True),
    _cat("costume", "Costume", "attribute", "#7c9cf0", "costumes"),
    _cat("pose", "Pose", "attribute", "#e58a5c", "poses"),
    _cat("emotion", "Emotion", "attribute", "#f07ca0", "emotions"),
    _cat("props", "Props", "attribute", "#8fb85c", "props"),
    _cat("situation", "Situation", "situation", "#f0b45c", "situations"),
    _cat("location", "Location", "scene", "#5cc08a", "locations"),
    _cat("lighting", "Lighting", "scene", "#f0e05c", "lighting"),
    _cat("view", "View", "scene", "#5cc0c0", "views"),
]
DEFAULT_BY_ID = {c["id"]: c for c in DEFAULT_CATEGORIES}


def normalize(raw: dict, known: dict | None = None) -> dict:
    """Validate one category entry; `known` is the existing entry with the same id (kept fields can't change if locked)."""
    cid = str(raw.get("id") or "").strip()
    if not _ID_RE.match(cid):
        raise ValueError(f"invalid category id: {cid!r}")
    kind = raw.get("kind") or "custom"
    if kind not in KINDS:
        raise ValueError(f"unknown category kind: {kind}")
    color = raw.get("color") or KINDS[kind]["color"]
    if not _COLOR_RE.match(color):
        raise ValueError(f"invalid color: {color}")
    folder = (known or {}).get("folder") or raw.get("folder") or cid
    if not _ID_RE.match(folder):
        raise ValueError(f"invalid folder: {folder!r}")
    names = normalize_names(raw.get("names"))
    if not names:
        legacy = str(raw.get("label") or "").strip() or cid
        builtin = DEFAULT_BY_ID.get(cid)
        names = dict(builtin["names"]) if builtin and legacy == builtin["label"] else {UNDETERMINED: legacy}
    can_belong = raw.get("can_belong")
    entry = {
        "id": cid,
        "names": names,
        "label": pick_name(names),
        "kind": kind,
        "color": color,
        "folder": folder,
        "locked": bool(raw.get("locked", False)),
        "can_belong": KINDS[kind]["can_belong"] if can_belong is None else bool(can_belong),
        "has_color": bool(raw.get("has_color", False)),
        "template": str(raw.get("template") or "{text}"),
    }
    if "{text}" not in entry["template"]:
        raise ValueError("template must contain {text}")
    if known and known.get("locked") and known["kind"] != kind:
        raise ValueError(f"locked category {cid} cannot change its kind")
    return entry


def load(path) -> list[dict]:
    if not path.exists():
        return [dict(c) for c in DEFAULT_CATEGORIES]
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    loaded = []
    for raw in data.get("categories", []):
        try:
            loaded.append(normalize(raw))
        except ValueError:
            continue
    return loaded or [dict(c) for c in DEFAULT_CATEGORIES]


def validate_list(items: list[dict], current: list[dict]) -> list[dict]:
    """Check a full replacement list: unique ids/folders, locked categories must stay."""
    known = {c["id"]: c for c in current}
    result, ids, folders = [], set(), set()
    for raw in items:
        entry = normalize(raw, known.get(str(raw.get("id") or "")))
        if entry["id"] in ids:
            raise ValueError(f"duplicate category id: {entry['id']}")
        if entry["folder"] in folders:
            raise ValueError(f"duplicate folder: {entry['folder']}")
        ids.add(entry["id"])
        folders.add(entry["folder"])
        result.append(entry)
    for cid, old in known.items():
        if old["locked"] and cid not in ids:
            raise ValueError(f"locked category cannot be removed: {cid}")
    return result


def save(path, items: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    stored = [{k: v for k, v in c.items() if k != "label"} for c in items]
    path.write_text(yaml.safe_dump({"categories": stored}, allow_unicode=True, sort_keys=False), encoding="utf-8")


def resolve(categories: list[dict], category_id: str) -> dict:
    """Config for an id: the library's own, else the built-in default, else a generic custom category."""
    for c in categories:
        if c["id"] == category_id:
            return c
    return DEFAULT_BY_ID.get(category_id) or {**normalize({"id": category_id or "x", "kind": "custom"}), "locked": False}
