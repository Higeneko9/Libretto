import { ReactFlow } from "@xyflow/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Canvas } from "./App";
import { useStore } from "./store";

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  ReactFlow: vi.fn(() => null),
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
});
