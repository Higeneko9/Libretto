import random
import re
from dataclasses import dataclass, field

from . import categories as cats
from .collections import filter_candidates, pick_item
from .library import Library

RESERVED_NODE_TYPES = {"generate", "collection", "prompt"}
HAIR_COLORS = [
    "black", "dark brown", "brown", "light brown", "auburn", "red", "ginger", "orange", "blonde",
    "platinum blonde", "white", "silver", "gray", "pink", "purple", "blue", "light blue", "green",
]
RANDOM_COLOR = "random"


def apply_hair_color(text: str, color: str | None) -> str:
    """Fill a {color} placeholder, or prepend "<color> hair" when the text has none."""
    color = (color or "").strip()
    if "{color}" in text:
        text = text.replace("{color}", color) if color else re.sub(r"\{color\}\s*", "", text)
        return re.sub(r"\s{2,}", " ", text).strip()
    return f"{color} hair, {text}" if color and text else (f"{color} hair" if color else text)


def category_rank(order: list[str], categories: list[dict] | None = None) -> dict[str, float]:
    """Rank per category id. Categories missing from `order` follow the nearest earlier category (in library order) that is in it."""
    categories = categories if categories is not None else cats.DEFAULT_CATEGORIES
    rank = {c: float(i) for i, c in enumerate(order)}
    ids = [c["id"] for c in categories]
    for index, cid in enumerate(ids):
        if cid in rank:
            continue
        before = next((rank[p] for p in reversed(ids[:index]) if p in rank), None)
        if before is not None:
            rank[cid] = before + 0.1
    return rank


@dataclass
class CompiledPrompt:
    positive: str
    negative: str
    loras: list[dict] = field(default_factory=list)
    items: list[dict] = field(default_factory=list)
    picks: list[dict] = field(default_factory=list)


def find_generate_node(graph: dict) -> dict:
    for node in graph.get("nodes", []):
        if node.get("type") == "generate":
            return node
    raise ValueError("graph has no generate node")


def connected_nodes(graph: dict, generate_id: str) -> list[dict]:
    source_ids = [e["source"] for e in graph.get("edges", []) if e["target"] == generate_id]
    by_id = {n["id"]: n for n in graph.get("nodes", [])}
    seen, nodes = set(), []
    for sid in source_ids:
        if sid in by_id and sid not in seen and not by_id[sid].get("data", {}).get("disabled"):
            seen.add(sid)
            nodes.append(by_id[sid])
    return nodes


def resolve_nodes(
    graph: dict,
    library: Library,
    pick_seed: int,
    state: dict,
) -> tuple[list[dict], list[dict]]:
    """Resolve connected nodes into concrete items; collection nodes pick one preset."""
    generate = find_generate_node(graph)
    items: list[dict] = []
    picks: list[dict] = []
    for node in connected_nodes(graph, generate["id"]):
        data = node.get("data", {})
        ntype = node.get("type")
        if ntype == "collection":
            category = data.get("category")
            if category not in library.category_ids():
                raise ValueError(f"collection {node['id']} has invalid category: {category}")
            candidates = filter_candidates(
                library.list(category), data.get("filter_labels", []), data.get("item_ids", []), library.tags
            )
            rng = random.Random(f"{pick_seed}:{node['id']}")
            node_state = state.setdefault(node["id"], {})
            chosen = pick_item(
                candidates,
                data.get("mode", "random"),
                rng,
                node_state,
                int(data.get("exclude_last", 0)),
                data.get("fixed_id"),
            )
            color = data.get("hair_color") if library.category_info(category)["has_color"] else None
            if color == RANDOM_COLOR:
                color = random.Random(f"{pick_seed}:{node['id']}:color").choice(HAIR_COLORS)
            items.append(
                {**chosen, "category": category, "emphasis": data.get("emphasis", 1.0), "pos": node.get("position"), "hair_color": color, "node_id": node["id"], "owner": data.get("owner") or None}
            )
            picks.append(
                {"node_id": node["id"], "category": category, "item_id": chosen["id"], "name": chosen.get("name"), "color": color}
            )
        elif ntype == "prompt":
            items.append(
                {
                    "kind": "prompt",
                    "id": node["id"],
                    "category": data.get("category") or "",
                    "text": data.get("text", ""),
                    "polarity": data.get("polarity", "positive"),
                    "placement": data.get("placement", "inline"),
                    "pos": node.get("position"),
                    "node_id": node["id"],
                    "owner": data.get("owner") or None,
                }
            )
        elif ntype not in RESERVED_NODE_TYPES:
            items.append({**data, "category": ntype, "id": data.get("id") or node["id"], "pos": node.get("position"), "node_id": node["id"], "owner": data.get("owner") or None})
    return items, picks


def _weighted(text: str, emphasis: float) -> str:
    if emphasis and abs(float(emphasis) - 1.0) > 1e-6:
        return f"({text}:{float(emphasis):g})"
    return text


def group_by_character(ordered: list[dict], categories: list[dict] | None = None) -> list[dict]:
    """Move items that belong to a group head (character) right behind it and tag them with a shared "group"."""
    categories = categories if categories is not None else cats.DEFAULT_CATEGORIES

    def info(it: dict) -> dict:
        return cats.resolve(categories, it["category"])

    def is_head(it: dict) -> bool:
        return it.get("kind") != "prompt" and info(it)["kind"] == "group_head"

    characters = {it["node_id"] for it in ordered if is_head(it) and it.get("node_id")}

    def owned_by(it: dict) -> str | None:
        if it.get("kind") == "prompt":
            inline_text = it.get("placement", "inline") == "inline" and it.get("polarity") != "negative"
        else:
            inline_text = info(it)["can_belong"]
        owner = it.get("owner")
        return owner if inline_text and owner in characters and it.get("node_id") != owner and not is_head(it) else None

    members: dict[str, list[dict]] = {}
    for it in ordered:
        if (owner := owned_by(it)) is not None:
            members.setdefault(owner, []).append({**it, "group": owner})
    if not members:
        return ordered
    result: list[dict] = []
    for it in ordered:
        if owned_by(it) is not None:
            continue
        if is_head(it) and it.get("node_id") in characters:
            result.append({**it, "group": it["node_id"]})
            result.extend(members.get(it["node_id"], []))
        else:
            result.append(it)
    return result


def compile_items(items: list[dict], profile: dict, order_mode: str = "category", group_sep: str = "comma", categories: list[dict] | None = None) -> CompiledPrompt:
    categories = categories if categories is not None else cats.DEFAULT_CATEGORIES
    order = profile.get("order") or [c["id"] for c in categories]
    rank = category_rank(order, categories)
    if order_mode == "position":
        # canvas position: top-to-bottom rows, then left-to-right
        def pos_key(it: dict):
            p = it.get("pos") or {}
            return (round(float(p.get("y", 0)) / 40), float(p.get("x", 0)))

        ordered = sorted(items, key=pos_key)
    else:
        ordered = sorted(items, key=lambda it: rank.get(it["category"], float(len(rank))))
    ordered = group_by_character(ordered, categories)
    natural = profile.get("format") == "natural"

    def sentence(text: str) -> str:
        return text if text.endswith((".", "!", "?")) else text + "."

    parts: list[str] = []
    part_groups: list[str | None] = []
    negatives: list[str] = []
    pre_parts: list[str] = []
    app_parts: list[str] = []
    pre_negatives: list[str] = []
    app_negatives: list[str] = []
    loras: list[dict] = []
    templates = profile.get("natural", {})
    for item in ordered:
        if item.get("kind") == "prompt":
            text = (item.get("text") or "").strip()
            if not text:
                continue
            placement = item.get("placement", "inline")
            if item.get("polarity") == "negative":
                target = {"prepend": pre_negatives, "append": app_negatives}.get(placement, negatives)
            else:
                target = {"prepend": pre_parts, "append": app_parts}.get(placement, parts)
            target.append(text)
            if target is parts:
                part_groups.append(item.get("group"))
            continue
        info = cats.resolve(categories, item["category"])
        color = item.get("hair_color") if info["has_color"] else None
        if natural:
            text = (item.get("description") or item.get("keywords") or item.get("name") or "").strip()
            if info["has_color"]:
                text = apply_hair_color(text, color)
            if text:
                parts.append((templates.get(item["category"]) or info["template"]).format(text=text))
                part_groups.append(item.get("group"))
        else:
            text = (item.get("keywords") or item.get("name") or "").strip()
            if info["has_color"]:
                text = apply_hair_color(text, color)
            if text:
                parts.append(_weighted(text, item.get("emphasis", 1.0)))
                part_groups.append(item.get("group"))
        if item.get("negative"):
            negatives.append(item["negative"].strip())
        if item.get("lora") and item["lora"].get("name"):
            loras.append({"name": item["lora"]["name"], "strength": float(item["lora"].get("strength", 1.0))})

    prefix = profile.get("quality_prefix", "")
    if natural:
        body = [sentence(p) for p in pre_parts] + ([prefix] if prefix else []) + [sentence(p) for p in parts + app_parts]
        positive = " ".join(body)
    else:
        head = pre_parts + ([prefix] if prefix else [])
        segments: list[list[str]] = []
        last: object = object()
        for text, group in zip(parts, part_groups):
            if segments and group == last:
                segments[-1].append(text)
            else:
                segments.append([text])
            last = group
        if group_sep == "break" and len(segments) > 1:
            segments[0] = head + segments[0]
            segments[-1] = segments[-1] + app_parts
            positive = " BREAK ".join(", ".join(s) for s in segments)
        else:
            positive = ", ".join(head + parts + app_parts)

    template = [profile["negative_template"]] if profile.get("negative_template") else []
    negative_parts = pre_negatives + template + negatives + app_negatives
    negative = ", ".join(negative_parts) if profile.get("use_negative", True) else ""
    return CompiledPrompt(positive=positive, negative=negative, loras=loras, items=ordered)

def compile_graph(
    graph: dict,
    library: Library,
    profile: dict,
    pick_seed: int,
    state: dict,
) -> CompiledPrompt:
    items, picks = resolve_nodes(graph, library, pick_seed, state)
    options = find_generate_node(graph).get("data", {})
    if options.get("order"):
        profile = {**profile, "order": options["order"]}
    compiled = compile_items(items, profile, options.get("order_mode", "category"), options.get("group_sep", "comma"), library.categories())
    compiled.picks = picks
    natural = profile.get("format") == "natural"
    extra = (graph.get("scene_prompt") or "").strip()
    if extra:
        joiner = " " if natural else ", "
        compiled.positive = f"{compiled.positive}{joiner}{extra}" if compiled.positive else extra
    extra_negative = (graph.get("scene_negative") or "").strip()
    if extra_negative and profile.get("use_negative", True):
        compiled.negative = f"{compiled.negative}, {extra_negative}" if compiled.negative else extra_negative
    pre = (options.get("prepend_positive") or "").strip()
    app = (options.get("append_positive") or "").strip()
    joiner = " " if natural else ", "
    compiled.positive = joiner.join(p for p in (pre, compiled.positive, app) if p)
    if profile.get("use_negative", True):
        pre_n = (options.get("prepend_negative") or "").strip()
        app_n = (options.get("append_negative") or "").strip()
        compiled.negative = ", ".join(p for p in (pre_n, compiled.negative, app_n) if p)
    return compiled
