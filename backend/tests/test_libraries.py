import io
import zipfile

import pytest
import yaml
from PIL import Image

from libretto.libraries import Libraries, META_FILE
from libretto.scenes import Scenes


def test_export_import_preserves_shared_scene_library_and_preset_references(tmp_path):
    source = Libraries(tmp_path / "source")
    library_id = source.create("Shared")["id"]
    source.rename(library_id, "Shared", {"ja-JP": "共有"})
    library = source.get(library_id)
    preset = library.create("costume", {"name": "Kimono", "keywords": "red kimono", "labels": ["formal"]})
    Image.new("RGB", (8, 8), "red").save(library.thumb_path("costume", preset["id"]), "WEBP")
    archive = source.export_zip(library_id)
    with zipfile.ZipFile(io.BytesIO(archive)) as exported:
        assert yaml.safe_load(exported.read(META_FILE))["id"] == library_id

    graph = {
        "library": library_id,
        "nodes": [
            {"id": "preset", "type": "costume", "data": {"lib": library_id, "presetId": preset["id"]}},
            {"id": "collection", "type": "collection", "data": {"category": "costume", "item_ids": [preset["id"]]}},
        ],
        "edges": [],
    }
    receiver = Libraries(tmp_path / "receiver")
    imported = receiver.import_zip("Shared", archive)
    assert imported == {"id": library_id, "name": "Shared"}
    scene = Scenes(tmp_path / "scenes").create("Shared scene", graph)
    restored = scene["graph"]
    assert restored["library"] == imported["id"]
    node = restored["nodes"][0]["data"]
    assert receiver.get(node["lib"]).get("costume", node["presetId"])["keywords"] == "red kimono"
    assert receiver.get(restored["library"]).get("costume", restored["nodes"][1]["data"]["item_ids"][0])["id"] == preset["id"]
    assert receiver.get(library_id).thumb_path("costume", preset["id"]).read_bytes() == library.thumb_path("costume", preset["id"]).read_bytes()
    assert receiver.get(library_id).tags.get(preset["labels"][0])["names"]
    assert next(item for item in receiver.list() if item["id"] == library_id)["names"] == {"ja-JP": "共有"}


def test_import_conflicts_create_separate_libraries_with_numbered_names(tmp_path, monkeypatch):
    libraries = Libraries(tmp_path)
    library_id = libraries.create("Shared")["id"]
    library = libraries.get(library_id)
    preset = library.create("costume", {"name": "Kimono", "keywords": "red kimono"})
    original = library._file("costume", preset["id"]).read_bytes()
    archive = libraries.export_zip(library_id)
    tokens = iter([library_id.removeprefix("l-"), "11111111", "22222222"])
    monkeypatch.setattr("libretto.ids.secrets.token_hex", lambda _: next(tokens))

    first = libraries.import_zip("Shared", archive)
    second = libraries.import_zip("SHARED", archive)
    assert first == {"id": "l-11111111", "name": "Shared (1)"}
    assert second == {"id": "l-22222222", "name": "SHARED (2)"}
    for imported in (first, second):
        assert libraries.get(imported["id"]).get("costume", preset["id"])["keywords"] == "red kimono"
    assert library._file("costume", preset["id"]).read_bytes() == original
    assert libraries.name_of(library_id) == "Shared"


def test_name_collision_does_not_change_available_archived_id(tmp_path):
    source = Libraries(tmp_path / "source")
    library_id = source.create("Shared")["id"]
    source.get(library_id).create("costume", {"name": "Kimono"})
    receiver = Libraries(tmp_path / "receiver")
    receiver.create("Shared")
    assert receiver.import_zip("Shared", source.export_zip(library_id)) == {"id": library_id, "name": "Shared (1)"}


def test_legacy_archive_without_metadata_still_imports(tmp_path):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as exported:
        exported.writestr("costumes/kimono.yaml", "name: Kimono\nkeywords: red kimono\n")
    libraries = Libraries(tmp_path)
    imported = libraries.import_zip("Legacy", archive.getvalue())
    assert imported["id"].startswith("l-")
    assert libraries.get(imported["id"]).get("costume", "kimono")["keywords"] == "red kimono"


@pytest.mark.parametrize("metadata", [
    "id: ../escape",
    "id: 42",
    "id: ''",
    "- not a mapping",
    "id: [",
])
def test_invalid_archive_identity_does_not_modify_existing_libraries(tmp_path, metadata):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as exported:
        exported.writestr(META_FILE, metadata)
        exported.writestr("costumes/kimono.yaml", "name: Kimono\n")
    libraries = Libraries(tmp_path)
    before = libraries.list()
    with pytest.raises(ValueError):
        libraries.import_zip("Invalid", archive.getvalue())
    assert libraries.list() == before
