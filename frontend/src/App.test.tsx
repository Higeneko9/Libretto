import { ReactFlow, type ReactFlowProps } from "@xyflow/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Canvas } from "./App";
import { useStore } from "./store";

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  ReactFlow: vi.fn((props: ReactFlowProps) => (
    <div data-testid="selection" onContextMenu={(event) => props.onSelectionContextMenu?.(event, (props.nodes ?? []).filter((node) => node.selected))} />
  )),
  useReactFlow: () => ({}),
}));

let container: HTMLDivElement;
let root: Root;
let previous: ReturnType<typeof useStore.getState>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  previous = useStore.getState();
  useStore.setState({
    sceneReady: false,
    focusId: null,
    nodes: [
      { id: "generate", type: "generate", position: { x: 600, y: 0 }, data: { profile: "sdxl" } },
      { id: "character", type: "character", position: { x: 0, y: 0 }, data: { name: "Nancy" } },
    ],
    edges: [{ id: "character->generate", source: "character", target: "generate" }],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Canvas />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStore.setState(previous);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderedEdges() {
  const props = vi.mocked(ReactFlow).mock.calls.at(-1)?.[0];
  if (!props) throw new Error("Canvas did not render ReactFlow");
  return props;
}

describe("hidden scene connections", () => {
  it("hides saved connections without changing their exported graph", () => {
    const graph = useStore.getState().toGraph();
    const props = renderedEdges();
    expect(props.edges).toEqual([
      { id: "character->generate", source: "character", target: "generate", hidden: true },
    ]);
    expect(props.nodesConnectable).toBe(false);
    expect(props.edgesReconnectable).toBe(false);
    expect(props.edgesFocusable).toBe(false);
    expect(useStore.getState().edges[0].hidden).toBeUndefined();
    expect(useStore.getState().toGraph()).toEqual(graph);
    expect(graph.edges).toEqual([{ source: "character", target: "generate" }]);
  });

  it("allows zooming from 10% to 400% while keeping the initial fit limits", () => {
    const props = renderedEdges();
    expect(props.minZoom).toBe(0.1);
    expect(props.maxZoom).toBe(4);
    expect(props.fitViewOptions?.minZoom).toBe(0.5);
    expect(props.fitViewOptions?.maxZoom).toBe(2);
  });

  it("routes prompt F2 editing only to the hovered canvas and offers it in the node menu", async () => {
    const prompt = { id: "prompt", type: "prompt", position: { x: 0, y: 0 }, data: { text: "A prompt" } };
    await act(async () => useStore.setState((s) => ({ nodes: [...s.nodes, prompt], selectedId: prompt.id })));
    const canvas = container.querySelector(".canvas")!;
    const editor = document.createElement("button");
    editor.className = "prompt-text";
    editor.dataset.nodeId = prompt.id;
    const edit = vi.fn();
    editor.addEventListener("click", edit);
    canvas.append(editor);
    const outside = document.createElement("button");
    outside.dataset.shortcutPanel = "outline";
    container.append(outside);
    outside.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F2" })));
    expect(edit).not.toHaveBeenCalled();
    canvas.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F2" })));
    expect(edit).toHaveBeenCalledOnce();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F2", repeat: true })));
    expect(edit).toHaveBeenCalledOnce();
    const contextMenu = renderedEdges().onNodeContextMenu!;
    await act(async () => contextMenu({ preventDefault() {}, clientX: 100, clientY: 100 } as React.MouseEvent, prompt));
    const action = [...container.querySelectorAll<HTMLButtonElement>(".ctx-menu button")].find((item) => item.textContent === "Edit prompt");
    expect(action).toBeDefined();
    await act(async () => action!.click());
    expect(edit).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".ctx-menu")).toBeNull();
  });

  it.each(["Delete", "Backspace"])("limits %s node removal to the hovered canvas, not the focused panel", async (key) => {
    await act(async () => useStore.setState((s) => ({ nodes: [
      ...s.nodes.map((node) => ({ ...node, selected: true })),
      { id: "protected", type: "character", position: { x: 10, y: 10 }, data: {}, selected: true, deletable: false },
    ] })));
    expect(renderedEdges().deleteKeyCode).toBeNull();
    const canvas = container.querySelector(".canvas")!;
    const outside = document.createElement("button");
    outside.dataset.shortcutPanel = "outline";
    container.append(outside);
    outside.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })));
    expect(useStore.getState().nodes).toHaveLength(3);
    canvas.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    outside.focus();
    await act(async () => outside.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })));
    expect(useStore.getState().nodes.map((node) => node.id)).toEqual(["generate", "protected"]);
  });

  it("keeps newly added and pasted nodes connected without showing their lines", async () => {
    await act(async () => {
      useStore.getState().addNode("costume", { name: "Suit" }, { x: 20, y: 20 });
      useStore.getState().copyNodes(["character"]);
      useStore.getState().pasteNodes({ x: 50, y: 50 });
    });
    const edges = useStore.getState().edges;
    expect(edges).toHaveLength(3);
    expect(edges.every((edge) => edge.target === "generate")).toBe(true);
    expect(useStore.getState().toGraph().edges).toEqual(edges.map(({ source, target }) => ({ source, target })));
    expect(renderedEdges().edges).toEqual(useStore.getState().edges.map((edge) => ({ ...edge, hidden: true })));
    expect(useStore.getState().edges.every((edge) => edge.hidden === undefined)).toBe(true);
  });

  it("opens the selection context menu and copies selected nodes except Generate", async () => {
    await act(async () => useStore.setState((s) => ({
      nodes: [
        ...s.nodes.map((node) => ({ ...node, selected: true })),
        { id: "costume", type: "costume", position: { x: 20, y: 30 }, data: { name: "Suit" }, selected: true },
        { id: "other", type: "pose", position: { x: 30, y: 40 }, data: {}, selected: false },
      ],
    })));
    const bubbled = vi.fn();
    document.addEventListener("contextmenu", bubbled);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
    await act(async () => container.querySelector('[data-testid="selection"]')!.dispatchEvent(event));
    document.removeEventListener("contextmenu", bubbled);
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    const copy = [...container.querySelectorAll<HTMLButtonElement>(".ctx-menu button")].find((item) => item.textContent === "Copy (2)");
    expect(copy).toBeDefined();
    await act(async () => copy!.click());
    expect(useStore.getState().nodeClip.map((node) => node.id)).toEqual(["character", "costume"]);
    expect(useStore.getState().nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(["generate", "character", "costume"]);
  });
});
