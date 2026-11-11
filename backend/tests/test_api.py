import io
import json
import re
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from libretto.config import LB_PROJECT_ROOT, LB_Settings
from libretto.main import create_app


class FakeComfy:
    def __init__(self):
        self.queued = []
        self.done = False

    def queue_prompt(self, workflow, client_id):
        self.queued.append(workflow)
        return f"prompt-{len(self.queued)}"

    def history(self, prompt_id):
        if not self.done:
            return None
        return {
            "status": {
                "status_str": "success",
                "messages": [["execution_start", {"timestamp": 1000}], ["execution_success", {"timestamp": 4500}]],
            },
            "outputs": {"9": {"images": [{"filename": "Libretto_00001_.png", "subfolder": "", "type": "output"}]}},
        }

    def queue_state(self):
        return {"queue_running": [[0, "prompt-1", {}]], "queue_pending": []}

    def delete_queued(self, ids):
        self.deleted = list(ids)

    def interrupt(self):
        self.interrupted = True

    def view(self, filename, subfolder, folder_type):
        buffer = io.BytesIO()
        Image.new("RGB", (512, 768), "blue").save(buffer, "PNG")
        return buffer.getvalue()

    def system_stats(self):
        return {"system": {"comfyui_version": "0.0-test", "pytorch_version": "2.x"}, "devices": [{"name": "TestGPU"}]}


@pytest.fixture
def env(tmp_path):
    libraries = tmp_path / "libraries"
    shutil.copytree(Path(__file__).parent / "fixtures" / "library", libraries / "default", ignore=shutil.ignore_patterns("*.webp"))
    (tmp_path / "scenes").mkdir()  # an existing scenes folder is never seeded with the sample scenes
    settings = LB_Settings(
        ComfyUrl="http://fake",
        LibrariesRoot=libraries,
        ScenesRoot=tmp_path / "scenes",
        ProfilesRoot=LB_PROJECT_ROOT / "profiles",
        UserProfilesRoot=tmp_path / "profiles",
        DataRoot=tmp_path / "data",
        ModelsRoot=None,
    )
    comfy = FakeComfy()
    app = create_app(settings, comfy, start_worker=False)
    return TestClient(app), comfy, app.state.generator


def graph(profile="sdxl", **generate_data):
    return {
        "nodes": [
            {"id": "c", "type": "character", "data": {"keywords": "nancy, brown hair"}},
            {
                "id": "k",
                "type": "collection",
                "data": {"category": "costume", "mode": "random", "filter_labels": ["casual"]},
            },
            {"id": "g", "type": "generate", "data": {"profile": profile, "batch": 1, **generate_data}},
        ],
        "edges": [{"source": "c", "target": "g"}, {"source": "k", "target": "g"}],
    }


def test_tag_compile_orders_by_profile(env):
    client, _, _ = env
    body = client.post("/api/compile", json={"graph": graph()}).json()
    assert body["positive"].startswith("masterpiece, best quality, nancy, brown hair, ")
    assert body["picks"][0]["item_id"] in {"white-onepiece", "denim-jacket"}
    assert "worst quality" in body["negative"]


def test_prompt_order_prepend_append(env):
    client, _, _ = env

    def fixed(**data):
        return {
            "nodes": [
                {"id": "c", "type": "character", "position": {"x": 500, "y": 0}, "data": {"keywords": "AAA"}},
                {"id": "k", "type": "costume", "position": {"x": 0, "y": 400}, "data": {"keywords": "BBB"}},
                {"id": "g", "type": "generate", "data": {"profile": "sdxl", **data}},
            ],
            "edges": [{"source": "c", "target": "g"}, {"source": "k", "target": "g"}],
        }

    def positive(**data):
        return client.post("/api/compile", json={"graph": fixed(**data)}).json()

    assert positive()["positive"].index("AAA") < positive()["positive"].index("BBB")
    swapped = positive(order=["costume", "character"])["positive"]
    assert swapped.index("BBB") < swapped.index("AAA")
    wrapped = positive(prepend_positive="PRE", append_positive="POST", append_negative="NEGX")
    assert wrapped["positive"].startswith("PRE, ") and wrapped["positive"].endswith(", POST")
    assert wrapped["negative"].endswith(", NEGX")
    by_position = positive(order_mode="position", order=["costume", "character"])["positive"]
    assert by_position.index("AAA") < by_position.index("BBB")

def test_prompt_nodes_placement_polarity_category(env):
    client, _, _ = env

    def prompt(nid, text, **data):
        return {"id": nid, "type": "prompt", "position": {"x": 0, "y": 0}, "data": {"text": text, **data}}

    g = {
        "nodes": [
            {"id": "c", "type": "character", "data": {"keywords": "AAA"}},
            {"id": "k", "type": "costume", "data": {"keywords": "BBB"}},
            prompt("p1", "FIRST", placement="prepend"),
            prompt("p2", "LAST", placement="append"),
            prompt("p3", "BETWEEN", category="character"),
            prompt("p4", "NOPE", polarity="negative", placement="prepend"),
            prompt("p5", "BAD", polarity="negative", placement="append"),
            {"id": "g", "type": "generate", "data": {"profile": "sdxl", "order": ["character", "costume"]}},
        ],
        "edges": [{"source": s, "target": "g"} for s in ("c", "k", "p1", "p2", "p3", "p4", "p5")],
    }
    body = client.post("/api/compile", json={"graph": g}).json()
    pos = body["positive"]
    assert pos.startswith("FIRST, masterpiece") and pos.endswith(", LAST")
    assert pos.index("AAA") < pos.index("BETWEEN") < pos.index("BBB")
    assert body["negative"].startswith("NOPE, ") and body["negative"].endswith(", BAD")


def test_natural_profile_has_no_negative(env):
    client, _, _ = env
    body = client.post("/api/compile", json={"graph": graph("flux")}).json()
    assert body["negative"] == ""
    assert "She is wearing" in body["positive"]


def test_generate_snapshot_and_exact_requeue(env):
    client, comfy, generator = env
    runs = client.post("/api/generate", json={"graph": graph(seed=42, seed_locked=True, batch=2)}).json()
    assert [r["seed"] for r in runs] == [42, 43]
    snapshot = client.get(f"/api/runs/{runs[0]['id']}/snapshot").json()
    assert snapshot["params"]["seed"] == 42
    assert snapshot["environment"]["devices"] == ["TestGPU"]
    assert snapshot["workflow"]["3"]["inputs"]["seed"] == 42
    assert snapshot["picks"][0]["category"] == "costume"

    again = client.post(f"/api/runs/{runs[0]['id']}/requeue").json()
    assert comfy.queued[-1] == snapshot["workflow"]
    assert again["parent_id"] == runs[0]["id"]


def test_pick_is_reproducible_from_pick_seed(env):
    _, _, generator = env
    g = graph(pick_seed=7, pick_locked=True)
    first = generator.generate(g)[0]
    second = generator.generate(g)[0]
    assert generator.read_snapshot(first["id"])["picks"] == generator.read_snapshot(second["id"])["picks"]


def test_poll_saves_images(env):
    client, comfy, generator = env
    run = client.post("/api/generate", json={"graph": graph()}).json()[0]
    generator.poll_once()
    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "running"
    comfy.done = True
    generator.poll_once()
    done = client.get(f"/api/runs/{run['id']}").json()
    assert done["status"] == "done" and done["images"] == ["Libretto_00001_.png"]
    assert done["duration_s"] == 3.5 and done["started_at"] and done["finished_at"]
    assert client.get(f"/api/runs/{run['id']}/images/Libretto_00001_.png").status_code == 200
    assert client.get(f"/api/runs/{run['id']}/images/..%2Fsnapshot.json").status_code == 404


def test_lora_injection(env):
    _, comfy, generator = env
    g = graph()
    g["nodes"][0]["data"]["lora"] = {"name": "nancy.safetensors", "strength": 0.8}
    generator.generate(g)
    wf = comfy.queued[-1]
    lora = next(n for n in wf.values() if n["class_type"] == "LoraLoader")
    assert lora["inputs"]["model"] == ["4", 0]
    assert wf["3"]["inputs"]["model"][0] != "4"
    assert wf["6"]["inputs"]["clip"][0] != "4"


def test_thumbnail_from_run_and_fallback(env):
    client, comfy, generator = env
    comfy.done = True
    run = client.post("/api/generate", json={"graph": graph()}).json()[0]
    generator.poll_once()
    response = client.post(
        "/api/library/costume/white-onepiece/thumbnail/from-run",
        json={"run_id": run["id"], "image": "Libretto_00001_.png"},
    )
    assert response.status_code == 200 and response.json()["has_thumbnail"]
    assert response.json()["thumbnail_profiles"] == ["sdxl"]
    thumb = client.get("/api/library/costume/white-onepiece/thumbnail?profile=pony")
    assert thumb.status_code == 200
    assert max(Image.open(io.BytesIO(thumb.content)).size) <= 256
    assert client.get("/api/library/costume/denim-jacket/thumbnail").status_code == 404


def test_generate_records_error_when_comfy_down(env):
    client, comfy, _ = env

    def boom(*_):
        raise ConnectionError("down")

    comfy.queue_prompt = boom
    run = client.post("/api/generate", json={"graph": graph()}).json()[0]
    assert run["status"] == "error" and "down" in run["error"]
    assert client.get(f"/api/runs/{run['id']}/snapshot").status_code == 200


def test_library_crud_and_wildcard(env):
    client, _, _ = env
    created = client.post("/api/library/location", json={"name": "Beach", "keywords": "beach"}).json()
    assert created["id"].startswith("p-") and created["name"] == "Beach"
    imported = client.post("/api/library/lighting/import-wildcard", json={"text": "# c\nneon\nmoonlight\n"}).json()
    assert [p["name"] for p in imported] == ["neon", "moonlight"]
    assert client.delete(f"/api/library/location/{created['id']}").status_code == 200
    assert client.get("/api/library/bogus").status_code == 400
    assert client.put("/api/library/location/..x", json={}).status_code in (400, 404)


def test_delete_run_removes_entry_and_snapshot(env):
    client, _, generator = env
    run = client.post("/api/generate", json={"graph": graph()}).json()[0]
    generator.store.update(run["id"], status="running")
    assert client.delete(f"/api/runs/{run['id']}").status_code == 409
    generator.store.update(run["id"], status="done")
    assert client.delete(f"/api/runs/{run['id']}").status_code == 200
    assert client.get(f"/api/runs/{run['id']}").status_code == 404
    assert not generator.snapshot_dir(run["id"]).exists()
    assert client.delete(f"/api/runs/{run['id']}").status_code == 404


def test_cancel_one_and_all_active_runs(env):
    client, comfy, generator = env
    first = client.post("/api/generate", json={"graph": graph(batch=3)}).json()
    # prompt-1 is the running one in FakeComfy; prompt-2 and prompt-3 are pending
    assert client.post(f"/api/runs/{first[1]['id']}/cancel").json() == {"cancelled": [first[1]["id"]]}
    assert comfy.deleted == ["prompt-2"] and not hasattr(comfy, "interrupted")
    assert client.get(f"/api/runs/{first[1]['id']}").json()["status"] == "cancelled"
    assert len(client.post("/api/queue/cancel").json()["cancelled"]) == 2
    assert comfy.interrupted
    assert generator.store.active() == []
    assert client.post("/api/runs/nope/cancel").status_code == 404


def test_deleted_preset_can_be_restored_with_thumbnails(env):
    client, _, _ = env
    made = client.post("/api/library/location", json={"name": "Beach"}).json()
    base = f"/api/library/location/{made['id']}"
    png = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(png, "PNG")
    for profile in ("", "?profile=sdxl"):
        client.post(f"{base}/thumbnail{profile}", files={"file": ("t.png", png.getvalue())})
    assert client.delete(base).status_code == 200
    assert made["id"] not in [p["id"] for p in client.get("/api/library/location").json()]
    assert client.get(f"{base}/thumbnail").status_code == 404

    restored = client.post(f"{base}/restore").json()
    assert restored["id"] == made["id"] and restored["name"] == "Beach" and restored["has_thumbnail"]
    assert client.get(f"{base}/thumbnail?profile=sdxl").status_code == 200
    assert client.post(f"{base}/restore").status_code in (400, 404)  # nothing left in the trash

    client.delete(base)
    client.post("/api/library/location", json={"name": "Beach"})
    assert client.post(f"{base}/restore").status_code == 200


def test_library_create_copy_export_import_and_scope(env):
    client, _, _ = env
    assert [l["id"] for l in client.get("/api/libraries").json()] == ["default"]
    fantasy = client.post("/api/libraries", json={"name": "ファンタジー"}).json()
    fid = fantasy["id"]
    assert fid.startswith("l-") and fantasy["name"] == "ファンタジー"
    assert client.post("/api/libraries", json={"name": "ファンタジー"}).status_code == 400
    assert client.get(f"/api/library/costume?lib={fid}").json() == []
    assert len(client.get("/api/library/costume").json()) > 0

    copied = client.post(
        f"/api/libraries/{fid}/copy",
        json={"source": "default", "items": [{"category": "costume", "id": "red-kimono"}]},
    ).json()
    assert re.fullmatch(r"p-[0-9a-f]{8}", copied[0]["id"])
    again = client.post(
        f"/api/libraries/{fid}/copy",
        json={"source": "default", "items": [{"category": "costume", "id": "red-kimono"}]},
    ).json()
    assert re.fullmatch(r"p-[0-9a-f]{8}", again[0]["id"])
    assert again[0]["id"] != copied[0]["id"]
    assert {p["id"] for p in client.get(f"/api/library/costume?lib={fid}").json()} == {copied[0]["id"], again[0]["id"]}

    renamed = client.patch(f"/api/libraries/{fid}", json={"name": "Fantasy Set"}).json()
    assert renamed == {"id": fid, "name": "Fantasy Set", "names": {}}
    names = {l["id"]: l["name"] for l in client.get("/api/libraries").json()}
    assert names == {"default": "default", fid: "Fantasy Set"}
    assert client.patch(f"/api/libraries/{fid}", json={"name": "DEFAULT"}).status_code == 400
    assert client.patch(f"/api/libraries/{fid}", json={"name": "  "}).status_code == 400
    assert client.patch("/api/libraries/default", json={"name": "Main"}).status_code == 200

    archive = client.get(f"/api/libraries/{fid}/export")
    assert archive.status_code == 200
    imported = client.post("/api/libraries/import?name=Backup", files={"file": ("x.zip", archive.content)}).json()
    bid = imported["id"]
    assert bid.startswith("l-") and imported["name"] == "Backup"
    assert len(client.get(f"/api/library/costume?lib={bid}").json()) == 2
    duplicate = client.post("/api/libraries/import?name=Backup", files={"file": ("x.zip", archive.content)})
    assert duplicate.status_code == 200
    assert duplicate.json()["id"] not in (fid, bid)
    assert duplicate.json()["name"] == "Backup (1)"
    assert client.post("/api/libraries/import?name=bad", files={"file": ("x.zip", b"nope")}).status_code == 400

    assert client.delete("/api/libraries/default").status_code == 400
    assert client.delete(f"/api/libraries/{bid}").status_code == 200
    assert client.get(f"/api/library/costume?lib={bid}").status_code == 404


def test_scene_crud(env):
    client, _, _ = env
    scene = client.post("/api/scenes", json={"name": "Beach Day", "graph": {"nodes": [], "edges": []}}).json()
    sid = scene["id"]
    assert sid.startswith("s-")
    other = client.post("/api/scenes", json={"name": "Beach Day"}).json()["id"]
    assert other != sid
    client.put(f"/api/scenes/{sid}", json={"name": "Beach", "graph": {"nodes": [{"id": "x"}], "edges": []}})
    stored = client.get(f"/api/scenes/{sid}").json()
    assert stored["id"] == sid and stored["name"] == "Beach" and stored["graph"]["nodes"] == [{"id": "x"}]
    assert {s["id"] for s in client.get("/api/scenes").json()} == {sid, other}
    assert client.delete(f"/api/scenes/{sid}").status_code == 200
    assert client.get(f"/api/scenes/{sid}").status_code == 404


def test_scene_and_library_display_names(env):
    client, _, _ = env
    sid = client.post("/api/scenes", json={"name": "Beach"}).json()["id"]
    client.put(f"/api/scenes/{sid}", json={"names": {"ja_jp": " ビーチ ", "en-US": ""}})
    assert client.get(f"/api/scenes/{sid}").json()["names"] == {"ja-JP": "ビーチ"}
    assert [s for s in client.get("/api/scenes").json() if s["id"] == sid][0]["names"] == {"ja-JP": "ビーチ"}
    client.put(f"/api/scenes/{sid}", json={"names": {}})
    assert "names" not in client.get(f"/api/scenes/{sid}").json()
    lib = client.post("/api/libraries", json={"name": "Mine"}).json()["id"]
    client.patch(f"/api/libraries/{lib}", json={"name": "Mine", "names": {"ja-JP": "私の"}})
    assert [x for x in client.get("/api/libraries").json() if x["id"] == lib][0]["names"] == {"ja-JP": "私の"}


def test_scene_prompt_library_and_output_overrides(env, tmp_path):
    client, comfy, generator = env
    empty = client.post("/api/libraries", json={"name": "empty"}).json()["id"]
    g = graph(output_prefix="{scene}/{profile}/img", output_dir=str(tmp_path / "export"))
    g.update(name="My Scene", scene_prompt="rainy street", scene_negative="blurry", library=empty)
    g["nodes"][1] = {"id": "k", "type": "character", "data": {"keywords": "tom"}}  # no collection from the empty library
    compiled = client.post("/api/compile", json={"graph": g}).json()
    assert compiled["positive"].endswith("rainy street") and compiled["negative"].endswith("blurry")

    run = client.post("/api/generate", json={"graph": g}).json()[0]
    save_nodes = [n for n in comfy.queued[-1].values() if "filename_prefix" in n["inputs"]]
    assert save_nodes and all(n["inputs"]["filename_prefix"] == "my-scene/sdxl/img" for n in save_nodes)
    assert generator.read_snapshot(run["id"])["output"]["dir"] == str(tmp_path / "export")

    bad = graph(output_prefix="../escape")
    assert client.post("/api/generate", json={"graph": bad}).status_code == 400
    comfy.done = True
    generator.poll_once()
    assert (tmp_path / "export" / "Libretto_00001_.png").exists()


def test_copy_within_same_library_duplicates(env):
    client, _, _ = env
    done = client.post(
        "/api/libraries/default/copy",
        json={"source": "default", "items": [{"category": "costume", "id": "red-kimono"}]},
    ).json()
    assert re.fullmatch(r"p-[0-9a-f]{8}", done[0]["id"])
    presets = {p["id"]: p for p in client.get("/api/library/costume").json()}
    original = presets["red-kimono"]
    copied = presets[done[0]["id"]]
    assert done[0]["from"] == original["id"]
    assert copied["name"] == f"{original['name']} (1)"
    assert copied["keywords"] == original["keywords"]


@pytest.mark.parametrize("same_library", [True, False])
def test_preset_copies_preserve_metadata_and_all_thumbnails(tmp_path, same_library):
    from libretto.libraries import Libraries

    libs = Libraries(tmp_path / "libraries")
    source = libs.get("default")
    original = source.create("costume", {
        "name": "Kimono",
        "names": {"ja-JP": "着物"},
        "keywords": "red kimono",
        "description": "A red kimono",
        "negative": "blue",
        "weight": 2,
        "labels": ["dress/formal"],
        "lora": {"name": "kimono.safetensors", "strength": 0.8},
        "thumbnail_source": {"run": "example"},
    })
    for profile, color in [(None, "red"), ("sdxl", "blue")]:
        Image.new("RGB", (8, 8), color).save(source.thumb_path("costume", original["id"], profile), "WEBP")
    target_id = "default" if same_library else libs.create("Other")["id"]
    target = libs.get(target_id)
    copied_ids = []
    for _ in range(2):
        copied = libs.copy_items("default", target_id, [{"category": "costume", "id": original["id"]}])[0]
        copied_ids.append(copied["id"])
        assert re.fullmatch(r"p-[0-9a-f]{8}", copied["id"])
        assert copied["id"] != original["id"]
        stored = target.get("costume", copied["id"])
        for field in ("names", "keywords", "description", "negative", "weight", "labels", "lora", "thumbnail_source"):
            assert stored[field] == original[field]
        assert stored["has_thumbnail"] and stored["thumbnail_profiles"] == ["sdxl"]
        assert target._file("costume", copied["id"]).is_file()
        for profile in (None, "sdxl"):
            assert target.thumb_path("costume", copied["id"], profile).read_bytes() == source.thumb_path("costume", original["id"], profile).read_bytes()
    assert len(set(copied_ids)) == 2
    assert source.get("costume", original["id"])["name"] == original["name"]


def test_library_names_are_unique_case_insensitively(env):
    client, _, _ = env
    first = client.post("/api/library/costume", json={"name": "Hoodie"}).json()
    second = client.post("/api/library/costume", json={"name": "HOODIE"}).json()
    assert first["id"] != second["id"]
    assert second["name"] == "HOODIE (1)"
    other = client.post("/api/library/costume", json={"name": "Cape"}).json()
    renamed = client.put(f"/api/library/costume/{other['id']}", json={"name": "hoodie"}).json()
    assert renamed["name"] == "hoodie (2)" and renamed["id"] == other["id"]
    same = client.put(f"/api/library/costume/{first['id']}", json={"name": "Hoodie"}).json()
    assert same["name"] == "Hoodie"
    copy = client.post(
        "/api/libraries/default/copy",
        json={"source": "default", "items": [{"category": "costume", "id": first["id"]}]},
    ).json()
    names = {p["id"]: p["name"] for p in client.get("/api/library/costume?lib=default").json()}
    assert names[copy[0]["id"]] == "Hoodie (3)"


def test_ids_stay_stable_for_non_ascii_and_renamed_names(env):
    client, _, _ = env
    made = client.post("/api/library/costume", json={"name": "赤い着物"}).json()
    assert made["name"] == "赤い着物" and made["id"].startswith("p-")
    renamed = client.put(f"/api/library/costume/{made['id']}", json={"name": "青い着物"}).json()
    assert renamed["id"] == made["id"] and renamed["name"] == "青い着物"