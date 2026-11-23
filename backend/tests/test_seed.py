import json

import pytest

from libretto.compiler import compile_graph
from libretto.config import LB_PROJECT_ROOT, LB_Settings
from libretto.libraries import Libraries
from libretto.main import create_app
from libretto.profiles import load_profiles
from libretto.scenes import Scenes

SAMPLES = LB_PROJECT_ROOT / "samples"
SHOWS_SEED = SAMPLES / "shows"
SHOW_ID = "show-71a0b9f1"


def test_fresh_install_gets_sample_show_once(tmp_path):
    root = tmp_path / "scenes"
    shows_root = tmp_path / "other" / "shows"
    scenes = Scenes(root, shows_root=shows_root, shows_seed=SHOWS_SEED)
    show = scenes.get_show(SHOW_ID)
    assert show["name"] == "Sample Show"
    assert [item["name"] for item in show["items"]] == ["Samples", "Thumbnails Creation"]
    assert [len(item["scene_ids"]) for item in show["items"]] == [2, 7]
    assert show["output_layout"] == "show_scene"
    assert "output_comfy_root" not in show and "output_local_root" not in show
    listed = scenes.list()
    assert len(listed) == 9
    assert [(s["name"], s["starter"]) for s in sorted(
        (s for s in listed if s["starter"] is not None), key=lambda s: s["starter"]
    )] == [("Sample", 1), ("Complex Sample", 2)]

    scenes.delete("s-8706cf01")
    restarted = Scenes(root, shows_root=shows_root, shows_seed=SHOWS_SEED)
    assert len(restarted.list()) == 8
    assert "s-8706cf01" not in restarted.get_show(SHOW_ID)["items"][0]["scene_ids"]
    restarted.delete_hierarchy(SHOW_ID)
    assert Scenes(root, shows_root=shows_root, shows_seed=SHOWS_SEED).list_shows() == []


def test_existing_scenes_get_sample_show_when_shows_folder_is_missing(tmp_path):
    root = tmp_path / "scenes"
    shows_root = tmp_path / "shows"
    existing = Scenes(root, shows_root=shows_root).create("Existing scene")
    scene_file = root / f"{existing['id']}.json"
    before = scene_file.read_bytes()

    seeded = Scenes(root, shows_root=shows_root, shows_seed=SHOWS_SEED)
    assert len(seeded.list()) == 10
    assert seeded.get(existing["id"]) == existing
    assert scene_file.read_bytes() == before
    assert seeded.get_show(SHOW_ID)["name"] == "Sample Show"


def test_existing_empty_shows_folder_is_not_seeded(tmp_path):
    shows_root = tmp_path / "shows"
    shows_root.mkdir()
    scenes = Scenes(tmp_path / "scenes", shows_root=shows_root, shows_seed=SHOWS_SEED)
    assert scenes.list_shows() == []
    assert list(shows_root.iterdir()) == []


def test_existing_shows_folder_is_not_modified(tmp_path):
    shows_root = tmp_path / "shows"
    scenes = Scenes(tmp_path / "existing-scenes", shows_root=shows_root)
    show = scenes.create_show("Existing")
    scene = scenes.create("Existing scene", show_id=show["id"])
    before = {p.relative_to(shows_root): p.read_bytes() for p in shows_root.rglob("*.json")}
    new_root = tmp_path / "new-scenes"
    reopened = Scenes(new_root, shows_root=shows_root, shows_seed=SHOWS_SEED)
    assert new_root.is_dir()
    assert [s["id"] for s in reopened.list()] == [scene["id"]]
    assert {p.relative_to(shows_root): p.read_bytes() for p in shows_root.rglob("*.json")} == before


def test_failed_show_copy_can_be_retried(tmp_path, monkeypatch):
    import libretto.scenes as scenes_module

    copytree = scenes_module.shutil.copytree

    def fail_copy(source, destination):
        destination.mkdir()
        (destination / "partial").write_text("partial", encoding="utf-8")
        raise OSError("copy failed")

    root, shows_root = tmp_path / "scenes", tmp_path / "shows"
    with monkeypatch.context() as patch:
        patch.setattr(scenes_module.shutil, "copytree", fail_copy)
        with pytest.raises(OSError, match="copy failed"):
            Scenes(root, shows_root=shows_root, shows_seed=SHOWS_SEED)
    assert not root.exists() and not shows_root.exists()
    assert scenes_module.shutil.copytree is copytree
    assert len(Scenes(root, shows_root=shows_root, shows_seed=SHOWS_SEED).list()) == 9


@pytest.mark.parametrize("existing_scene", [False, True])
def test_app_seeds_sample_show(tmp_path, existing_scene):
    settings = LB_Settings(
        ComfyUrl="http://fake",
        LibrariesRoot=tmp_path / "libraries",
        ScenesRoot=tmp_path / "scenes",
        ShowsRoot=tmp_path / "shows",
        ProfilesRoot=LB_PROJECT_ROOT / "profiles",
        UserProfilesRoot=tmp_path / "profiles",
        DataRoot=tmp_path / "data",
        ModelsRoot=None,
    )
    if existing_scene:
        Scenes(settings.ScenesRoot, shows_root=settings.EffectiveShowsRoot).create("Existing scene")
    create_app(settings, start_worker=False)
    assert len(Scenes(settings.ScenesRoot, shows_root=settings.EffectiveShowsRoot).list()) == 9 + existing_scene


def test_sample_show_references_and_graphs_are_self_contained(tmp_path):
    library = Libraries(tmp_path / "libs", SAMPLES / "default").get("default")
    profiles = load_profiles(LB_PROJECT_ROOT / "profiles", tmp_path / "profiles")
    show_dir = SHOWS_SEED / SHOW_ID
    show = json.loads((show_dir / "show-outline.json").read_text(encoding="utf-8"))
    scene_ids = [scene_id for act in show["items"] for scene_id in act["scene_ids"]]
    files = list(show_dir.glob("*.scene.json"))
    assert len(scene_ids) == len(set(scene_ids)) == len(files) == 9
    assert {p.name.removesuffix(".scene.json") for p in files} == set(scene_ids)

    for file in files:
        scene = json.loads(file.read_text(encoding="utf-8"))
        assert scene["id"] == file.name.removesuffix(".scene.json")
        graph = scene["graph"]
        assert graph.get("library") == "default"
        nodes = graph["nodes"]
        by_id = {node["id"]: node for node in nodes}
        assert len(by_id) == len(nodes), file.name
        assert all(edge["source"] in by_id and edge["target"] in by_id for edge in graph["edges"]), file.name
        generate = [node for node in nodes if node["type"] == "generate"]
        assert len(generate) == 1
        profile_id = generate[0]["data"]["profile"]
        assert profile_id in profiles
        for node in nodes:
            data = node["data"]
            if owner := data.get("owner"):
                assert owner in by_id and by_id[owner]["type"] == "character" and owner != node["id"]
            if node["type"] not in {"generate", "prompt"}:
                assert node["type"] in library.category_ids()
            if preset_id := data.get("presetId"):
                assert data.get("lib", "default") == "default"
                library.get(node["type"], preset_id)
                assert library.thumb_path(node["type"], preset_id).is_file(), (file.name, preset_id)
        assert compile_graph(graph, library, profiles[profile_id], 0, {}).positive, file.name
