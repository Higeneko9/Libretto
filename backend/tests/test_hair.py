from libretto.compiler import HAIR_COLORS, apply_hair_color, compile_items, resolve_nodes
from libretto.library import Library

TAGS = {"format": "tags", "order": ["style", "character", "costume", "view"], "use_negative": False}


def hair(**extra):
    return {"category": "hair", "keywords": "{color} hair, long hair", "description": "long {color} hair", **extra}


def item(category, text):
    return {"category": category, "keywords": text}


def test_color_placeholder_and_fallbacks():
    assert apply_hair_color("{color} hair, bob cut", "blue") == "blue hair, bob cut"
    assert apply_hair_color("{color} hair, bob cut", None) == "hair, bob cut"
    assert apply_hair_color("long {color} hair", "") == "long hair"
    assert apply_hair_color("twintails", "pink") == "pink hair, twintails"
    assert apply_hair_color("twintails", None) == "twintails"


def test_hair_compiles_after_character_even_when_order_lacks_it():
    items = [item("costume", "kimono"), hair(hair_color="blonde"), item("character", "nancy")]
    compiled = compile_items(items, TAGS)
    assert compiled.positive == "nancy, blonde hair, long hair, kimono, masterpiece" or compiled.positive.startswith(
        "nancy, blonde hair, long hair, kimono"
    )


def test_natural_profile_uses_description_and_template():
    profile = {"format": "natural", "order": ["character", "hair"], "natural": {"hair": "She has {text}"}}
    compiled = compile_items([hair(hair_color="red")], profile)
    assert compiled.positive == "She has long red hair."


def test_random_color_is_deterministic_per_pick_seed(tmp_path):
    library = Library(tmp_path)
    library.save("hair", {"name": "Bob", "keywords": "{color} hair"}, "bob")
    graph = {
        "nodes": [
            {"id": "g", "type": "generate", "data": {}},
            {"id": "h", "type": "collection", "data": {"category": "hair", "hair_color": "random"}},
        ],
        "edges": [{"source": "h", "target": "g"}],
    }
    first = resolve_nodes(graph, library, 7, {})[1][0]["color"]
    again = resolve_nodes(graph, library, 7, {})[1][0]["color"]
    assert first == again and first in HAIR_COLORS
    colors = {resolve_nodes(graph, library, seed, {})[1][0]["color"] for seed in range(40)}
    assert len(colors) > 1

def test_disabled_nodes_are_skipped(tmp_path):
    graph = {
        "nodes": [
            {"id": "g", "type": "generate", "data": {}},
            {"id": "a", "type": "prompt", "data": {"text": "on"}},
            {"id": "b", "type": "prompt", "data": {"text": "off", "disabled": True}},
        ],
        "edges": [{"source": "a", "target": "g"}, {"source": "b", "target": "g"}],
    }
    items, _ = resolve_nodes(graph, Library(tmp_path), 1, {})
    assert [i["text"] for i in items] == ["on"]


def test_nested_tags_match_ancestor_tag(tmp_path):
    from libretto.collections import filter_candidates
    from libretto.tags import TagStore

    store = TagStore(tmp_path / "tags.yaml")
    formal, dresser = store.resolve("dress/formal"), store.resolve("dresser")
    dress = store.find("dress")
    presets = [
        {"id": "a", "labels": [formal]},
        {"id": "b", "labels": [dress]},
        {"id": "c", "labels": [dresser]},
    ]
    assert [p["id"] for p in filter_candidates(presets, [dress], [], store)] == ["a", "b"]
    assert [p["id"] for p in filter_candidates(presets, ["dress/formal"], [], store)] == ["a"]


def test_pose_emotion_props_follow_costume_in_order_for_older_profiles():
    items = [item("view", "full body"), item("props", "umbrella"), item("emotion", "smiling"), item("pose", "arms crossed"), item("costume", "kimono")]
    compiled = compile_items(items, TAGS)
    assert compiled.positive.startswith("kimono, arms crossed, smiling, umbrella, full body")


def owned(category, text, node_id, owner=None):
    return {"category": category, "keywords": text, "node_id": node_id, "owner": owner}


TWO = [
    owned("view", "full body", "v"),
    owned("costume", "suit", "c2", "boy"),
    owned("character", "1girl", "girl"),
    owned("costume", "white dress", "c1", "girl"),
    owned("character", "1boy", "boy"),
    owned("hair", "short hair", "h2", "boy"),
]


def test_owned_items_follow_their_character():
    compiled = compile_items(TWO, {**TAGS, "order": ["character", "hair", "costume", "view"]})
    assert compiled.positive == "1girl, white dress, 1boy, short hair, suit, full body"


def test_break_separator_splits_characters_and_shared_text():
    profile = {**TAGS, "order": ["character", "hair", "costume", "view"], "quality_prefix": "best"}
    compiled = compile_items(TWO, profile, group_sep="break")
    assert compiled.positive == "best, 1girl, white dress BREAK 1boy, short hair, suit BREAK full body"


def test_unknown_owner_is_treated_as_shared():
    items = [owned("character", "1girl", "girl"), owned("costume", "dress", "c", "gone")]
    assert compile_items(items, TAGS, group_sep="break").positive == "1girl, dress"
