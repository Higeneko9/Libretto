import random

from libretto.collections import pick_item

ITEMS = [{"id": c, "weight": 1.0} for c in "abcd"]


def test_sequential_cycles():
    state = {}
    picks = [pick_item(ITEMS, "sequential", random.Random(0), state)["id"] for _ in range(5)]
    assert picks == ["a", "b", "c", "d", "a"]


def test_shuffle_visits_all_before_repeat():
    state = {}
    rng = random.Random(1)
    picks = [pick_item(ITEMS, "shuffle", rng, state)["id"] for _ in range(4)]
    assert sorted(picks) == list("abcd")


def test_random_exclude_last_avoids_repeats():
    state = {}
    rng = random.Random(2)
    picks = [pick_item(ITEMS, "random", rng, state, exclude_last=3)["id"] for _ in range(12)]
    assert all(len(set(picks[i : i + 4])) == 4 for i in range(len(picks) - 3))


def test_random_is_deterministic_per_seed_and_weighted():
    heavy = [{"id": "x", "weight": 0.0}, {"id": "y", "weight": 1.0}]
    assert {pick_item(heavy, "random", random.Random(s), {})["id"] for s in range(20)} == {"y"}
    assert pick_item(ITEMS, "random", random.Random(5), {}) == pick_item(ITEMS, "random", random.Random(5), {})
