"""Convert ComfyUI UI-format workflows to API format and derive a Libretto profile from them."""

import json
import re
from typing import Callable

import yaml

SKIP_TYPES = {"Note", "MarkdownNote"}
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
NATURAL_HINTS = ("flux", "qwen", "moss", "krea", "z-image", "zimage", "hidream", "chroma")
SAMPLER_KEYS = {
    "seed": "seed",
    "steps": "steps",
    "cfg": "cfg",
    "sampler": "sampler_name",
    "scheduler": "scheduler",
    "denoise": "denoise",
}


class WorkflowImportError(ValueError):
    pass


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "workflow"


def is_api_format(workflow: dict) -> bool:
    return bool(workflow) and "nodes" not in workflow and all(
        isinstance(v, dict) and "class_type" in v for v in workflow.values()
    )


def _norm_links(raw: list) -> list[list]:
    out = []
    for link in raw:
        if isinstance(link, dict):
            out.append([link["id"], link["origin_id"], link["origin_slot"], link["target_id"], link["target_slot"], link.get("type")])
        else:
            out.append(list(link[:6]))
    return out


def flatten_subgraphs(ui: dict) -> dict:
    """Inline every subgraph instance into the top-level graph so the rest of the importer sees plain nodes."""
    definitions = {sg["id"]: sg for sg in ui.get("definitions", {}).get("subgraphs", [])}
    nodes = [dict(n) for n in ui["nodes"]]
    links = _norm_links(ui.get("links", []))
    if not definitions:
        return {**ui, "nodes": nodes, "links": links}
    next_link = max([l[0] for l in links] + [0]) + 1000

    for _ in range(10):
        instance = next((n for n in nodes if n["type"] in definitions and n.get("mode", 0) not in (2, 4)), None)
        if instance is None:
            break
        sg = definitions[instance["type"]]
        prefix = f"{instance['id']}:"
        nodes.remove(instance)

        widget_values = instance.get("widgets_values") or []
        widget_index = 0
        input_source: dict[int, tuple] = {}
        for slot, inp in enumerate(instance.get("inputs", [])):
            if inp.get("link") is not None:
                link = next(l for l in links if l[0] == inp["link"])
                input_source[slot] = ("link", link[1], link[2])
            elif "widget" in inp:
                if widget_index < len(widget_values):
                    input_source[slot] = ("const", widget_values[widget_index], inp.get("type"))
            if "widget" in inp:
                widget_index += 1
        links = [l for l in links if l[3] != instance["id"]]

        inner_nodes = [json.loads(json.dumps(n)) for n in sg["nodes"]]
        id_map = {n["id"]: f"{prefix}{n['id']}" for n in inner_nodes}
        link_ids: dict[int, int] = {}
        out_map: dict[int, tuple] = {}
        for raw in _norm_links(sg["links"]):
            lid, origin, oslot, target, tslot, ltype = raw
            if target == -20:
                out_map[tslot] = (id_map[origin], oslot)
                continue
            new_id = next_link
            next_link += 1
            link_ids[lid] = new_id
            if origin == -10:
                source = input_source.get(oslot)
                if source is None:
                    link_ids.pop(lid)
                    continue
                if source[0] == "link":
                    links.append([new_id, source[1], source[2], id_map[target], tslot, ltype])
                else:
                    const_id = f"{prefix}const{oslot}"
                    if not any(n["id"] == const_id for n in nodes):
                        nodes.append({"id": const_id, "type": "PrimitiveNode", "mode": 0, "inputs": [],
                                      "outputs": [{"type": ltype, "name": "value"}], "widgets_values": [source[1]]})
                    links.append([new_id, const_id, 0, id_map[target], tslot, ltype])
            else:
                links.append([new_id, id_map[origin], oslot, id_map[target], tslot, ltype])
        for n in inner_nodes:
            for inp in n.get("inputs", []):
                inp["link"] = link_ids.get(inp.get("link"))
            n["id"] = id_map[n["id"]]
            nodes.append(n)
        for l in links:
            if l[1] == instance["id"]:
                if l[2] not in out_map:
                    raise WorkflowImportError(f"subgraph output {l[2]} of node {instance['id']} is not connected")
                l[1], l[2] = out_map[l[2]]
    return {**ui, "nodes": nodes, "links": links}


def ui_to_api(ui: dict, object_info: Callable[[str], dict | None]) -> dict:
    if is_api_format(ui):
        return ui
    if "nodes" not in ui:
        raise WorkflowImportError("not a ComfyUI workflow file")
    ui = flatten_subgraphs(ui)

    links: dict[int, tuple[int, int]] = {}
    for link in ui.get("links", []):
        if isinstance(link, dict):
            links[link["id"]] = (link["origin_id"], link["origin_slot"])
        else:
            links[link[0]] = (link[1], link[2])
    nodes = {n["id"]: n for n in ui["nodes"]}

    def resolve(link_id: int, depth: int = 0) -> tuple:
        if depth > 50 or link_id not in links:
            raise WorkflowImportError("broken link in workflow")
        origin, slot = links[link_id]
        node = nodes[origin]
        mode = node.get("mode", 0)
        if node["type"] == "Reroute":
            return resolve(node["inputs"][0]["link"], depth + 1)
        if node["type"] == "PrimitiveNode":
            return ("const", node["widgets_values"][0])
        if mode == 4:
            out_type = node["outputs"][slot]["type"]
            for inp in node.get("inputs", []):
                if inp.get("link") is not None and inp.get("type") == out_type:
                    return resolve(inp["link"], depth + 1)
            raise WorkflowImportError(f"bypassed node {origin} ({node['type']}) has no pass-through input")
        if mode == 2:
            raise WorkflowImportError(f"node {origin} ({node['type']}) is muted but still used")
        return ("ref", str(origin), slot)

    api: dict[str, dict] = {}
    for node_id, node in nodes.items():
        node_type = node["type"]
        if node_type in SKIP_TYPES or node_type in ("Reroute", "PrimitiveNode") or node.get("mode", 0) in (2, 4):
            continue
        info = object_info(node_type)
        if info is None:
            hint = " (looks like a subgraph; expand it in ComfyUI first)" if re.fullmatch(r"[0-9a-f-]{36}", node_type) else ""
            raise WorkflowImportError(f"node type not available on the server: {node_type}{hint}")

        widget_specs: list[tuple[str, dict]] = []
        for section in ("required", "optional"):
            for name, spec in info.get("input", {}).get(section, {}).items():
                kind = spec[0]
                config = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
                if (isinstance(kind, list) or kind in WIDGET_TYPES) and not config.get("forceInput"):
                    widget_specs.append((name, config))

        inputs: dict = {}
        values = node.get("widgets_values", [])
        if isinstance(values, dict):
            inputs.update(values)
        else:
            ui_names = [i["name"] for i in node.get("inputs", []) if "widget" in i]
            if len(ui_names) >= len(widget_specs) and ui_names:
                # dynamic widgets (e.g. DynamicCombo) are only listed flat in the UI node's own inputs
                configs = dict(widget_specs)
                names = [(n, configs.get(n, {})) for n in ui_names]
            else:
                names = widget_specs
            index = 0
            for name, config in names:
                if index >= len(values):
                    break
                inputs[name] = values[index]
                index += 2 if config.get("control_after_generate") else 1

        for inp in node.get("inputs", []):
            if inp.get("link") is None:
                continue
            kind = resolve(inp["link"])
            inputs[inp["name"]] = kind[1] if kind[0] == "const" else [kind[1], kind[2]]
        api[str(node_id)] = {"class_type": node_type, "inputs": inputs, "_meta": {"title": node.get("title") or node_type}}
    return api


def _ref(value) -> str | None:
    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
        return value[0]
    return None


def _literal_or_link(value) -> bool:
    return isinstance(value, int) or _ref(value) is not None


def _ancestors(api: dict, start: str) -> list[str]:
    seen, order, queue = set(), [], [start]
    while queue:
        current = queue.pop(0)
        if current in seen or current not in api:
            continue
        seen.add(current)
        order.append(current)
        for value in api[current]["inputs"].values():
            ref = _ref(value)
            if ref:
                queue.append(ref)
    return order


def _find_string_source(api: dict, start: str | None) -> tuple[str, str, str] | None:
    """Breadth-first search upstream for a node holding the literal prompt text: (node, input, text)."""
    queue, seen = [start], set()
    while queue:
        current = queue.pop(0)
        if current is None or current in seen or current not in api:
            continue
        seen.add(current)
        node = api[current]
        if "Primitive" in node["class_type"] and isinstance(node["inputs"].get("value"), str):
            return current, "value", node["inputs"]["value"]
        if node["class_type"] == "ComfySwitchNode" and isinstance(node["inputs"].get("on_false"), str):
            return current, "on_false", node["inputs"]["on_false"]
        queue.extend(_ref(v) for v in node["inputs"].values() if _ref(v))
    return None


def _text_target(api: dict, conditioning_ref, warnings: list[str], label: str) -> tuple[str, str, str] | None:
    """Follow a conditioning link to its text encoder and return (node, input, current text)."""
    current = _ref(conditioning_ref)
    slot = conditioning_ref[1] if isinstance(conditioning_ref, list) else 0
    for _ in range(20):
        if current is None or current not in api:
            return None
        node = api[current]
        inputs = node["inputs"]
        text_input = None
        if node["class_type"] == "CLIPTextEncode":
            text_input = "text"
        elif not any("conditioning" in k for k in inputs):
            text_input = next((n for n in (("prompt", "negative_prompt") if slot == 0 else ("negative_prompt",)) if n in inputs), None)
        if text_input:
            text = inputs.get(text_input)
            if isinstance(text, str):
                return current, text_input, text
            found = _find_string_source(api, _ref(text))
            if found:
                if found[0] != _ref(text):
                    warnings.append(f"{label} text passes through other nodes (e.g. a prompt enhancer or switch); check its toggle in the workflow")
                return found
            warnings.append(f"{label} text is driven by an unsupported node; it will not be replaced")
            return None
        nxt = next(
            (v for k, v in inputs.items() if "conditioning" in k and _ref(v)),
            None,
        )
        current = _ref(nxt)
        slot = nxt[1] if nxt else 0
    return None


def analyze(api: dict, keep_positive: bool = False, keep_negative: bool = True) -> dict:
    """Derive profile fields (injection map, defaults, templates) from an API-format workflow."""
    warnings: list[str] = []
    samplers = [k for k, n in api.items() if n["class_type"] == "KSampler"]
    if not samplers:
        raise WorkflowImportError("no KSampler node found; only KSampler-based workflows are supported")
    primary = next(
        (
            s
            for s in samplers
            if any(
                "Empty" in api[a]["class_type"] and "Latent" in api[a]["class_type"]
                for a in _ancestors(api, _ref(api[s]["inputs"].get("latent_image")) or "")
            )
        ),
        samplers[0],
    )
    sampler = api[primary]["inputs"]
    injection: dict = {"seed": samplers}
    defaults: dict = {}
    for key, input_name in SAMPLER_KEYS.items():
        if key != "seed" and isinstance(sampler.get(input_name), (int, float, str)):
            injection[key] = primary
            defaults[key] = sampler[input_name]

    positive = _text_target(api, sampler.get("positive"), warnings, "positive prompt")
    if positive is None:
        raise WorkflowImportError("could not find the positive prompt text node")
    negative = _text_target(api, sampler.get("negative"), warnings, "negative prompt")
    injection["positive"], injection["positive_input"] = positive[0], positive[1]
    if negative:
        injection["negative"], injection["negative_input"] = negative[0], negative[1]

    for ancestor in _ancestors(api, _ref(sampler.get("latent_image")) or ""):
        inputs = api[ancestor]["inputs"]
        if "Empty" in api[ancestor]["class_type"] and all(_literal_or_link(inputs.get(k)) for k in ("width", "height")):
            injection["width"] = injection["height"] = ancestor
            if isinstance(inputs["width"], int) and isinstance(inputs["height"], int):
                defaults["width"], defaults["height"] = inputs["width"], inputs["height"]
            break
    else:
        warnings.append("no empty latent node with width/height found; resolution comes from the workflow")

    lora = {"mode": "model_only", "sampler": primary}
    for ancestor in _ancestors(api, _ref(sampler.get("model")) or ""):
        node = api[ancestor]
        for loader, input_name in (("CheckpointLoaderSimple", "ckpt_name"), ("UNETLoader", "unet_name")):
            if node["class_type"] == loader and isinstance(node["inputs"].get(input_name), str):
                injection["checkpoint"], injection["checkpoint_input"] = ancestor, input_name
                defaults["checkpoint"] = node["inputs"][input_name]
                if loader == "CheckpointLoaderSimple":
                    lora = {"mode": "checkpoint", "sampler": primary}
                break
        if "checkpoint" in injection:
            break
    else:
        warnings.append("model loader not recognized; checkpoint cannot be overridden")

    guess_natural = negative is None or any(h in str(defaults.get("checkpoint", "")).lower() for h in NATURAL_HINTS)
    return {
        "injection": injection,
        "defaults": defaults,
        "lora": lora,
        "format": "natural" if guess_natural else "tags",
        "use_negative": negative is not None,
        "quality_prefix": positive[2].strip().rstrip(",") if keep_positive else "",
        "negative_template": negative[2].strip() if negative and keep_negative else "",
        "warnings": warnings,
    }


def build_profile(name: str, source_path: str, template_file: str, analysis: dict, fmt: str | None) -> dict:
    profile = {
        "name": name,
        "source": {"type": "comfyui", "path": source_path},
        "format": fmt or analysis["format"],
        "order": ["style", "character", "hair", "costume", "pose", "emotion", "props", "situation", "location", "lighting", "view"],
        "quality_prefix": analysis["quality_prefix"],
        "negative_template": analysis["negative_template"],
        "use_negative": analysis["use_negative"],
        "workflow_template": template_file,
        "defaults": analysis["defaults"],
        "injection": analysis["injection"],
        "lora": analysis["lora"],
    }
    if profile["format"] == "natural":
        profile["natural"] = {
            "style": "A {text} image",
            "hair": "She has {text}",
            "location": "The scene takes place in {text}",
            "lighting": "The lighting is {text}",
            "view": "Shot as {text}",
        }
    return profile


def dump_profile(profile: dict) -> str:
    return yaml.safe_dump(profile, allow_unicode=True, sort_keys=False)
