import yaml

from libretto.i18n import normalize_locale
from libretto.libraries import Libraries
from libretto.library import Library
from libretto.tags import TagStore


def test_locale_normalization():
    assert normalize_locale("ja_jp") == "ja-JP"
    assert normalize_locale("EN-us") == "en-US"
    assert normalize_locale("zh-hant-tw") == "zh-Hant-TW"
    assert normalize_locale(None) == normalize_locale("") == normalize_locale("nonsense!") == "und"


def test_resolve_creates_nested_tags_and_reuses_names_from_any_locale(tmp_path):
    store = TagStore(tmp_path / "tags.yaml")
    formal = store.resolve("dress/formal", "en-us")
    dress = store.find("dress")
    assert store.get(formal)["parent"] == dress and formal.startswith("t-")
    store.rename(dress, "ja-JP", "ドレス")
    assert store.get(dress)["names"] == {"en-US": "dress", "ja-JP": "ドレス"}
    assert store.resolve("ドレス/formal", "ja-JP") == formal
    assert store.resolve("DRESS/Formal") == formal
    assert TagStore(tmp_path / "tags.yaml").get(dress)["names"]["ja-JP"] == "ドレス"


def test_rename_move_and_delete_rules(tmp_path):
    store = TagStore(tmp_path / "tags.yaml")
    a, b = store.resolve("a"), store.resolve("a/b")
    other = store.resolve("other")
    assert store.descendants(a) == {a, b}
    for bad in (b, "t-00000000"):
        try:
            store.move(a, bad)
        except (ValueError, FileNotFoundError):
            pass
        else:
            raise AssertionError("cycle or unknown parent accepted")
    store.rename(other, "en-US", "Other2")
    try:
        store.rename(other, "en-US", "a")
    except ValueError:
        pass
    else:
        raise AssertionError("sibling name clash accepted")
    assert store.delete(a) is None
    assert store.get(b)["parent"] is None


def test_legacy_text_labels_are_converted_once(tmp_path):
    (tmp_path / "costumes").mkdir()
    path = tmp_path / "costumes" / "kimono.yaml"
    path.write_text(yaml.safe_dump({"name": "Kimono", "labels": ["dress/formal", "summer"]}), encoding="utf-8")
    library = Library(tmp_path)
    labels = library.get("costume", "kimono")["labels"]
    assert all(l.startswith("t-") for l in labels)
    assert {library.tags.get(l)["names"]["und"] for l in labels} == {"formal", "summer"}
    assert yaml.safe_load(path.read_text(encoding="utf-8"))["labels"] == labels
    assert Library(tmp_path).get("costume", "kimono")["labels"] == labels


def test_save_accepts_ids_and_names_and_drops_dangling_ids(tmp_path):
    library = Library(tmp_path)
    tag = library.tags.resolve("hat", "en-US")
    saved = library.save("costume", {"name": "x", "labels": [tag, "ハット", "t-deadbeef", " "]}, "x", "ja-JP")
    assert saved["labels"][0] == tag and len(saved["labels"]) == 2
    assert library.tags.get(saved["labels"][1])["names"] == {"ja-JP": "ハット"}


def test_delete_tag_strips_it_from_presets(tmp_path):
    library = Library(tmp_path)
    saved = library.save("costume", {"name": "x", "labels": ["hat", "red"]}, "x")
    hat = library.tags.find("hat")
    library.delete_tag(hat)
    assert library.get("costume", "x")["labels"] == [l for l in saved["labels"] if l != hat]
    assert not library.tags.exists(hat)


def test_copy_between_libraries_keeps_tag_identity(tmp_path):
    libs = Libraries(tmp_path / "libs")
    source = libs.get("default")
    saved = source.save("costume", {"name": "x", "labels": ["dress/formal"]}, "x", "en-US")
    other = libs.create("other")["id"]
    libs.copy_items("default", other, [{"category": "costume", "id": "x"}])
    target = libs.get(other)
    labels = target.get("costume", "x")["labels"]
    assert labels == saved["labels"]
    leaf = target.tags.get(labels[0])
    assert leaf["names"]["en-US"] == "formal" and target.tags.get(leaf["parent"])["names"]["en-US"] == "dress"
    data = libs.export_zip("default")
    imported = libs.import_zip("imp", data)["id"]
    assert libs.get(imported).tags.get(labels[0])["names"]["en-US"] == "formal"


def test_parallel_resolve_creates_one_tag(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    path = tmp_path / "tags.yaml"
    with ThreadPoolExecutor(8) as pool:
        ids = list(pool.map(lambda _: TagStore(path).resolve("brand new", "en"), range(16)))
    assert len(set(ids)) == 1
    assert len(TagStore(path).list()) == 1



def test_bundled_japanese_names(tmp_path):
    path = tmp_path / "tags.yaml"
    store = TagStore(path)
    tag_id = store.resolve("Summer", "en-US")
    assert store.get(tag_id)["names"] == {"en-US": "Summer", "ja-JP": "夏"}
    # an old library gets them once; a later edit is kept
    path.write_text(yaml.safe_dump({"tags": {"t-00000001": {"names": {"und": "cat"}, "parent": None}}}), encoding="utf-8")
    old = TagStore(path)
    assert old.get("t-00000001")["names"]["ja-JP"] == "猫"
    old.rename("t-00000001", "ja-JP", "ねこ")
    assert TagStore(path).get("t-00000001")["names"]["ja-JP"] == "ねこ"

