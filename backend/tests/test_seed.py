import json

from libretto.config import LB_PROJECT_ROOT
from libretto.libraries import Libraries
from libretto.scenes import Scenes

SAMPLES = LB_PROJECT_ROOT / "samples"


def test_fresh_install_gets_sample_scenes_once(tmp_path):
    root = tmp_path / "scenes"
    scenes = Scenes(root, SAMPLES / "scenes")
    assert {s["name"] for s in scenes.list()} == {"Sample", "Complex Sample"}

    scenes.delete("sample")
    assert {s["name"] for s in Scenes(root, SAMPLES / "scenes").list()} == {"Complex Sample"}


def test_existing_scenes_folder_is_not_seeded(tmp_path):
    root = tmp_path / "scenes"
    root.mkdir()
    assert Scenes(root, SAMPLES / "scenes").list() == []


def test_sample_scenes_only_use_shipped_presets_and_profiles(tmp_path):
    library = Libraries(tmp_path / "libs", SAMPLES / "default").get("default")
    profiles = {p.stem for p in (LB_PROJECT_ROOT / "profiles").glob("*.yaml")}
    for file in (SAMPLES / "scenes").glob("*.json"):
        graph = json.loads(file.read_text(encoding="utf-8"))["graph"]
        for node in graph["nodes"]:
            data = node["data"]
            if node["type"] == "generate":
                assert data["profile"] in profiles
            elif data.get("presetId"):
                assert data.get("lib", "default") == "default"
                library.get(node["type"], data["presetId"])
                assert library.thumb_path(node["type"], data["presetId"]).is_file(), (file.name, data["presetId"])
