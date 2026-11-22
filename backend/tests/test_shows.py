import json

import pytest

from libretto.scenes import Scenes
from libretto.store import RunStore
from test_api import env, graph  # noqa: F401


def step(scenes, redo=False):
    return scenes.step_history(redo, scenes.history()["revision"])


def test_show_output_settings_persist_and_support_undo_without_moving_files(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("My Show")
    scene = scenes.create("Prologue", show_id=show["id"])
    act = scenes.create_act(show["id"], "Opening")
    one = scenes.create("Arrival", show_id=show["id"], act_id=act["id"])
    two = scenes.create("Arrival", show_id=show["id"], act_id=act["id"])
    second_act = scenes.create_act(show["id"], "Finale")
    last = scenes.create("Curtain", show_id=show["id"], act_id=second_act["id"])
    epilogue = scenes.create("Epilogue", show_id=show["id"])
    files = {path: path.read_bytes() for path in tmp_path.rglob("*.scene.json")}
    scenes.clear_history()
    assert scenes.output_prefix(one["id"]) is None
    scenes.set_output_layout(show["id"], "show_act_scene")
    assert Scenes(scenes.root).get_show(show["id"])["output_layout"] == "show_act_scene"
    expected = ["my-show/01-prologue", "my-show/01-opening/01-arrival",
                "my-show/01-opening/02-arrival", "my-show/02-finale/01-curtain", "my-show/02-epilogue"]
    assert [item["prefix"] for item in scenes.output_preview(show["id"])["examples"]] == expected
    assert [scenes.output_prefix(item["id"]) for item in (scene, one, two, last, epilogue)] == expected
    assert scenes.history()["undo"] == 1
    step(scenes)
    assert "output_layout" not in scenes.get_show(show["id"])
    step(scenes, redo=True)
    assert scenes.output_prefix(one["id"]) == expected[1]
    assert {path: path.read_bytes() for path in tmp_path.rglob("*.scene.json")} == files
    scenes.set_output_layout(show["id"], "show_scene")
    assert [item["prefix"] for item in scenes.output_preview(show["id"])["examples"]] == [
        "my-show/01-prologue", "my-show/02-arrival", "my-show/03-arrival", "my-show/04-curtain", "my-show/05-epilogue"]
    scenes.set_output_layout(show["id"], "workflow")
    assert "output_layout" not in scenes.get_show(show["id"])
    assert scenes.output_prefix(one["id"]) is None


def test_show_output_names_are_literal_portable_and_keep_unicode(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("CON.")
    act = scenes.create_act(show["id"], "../\u65e5\u672c\u8a9e:\u5e55%{scene}")
    scene = scenes.create("Opening / intro", show_id=show["id"], act_id=act["id"])
    scenes.set_output_layout(show["id"], "show_act_scene")
    assert scenes.output_prefix(scene["id"]) == "_con/01-\u65e5\u672c\u8a9e-\u5e55-scene/01-opening-intro"
    scenes.update(scene["id"], names={"en-US": "Different display name"})
    assert scenes.output_prefix(scene["id"]).endswith("/01-opening-intro")
    assert scenes.output_preview(show["id"], "workflow")["examples"][0]["prefix"] is None
    assert scenes.output_prefix(scenes.create("Standalone")["id"]) is None
    assert scenes.output_prefix("unsaved-scene") is None


def test_output_preview_includes_manually_added_show_scenes_and_rejects_invalid_disk_settings(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Show")
    scene = scenes.create("Manually added")
    scenes._file(scene["id"]).replace(scenes.shows_root / show["id"] / f"{scene['id']}.scene.json")
    scenes.set_output_layout(show["id"], "show_scene")
    assert scenes.output_prefix(scene["id"]) == "show/01-manually-added"
    assert scenes.output_preview(show["id"])["examples"] == [
        {"scene_id": scene["id"], "name": scene["name"], "prefix": "show/01-manually-added"}]
    invalid = {**scenes.get_show(show["id"]), "output_layout": "typo"}
    scenes._outline(show["id"]).write_text(json.dumps(invalid), encoding="utf-8")
    with pytest.raises(ValueError, match="invalid show output layout"):
        scenes.output_prefix(scene["id"])


@pytest.mark.parametrize(("layout", "override", "expected"), [
    ("workflow", None, None),
    ("show_scene", "", "my-show/01-arrival"),
    ("show_act_scene", "   ", "my-show/01-opening/01-arrival"),
    ("show_act_scene", "manual/image", "manual/image"),
])
def test_generation_uses_show_layout_but_keeps_explicit_overrides(env, layout, override, expected):
    client, comfy, generator = env
    show = client.post("/api/shows", json={"name": "My Show"}).json()
    act = client.post(f"/api/shows/{show['id']}/acts", json={"name": "Opening"}).json()
    scene = client.post("/api/scenes", json={"name": "Arrival", "show_id": show["id"], "act_id": act["id"]}).json()
    g = {**graph(), "name": "Stale client name"}
    client.post("/api/generate", json={"graph": g, "scene_id": scene["id"]}).raise_for_status()
    original = [n["inputs"]["filename_prefix"] for n in comfy.queued[-1].values() if "filename_prefix" in n["inputs"]]
    assert client.patch(f"/api/shows/{show['id']}/settings", json={"output_layout": layout}).status_code == 200
    g["nodes"][-1]["data"]["output_prefix"] = override
    response = client.post("/api/generate", json={"graph": g, "scene_id": scene["id"]})
    assert response.status_code == 200, response.text
    run = response.json()[0]
    actual = [n["inputs"]["filename_prefix"] for n in comfy.queued[-1].values() if "filename_prefix" in n["inputs"]]
    assert actual and actual == ([expected] * len(actual) if expected is not None else original)
    assert generator.read_snapshot(run["id"])["output"]["prefix"] == expected
    preview = client.get(f"/api/shows/{show['id']}/output-preview", params={"layout": layout}).json()["examples"][0]
    assert preview["scene_id"] == scene["id"]
    if not override or not override.strip():
        assert preview["prefix"] == expected


def test_show_output_changes_only_future_generations_and_validates_settings(env):
    client, _, generator = env
    show = client.post("/api/shows", json={"name": "Show"}).json()
    assert client.get(f"/api/shows/{show['id']}/output-preview").json() == {"examples": []}
    for bad in ("custom", None, {}, 5):
        assert client.patch(f"/api/shows/{show['id']}/settings", json={"output_layout": bad}).status_code == 422
    assert client.get(f"/api/shows/{show['id']}/output-preview?layout=custom").status_code == 422
    assert client.patch("/api/shows/missing/settings", json={"output_layout": "show_scene"}).status_code == 404
    act = client.post(f"/api/shows/{show['id']}/acts", json={"name": "Act"}).json()
    scene = client.post("/api/scenes", json={"name": "Scene", "show_id": show["id"], "act_id": act["id"]}).json()
    client.patch(f"/api/shows/{show['id']}/settings", json={"output_layout": "show_act_scene"})
    old = client.post("/api/generate", json={"graph": graph(), "scene_id": scene["id"]}).json()[0]
    assert generator.read_snapshot(old["id"])["output"]["prefix"] == "show/01-act/01-scene"
    client.post(f"/api/scenes/{scene['id']}/place", json={"show_id": show["id"], "index": 0}).raise_for_status()
    client.patch(f"/api/shows/{show['id']}", json={"name": "Renamed"}).raise_for_status()
    new = client.post("/api/generate", json={"graph": graph(), "scene_id": scene["id"]}).json()[0]
    assert generator.read_snapshot(new["id"])["output"]["prefix"] == "renamed/01-scene"
    assert generator.read_snapshot(old["id"])["output"]["prefix"] == "show/01-act/01-scene"
    rerun = client.post(f"/api/runs/{old['id']}/requeue").json()
    assert generator.read_snapshot(rerun["id"])["output"]["prefix"] == "show/01-act/01-scene"


def test_organization_creation_can_be_undone_and_redone_with_stable_ids(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Show")
    act = scenes.create_act(show["id"], "Act")
    scene = scenes.create("Scene", graph(), show["id"], act["id"])
    original = {p: p.read_bytes() for p in tmp_path.rglob("*.json")}
    for _ in range(3):
        step(scenes)
    assert scenes.list() == scenes.list_shows() == []
    assert scenes.history()["undo"] == 0
    for _ in range(3):
        step(scenes, redo=True)
    assert {p: p.read_bytes() for p in tmp_path.rglob("*.json")} == original
    assert scenes.get_show(show["id"])["items"][0]["scene_ids"] == [scene["id"]]


def test_organization_undo_keeps_later_graph_edits_and_editor_redo(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    scene = scenes.create("Original", graph())
    scenes.clear_history()
    scenes.update(scene["id"], name="Renamed", names={"ja-JP": "Translated"})
    edited = {**graph(), "scene_prompt": "Keep this edit"}
    scenes.update(scene["id"], graph=edited)
    assert scenes.history()["undo"] == 1
    step(scenes)
    assert scenes.get(scene["id"])["name"] == "Original"
    assert "names" not in scenes.get(scene["id"])
    assert scenes.get(scene["id"])["graph"] == edited
    scenes.update(scene["id"], graph={**edited, "scene_negative": "Still editing"})
    assert scenes.history()["redo"] == 1
    step(scenes, redo=True)
    assert scenes.get(scene["id"])["names"] == {"ja-JP": "Translated"}
    assert scenes.get(scene["id"])["graph"]["scene_negative"] == "Still editing"
    step(scenes)
    scenes.rename_show(scenes.create_show("New")["id"], "Different")
    assert scenes.history()["redo"] == 0


@pytest.mark.parametrize("kind", ["scene", "act", "show", "standalone"])
def test_undo_redo_moves_and_ordering_preserve_scene_edits(tmp_path, kind):
    scenes = Scenes(tmp_path / "scenes")
    first, second = scenes.create_show("First"), scenes.create_show("Second")
    act = scenes.create_act(first["id"], "Act")
    one = scenes.create("One", show_id=first["id"], act_id=act["id"])
    two = scenes.create("Two")
    scenes.clear_history()
    before_shows, before_scenes = scenes.list_shows(), scenes.list()
    if kind == "scene":
        scenes.place_scene(one["id"], second["id"])
    elif kind == "act":
        scenes.place_act(first["id"], act["id"], second["id"])
    elif kind == "show":
        scenes.place_show(second["id"], 0)
    else:
        scenes.place_scene(one["id"], index=0)
    after_shows = scenes.list_shows()
    edited = {**graph(), "scene_prompt": "Edited after moving"}
    scenes.update(one["id"], graph=edited)
    step(scenes)
    assert scenes.list_shows() == before_shows
    for original in before_scenes:
        current = next(s for s in scenes.list() if s["id"] == original["id"])
        assert {k: v for k, v in current.items() if k != "updated_at"} == {
            k: v for k, v in original.items() if k != "updated_at"
        }
    assert scenes.get(one["id"])["graph"] == edited
    step(scenes, redo=True)
    assert scenes.list_shows() == after_shows
    assert scenes.get(one["id"])["graph"] == edited
    assert scenes.get(two["id"])["name"] == "Two"


def test_act_copy_is_one_step_and_redo_restores_edited_copies(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Show")
    act = scenes.create_act(show["id"], "Act")
    original = scenes.create("Original", graph(), show["id"], act["id"])
    scenes.clear_history()
    duplicate = scenes.place_act(show["id"], act["id"], show["id"], copy_act=True)
    copied_id = duplicate["scene_ids"][0]
    edited = {**graph(), "scene_prompt": "Copy edits"}
    scenes.update(copied_id, graph=edited)
    assert scenes.history()["undo"] == 1
    step(scenes)
    assert [s["id"] for s in scenes.list()] == [original["id"]]
    step(scenes, redo=True)
    assert scenes.get(copied_id)["graph"] == edited
    assert scenes.get_show(show["id"])["items"][1]["id"] == duplicate["id"]


def test_standalone_reordering_undo_restores_absent_order_metadata(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    one, two = scenes.create("One"), scenes.create("Two")
    scenes.clear_history()
    scenes.place_scene(one["id"], index=0)
    assert scenes.get(one["id"])["order"] == 0
    assert scenes.get(two["id"])["order"] == 1
    step(scenes)
    assert all("order" not in scenes.get(sid) for sid in (one["id"], two["id"]))
    step(scenes, redo=True)
    assert scenes.get(one["id"])["order"] == 0
    assert scenes.get(two["id"])["order"] == 1


def test_undo_rejects_stale_requests_and_external_changes_without_overwriting(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Original")
    stale = scenes.history()["revision"]
    scenes.rename_show(show["id"], "Renamed")
    with pytest.raises(ValueError, match="history changed"):
        scenes.step_history(False, stale)
    path = scenes._outline(show["id"])
    external = {**scenes.get_show(show["id"]), "name": "External edit"}
    path.write_text(json.dumps(external), encoding="utf-8")
    history = scenes.history()
    with pytest.raises(ValueError, match="changed on disk"):
        step(scenes)
    assert scenes.get_show(show["id"]) == external
    assert scenes.history() == history


def test_failed_undo_keeps_history_and_rolls_back_files(tmp_path, monkeypatch):
    from pathlib import Path

    scenes = Scenes(tmp_path / "scenes")
    scene = scenes.create("Scene")
    show = scenes.create_show("Show")
    scenes.place_scene(scene["id"], show["id"])
    before = {p: p.read_bytes() for p in tmp_path.rglob("*.json")}
    history = scenes.history()
    replace = Path.replace

    def fail_restore(path, target):
        if target.parent == scenes.root:
            raise OSError("disk full")
        return replace(path, target)

    monkeypatch.setattr(Path, "replace", fail_restore)
    with pytest.raises(OSError, match="disk full"):
        step(scenes)
    assert scenes.history() == history
    assert {p: p.read_bytes() for p in tmp_path.rglob("*.json")} == before


def test_delete_undo_restores_scene_and_snapshots_without_deleting_outputs(env):
    client, comfy, generator = env
    scene = client.post("/api/scenes", json={"name": "Scene", "graph": graph()}).json()
    sid = scene["id"]
    run = client.post("/api/generate", json={"graph": graph(), "scene_id": sid}).json()[0]
    generator.scene_snaps.set_thumbnail(sid, 1, comfy.view("", "", ""))
    snapshot_root = generator.scene_snaps.root / sid
    snapshots = {p: p.read_bytes() for p in snapshot_root.iterdir()}
    assert client.delete(f"/api/scenes/{sid}").status_code == 200
    assert not list(snapshot_root.iterdir())
    history = client.get("/api/organization/history").json()
    assert client.post("/api/organization/history/undo", json={"revision": history["revision"]}).status_code == 200
    assert client.get(f"/api/scenes/{sid}").json()["graph"] == graph()
    assert {p: p.read_bytes() for p in snapshot_root.iterdir()} == snapshots
    assert client.get(f"/api/runs/{run['id']}").json()["scene_id"] == sid
    generator.scene_snaps.set_name(sid, 1, "Later history edit")
    snapshots = {p: p.read_bytes() for p in snapshot_root.iterdir()}
    history = client.get("/api/organization/history").json()
    assert client.post("/api/organization/history/redo", json={"revision": history["revision"]}).status_code == 200
    assert client.get(f"/api/scenes/{sid}").status_code == 404
    assert not list(snapshot_root.iterdir())
    history = client.get("/api/organization/history").json()
    assert client.post("/api/organization/history/undo", json={"revision": history["revision"]}).status_code == 200
    assert {p: p.read_bytes() for p in snapshot_root.iterdir()} == snapshots


@pytest.mark.parametrize("kind", ["show", "act"])
def test_delete_hierarchy_is_one_reversible_change_and_keeps_outputs(env, kind):
    client, _, generator = env
    show = client.post("/api/shows", json={"name": "Show"}).json()
    act = client.post(f"/api/shows/{show['id']}/acts", json={"name": "Act"}).json()
    first = client.post("/api/scenes", json={"name": "First", "graph": graph(), "show_id": show["id"], "act_id": act["id"]}).json()
    second = client.post("/api/scenes", json={"name": "Direct", "graph": graph(), "show_id": show["id"]}).json()
    run = client.post("/api/generate", json={"graph": graph(), "scene_id": first["id"]}).json()[0]
    saved = generator.scene_snaps.root / first["id"]
    before = {p: p.read_bytes() for p in saved.rglob("*") if p.is_file()}
    assert before
    other = client.post("/api/shows", json={"name": "Other"}).json()
    other_scene = client.post("/api/scenes", json={"name": "Keep", "show_id": other["id"]}).json()
    history = client.get("/api/organization/history").json()
    endpoint = f"/api/shows/{show['id']}" + (f"/acts/{act['id']}" if kind == "act" else "") + "/hierarchy"
    expected = {"scene_ids": [first["id"]] + ([second["id"]] if kind == "show" else []), "act_ids": [act["id"]]}
    response = client.request("DELETE", endpoint, json=expected)
    assert response.status_code == 200
    assert response.json()["history"] == client.get("/api/organization/history").json()
    history_id = response.json()["history_id"]
    assert client.get("/api/organization/history").json()["undo"] == history["undo"] + 1
    assert client.get(f"/api/scenes/{first['id']}").status_code == 404
    assert client.get(f"/api/scenes/{second['id']}").status_code == (200 if kind == "act" else 404)
    assert client.get(f"/api/scenes/{other_scene['id']}").status_code == 200
    assert not [p for p in saved.rglob("*") if p.is_file()]
    assert client.get(f"/api/runs/{run['id']}").json()["scene_id"] == first["id"]
    assert generator.read_snapshot(run["id"])["scene_id"] == first["id"]
    revision = client.get("/api/organization/history").json()["revision"]
    assert client.post("/api/organization/history/undo", json={"revision": revision, "history_id": "previous-server"}).status_code == 400
    assert client.post("/api/organization/history/undo", json={"revision": revision, "history_id": history_id}).status_code == 200
    assert client.get(f"/api/scenes/{first['id']}").json()["graph"] == graph()
    assert {p: p.read_bytes() for p in saved.rglob("*") if p.is_file()} == before
    restored = client.get("/api/shows").json()
    assert next(item for item in restored if item["id"] == show["id"]) == show | {
        "items": [dict(act, scene_ids=[first["id"]]), {"kind": "scene", "id": second["id"]}]}
    revision = client.get("/api/organization/history").json()["revision"]
    assert client.post("/api/organization/history/redo", json={"revision": revision}).status_code == 200
    assert client.get(f"/api/scenes/{first['id']}").status_code == 404
    assert client.get(f"/api/runs/{run['id']}").status_code == 200


def test_delete_show_hierarchy_includes_unlisted_scenes_but_keeps_other_files(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Show")
    scene = scenes.create("Unlisted")
    destination = scenes.shows_root / show["id"] / f"{scene['id']}.scene.json"
    scenes._file(scene["id"]).replace(destination)
    extra = destination.parent / "notes.txt"
    extra.write_text("Keep", encoding="utf-8")
    scenes.clear_history()
    scenes.delete_hierarchy(show["id"])
    assert not destination.exists()
    assert extra.read_text(encoding="utf-8") == "Keep"
    step(scenes)
    assert scenes.get(scene["id"])["name"] == "Unlisted"
    assert extra.read_text(encoding="utf-8") == "Keep"


@pytest.mark.parametrize("kind", ["show", "act"])
def test_delete_hierarchy_rejects_stale_confirmation(env, kind):
    client, _, _ = env
    show = client.post("/api/shows", json={"name": "Show"}).json()
    act = client.post(f"/api/shows/{show['id']}/acts", json={"name": "Act"}).json()
    endpoint = f"/api/shows/{show['id']}" + (f"/acts/{act['id']}" if kind == "act" else "") + "/hierarchy"
    expected = {"scene_ids": [], "act_ids": [act["id"]]}
    scene = client.post("/api/scenes", json={"name": "New", "show_id": show["id"], "act_id": act["id"]}).json()
    history = client.get("/api/organization/history").json()
    response = client.request("DELETE", endpoint, json=expected)
    assert response.status_code == 400
    assert "hierarchy changed" in response.json()["detail"]
    assert client.get(f"/api/scenes/{scene['id']}").status_code == 200
    assert client.get("/api/organization/history").json() == history
    if kind == "show":
        extra = client.post(f"/api/shows/{show['id']}/acts", json={"name": "New act"}).json()
        expected["scene_ids"] = [scene["id"]]
        assert client.request("DELETE", endpoint, json=expected).status_code == 400
        assert any(i["id"] == extra["id"] for i in client.get("/api/shows").json()[0]["items"])


@pytest.mark.parametrize("kind", ["show", "act"])
def test_delete_hierarchy_refuses_missing_or_misplaced_scene_without_changes(tmp_path, kind):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Show")
    act = scenes.create_act(show["id"], "Act")
    scene = scenes.create("Scene", show_id=show["id"], act_id=act["id"])
    scenes.root.mkdir(parents=True, exist_ok=True)
    scenes._file(scene["id"]).replace(scenes.root / f"{scene['id']}.json")
    before = scenes._outline(show["id"]).read_bytes()
    history = scenes.history()
    with pytest.raises(ValueError, match="missing"):
        scenes.delete_hierarchy(show["id"], act["id"] if kind == "act" else None)
    assert scenes._outline(show["id"]).read_bytes() == before
    assert scenes.get(scene["id"])["name"] == "Scene"
    assert scenes.history() == history


def test_delete_hierarchy_rolls_back_after_disk_error(tmp_path, monkeypatch):
    from pathlib import Path

    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Show")
    first = scenes.create("One", show_id=show["id"])
    second = scenes.create("Two", show_id=show["id"])
    before = {p: p.read_bytes() for p in tmp_path.rglob("*.json")}
    history = scenes.history()
    unlink = Path.unlink
    failed = False

    def fail_once(path, *args, **kwargs):
        nonlocal failed
        if path.name == f"{second['id']}.scene.json" and not failed:
            failed = True
            raise OSError("disk full")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_once)
    with pytest.raises(OSError, match="disk full"):
        scenes.delete_hierarchy(show["id"])
    assert {p: p.read_bytes() for p in tmp_path.rglob("*.json")} == before
    assert scenes.get(first["id"])["name"] == "One"
    assert scenes.history() == history


def test_standalone_scenes_are_not_relocated_and_shows_are_self_contained(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    root = scenes.create("Standalone")
    original = (scenes.root / f"{root['id']}.json").read_bytes()
    show = scenes.create_show("A Show")
    act = scenes.create_act(show["id"], "Act I")
    direct = scenes.create("Opening", show_id=show["id"])
    nested = scenes.create("Arrival", graph(), show["id"], act["id"])
    folder = scenes.shows_root / show["id"]
    assert {p.name for p in folder.iterdir()} == {
        "show-outline.json", f"{direct['id']}.scene.json", f"{nested['id']}.scene.json",
    }
    assert (scenes.root / f"{root['id']}.json").read_bytes() == original
    metadata = {s["id"]: s for s in scenes.list()}
    assert metadata[root["id"]]["show_id"] is None
    assert metadata[direct["id"]]["show_id"] == show["id"]
    assert metadata[nested["id"]]["act_id"] == act["id"]
    # A copied show folder is discoverable without a separate global registry.
    reopened = Scenes(tmp_path / "scenes")
    assert reopened.get(nested["id"])["graph"] == graph()
    assert reopened.list_shows() == scenes.list_shows()


def test_move_and_copy_scenes_between_shows_acts_and_standalone(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    first, second = scenes.create_show("First"), scenes.create_show("Second")
    act = scenes.create_act(first["id"], "Act I")
    scene = scenes.create("Scene", graph())
    sid = scene["id"]
    scenes.place_scene(sid, first["id"], act["id"])
    assert scenes.get_show(first["id"])["items"][0]["scene_ids"] == [sid]
    assert not (scenes.root / f"{sid}.json").exists()
    copied = scenes.place_scene(sid, second["id"], copy_scene=True)
    assert copied["id"] != sid
    assert copied["graph"] == scene["graph"]
    assert scenes.get(sid)["name"] == "Scene"
    moved = scenes.place_scene(sid, second["id"])
    assert moved["id"] == sid
    assert scenes.get_show(first["id"])["items"][0]["scene_ids"] == []
    assert not (scenes.shows_root / first["id"] / f"{sid}.scene.json").exists()
    scenes.place_scene(sid)
    assert (scenes.root / f"{sid}.json").exists()
    assert scenes.get_show(second["id"])["items"] == [{"kind": "scene", "id": copied["id"]}]


def test_act_move_copy_and_ordering_preserve_originals(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    first, second = scenes.create_show("First"), scenes.create_show("Second")
    act = scenes.create_act(first["id"], "Act")
    one = scenes.create("One", show_id=first["id"], act_id=act["id"])
    two = scenes.create("Two", show_id=first["id"], act_id=act["id"])
    scenes.place_scene(two["id"], first["id"], act["id"], index=0)
    expected = [two["id"], one["id"]]
    assert scenes.get_show(first["id"])["items"][0]["scene_ids"] == expected
    duplicate = scenes.place_act(first["id"], act["id"], first["id"], copy_act=True)
    assert duplicate["id"] != act["id"]
    assert len(set(duplicate["scene_ids"]) | set(expected)) == 4
    assert [scenes.get(s)["name"] for s in duplicate["scene_ids"]] == ["Two", "One"]
    moved = scenes.place_act(first["id"], act["id"], second["id"])
    assert moved["id"] == act["id"]
    assert moved["scene_ids"] == expected
    assert all(s["show_id"] == second["id"] for s in scenes.list() if s["id"] in expected)
    scenes.place_act(first["id"], duplicate["id"], second["id"], index=0)
    assert [a["id"] for a in scenes.get_show(second["id"])["items"]] == [duplicate["id"], act["id"]]


def test_invalid_operations_do_not_change_files_and_delete_removes_references(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Show")
    act = scenes.create_act(show["id"], "Act")
    scene = scenes.create("Scene", show_id=show["id"], act_id=act["id"])
    before = {p: p.read_bytes() for p in tmp_path.rglob("*.json")}
    for action in [
        lambda: scenes.place_scene(scene["id"], show["id"], "missing"),
        lambda: scenes.place_scene(scene["id"], show["id"], index=99),
        lambda: scenes.place_scene(scene["id"], act_id=act["id"]),
        lambda: scenes.place_scene(scene["id"], "../outside"),
        lambda: scenes.delete_group(show["id"]),
        lambda: scenes.delete_group(show["id"], act["id"]),
        lambda: scenes.place_act(show["id"], act["id"], None),
    ]:
        with pytest.raises((ValueError, FileNotFoundError)):
            action()
        assert {p: p.read_bytes() for p in tmp_path.rglob("*.json")} == before
    scenes.delete(scene["id"])
    assert scenes.get_show(show["id"])["items"][0]["scene_ids"] == []
    scenes.delete_group(show["id"], act["id"])
    scenes.delete_group(show["id"])
    assert scenes.list_shows() == []


def test_failed_cross_show_move_rolls_back(tmp_path, monkeypatch):
    from pathlib import Path

    scenes = Scenes(tmp_path / "scenes")
    first, second = scenes.create_show("First"), scenes.create_show("Second")
    scene = scenes.create("Scene", show_id=first["id"])
    original = {p: p.read_bytes() for p in tmp_path.rglob("*.json")}
    replace = Path.replace

    def fail_destination(path, target):
        if target.name == f"{scene['id']}.scene.json" and target.parent.name == second["id"]:
            raise OSError("disk full")
        return replace(path, target)

    monkeypatch.setattr(Path, "replace", fail_destination)
    with pytest.raises(OSError, match="disk full"):
        scenes.place_scene(scene["id"], second["id"])
    assert {p: p.read_bytes() for p in tmp_path.rglob("*.json")} == original
    assert not list(tmp_path.rglob("*.tmp"))


def test_reorganizing_inside_a_show_only_changes_the_outline(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Show")
    act = scenes.create_act(show["id"], "Act")
    scene = scenes.create("Scene", show_id=show["id"])
    path = scenes._file(scene["id"])
    content, mtime = path.read_bytes(), path.stat().st_mtime_ns
    scenes.place_scene(scene["id"], show["id"], act["id"])
    assert path.read_bytes() == content
    assert path.stat().st_mtime_ns == mtime
    scenes.place_scene(scene["id"])
    assert scenes._file(scene["id"]).read_bytes() == content


def test_merge_restore_rejects_relocated_scene_ids_without_creating_duplicates(env):
    client, _, _ = env
    show = client.post("/api/shows", json={"name": "Show"}).json()
    scene = client.post("/api/scenes", json={"name": "Scene"}).json()
    backup = client.post("/api/backups", json={}).json()
    client.post(f"/api/scenes/{scene['id']}/place", json={"show_id": show["id"]})
    restored = client.post(f"/api/backups/{backup['id']}/restore", json={"mode": "merge"})
    assert restored.status_code == 400
    assert "another location" in restored.json()["detail"]
    assert len(client.get("/api/scenes").json()) == 1


def test_generation_ownership_survives_moves_requeues_and_backup_restore(env):
    client, _, generator = env
    show = client.post("/api/shows", json={"name": "Show"}).json()
    act = client.post(f"/api/shows/{show['id']}/acts", json={"name": "Act"}).json()
    scene = client.post("/api/scenes", json={"name": "Scene", "graph": graph()}).json()
    sid = scene["id"]
    run = client.post("/api/generate", json={"graph": graph(), "scene_id": sid}).json()[0]
    assert run["scene_id"] == sid
    response = client.post(f"/api/scenes/{sid}/place", json={"show_id": show["id"], "act_id": act["id"]})
    assert response.status_code == 200
    assert client.get("/api/scenes").json()[0]["act_id"] == act["id"]
    assert client.get(f"/api/runs/{run['id']}").json()["scene_id"] == sid
    copy = client.post(f"/api/scenes/{sid}/place", json={"show_id": show["id"], "copy": True}).json()
    assert client.get(f"/api/scenes/{copy['id']}/snaps").json()["items"] == []
    rerun = client.post(f"/api/runs/{run['id']}/requeue").json()
    assert rerun["scene_id"] == sid
    assert {r["scene_id"] for r in client.get("/api/runs?limit=0").json()} == {sid}
    backup = client.post("/api/backups", json={}).json()
    assert backup["counts"]["shows"] == 3  # outline and two scenes
    client.post(f"/api/scenes/{sid}/place", json={})
    restored = client.post(f"/api/backups/{backup['id']}/restore", json={"mode": "replace"})
    assert restored.status_code == 200
    assert client.get("/api/organization/history").json()["undo"] == 0
    assert next(s for s in client.get("/api/scenes").json() if s["id"] == sid)["show_id"] == show["id"]
    assert client.get(f"/api/scenes/{sid}").json()["graph"] == graph()


def test_ownership_does_not_depend_on_successful_history_snapshot(env, monkeypatch):
    client, _, generator = env
    monkeypatch.setattr(generator.scene_snaps, "record", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
    run = client.post("/api/generate", json={"graph": graph(), "scene_id": "s1"}).json()[0]
    assert run["scene_id"] == "s1"
    assert client.post(f"/api/runs/{run['id']}/requeue").json()["scene_id"] == "s1"


def test_old_runs_recover_only_explicit_scene_ids(tmp_path):
    store = RunStore(tmp_path / "runs.db")
    store.insert({"id": "known", "created_at": "2026", "status": "done", "prompt_id": None, "profile": "p", "seed": 1, "positive": ""})
    store.insert({"id": "unknown", "created_at": "2026", "status": "done", "prompt_id": None, "profile": "p", "seed": 1, "positive": ""})
    folder = tmp_path / "snapshots" / "known"
    folder.mkdir(parents=True)
    (folder / "snapshot.json").write_text(json.dumps({"scene": {"id": "s1", "version": 1}}))
    store.index_scene_ids(tmp_path / "snapshots")
    assert store.get("known")["scene_id"] == "s1"
    assert store.get("unknown")["scene_id"] is None


def test_output_listing_can_include_runs_beyond_the_previous_thousand_limit(env):
    client, _, generator = env
    generator.store.import_rows([
        {"id": f"run-{i}", "created_at": f"2026-{i:04}", "status": "done", "scene_id": "s1"}
        for i in range(1003)
    ])
    assert len(client.get("/api/runs").json()) == 100
    assert len(client.get("/api/runs?limit=0").json()) == 1003
    assert client.get("/api/runs?limit=-1").status_code == 422


def test_show_order_is_persistent_and_new_shows_append(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    shows = [scenes.create_show(name) for name in ("One", "Two", "Three")]
    scene = scenes.create("Scene", show_id=shows[0]["id"])
    content = scenes._file(scene["id"]).read_bytes()
    scenes.place_show(shows[0]["id"], 2)
    reopened = Scenes(tmp_path / "scenes")
    assert [s["name"] for s in reopened.list_shows()] == ["Two", "Three", "One"]
    reopened.create_show("Four")
    reopened.place_show(shows[2]["id"], 0)
    assert [s["name"] for s in reopened.list_shows()] == ["Three", "Two", "One", "Four"]
    assert reopened._file(scene["id"]).read_bytes() == content
    before = [reopened.get_show(s["id"]) for s in reopened.list_shows()]
    with pytest.raises(ValueError):
        reopened.place_show(shows[0]["id"], 99)
    assert reopened.list_shows() == before


def test_standalone_reordering_survives_edits_copies_and_reload(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    a, b, c = [scenes.create(name) for name in ("A", "B", "C")]

    def order():
        return [s["name"] for s in sorted(
            (s for s in Scenes(scenes.root).list() if not s["show_id"]),
            key=lambda s: s["order"] if s["order"] is not None else 0,
        )]

    scenes.place_scene(a["id"], index=0)
    assert order() == ["A", "C", "B"]
    scenes.update(a["id"], graph={"nodes": [], "edges": []})
    assert order() == ["A", "C", "B"]
    scenes.place_scene(c["id"], index=2)
    assert order() == ["A", "B", "C"]
    copy = scenes.place_scene(a["id"], copy_scene=True, name="Copy", index=1)
    assert copy["id"] != a["id"]
    assert order() == ["A", "Copy", "B", "C"]
    scenes.create("New")
    assert order() == ["New", "A", "Copy", "B", "C"]
    before = {p: p.read_bytes() for p in tmp_path.rglob("*.json")}
    with pytest.raises(ValueError):
        scenes.place_scene(b["id"], index=99)
    assert {p: p.read_bytes() for p in tmp_path.rglob("*.json")} == before


def test_drop_next_to_an_unlisted_scene_materializes_only_the_outline(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    show = scenes.create_show("Show")
    act = scenes.create_act(show["id"], "Act")
    path = scenes.shows_root / show["id"] / "s-external.scene.json"
    content = json.dumps({"id": "s-external", "name": "External", "graph": {"nodes": [], "edges": []}})
    path.write_text(content, encoding="utf-8")
    assert scenes.get_show(show["id"])["items"] == [act]
    root = scenes.create("Root")
    scenes.place_scene(root["id"], show["id"], index=2)
    assert [i["id"] for i in scenes.get_show(show["id"])["items"]] == [act["id"], "s-external", root["id"]]
    assert path.read_text(encoding="utf-8") == content


def test_show_reorder_endpoint(env):
    client, _, _ = env
    one = client.post("/api/shows", json={"name": "One"}).json()
    two = client.post("/api/shows", json={"name": "Two"}).json()
    assert client.post(f"/api/shows/{two['id']}/place", json={"index": 0}).status_code == 200
    assert [s["id"] for s in client.get("/api/shows").json()] == [two["id"], one["id"]]
    assert client.post(f"/api/shows/{one['id']}/place", json={"index": -1}).status_code == 422


def test_move_multiple_outline_items_is_one_undoable_change(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    root = scenes.create("Root")
    one = scenes.create_show("One")
    act = scenes.create_act(one["id"], "Act")
    child = scenes.create("Child", graph(), one["id"], act["id"])
    direct = scenes.create("Direct", graph(), one["id"])
    two = scenes.create_show("Two")
    anchor = scenes.create_act(two["id"], "Anchor")
    scenes.clear_history()
    before = {p: p.read_bytes() for p in tmp_path.rglob("*.json")}
    items = [
        {"kind": "scene", "id": root["id"], "show_id": None, "act_id": None},
        {"kind": "act", "id": act["id"], "show_id": one["id"], "act_id": None},
        {"kind": "scene", "id": child["id"], "show_id": one["id"], "act_id": act["id"]},
        {"kind": "scene", "id": direct["id"], "show_id": one["id"], "act_id": None},
    ]
    target = {"kind": "act", "id": anchor["id"], "show_id": two["id"], "act_id": None}
    scenes.move_outline(items, target, "before", scenes.history()["revision"])
    assert [i["id"] for i in scenes.get_show(two["id"])["items"]] == [
        root["id"], act["id"], direct["id"], anchor["id"]]
    assert scenes.get_show(two["id"])["items"][1]["scene_ids"] == [child["id"]]
    assert scenes.get_show(one["id"])["items"] == []
    assert all(scenes._file(sid).parent.name == two["id"] for sid in (root["id"], child["id"], direct["id"]))
    assert scenes.history()["undo"] == 1
    step(scenes)
    assert {p: p.read_bytes() for p in tmp_path.rglob("*.json")} == before
    step(scenes, redo=True)
    assert [i["id"] for i in scenes.get_show(two["id"])["items"]] == [
        root["id"], act["id"], direct["id"], anchor["id"]]


def test_move_scenes_across_acts_and_standalone_keeps_order(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    one = scenes.create_show("One")
    act = scenes.create_act(one["id"], "Act")
    a = scenes.create("A", graph(), one["id"], act["id"])
    b = scenes.create("B", graph(), one["id"])
    root = scenes.create("Root")
    scenes.clear_history()
    items = [
        {"kind": "scene", "id": a["id"], "show_id": one["id"], "act_id": act["id"]},
        {"kind": "scene", "id": b["id"], "show_id": one["id"], "act_id": None},
    ]
    scenes.move_outline(items, {"kind": "standalone", "id": None}, "inside", scenes.history()["revision"])
    order = sorted((s for s in scenes.list() if not s["show_id"]), key=lambda s: s["order"])
    assert [s["id"] for s in order] == [root["id"], a["id"], b["id"]]
    step(scenes)
    assert scenes.get_show(one["id"])["items"][0]["scene_ids"] == [a["id"]]
    assert scenes._file(b["id"]).parent.name == one["id"]


def test_move_outline_validates_revision_destinations_and_source_membership(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    first, second, third = [scenes.create_show(name) for name in ("First", "Second", "Third")]
    act = scenes.create_act(first["id"], "Act")
    child = scenes.create("Child", graph(), first["id"], act["id"])
    scenes.clear_history()
    show_items = [{"kind": "show", "id": show["id"]} for show in (first, third)]
    target = {"kind": "show", "id": second["id"]}
    revision = scenes.history()["revision"]
    before = {p: p.read_bytes() for p in tmp_path.rglob("*.json")}
    with pytest.raises(ValueError, match="history changed"):
        scenes.move_outline(show_items, target, "after", revision - 1)
    with pytest.raises(ValueError, match="own selection"):
        scenes.move_outline(show_items, {"kind": "scene", "id": child["id"],
                                        "show_id": first["id"], "act_id": act["id"]}, "before", revision)
    with pytest.raises(ValueError, match="outline changed"):
        scenes.move_outline([{"kind": "scene", "id": child["id"], "show_id": second["id"], "act_id": None}],
                            target, "inside", revision)
    assert {p: p.read_bytes() for p in tmp_path.rglob("*.json")} == before
    scenes.move_outline(show_items, target, "after", revision)
    assert [s["id"] for s in scenes.list_shows()] == [second["id"], first["id"], third["id"]]
    step(scenes)
    assert [s["id"] for s in scenes.list_shows()] == [first["id"], second["id"], third["id"]]


def test_move_outline_endpoint_rejects_stale_revision(env):
    client, _, _ = env
    one = client.post("/api/shows", json={"name": "One"}).json()
    two = client.post("/api/shows", json={"name": "Two"}).json()
    revision = client.get("/api/organization/history").json()["revision"]
    history_id = client.get("/api/organization/history").json()["history_id"]
    body = {"items": [{"kind": "show", "id": one["id"]}], "target": {"kind": "show", "id": two["id"]},
            "position": "after", "revision": revision - 1, "history_id": history_id}
    assert client.post("/api/organization/move", json=body).status_code == 400
    body["revision"] = revision
    body["history_id"] = "previous-server"
    assert client.post("/api/organization/move", json=body).status_code == 400
    body["history_id"] = history_id
    assert client.post("/api/organization/move", json=body).status_code == 200
    assert [s["id"] for s in client.get("/api/shows").json()] == [two["id"], one["id"]]


def test_move_multiple_scenes_into_act_preserves_order_and_later_edits(tmp_path):
    scenes = Scenes(tmp_path / "scenes")
    one = scenes.create_show("One")
    source = scenes.create_act(one["id"], "Source")
    a = scenes.create("A", graph(), one["id"], source["id"])
    b = scenes.create("B", graph(), one["id"])
    two = scenes.create_show("Two")
    destination = scenes.create_act(two["id"], "Destination")
    anchor = scenes.create("Anchor", graph(), two["id"], destination["id"])
    scenes.clear_history()
    items = [
        {"kind": "scene", "id": a["id"], "show_id": one["id"], "act_id": source["id"]},
        {"kind": "scene", "id": b["id"], "show_id": one["id"], "act_id": None},
    ]
    target = {"kind": "scene", "id": anchor["id"], "show_id": two["id"], "act_id": destination["id"]}
    scenes.move_outline(items, target, "before", scenes.history()["revision"])
    assert scenes.get_show(two["id"])["items"][0]["scene_ids"] == [a["id"], b["id"], anchor["id"]]
    edited = {**graph(), "scene_prompt": "Keep this edit"}
    scenes.update(a["id"], graph=edited)
    step(scenes)
    assert scenes.get(a["id"])["graph"] == edited
    assert scenes.get_show(one["id"])["items"][0]["scene_ids"] == [a["id"]]
    step(scenes, redo=True)
    assert scenes.get(a["id"])["graph"] == edited
    assert scenes.get_show(two["id"])["items"][0]["scene_ids"] == [a["id"], b["id"], anchor["id"]]
