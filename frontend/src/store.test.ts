import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATEGORIES, normalizeOrder } from "./types";
import { migrateLegacyPrompts, resetHistory, useStore, type LbNode } from "./store";

const generate = (): LbNode => ({
  id: "generate",
  type: "generate",
  position: { x: 600, y: 100 },
  data: { profile: "sdxl" },
});

const character = (): LbNode => ({
  id: "c1",
  type: "character",
  position: { x: 0, y: 0 },
  data: { name: "Nancy", keywords: "nancy" },
});

const text = () => useStore.getState().nodes.find((n) => n.id === "c1")?.data.keywords;
const edit = (keywords: string) => useStore.getState().updateNode("c1", { keywords });
const settle = () => vi.advanceTimersByTime(500);

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState({ nodes: [generate(), character()], edges: [], scenePrompt: "", sceneNegative: "", selectedId: null, sceneReady: false });
  useStore.setState({ sceneReady: true });
  resetHistory();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("addNode replacement", () => {
  it("replaces only the targeted node when categories match", () => {
    const { addNode } = useStore.getState();
    addNode("character", { name: "Mia", keywords: "mia" }, { x: 5, y: 5 }, "c1");
    let nodes = useStore.getState().nodes;
    expect(nodes.filter((n) => n.type === "character")).toHaveLength(1);
    expect(nodes.find((n) => n.id === "c1")?.data.name).toBe("Mia");

    addNode("collection", { category: "character", mode: "random" }, { x: 0, y: 0 }, "c1");
    nodes = useStore.getState().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.id === "c1")?.type).toBe("collection");
  });

  it("adds a new node when dropped elsewhere or on a different category", () => {
    const { addNode } = useStore.getState();
    addNode("character", { name: "Mia" }, { x: 0, y: 0 });
    addNode("costume", { name: "Suit" }, { x: 0, y: 0 }, "c1");
    addNode("character", { name: "Zed" }, { x: 0, y: 0 }, "generate");
    expect(useStore.getState().nodes).toHaveLength(5);
    expect(useStore.getState().nodes.find((n) => n.id === "c1")?.data.name).toBe("Nancy");
  });
});

describe("addNodeFocused", () => {
  it("selects only the new node and asks the canvas to scroll to it", () => {
    useStore.setState({ nodes: [generate(), { ...character(), selected: true }] });
    useStore.getState().addNodeFocused("costume", { name: "Suit" });
    const { nodes, focusId, selectedId } = useStore.getState();
    const added = nodes.find((n) => n.type === "costume")!;
    expect(focusId).toBe(added.id);
    expect(selectedId).toBe(added.id);
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([added.id]);
  });
});

describe("undo/redo", () => {
  it("undoes and redoes an edit", () => {
    edit("nancy, smiling");
    settle();
    expect(useStore.getState().canUndo).toBe(true);

    useStore.getState().undo();
    expect(text()).toBe("nancy");
    expect(useStore.getState().canRedo).toBe(true);

    useStore.getState().redo();
    expect(text()).toBe("nancy, smiling");
    expect(useStore.getState().canRedo).toBe(false);
  });

  it("coalesces rapid edits into a single step", () => {
    edit("a");
    edit("ab");
    edit("abc");
    settle();
    useStore.getState().undo();
    expect(text()).toBe("nancy");
    expect(useStore.getState().canUndo).toBe(false);
  });

  it("keeps separate steps for edits made apart in time", () => {
    edit("one");
    settle();
    edit("two");
    settle();
    useStore.getState().undo();
    expect(text()).toBe("one");
    useStore.getState().undo();
    expect(text()).toBe("nancy");
  });

  it("undoes an edit that has not been committed yet", () => {
    edit("pending");
    useStore.getState().undo();
    expect(text()).toBe("nancy");
  });

  it("does not record selection changes", () => {
    useStore.getState().select("c1");
    useStore.getState().onNodesChange([{ id: "c1", type: "select", selected: true }]);
    settle();
    expect(useStore.getState().canUndo).toBe(false);
  });

  it("records scene prompt changes", () => {
    useStore.getState().setScenePrompt("rainy street");
    settle();
    useStore.getState().undo();
    expect(useStore.getState().scenePrompt).toBe("");
  });

  it("restores removed nodes and their edges", () => {
    useStore.getState().onConnect({ source: "c1", target: "generate", sourceHandle: null, targetHandle: null });
    settle();
    useStore.getState().removeNode("c1");
    settle();
    expect(useStore.getState().nodes).toHaveLength(1);

    useStore.getState().undo();
    expect(useStore.getState().nodes).toHaveLength(2);
    expect(useStore.getState().edges).toHaveLength(1);
  });

  it("clears redo after a new edit", () => {
    edit("one");
    settle();
    useStore.getState().undo();
    edit("two");
    settle();
    expect(useStore.getState().canRedo).toBe(false);
  });

  it("starts empty after the history is reset (scene switch)", () => {
    edit("one");
    settle();
    resetHistory();
    expect(useStore.getState().canUndo).toBe(false);
    useStore.getState().undo();
    expect(text()).toBe("one");
  });

  it("ignores the automatic lastPick update after generating", () => {
    useStore.getState().updateNode("c1", { lastPick: "white-onepiece" });
    settle();
    expect(useStore.getState().canUndo).toBe(false);
  });
});

describe("migrateLegacyPrompts", () => {
  it("turns prepend/append fields on the generate node into prompt nodes", () => {
    const node = generate();
    node.data = { ...node.data, prepend_positive: "masterpiece", append_negative: "blurry" };
    const { nodes, edges } = migrateLegacyPrompts([node], []);

    const prompts = nodes.filter((n) => n.type === "prompt");
    expect(prompts.map((p) => [p.data.text, p.data.polarity, p.data.placement])).toEqual([
      ["masterpiece", "positive", "prepend"],
      ["blurry", "negative", "append"],
    ]);
    expect(edges.every((e) => e.target === "generate")).toBe(true);
    expect(nodes.find((n) => n.id === "generate")?.data.prepend_positive).toBeUndefined();
  });

  it("leaves graphs without legacy fields untouched", () => {
    const input = [generate()];
    expect(migrateLegacyPrompts(input, []).nodes).toBe(input);
  });
});

describe("normalizeOrder", () => {
  const cats = (...ids: string[]) => ids.map((id) => ({ ...DEFAULT_CATEGORIES[0], id, folder: id }));
  it("places a missing category after the nearest earlier one in library order", () => {
    const list = cats("style", "character", "hair", "costume", "pose");
    expect(normalizeOrder(["style", "character", "costume"], list)).toEqual(["style", "character", "hair", "costume", "pose"]);
    expect(normalizeOrder(["costume", "hair", "character", "pose"], list)).toEqual(["costume", "hair", "character", "pose"]);
  });
  it("places custom categories without disturbing the saved order", () => {
    const list = cats("style", "character", "effects", "view");
    expect(normalizeOrder(["character", "view", "style"], list)).toEqual(["character", "effects", "view", "style"]);
  });
});

describe("node clipboard", () => {
  it("copies, pastes at a position with a new id and generate edge, and never touches generate", () => {
    const s = useStore.getState();
    s.copyNodes(["c1", "generate"]);
    expect(useStore.getState().nodeClip.map((n) => n.id)).toEqual(["c1"]);
    s.pasteNodes({ x: 50, y: 60 });
    const nodes = useStore.getState().nodes;
    const copy = nodes.find((n) => n.id !== "c1" && n.type === "character");
    expect(copy?.position).toEqual({ x: 50, y: 60 });
    expect(copy?.data.name).toBe("Nancy");
    expect(useStore.getState().edges.some((e) => e.source === copy?.id && e.target === "generate")).toBe(true);
    useStore.getState().removeNodes(["generate", copy!.id]);
    expect(useStore.getState().nodes.map((n) => n.id)).toEqual(["generate", "c1"]);
  });
});

describe("owner handling", () => {
  it("keeps the owner when a node is replaced by a same-category preset", () => {
    useStore.getState().updateNode("c1", { owner: "girl" });
    useStore.getState().addNode("character", { name: "Mia", keywords: "mia" }, { x: 0, y: 0 }, "c1");
    expect(useStore.getState().nodes.find((n) => n.id === "c1")?.data).toMatchObject({ name: "Mia", owner: "girl" });
  });

  it("updateNodes patches only the listed nodes", () => {
    useStore.getState().updateNodes(["c1"], { owner: "boy" });
    const nodes = useStore.getState().nodes;
    expect(nodes.find((n) => n.id === "c1")?.data.owner).toBe("boy");
    expect(nodes.find((n) => n.id === "generate")?.data.owner).toBeUndefined();
  });
});
