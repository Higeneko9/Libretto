import pytest
from fastapi.testclient import TestClient

from libretto.config import LB_Settings, normalize_comfy_url
from libretto.main import create_app


class Comfy:
    base_url = "http://old:8188"

    def set_base_url(self, url):
        self.base_url = url

    def system_stats(self):
        return {"system": {"comfyui_version": "1.2.3"}}


@pytest.fixture
def client(tmp_path):
    settings = LB_Settings(
        ComfyUrl="http://old:8188",
        LibrariesRoot=tmp_path / "libs",
        ProfilesRoot=tmp_path / "profiles",
        UserProfilesRoot=tmp_path / "uprofiles",
        DataRoot=tmp_path / "data",
        ScenesRoot=tmp_path / "scenes",
        ModelsRoot=None,
        SettingsFile=tmp_path / "settings.json",
    )
    return TestClient(create_app(settings, Comfy(), start_worker=False)), settings


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("myserver", "http://myserver"),
        ("myserver:8188", "http://myserver:8188"),
        (" https://box.local:443/ ", "https://box.local:443"),
        ("127.0.0.1:8000", "http://127.0.0.1:8000"),
    ],
)
def test_normalize_comfy_url(raw, expected):
    assert normalize_comfy_url(raw) == expected


@pytest.mark.parametrize("raw", ["", "ftp://x", "host:notaport", "host:99999"])
def test_normalize_rejects_bad_addresses(raw):
    with pytest.raises(ValueError):
        normalize_comfy_url(raw)


def test_settings_are_saved_and_applied_live(client, monkeypatch):
    monkeypatch.delenv("LB_COMFY_URL", raising=False)
    http, settings = client
    # nothing saved yet: the UI should ask for the ComfyUI address
    assert http.get("/api/settings").json() == {"comfy_url": "http://old:8188", "port": 8000, "configured": False}
    saved = http.put("/api/settings", json={"comfy_url": "newhost:9000", "port": 8123}).json()
    assert saved == {"comfy_url": "http://newhost:9000", "port": 8123, "configured": True}
    assert http.get("/api/settings").json() == saved
    assert settings.SettingsFile.exists()
    assert http.put("/api/settings", json={"port": 0}).status_code == 400
    assert http.put("/api/settings", json={"comfy_url": "ftp://x"}).status_code == 400


def test_settings_connection_test(client):
    http, _ = client
    assert http.post("/api/settings/test", json={"comfy_url": "http://127.0.0.1:1"}).json()["ok"] is False
    assert http.post("/api/settings/test", json={"comfy_url": "nope://x"}).json()["ok"] is False
