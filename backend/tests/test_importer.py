import pytest

from libretto.importer import WorkflowImportError, analyze, ui_to_api
from libretto.workflow import build_workflow

INFO = {
    "CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": [["a.safetensors"]]}}},
    "UNETLoader": {"input": {"required": {"unet_name": [["u.safetensors"]], "weight_dtype": [["default"]]}}},
    "CLIPTextEncode": {"input": {"required": {"text": ["STRING", {}], "clip": ["CLIP"]}}},
    "EmptyLatentImage": {"input": {"required": {"width": ["INT", {}], "height": ["INT", {}], "batch_size": ["INT", {}]}}},
    "KSampler": {
        "input": {
            "required": {
                "model": ["MODEL"],
                "seed": ["INT", {"control_after_generate": True}],
                "steps": ["INT", {}],
                "cfg": ["FLOAT", {}],
                "sampler_name": [["euler"]],
                "scheduler": [["normal"]],
                "positive": ["CONDITIONING"],
                "negative": ["CONDITIONING"],
                "latent_image": ["LATENT"],
                "denoise": ["FLOAT", {}],
            }
        }
    },
}


def ui_workflow(loader: str, loader_values: list):
    def node(i, t, inputs=None, values=None, mode=0):
        return {"id": i, "type": t, "mode": mode, "inputs": inputs or [], "widgets_values": values or [], "outputs": []}

    return {
        "nodes": [
            node(1, loader, values=loader_values),
            node(2, "CLIPTextEncode", [{"name": "clip", "link": 1}], ["masterpiece, 1girl"]),
            node(3, "CLIPTextEncode", [{"name": "clip", "link": 2}], ["lowres"]),
            node(4, "EmptyLatentImage", values=[832, 1216, 1]),
            node(
                5,
                "KSampler",
                [
                    {"name": "model", "link": 3},
                    {"name": "positive", "link": 4},
                    {"name": "negative", "link": 5},
                    {"name": "latent_image", "link": 6},
                ],
                [123, "randomize", 28, 6.5, "euler", "normal", 1.0],
            ),
        ],
        "links": [[1, 1, 1, 2, 0, "CLIP"], [2, 1, 1, 3, 0, "CLIP"], [3, 1, 0, 5, 0, "MODEL"], [4, 2, 0, 5, 1, "C"], [5, 3, 0, 5, 2, "C"], [6, 4, 0, 5, 3, "L"]],
    }


def test_convert_and_analyze_checkpoint_workflow():
    api = ui_to_api(ui_workflow("CheckpointLoaderSimple", ["a.safetensors"]), INFO.get)
    sampler = api["5"]["inputs"]
    assert sampler["steps"] == 28 and sampler["cfg"] == 6.5 and sampler["denoise"] == 1.0
    assert sampler["positive"] == ["2", 0] and sampler["model"] == ["1", 0]

    result = analyze(api, keep_positive=True)
    assert result["injection"]["positive"] == "2" and result["injection"]["negative"] == "3"
    assert result["injection"]["width"] == "4" and result["injection"]["checkpoint"] == "1"
    assert result["defaults"]["checkpoint"] == "a.safetensors" and result["defaults"]["width"] == 832
    assert result["quality_prefix"] == "masterpiece, 1girl" and result["negative_template"] == "lowres"
    assert result["lora"]["mode"] == "checkpoint"

    profile = {"injection": result["injection"], "lora": result["lora"]}
    workflow = build_workflow(api, profile, "P", "N", {"seed": 5, "width": 512, "checkpoint": "b.safetensors"}, [])
    assert workflow["2"]["inputs"]["text"] == "P" and workflow["3"]["inputs"]["text"] == "N"
    assert workflow["5"]["inputs"]["seed"] == 5 and workflow["4"]["inputs"]["width"] == 512
    assert workflow["1"]["inputs"]["ckpt_name"] == "b.safetensors"


def test_unet_workflow_uses_model_only_lora():
    api = ui_to_api(ui_workflow("UNETLoader", ["u.safetensors", "default"]), INFO.get)
    result = analyze(api)
    assert result["injection"]["checkpoint_input"] == "unet_name" and result["lora"]["mode"] == "model_only"
    profile = {"injection": result["injection"], "lora": result["lora"]}
    workflow = build_workflow(api, profile, "P", "N", {"checkpoint": "z.safetensors"}, [{"name": "l.safetensors", "strength": 0.7}])
    assert workflow["1"]["inputs"]["unet_name"] == "z.safetensors"
    lora_id = workflow["5"]["inputs"]["model"][0]
    assert workflow[lora_id]["class_type"] == "LoraLoaderModelOnly"
    assert workflow[lora_id]["inputs"]["model"] == ["1", 0]


def test_subgraph_is_flattened_with_promoted_widgets_and_links():
    def node(i, t, inputs=None, values=None):
        return {"id": i, "type": t, "mode": 0, "inputs": inputs or [], "widgets_values": values or [], "outputs": []}

    sg_id = "3301b744-2960-415a-83b0-fe8a89d99fdb"
    subgraph = {
        "id": sg_id,
        "inputs": [{"name": "unet_name"}, {"name": "text"}, {"name": "width"}],
        "nodes": [
            node(1, "UNETLoader", [{"name": "unet_name", "link": 10}], ["u.safetensors", "default"]),
            node(2, "CLIPTextEncode", [{"name": "text", "link": 11}]),
            node(4, "EmptyLatentImage", [{"name": "width", "link": 12}], [512, 512, 1]),
            node(5, "KSampler", [{"name": "model", "link": 1}, {"name": "positive", "link": 2}, {"name": "negative", "link": 3},
                                  {"name": "latent_image", "link": 4}], [1, "fixed", 20, 5.0, "euler", "normal", 1.0]),
        ],
        "links": [
            {"id": 10, "origin_id": -10, "origin_slot": 0, "target_id": 1, "target_slot": 0, "type": "COMBO"},
            {"id": 11, "origin_id": -10, "origin_slot": 1, "target_id": 2, "target_slot": 1, "type": "STRING"},
            {"id": 12, "origin_id": -10, "origin_slot": 2, "target_id": 4, "target_slot": 0, "type": "INT"},
            {"id": 1, "origin_id": 1, "origin_slot": 0, "target_id": 5, "target_slot": 0, "type": "MODEL"},
            {"id": 2, "origin_id": 2, "origin_slot": 0, "target_id": 5, "target_slot": 1, "type": "C"},
            {"id": 3, "origin_id": 2, "origin_slot": 0, "target_id": 5, "target_slot": 2, "type": "C"},
            {"id": 4, "origin_id": 4, "origin_slot": 0, "target_id": 5, "target_slot": 3, "type": "L"},
            {"id": 5, "origin_id": 5, "origin_slot": 0, "target_id": -20, "target_slot": 0, "type": "LATENT"},
        ],
    }
    ui = {
        "nodes": [
            node(7, sg_id, [{"name": "unet_name", "widget": {"name": "unet_name"}}, {"name": "text", "widget": {"name": "text"}},
                            {"name": "width", "widget": {"name": "width"}, "link": 20}], ["u.safetensors", "a girl"]),
            node(8, "EmptyLatentImage", values=[640, 640, 1]),
        ],
        "links": [[20, 8, 0, 7, 2, "INT"]],
        "definitions": {"subgraphs": [subgraph]},
    }
    api = ui_to_api(ui, INFO.get)
    assert api["7:1"]["inputs"]["unet_name"] == "u.safetensors"
    assert api["7:2"]["inputs"]["text"] == "a girl"
    assert api["7:4"]["inputs"]["width"] == ["8", 0]
    assert api["7:5"]["inputs"]["model"] == ["7:1", 0]


def advanced_workflow(zero_negative=False):
    return {
        "1": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "original"}},
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux-2-klein.safetensors", "weight_dtype": "default"}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": ["1", 0], "clip": ["4", 0]}},
        "4": {"class_type": "CLIPLoader", "inputs": {}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "negative", "clip": ["4", 0]}},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["3", 0]}},
        "7": {"class_type": "CFGGuider", "inputs": {"model": ["2", 0], "positive": ["3", 0], "negative": ["6" if zero_negative else "5", 0], "cfg": 5.0}},
        "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": 123}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "10": {"class_type": "PrimitiveInt", "inputs": {"value": 1024}},
        "11": {"class_type": "PrimitiveInt", "inputs": {"value": 768}},
        "12": {"class_type": "Flux2Scheduler", "inputs": {"steps": 20, "width": ["10", 0], "height": ["11", 0]}},
        "13": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": ["10", 0], "height": ["11", 0], "batch_size": 1}},
        "14": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["8", 0], "guider": ["7", 0], "sampler": ["9", 0], "sigmas": ["12", 0], "latent_image": ["13", 0]}},
    }


def test_advanced_sampler_maps_connected_parameters_and_preserves_links():
    api = advanced_workflow()
    result = analyze(api, keep_positive=True)
    assert result["quality_prefix"] == "original"
    assert result["defaults"]["width"] == 1024 and result["defaults"]["height"] == 768
    profile = {"injection": result["injection"], "lora": result["lora"]}
    workflow = build_workflow(api, profile, "new prompt", "new negative",
                              {"seed": 42, "width": 640, "height": 896, "steps": 4,
                               "cfg": 1, "sampler": "heun", "scheduler": "ignored",
                               "checkpoint": "other.safetensors"},
                              [{"name": "a.safetensors", "strength": 0.7}])
    assert workflow["1"]["inputs"]["value"] == "new prompt"
    assert workflow["5"]["inputs"]["text"] == "new negative"
    assert workflow["8"]["inputs"]["noise_seed"] == 42
    assert workflow["10"]["inputs"]["value"] == 640 and workflow["11"]["inputs"]["value"] == 896
    assert workflow["13"]["inputs"]["width"] == workflow["12"]["inputs"]["width"] == ["10", 0]
    assert workflow["13"]["inputs"]["height"] == workflow["12"]["inputs"]["height"] == ["11", 0]
    assert workflow["12"]["inputs"] == {"steps": 4, "width": ["10", 0], "height": ["11", 0]}
    assert workflow["9"]["inputs"]["sampler_name"] == "heun"
    assert workflow["7"]["inputs"]["cfg"] == 1
    assert workflow["2"]["inputs"]["unet_name"] == "other.safetensors"
    lora = workflow[workflow["7"]["inputs"]["model"][0]]
    assert lora["class_type"] == "LoraLoaderModelOnly" and lora["inputs"]["model"] == ["2", 0]


def test_advanced_zeroed_negative_does_not_replace_positive():
    result = analyze(advanced_workflow(zero_negative=True))
    assert not result["use_negative"]
    assert "negative" not in result["injection"]


def test_advanced_rejects_unsupported_noise():
    api = advanced_workflow()
    api["8"]["class_type"] = "CustomNoise"
    with pytest.raises(WorkflowImportError, match="unsupported SamplerCustomAdvanced noise: CustomNoise"):
        analyze(api)


def test_advanced_shared_dimension_input_is_not_overridden():
    api = advanced_workflow()
    api["12"]["inputs"]["height"] = ["10", 0]
    api["13"]["inputs"]["height"] = ["10", 0]
    result = analyze(api)
    assert "width" not in result["injection"] and "height" not in result["injection"]
    assert any("share one input" in warning for warning in result["warnings"])


def test_advanced_rejects_basic_scheduler_with_another_model():
    api = advanced_workflow()
    api["12"] = {"class_type": "BasicScheduler", "inputs": {"model": ["4", 0], "scheduler": "normal", "steps": 20, "denoise": 1.0}}
    with pytest.raises(WorkflowImportError, match="same model connection"):
        analyze(api)


def test_basic_scheduler_tracks_the_guider_model_and_supported_parameters():
    api = advanced_workflow()
    api["12"] = {"class_type": "BasicScheduler", "inputs": {
        "model": ["2", 0], "scheduler": "normal", "steps": 20, "denoise": 1.0,
    }}
    result = analyze(api)
    workflow = build_workflow(api, result, "positive", "negative",
                              {"scheduler": "karras", "denoise": 0.8},
                              [{"name": "a.safetensors", "strength": 0.7}])
    assert workflow["12"]["inputs"]["scheduler"] == "karras"
    assert workflow["12"]["inputs"]["denoise"] == 0.8
    assert workflow["12"]["inputs"]["model"] == workflow["7"]["inputs"]["model"]


def test_subgraph_input_names_map_to_definition_slots():
    ui = {
        "nodes": [
            {"id": 1, "type": "PrimitiveStringMultiline", "inputs": [], "widgets_values": ["prompt"]},
            {"id": 2, "type": "subgraph", "inputs": [{"name": "text", "link": 1}], "widgets_values": []},
        ],
        "links": [[1, 1, 0, 2, 0, "STRING"]],
        "definitions": {"subgraphs": [{
            "id": "subgraph", "inputs": [{"name": "width"}, {"name": "text"}],
            "nodes": [{"id": 3, "type": "CLIPTextEncode", "inputs": [{"name": "text", "link": 2}], "widgets_values": [""]}],
            "links": [{"id": 2, "origin_id": -10, "origin_slot": 1, "target_id": 3, "target_slot": 0, "type": "STRING"}],
        }]},
    }
    info = {**INFO, "PrimitiveStringMultiline": {"input": {"required": {"value": ["STRING", {}]}}}}
    api = ui_to_api(ui, info.get)
    assert api["2:3"]["inputs"]["text"] == ["1", 0]


def test_subgraph_advanced_workflow_imports_and_injects_end_to_end():
    template = advanced_workflow()
    metadata = {
        "PrimitiveStringMultiline": {"value": "STRING"},
        "UNETLoader": {"unet_name": ["model"], "weight_dtype": ["default"]},
        "CLIPTextEncode": {"text": "STRING", "clip": "CLIP"},
        "CLIPLoader": {},
        "ConditioningZeroOut": {"conditioning": "CONDITIONING"},
        "CFGGuider": {"model": "MODEL", "positive": "CONDITIONING", "negative": "CONDITIONING", "cfg": "FLOAT"},
        "RandomNoise": {"noise_seed": "INT"},
        "KSamplerSelect": {"sampler_name": ["euler"]},
        "PrimitiveInt": {"value": "INT"},
        "Flux2Scheduler": {"steps": "INT", "width": "INT", "height": "INT"},
        "EmptyFlux2LatentImage": {"width": "INT", "height": "INT", "batch_size": "INT"},
        "SamplerCustomAdvanced": {"noise": "NOISE", "guider": "GUIDER", "sampler": "SAMPLER", "sigmas": "SIGMAS", "latent_image": "LATENT"},
    }
    info = {node_type: {"input": {"required": {name: [kind, {}] for name, kind in fields.items()}}}
            for node_type, fields in metadata.items()}
    links = []
    nodes = []
    for node_id, node in template.items():
        if node_id == "1":
            continue
        ui_inputs, values = [], []
        for name, kind in metadata[node["class_type"]].items():
            value = node["inputs"][name]
            if isinstance(value, list) and len(value) == 2:
                link_id = len(links) + 1
                origin = -10 if value[0] == "1" else int(value[0])
                slot = 1 if origin == -10 else value[1]
                links.append({"id": link_id, "origin_id": origin, "origin_slot": slot,
                              "target_id": int(node_id), "target_slot": 0, "type": kind})
                ui_inputs.append({"name": name, "link": link_id})
            elif isinstance(kind, list) or kind in {"STRING", "INT", "FLOAT"}:
                values.append(value)
        nodes.append({"id": int(node_id), "type": node["class_type"], "inputs": ui_inputs, "widgets_values": values})
    ui = {
        "nodes": [
            {"id": 1, "type": "PrimitiveStringMultiline", "inputs": [], "widgets_values": ["original"]},
            {"id": 20, "type": "subgraph", "inputs": [{"name": "text", "link": 100}], "widgets_values": []},
        ],
        "links": [[100, 1, 0, 20, 0, "STRING"]],
        "definitions": {"subgraphs": [{"id": "subgraph", "inputs": [{"name": "width"}, {"name": "text"}],
                                       "nodes": nodes, "links": links}]},
    }
    api = ui_to_api(ui, info.get)
    analysis = analyze(api)
    workflow = build_workflow(api, analysis, "new prompt", "new negative",
                              {"seed": 42, "width": 640, "height": 896}, [])
    assert workflow["1"]["inputs"]["value"] == "new prompt"
    assert workflow["20:8"]["inputs"]["noise_seed"] == 42
    assert workflow["20:10"]["inputs"]["value"] == 640
    assert workflow["20:11"]["inputs"]["value"] == 896
    assert workflow["20:12"]["inputs"]["width"] == ["20:10", 0]
