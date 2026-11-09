import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

# Bundled read-only resources (profiles, samples, frontend build): the PyInstaller bundle when frozen, else the repo.
LB_PROJECT_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
DEFAULT_COMFY_URL = "http://127.0.0.1:8188"
DEFAULT_PORT = 8000


@dataclass(frozen=True)
class LB_Settings:
    ComfyUrl: str
    LibrariesRoot: Path
    ProfilesRoot: Path
    UserProfilesRoot: Path
    DataRoot: Path
    ScenesRoot: Path
    ModelsRoot: Path | None
    BackupsRoot: Path | None = None
    SceneSnapMax: int = 30
    SettingsFile: Path | None = None

    @property
    def SceneSnapsRoot(self) -> Path:
        return self.DataRoot / "scene_snaps"

    @property
    def SnapshotsRoot(self) -> Path:
        return self.DataRoot / "snapshots"

    @property
    def DbPath(self) -> Path:
        return self.DataRoot / "libretto.db"


def LB_UgcRoot() -> Path:
    return Path(os.environ.get("LB_UGC_ROOT", Path(__file__).resolve().parents[2] / "ugc"))


def normalize_comfy_url(url: str) -> str:
    """Accept `host`, `host:port` or a full URL; return `scheme://host[:port]`."""
    text = (url or "").strip().rstrip("/")
    if not text:
        raise ValueError("ComfyUI address is empty")
    if "://" not in text:
        text = "http://" + text
    parts = urlparse(text)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"invalid ComfyUI address: {url!r}")
    try:
        port = parts.port
    except ValueError:
        raise ValueError(f"invalid port in {url!r}") from None
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    return f"{parts.scheme}://{host}" + (f":{port}" if port else "")


def load_user_settings(path: Path | None) -> dict:
    """User-editable settings (settings.json next to the libraries); a missing or broken file means defaults."""
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path and path.exists() else {}
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_user_settings(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def LB_LoadSettings() -> LB_Settings:
    models = os.environ.get("LB_MODELS_ROOT")
    ugc = LB_UgcRoot()
    settings_file = ugc / "settings.json"
    saved = load_user_settings(settings_file).get("comfy_url")
    try:
        comfy_url = normalize_comfy_url(saved) if saved else normalize_comfy_url(os.environ.get("LB_COMFY_URL", DEFAULT_COMFY_URL))
    except ValueError:
        comfy_url = DEFAULT_COMFY_URL
    return LB_Settings(
        ComfyUrl=comfy_url,
        SettingsFile=settings_file,
        LibrariesRoot=Path(os.environ.get("LB_LIBRARIES_ROOT", ugc / "libraries")),
        ProfilesRoot=Path(os.environ.get("LB_PROFILES_ROOT", LB_PROJECT_ROOT / "profiles")),
        UserProfilesRoot=Path(os.environ.get("LB_USER_PROFILES_ROOT", ugc / "profiles")),
        DataRoot=Path(os.environ.get("LB_DATA_ROOT", ugc / "data")),
        ScenesRoot=Path(os.environ.get("LB_SCENES_ROOT", ugc / "scenes")),
        ModelsRoot=Path(models) if models else None,
        BackupsRoot=Path(os.environ.get("LB_BACKUP_ROOT", ugc.parent / "backups")),
        SceneSnapMax=max(1, int(os.environ.get("LB_SCENE_SNAP_MAX", "30"))),
    )
