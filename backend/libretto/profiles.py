import json
from pathlib import Path

import yaml


def load_profiles(builtin_root: Path, user_root: Path) -> dict[str, dict]:
    profiles: dict[str, dict] = {}
    # user profiles override built-ins with the same id
    for path in [*sorted(builtin_root.glob("*.yaml")), *sorted(user_root.glob("*.yaml"))]:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        data.setdefault("id", path.stem)
        profiles[data["id"]] = data
    return profiles


def profile_path(user_root: Path, profile: dict) -> Path:
    return user_root / f"{profile['id']}.yaml"


def save_profile(root: Path, profile: dict) -> None:
    path = profile_path(root, profile)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {k: v for k, v in profile.items() if k != "id"}
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def load_workflow_template(builtin_root: Path, user_root: Path, profile: dict) -> dict:
    path = user_root / profile["workflow_template"]
    if not path.exists():
        path = builtin_root / profile["workflow_template"]
    return json.loads(path.read_text(encoding="utf-8"))
