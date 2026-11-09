from libretto.workflow import build_workflow

TEMPLATE = {
    "1": {"class_type": "CLIPLoader", "inputs": {}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 0]}},
    "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 0]}},
    "6": {"class_type": "KSampler", "inputs": {"positive": ["4", 0], "negative": ["5", 0]}},
}
PROFILE = {"injection": {"positive": "4", "negative": "5"}}


def test_break_splits_into_concatenated_encoders():
    wf = build_workflow(TEMPLATE, PROFILE, "a, b BREAK c, d BREAK e", "neg", {}, [])
    encoders = [n for n in wf.values() if n["class_type"] == "CLIPTextEncode" and n["inputs"]["text"] != "neg"]
    assert sorted(n["inputs"]["text"] for n in encoders) == ["a, b", "c, d", "e"]
    concats = {k: n for k, n in wf.items() if n["class_type"] == "ConditioningConcat"}
    assert len(concats) == 2
    final = wf["6"]["inputs"]["positive"][0]
    assert final in concats
    assert wf["6"]["inputs"]["negative"] == ["5", 0]
    assert wf[concats[final]["inputs"]["conditioning_to"][0]]["class_type"] == "ConditioningConcat"


def test_no_break_keeps_workflow_unchanged():
    wf = build_workflow(TEMPLATE, PROFILE, "a, b", "neg", {}, [])
    assert len(wf) == len(TEMPLATE)
    assert wf["6"]["inputs"]["positive"] == ["4", 0]


def test_resolution_overrides_linked_latent_size_even_without_width_injection():
    template = {
        **TEMPLATE,
        "6": {"class_type": "KSampler", "inputs": {"positive": ["4", 0], "negative": ["5", 0], "latent_image": ["7", 0]}},
        "7": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": ["8", 0], "height": ["8", 1], "batch_size": 1}},
        "8": {"class_type": "ResolutionSelector", "inputs": {}},
    }
    profile = {"injection": {"positive": "4", "negative": "5", "steps": "6"}}
    wf = build_workflow(template, profile, "a", "n", {"width": 640, "height": 960}, [])
    assert wf["7"]["inputs"]["width"] == 640 and wf["7"]["inputs"]["height"] == 960
    assert build_workflow(template, profile, "a", "n", {}, [])["7"]["inputs"]["width"] == ["8", 0]
