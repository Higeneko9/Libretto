import { beforeEach, describe, expect, it } from "vitest";
import { presetPayload } from "./Palette";
import { useStore, type LbNode } from "./store";
import type { Preset } from "./types";

const preset: Preset = {
  id: "p-00000001",
  category: "character",
  name: "Nancy",
  names: { "ja-JP": "ナンシー" },
  keywords: "nancy, red hair, green eyes",
  description: "a girl with red hair",
  negative: "blurry",
  labels: ["t-00000001"],
  weight: 1.5,
  lora: { name: "nancy.safetensors", strength: 0.8 },
  has_thumbnail: true,
  thumbnail_profiles: [],
};

const generate: LbNode = { id: "generate", type: "generate", position: { x: 600, y: 100 }, data: { profile: "sdxl" } };

// every field a preset defines that a node must carry (thumbnail flags are not part of a node)
const fields = ["name", "names", "keywords", "description", "negative", "labels", "weight", "lora"] as const;

beforeEach(() => {
  useStore.setState({ nodes: [generate], edges: [], selectedId: null, sceneReady: true });
});

describe("dropping a preset onto the graph", () => {
  it("creates a node with exactly the preset's values", () => {
    const { type, data } = presetPayload("character", preset, "default");
    useStore.getState().addNode(type, data, { x: 10, y: 20 });

    const node = useStore.getState().nodes.find((n) => n.type === "character")!;
    for (const field of fields) expect(node.data[field], field).toEqual(preset[field]);
    expect(node.data.presetId).toBe(preset.id);
    expect(node.data.lib).toBe("default");
    expect(node.position).toEqual({ x: 10, y: 20 });
  });

  it("gives a replaced node exactly the preset's values too", () => {
    useStore.getState().addNode("character", { name: "Old", keywords: "old" }, { x: 0, y: 0 });
    const oldId = useStore.getState().nodes.find((n) => n.type === "character")!.id;

    const { type, data } = presetPayload("character", preset, "default");
    useStore.getState().addNode(type, data, { x: 99, y: 99 }, oldId);

    const nodes = useStore.getState().nodes.filter((n) => n.type === "character");
    expect(nodes).toHaveLength(1);
    for (const field of fields) expect(nodes[0].data[field], field).toEqual(preset[field]);
  });

  it("gives two nodes dropped from the same preset identical values", () => {
    const { type, data } = presetPayload("character", preset, "default");
    useStore.getState().addNode(type, data, { x: 0, y: 0 });
    useStore.getState().addNode(type, data, { x: 300, y: 0 });

    const [a, b] = useStore.getState().nodes.filter((n) => n.type === "character");
    expect(a.id).not.toBe(b.id);
    expect(a.data).toEqual(b.data);
  });
});
