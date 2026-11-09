import io
import zipfile

import pytest
import yaml

from libretto.compiler import category_rank, compile_items, resolve_nodes
from libretto.library import Library

TAGS = {"format": "tags", "use_negative": False}


def custom(**extra):
    return {"id": "effects", "label": "Effects", "kind": "attribute", "color": "#112233", **extra}


def test_defaults_when_no_config_file(tmp_path):
    library = Library(tmp_path)
    ids = library.category_ids()
    assert ids[:3] == ["style", "character", "hair"]
    assert all(c["locked"] for c in library.categories())


def test_add_custom_category_and_use_it(tmp_path):
    library = Library(tmp_path)
    library.set_categories([*library.categories(), custom()])
    assert Library(tmp_path).category("effects")["folder"] == "effects"
    saved = library.save("effects", {"name": "Sparkles", "keywords": "sparkles"})
    assert library.list("effects")[0]["id"] == saved["id"]
    with pytest.raises(ValueError):
        library.list("nonsense")


def test_label_is_not_identity(tmp_path):
    library = Library(tmp_path)
    cats = [dict(c, names={"und": "Persona"}) if c["id"] == "character" else c for c in library.categories()]
    library.set_categories(cats)
    assert library.category("character")["label"] == "Persona"
    graph = {"nodes": [{"id": "generate", "type": "generate", "data": {}}, {"id": "c", "type": "character", "data": {"keywords": "mia"}}],
             "edges": [{"source": "c", "target": "generate"}]}
    items, _ = resolve_nodes(graph, library, 1, {})
    assert items[0]["category"] == "character"


def test_category_names_per_locale(tmp_path):
    (tmp_path / "categories.yaml").write_text("categories:\n- {id: costume, label: Costume, kind: attribute}\n- {id: c-1, label: Mine, kind: custom}\n", encoding="utf-8")
    library = Library(tmp_path)
    assert library.category("costume")["names"] == {"en-US": "Costume", "ja-JP": "衣装"}
    assert library.category("c-1")["names"] == {"und": "Mine"}
    library.set_categories([dict(c, names={**c["names"], "ja-JP": "私の"}) if c["id"] == "c-1" else c for c in library.categories()])
    text = (tmp_path / "categories.yaml").read_text(encoding="utf-8")
    assert "label:" not in text and "私の" in text
    assert Library(tmp_path).category("c-1")["names"] == {"und": "Mine", "ja-JP": "私の"}


def test_preset_translated_names(tmp_path):
    library = Library(tmp_path)
    saved = library.save("character", {"name": "Nancy", "names": {"ja_jp": " ナンシー ", "en-US": ""}, "keywords": "1girl, nancy"})
    assert saved["name"] == "Nancy" and saved["names"] == {"ja-JP": "ナンシー"}
    assert "names" not in library.save("character", {"name": "Bob"}, None)


def test_locked_rules(tmp_path):
    library = Library(tmp_path)
    with pytest.raises(ValueError, match="locked"):
        library.set_categories([c for c in library.categories() if c["id"] != "hair"])
    with pytest.raises(ValueError, match="kind"):
        library.set_categories([dict(c, kind="scene") if c["id"] == "hair" else c for c in library.categories()])
    unlocked = [dict(c, locked=False) if c["id"] == "hair" else c for c in library.categories()]
    library.set_categories(unlocked)
    library.set_categories([c for c in library.categories() if c["id"] != "hair"])
    assert "hair" not in library.category_ids()


def test_cannot_delete_category_with_presets(tmp_path):
    library = Library(tmp_path)
    library.set_categories([*library.categories(), custom()])
    library.save("effects", {"name": "Glow"})
    with pytest.raises(ValueError, match="presets"):
        library.set_categories([c for c in library.categories() if c["id"] != "effects"])
    library.set_categories([c for c in library.categories() if c["id"] != "effects"], purge=True)
    assert not (tmp_path / "effects").exists()
    assert (tmp_path / ".trash" / "categories" / "effects" / "glow.yaml").exists()

def test_duplicate_ids_and_bad_values_rejected(tmp_path):
    library = Library(tmp_path)
    with pytest.raises(ValueError):
        library.set_categories([*library.categories(), custom(), custom()])
    with pytest.raises(ValueError):
        library.set_categories([*library.categories(), custom(color="red")])
    with pytest.raises(ValueError):
        library.set_categories([*library.categories(), custom(id="Bad Id")])


def test_custom_category_is_placed_by_library_order_and_can_belong():
    cats = [
        {"id": "character", "kind": "group_head", "can_belong": False, "has_color": False, "template": "{text}"},
        {"id": "effects", "kind": "attribute", "can_belong": True, "has_color": False, "template": "{text}"},
        {"id": "view", "kind": "scene", "can_belong": False, "has_color": False, "template": "{text}"},
    ]
    assert category_rank(["character", "view"], cats)["effects"] == pytest.approx(0.1)
    items = [
        {"category": "view", "keywords": "close up", "node_id": "v"},
        {"category": "character", "keywords": "mia", "node_id": "a"},
        {"category": "character", "keywords": "zed", "node_id": "b"},
        {"category": "effects", "keywords": "glow", "node_id": "e", "owner": "a"},
    ]
    compiled = compile_items(items, {**TAGS, "order": ["character", "view"]}, categories=cats, group_sep="break")
    assert compiled.positive == "mia, glow BREAK zed BREAK close up"
    cats[1]["can_belong"] = False
    compiled = compile_items(items, {**TAGS, "order": ["character", "view"]}, categories=cats)
    assert compiled.positive == "mia, zed, glow, close up"


def test_unknown_category_node_still_compiles_from_its_own_data(tmp_path):
    library = Library(tmp_path)
    graph = {"nodes": [{"id": "generate", "type": "generate", "data": {}}, {"id": "n", "type": "from-elsewhere", "data": {"keywords": "hello"}}],
             "edges": [{"source": "n", "target": "generate"}]}
    items, _ = resolve_nodes(graph, library, 1, {})
    assert compile_items(items, TAGS, categories=library.categories()).positive == "hello"


def test_export_import_and_copy_carry_categories(tmp_path):
    from libretto.libraries import Libraries

    libs = Libraries(tmp_path / "libs")
    source = libs.get("default")
    source.set_categories([*source.categories(), custom()])
    source.save("effects", {"name": "Glow", "keywords": "glow"})
    data = libs.export_zip("default")
    assert "categories.yaml" in zipfile.ZipFile(io.BytesIO(data)).namelist()
    copy_id = libs.import_zip("copy", data)["id"]
    assert libs.get(copy_id).category("effects")["color"] == "#112233"
    assert libs.get(copy_id).list("effects")[0]["name"] == "Glow"
    blank = libs.create("blank")["id"]
    libs.copy_items("default", blank, [{"category": "effects", "id": "glow"}])
    assert libs.get(blank).list("effects")[0]["name"] == "Glow"
    assert libs.get(blank).category("effects")["locked"] is False
    assert yaml.safe_load((tmp_path / "libs" / blank / "categories.yaml").read_text(encoding="utf-8"))["categories"]
