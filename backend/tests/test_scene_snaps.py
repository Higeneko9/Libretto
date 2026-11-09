from test_api import env, graph  # noqa: F401  (fixtures)


def generate(client, g, scene="s1"):
    return client.post("/api/generate", json={"graph": g, "scene_id": scene}).json()


def snaps(client, scene="s1"):
    return client.get(f"/api/scenes/{scene}/snaps").json()


def test_identical_graph_reuses_version_and_thumbnail_updates(env):  # noqa: F811
    client, comfy, generator = env
    run = generate(client, graph())[0]
    generate(client, graph())
    listing = snaps(client)
    assert [i["version"] for i in listing["items"]] == [1]
    assert listing["items"][0]["thumb_at"] is None
    assert client.get("/api/scenes/s1/snaps/1/thumbnail").status_code == 404

    comfy.done = True
    generator.poll_once()
    assert client.get("/api/scenes/s1/snaps/1/thumbnail").headers["content-type"] == "image/webp"
    assert snaps(client)["items"][0]["thumb_at"]
    assert client.get(f"/api/runs/{run['id']}/snapshot").json()["scene"] == {"id": "s1", "version": 1}


def test_hash_ignores_layout_and_last_pick_but_not_content(env):  # noqa: F811
    client, _, _ = env
    base = graph()
    moved = graph()
    moved["nodes"][0]["position"] = {"x": 9, "y": 9}
    moved["nodes"][1]["data"]["lastPick"] = "white-onepiece"
    generate(client, base)
    generate(client, moved)
    assert len(snaps(client)["items"]) == 1
    generate(client, graph(steps=33))
    assert [i["version"] for i in snaps(client)["items"]] == [2, 1]


def test_lru_eviction_respects_keep(env):  # noqa: F811
    client, _, _ = env
    assert client.put("/api/scenes/s1/snap-settings", json={"max": 3}).json()["max"] == 3
    for steps in (10, 11, 12):
        generate(client, graph(steps=steps))
    client.patch("/api/scenes/s1/snaps/1", json={"keep": True})
    generate(client, graph(steps=10))  # touches v1, making v2 the least recently used
    generate(client, graph(steps=13))
    assert sorted(i["version"] for i in snaps(client)["items"]) == [1, 3, 4]
    generate(client, graph(steps=14))
    assert sorted(i["version"] for i in snaps(client)["items"]) == [1, 4, 5]


def test_rename_snapshot_survives_reuse(env):  # noqa: F811
    client, _, _ = env
    generate(client, graph())
    assert client.patch("/api/scenes/s1/snaps/1", json={"name": "  Smiling test "}).json()["name"] == "Smiling test"
    generate(client, graph())
    assert snaps(client)["items"][0]["name"] == "Smiling test"
    assert client.patch("/api/scenes/s1/snaps/1", json={"name": ""}).json()["name"] == ""


def test_apply_and_delete(env):  # noqa: F811
    client, _, _ = env
    generate(client, graph(steps=21))
    generate(client, graph(steps=22))
    applied = client.post("/api/scenes/s1/snaps/1/apply").json()["graph"]
    assert applied["nodes"][2]["data"]["steps"] == 21
    assert client.delete("/api/scenes/s1/snaps/1").status_code == 200
    assert [i["version"] for i in snaps(client)["items"]] == [2]
    assert client.post("/api/scenes/s1/snaps/1/apply").status_code == 404


def test_reused_version_moves_to_top(env):  # noqa: F811
    client, _, _ = env
    generate(client, graph(steps=10))
    generate(client, graph(steps=11))
    generate(client, graph(steps=12))
    assert [i["version"] for i in snaps(client)["items"]] == [3, 2, 1]
    generate(client, graph(steps=10))
    assert [i["version"] for i in snaps(client)["items"]] == [1, 3, 2]
    client.post("/api/scenes/s1/snaps/2/apply")  # loading a version does not reorder the list
    assert [i["version"] for i in snaps(client)["items"]] == [1, 3, 2]


def test_batch_count_is_not_part_of_snapshot(env):  # noqa: F811
    client, _, _ = env
    generate(client, graph(batch=1))
    generate(client, graph(batch=3))
    assert [i["version"] for i in snaps(client)["items"]] == [1]
    stored = client.post("/api/scenes/s1/snaps/1/apply").json()["graph"]
    assert "batch" not in stored["nodes"][2]["data"]


def test_version_remembers_latest_run(env):  # noqa: F811
    client, _, _ = env
    generate(client, graph())
    second = generate(client, graph(batch=2))
    assert snaps(client)["items"][0]["run_id"] == second[-1]["id"]


def test_generate_without_scene_creates_no_snapshot(env):  # noqa: F811
    client, _, _ = env
    client.post("/api/generate", json={"graph": graph()})
    assert snaps(client)["items"] == []
