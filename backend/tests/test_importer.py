from libretto.importer import analyze, ui_to_api
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
