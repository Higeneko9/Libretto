import random

from .tags import TagStore

MODES = ("random", "sequential", "shuffle", "fixed")


def filter_candidates(presets: list[dict], labels: list[str], item_ids: list[str], tags: TagStore) -> list[dict]:
    """Presets (by id list) that carry every filter tag; a filter tag also matches the tags nested below it.

    Filter labels are tag ids (older scenes may still hold tag names, which `tags` resolves)."""
    has = lambda preset, label: bool(set(preset.get("labels", [])) & tags.expand(label))
    result = []
    for preset in sorted(presets, key=lambda p: p["id"]):
        if item_ids and preset["id"] not in item_ids:
            continue
        if labels and not all(has(preset, l) for l in labels):
            continue
        result.append(preset)
    return result


def pick_item(
    candidates: list[dict],
    mode: str,
    rng: random.Random,
    state: dict,
    exclude_last: int = 0,
    fixed_id: str | None = None,
) -> dict:
    """Pick one preset. `state` is mutated and should be persisted by the caller."""
    if not candidates:
        raise ValueError("collection has no matching items")
    if mode not in MODES:
        raise ValueError(f"unknown pick mode: {mode}")
    by_id = {c["id"]: c for c in candidates}

    if mode == "fixed":
        chosen = by_id.get(fixed_id) or candidates[0]
    elif mode == "sequential":
        cursor = int(state.get("cursor", 0)) % len(candidates)
        chosen = candidates[cursor]
        state["cursor"] = cursor + 1
    elif mode == "shuffle":
        bag = [i for i in state.get("bag", []) if i in by_id]
        if not bag:
            bag = [c["id"] for c in candidates]
            rng.shuffle(bag)
        chosen = by_id[bag.pop(0)]
        state["bag"] = bag
    else:
        pool = candidates
        recent = state.get("recent", [])[-exclude_last:] if exclude_last > 0 else []
        allowed = [c for c in pool if c["id"] not in recent]
        if allowed:
            pool = allowed
        weights = [max(float(c.get("weight", 1.0)), 0.0) for c in pool]
        if sum(weights) <= 0:
            weights = [1.0] * len(pool)
        chosen = rng.choices(pool, weights=weights, k=1)[0]

    recent = state.get("recent", [])
    recent.append(chosen["id"])
    state["recent"] = recent[-50:]
    return chosen
