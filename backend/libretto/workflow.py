import copy

from .importer import _ancestors, _ref

PARAM_INPUTS = {
    "seed": "seed",
    "steps": "steps",
    "cfg": "cfg",
    "sampler": "sampler_name",
    "scheduler": "scheduler",
    "denoise": "denoise",
    "width": "width",
    "height": "height",
    "checkpoint": "ckpt_name",
}


def build_workflow(
    template: dict,
    profile: dict,
    positive: str,
    negative: str,
    params: dict,
    loras: list[dict],
) -> dict:
    """Fill a ComfyUI API-format template. Profile `injection` maps each parameter to node id(s)."""
    workflow = copy.deepcopy(template)
    injection = _with_latent_size(workflow, profile["injection"], params)

    def set_input(node_ids, name: str, value) -> None:
        for node_id in node_ids if isinstance(node_ids, list) else [node_ids]:
            workflow[str(node_id)]["inputs"][name] = value

    segments = [s.strip() for s in positive.split(" BREAK ") if s.strip()] or [positive]
    set_input(injection["positive"], injection.get("positive_input", "text"), segments[0])
    if len(segments) > 1:
        _split_break(workflow, injection["positive"], injection.get("positive_input", "text"), segments)
    if "negative" in injection:
        set_input(injection["negative"], injection.get("negative_input", "text"), negative)
    for key, default_input in PARAM_INPUTS.items():
        if key in params and params[key] is not None and key in injection:
            set_input(injection[key], injection.get(f"{key}_input", default_input), params[key])

    if loras:
        lora = profile.get("lora", {"mode": "checkpoint"})
        if lora["mode"] == "model_only":
            _insert_model_loras(workflow, str(lora["sampler"]), loras)
        else:
            _insert_loras(workflow, str(injection["checkpoint"]), loras)
    return workflow


def _with_latent_size(workflow: dict, injection: dict, params: dict) -> dict:
    """Profiles imported before resolution was injectable through links lack width/height: locate the empty latent feeding the sampler."""
    if "width" in injection or "height" in injection or not (params.get("width") or params.get("height")):
        return injection
    sampler = injection.get("steps") or injection.get("seed")
    sampler = sampler[0] if isinstance(sampler, list) else sampler
    if sampler is None or str(sampler) not in workflow:
        return injection
    for node_id in _ancestors(workflow, _ref(workflow[str(sampler)]["inputs"].get("latent_image")) or ""):
        node = workflow[node_id]
        if "Empty" in node["class_type"] and "width" in node["inputs"] and "height" in node["inputs"]:
            return {**injection, "width": node_id, "height": node_id}
    return injection


def _split_break(workflow: dict, node_ids, input_name: str, segments: list[str]) -> None:
    """ComfyUI's text encoders ignore BREAK, so encode each segment separately and join with ConditioningConcat."""
    for node_id in node_ids if isinstance(node_ids, list) else [node_ids]:
        node_id = str(node_id)
        source = workflow[node_id]
        encoded = [node_id]
        for segment in segments[1:]:
            new_id = str(_next_id(workflow))
            clone = copy.deepcopy(source)
            clone["inputs"][input_name] = segment
            workflow[new_id] = clone
            encoded.append(new_id)
        created = set(encoded)
        merged = encoded[0]
        for other in encoded[1:]:
            new_id = str(_next_id(workflow))
            workflow[new_id] = {
                "class_type": "ConditioningConcat",
                "inputs": {"conditioning_to": [merged, 0], "conditioning_from": [other, 0]},
            }
            created.add(new_id)
            merged = new_id
        for key, node in workflow.items():
            if key in created:
                continue
            for name, value in node.get("inputs", {}).items():
                if isinstance(value, list) and len(value) == 2 and str(value[0]) == node_id:
                    node["inputs"][name] = [merged, value[1]]


def apply_output_prefix(workflow: dict, prefix: str) -> None:
    """Override `filename_prefix` on every saving node (ComfyUI treats `a/b` as subfolder a, prefix b)."""
    for node in workflow.values():
        if isinstance(node.get("inputs", {}).get("filename_prefix"), str):
            node["inputs"]["filename_prefix"] = prefix


def _next_id(workflow: dict) -> int:
    return max(int(k) for k in workflow if k.isdigit()) + 1


def _insert_model_loras(workflow: dict, sampler_id: str, loras: list[dict]) -> None:
    """Chain LoraLoaderModelOnly nodes in front of the sampler's model input."""
    source = workflow[sampler_id]["inputs"]["model"]
    prev = source
    next_id = _next_id(workflow)
    for lora in loras:
        node_id = str(next_id)
        next_id += 1
        workflow[node_id] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": prev, "lora_name": lora["name"], "strength_model": lora["strength"]},
        }
        prev = [node_id, 0]
    for node in workflow.values():
        if node["class_type"] == "KSampler" and node["inputs"].get("model") == source:
            node["inputs"]["model"] = prev


def _insert_loras(workflow: dict, ckpt_id: str, loras: list[dict]) -> None:
    prev = ckpt_id
    new_ids: list[str] = []
    next_id = _next_id(workflow)
    for lora in loras:
        node_id = str(next_id)
        next_id += 1
        workflow[node_id] = {
            "class_type": "LoraLoader",
            "inputs": {
                "model": [prev, 0],
                "clip": [prev, 1],
                "lora_name": lora["name"],
                "strength_model": lora["strength"],
                "strength_clip": lora["strength"],
            },
        }
        new_ids.append(node_id)
        prev = node_id

    skip = set(new_ids)
    for node_id, node in workflow.items():
        if node_id in skip:
            continue
        for name, value in node["inputs"].items():
            if isinstance(value, list) and len(value) == 2 and value[0] == ckpt_id and value[1] in (0, 1):
                node["inputs"][name] = [prev, value[1]]
    # the first LoRA node must keep reading from the checkpoint itself
    workflow[new_ids[0]]["inputs"]["model"] = [ckpt_id, 0]
    workflow[new_ids[0]]["inputs"]["clip"] = [ckpt_id, 1]
