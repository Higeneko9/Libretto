import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePanelShortcuts } from "./panelShortcuts";

let container: HTMLDivElement;
let root: Root;
const canvas = vi.fn<(event: KeyboardEvent) => void>();
const outline = vi.fn<(event: KeyboardEvent) => void>();

function Panel({ name, handler, children }: { name: string; handler: (event: KeyboardEvent) => void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  usePanelShortcuts(ref, handler);
  return <div ref={ref} data-shortcut-panel={name} tabIndex={0}>{children}</div>;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  canvas.mockImplementation((event) => event.preventDefault());
  outline.mockImplementation((event) => event.preventDefault());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<>
    <Panel name="canvas" handler={canvas}><div data-shortcut-panel="properties">Properties</div></Panel>
    <Panel name="outline" handler={outline} />
  </>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const panel = (name: string) => container.querySelector<HTMLElement>(`[data-shortcut-panel="${name}"]`)!;
const hover = (element: Element) => element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
function press(target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

it("routes to the hovered panel before document-level handlers, regardless of focus", () => {
  const legacy = vi.fn();
  document.addEventListener("keydown", legacy);
  try {
    panel("canvas").focus();
    hover(panel("outline"));
    expect(press(panel("canvas")).defaultPrevented).toBe(true);
    expect(outline).toHaveBeenCalledOnce();
    expect(canvas).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener("keydown", legacy);
  }
});

it("does not fall through nested panel boundaries or retain hover after leaving the window", () => {
  hover(panel("properties"));
  press();
  expect(canvas).not.toHaveBeenCalled();
  hover(panel("canvas"));
  window.dispatchEvent(new Event("blur"));
  press();
  expect(canvas).not.toHaveBeenCalled();
  hover(panel("outline"));
  panel("outline").dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
  press();
  expect(outline).not.toHaveBeenCalled();
});

it.each(["input", "textarea", "select", "contenteditable"])("preserves native %s editing even when another panel is hovered", (kind) => {
  const field = document.createElement(kind === "contenteditable" ? "div" : kind);
  if (kind === "contenteditable") field.setAttribute("contenteditable", "true");
  panel("canvas").append(field);
  hover(panel("outline"));
  expect(press(field).defaultPrevented).toBe(false);
  expect(outline).not.toHaveBeenCalled();
  expect(canvas).not.toHaveBeenCalled();
});

it.each(["modal", "ask-box", "ctx-menu"])("suspends background shortcuts while a %s is open", (className) => {
  const overlay = document.createElement("div");
  overlay.className = className;
  container.append(overlay);
  hover(panel("canvas"));
  press();
  expect(canvas).not.toHaveBeenCalled();
});

it("blocks focused node movement over another panel but preserves it over the canvas", () => {
  const node = document.createElement("div");
  node.className = "react-flow__node";
  panel("canvas").append(node);
  const move = vi.fn();
  node.addEventListener("keydown", move);
  canvas.mockImplementation(() => {});
  hover(panel("properties"));
  const outside = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  node.dispatchEvent(outside);
  expect(outside.defaultPrevented).toBe(true);
  expect(move).not.toHaveBeenCalled();
  hover(panel("canvas"));
  node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  expect(move).toHaveBeenCalledOnce();
});

it.each(["modal", "fullscreen-view"])("allows the hovered %s to handle its own shortcuts", async (className) => {
  await act(async () => root.render(<div className={className}><Panel name="detail" handler={outline} /></div>));
  hover(panel("detail"));
  expect(press().defaultPrevented).toBe(true);
  expect(outline).toHaveBeenCalledOnce();
  expect(canvas).not.toHaveBeenCalled();
});

it("hit-tests the latest pointer position instead of using stale panel ownership after a layout change", () => {
  hover(panel("canvas"));
  const hitTest = vi.fn().mockReturnValue(panel("outline"));
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
  try {
    press();
    expect(outline).toHaveBeenCalledOnce();
    expect(canvas).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(document, "elementFromPoint");
  }
});
