import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { PromptNode } from "./nodes";
import { resetHistory, useStore, type LbNode } from "./store";

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  Handle: () => null,
}));

let container: HTMLDivElement;
let root: Root;
let previous: ReturnType<typeof useStore.getState>;
const nodeKeyHandler = vi.fn();

function PromptScene() {
  const nodes = useStore((s) => s.nodes);
  return <div onKeyDown={nodeKeyHandler}>{nodes.map((node) => <PromptNode key={node.id} id={node.id} type="prompt"
    data={node.data} selected={!!node.selected} dragging={false} draggable selectable deletable
    isConnectable={false} zIndex={0} positionAbsoluteX={0} positionAbsoluteY={0} />)}</div>;
}

beforeEach(async () => {
  vi.useFakeTimers();
  nodeKeyHandler.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previous = useStore.getState();
  const nodes: LbNode[] = [
    { id: "positive", type: "prompt", position: { x: 0, y: 0 }, data: { text: "Original positive", polarity: "positive", placement: "append", weight: 1.2 } },
    { id: "negative", type: "prompt", position: { x: 250, y: 0 }, data: { text: "Original negative", polarity: "negative", placement: "prepend" } },
  ];
  useStore.setState({ activeId: "scene1", sceneReady: false, selectedId: null, nodes, edges: [],
    ui: { ...previous.ui, locale: "en-US" } });
  resetHistory();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<PromptScene />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStore.setState({ sceneReady: false });
  vi.clearAllTimers();
  useStore.setState(previous);
  resetHistory();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const text = (id: string) => useStore.getState().nodes.find((node) => node.id === id)?.data.text;
const button = (id = "positive") => container.querySelector<HTMLButtonElement>(`button[data-node-id="${id}"]`)!;
const input = () => container.querySelector<HTMLTextAreaElement>(".prompt-editor")!;

async function begin(id = "positive") {
  await act(async () => button(id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
}

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value, ...options });
  await act(async () => input().dispatchEvent(event));
  return event;
}

it.each(["positive", "negative"])("edits %s prompt text without changing its other settings", async (id) => {
  const original = useStore.getState().nodes.find((node) => node.id === id)!.data;
  await begin(id);
  expect(input()).toBe(document.activeElement);
  expect(input().selectionStart).toBe(0);
  expect(input().selectionEnd).toBe(original.text!.length);
  expect(input().getAttribute("aria-label")).toBe(`Edit ${id} prompt`);
  expect(useStore.getState().selectedId).toBe(id);
  expect(useStore.getState().nodes.filter((node) => node.selected).map((node) => node.id)).toEqual([id]);
  const value = "  First line\nSecond line  ";
  await type(value);
  expect(text(id)).toBe(original.text);
  await key("Enter");
  expect(input()).toBeNull();
  expect(useStore.getState().nodes.find((node) => node.id === id)!.data).toEqual({ ...original, text: value });
  expect(button(id)).toBe(document.activeElement);
});

it("saves on blur and allows clearing a prompt", async () => {
  await begin("negative");
  await type("");
  await act(async () => input().blur());
  expect(input()).toBeNull();
  expect(text("negative")).toBe("");
  expect(button("negative").textContent).toBe("(empty prompt)");
});

it.each(["Enter", "Escape"])("handles %s followed by blur only once", async (command) => {
  const update = vi.spyOn(useStore.getState(), "updateNode");
  await begin();
  await type("Draft");
  await act(async () => {
    const field = input();
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: command }));
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(text("positive")).toBe(command === "Enter" ? "Draft" : "Original positive");
  expect(update).toHaveBeenCalledTimes(command === "Enter" ? 1 : 0);
  expect(input()).toBeNull();
});

it("does not write an unchanged prompt", async () => {
  const update = vi.spyOn(useStore.getState(), "updateNode");
  await begin();
  await key("Enter");
  expect(update).not.toHaveBeenCalled();
});

it("retains multiline drafts on Shift+Enter and ignores IME confirmation Enter", async () => {
  await begin();
  await type("First line");
  expect((await key("Enter", { shiftKey: true })).defaultPrevented).toBe(false);
  expect(input()).not.toBeNull();
  await type("First line\nSecond line");
  await key("Enter", { isComposing: true });
  expect(text("positive")).toBe("Original positive");
  expect(input()).not.toBeNull();
  await key("Enter");
  expect(text("positive")).toBe("First line\nSecond line");
});

it("keeps text-editing keys away from node keyboard handlers", async () => {
  await begin();
  for (const [value, options] of [
    ["Delete", {}], ["Backspace", {}], ["ArrowLeft", {}],
    ["z", { ctrlKey: true }], ["a", { metaKey: true }],
  ] as const) {
    expect((await key(value, options)).defaultPrevented).toBe(false);
  }
  expect(nodeKeyHandler).not.toHaveBeenCalled();
  expect(useStore.getState().nodes).toHaveLength(2);
  expect(text("positive")).toBe("Original positive");
});

it("opens from an accessible button activation and focused F2", async () => {
  await act(async () => button().click());
  expect(input()).not.toBeNull();
  await key("Escape");
  await act(async () => button().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F2" })));
  expect(input()).not.toBeNull();
});

it("discards drafts when switching scenes, even if a node ID is reused", async () => {
  const update = vi.spyOn(useStore.getState(), "updateNode");
  await begin();
  await type("Do not apply to another scene");
  await act(async () => useStore.setState((s) => ({
    activeId: "scene2",
    nodes: s.nodes.map((node) => ({ ...node, data: { ...node.data, text: "Another scene" } })),
  })));
  expect(input()).toBeNull();
  expect(text("positive")).toBe("Another scene");
  expect(update).not.toHaveBeenCalled();
  await act(async () => useStore.setState({ activeId: "scene1" }));
  expect(input()).toBeNull();
});

it("autosaves a committed edit and supports scene undo/redo without saving drafts", async () => {
  vi.spyOn(api, "saveScene").mockResolvedValue({});
  await act(async () => useStore.setState({ sceneReady: true }));
  resetHistory();
  await begin();
  await type("Uncommitted");
  await act(async () => vi.advanceTimersByTime(450));
  expect(useStore.getState().canUndo).toBe(false);
  expect(text("positive")).toBe("Original positive");
  await type("Committed prompt");
  await key("Enter");
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(api.saveScene).toHaveBeenLastCalledWith("scene1", { graph: useStore.getState().toGraph() });
  expect(text("positive")).toBe("Committed prompt");
  await act(async () => useStore.getState().undo());
  expect(text("positive")).toBe("Original positive");
  expect(useStore.getState().canUndo).toBe(false);
  await act(async () => useStore.getState().redo());
  expect(text("positive")).toBe("Committed prompt");
});
