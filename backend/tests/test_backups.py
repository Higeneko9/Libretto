import io
import zipfile

from test_api import env, graph  # noqa: F401  (fixtures)


def scene_names(client):
    return sorted(s["name"] for s in client.get("/api/scenes").json())


def test_backup_restore_roundtrip_merge_and_replace(env):
    client, _, _ = env
    keep = client.post("/api/scenes", json={"name": "Keep me", "graph": graph()}).json()
    first = client.post("/api/backups", json={"note": "before"}).json()
    assert first["kind"] == "manual" and first["note"] == "before"
    assert first["counts"]["scenes"] == 1 and first["counts"]["libraries"] > 0

    client.delete(f"/api/scenes/{keep['id']}")
    extra = client.post("/api/scenes", json={"name": "Newer", "graph": graph()}).json()
    client.delete("/api/library/costume/white-onepiece")
    assert scene_names(client) == ["Newer"]

    merged = client.post(f"/api/backups/{first['id']}/restore", json={"mode": "merge"}).json()
    assert merged["safety_backup"]
    assert scene_names(client) == ["Keep me", "Newer"]
    assert any(p["id"] == "white-onepiece" for p in client.get("/api/library/costume").json())

    client.post(f"/api/backups/{first['id']}/restore", json={"mode": "replace"})
    assert scene_names(client) == ["Keep me"]
    assert extra["id"] not in [s["id"] for s in client.get("/api/scenes").json()]

    kinds = [b["kind"] for b in client.get("/api/backups").json()]
    assert kinds.count("pre-restore") == 2 and "manual" in kinds


def test_history_is_optional_and_restored(env):
    client, _, _ = env
    run = client.post("/api/generate", json={"graph": graph(), "profile": "sdxl"}).json()
    run_id = (run.get("runs") or [run])[0]["id"] if isinstance(run, dict) else run[0]["id"]
    without = client.post("/api/backups", json={"include_history": False}).json()
    with_history = client.post("/api/backups", json={"include_history": True}).json()
    assert without["counts"]["runs"] == 0 and with_history["counts"]["runs"] == 1

    client.post(f"/api/runs/{run_id}/cancel")
    client.delete(f"/api/runs/{run_id}")
    assert client.get(f"/api/runs/{run_id}").status_code == 404

    client.post(f"/api/backups/{without['id']}/restore", json={"mode": "merge"})
    assert client.get(f"/api/runs/{run_id}").status_code == 404

    client.post(f"/api/backups/{with_history['id']}/restore", json={"mode": "merge"})
    restored = client.get(f"/api/runs/{run_id}").json()
    assert restored["status"] == "cancelled"
    assert client.get(f"/api/runs/{run_id}/snapshot").status_code == 200


def test_download_import_delete_and_validation(env):
    client, _, _ = env
    made = client.post("/api/backups", json={}).json()
    blob = client.get(f"/api/backups/{made['id']}/download").content
    imported = client.post("/api/backups/import", files={"file": ("b.zip", blob)}).json()
    assert imported["kind"] == "imported" and imported["id"] != made["id"]

    bad = client.post("/api/backups/import", files={"file": ("x.zip", b"nope")})
    assert bad.status_code == 400
    assert client.get("/api/backups/not-an-id/download").status_code == 400
    assert client.post(f"/api/backups/{made['id']}/restore", json={"mode": "bogus"}).status_code == 400

    client.delete(f"/api/backups/{made['id']}")
    assert made["id"] not in [b["id"] for b in client.get("/api/backups").json()]


def test_restore_ignores_paths_outside_managed_folders(env, tmp_path):
    client, _, _ = env
    made = client.post("/api/backups", json={}).json()
    path = tmp_path / "backups" / f"{made['id']}.zip"
    evil = tmp_path / "backups" / "20000101-000000.zip"
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(evil, "w") as target:
        for member in source.infolist():
            target.writestr(member, source.read(member))
        target.writestr("scenes/../../escaped.txt", "x")
        target.writestr("other/file.txt", "x")
    client.post("/api/backups/20000101-000000/restore", json={"mode": "merge"})
    assert not (tmp_path / "escaped.txt").exists()
    assert not (tmp_path / "other").exists()


def test_auto_backup_runs_daily_and_prunes(tmp_path):
    from datetime import timedelta

    from libretto.backups import Backups

    scenes = tmp_path / "scenes"
    scenes.mkdir()
    (scenes / "a.json").write_text("{}")
    backups = Backups(tmp_path / "backups", {"scenes": scenes}, tmp_path / "snap", lambda: [], lambda rows, replace: 0)

    first = backups.auto_backup(keep=2)
    assert first and first["kind"] == "auto"
    assert backups.auto_backup(keep=2) is None  # one per day

    for _ in range(3):
        backups.auto_backup(keep=2, min_age=timedelta(0))
    autos = [b for b in backups.list() if b["kind"] == "auto"]
    assert len(autos) == 2
