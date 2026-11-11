import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { Palette } from "./Palette";
import { useStore } from "./store";
import { DEFAULT_CATEGORIES, type Preset } from "./types";

const preset = (id: string): Preset => ({
  id, category: "character", name: id, keywords: id, description: "", negative: "",
  labels: [], weight: 1, has_thumbnail: false, thumbnail_profiles: [],
});

let container: HTMLDivElement;
let root: Root;
let previous: ReturnType<typeof useStore.getState>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previous = useStore.getState();
  useStore.setState({
    sceneReady: false,
    library: "default",
    libraries: [{ id: "default", name: "default", counts: {} }],
    categories: DEFAULT_CATEGORIES,
    presets: { character: [preset("first"), preset("second")] },
    tags: [],
    ui: { ...previous.ui, locale: "en-US", libSel: ["character"], propsOpen: false },
    presetClip: { library: "other", items: [{ category: "costume", id: "clipboard" }], cut: false },
    refreshPresets: vi.fn().mockResolvedValue(undefined),
    refreshLibraries: vi.fn().mockResolvedValue(undefined),
    bumpThumbs: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Palette />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStore.setState(previous);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function card(id: string) {
  const element = container.querySelector(`[data-item="character|${id}"]`);
  if (!element) throw new Error(`Missing preset card: ${id}`);
  return element;
}

async function duplicate() {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".ctx-menu button")]
    .find((button) => button.textContent === "Duplicate");
  if (!button) throw new Error("Missing Duplicate menu item");
  await act(async () => button.click());
}

describe("preset card duplication", () => {
  it("duplicates the right-clicked card without replacing the clipboard", async () => {
    const clipboard = useStore.getState().presetClip;
    const copy = vi.spyOn(api, "copyItems").mockResolvedValue([{ category: "character", id: "p-00000001", from: "second" }]);
    await act(async () => card("second").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await duplicate();
    expect(copy).toHaveBeenCalledWith("default", "default", [{ category: "character", id: "second" }]);
    expect(useStore.getState().presetClip).toBe(clipboard);
    expect(useStore.getState().refreshPresets).toHaveBeenCalledWith("character");
    expect(container.textContent).toContain("Duplicated 1");
  });

  it("duplicates all selected cards when opening their context menu", async () => {
    vi.spyOn(api, "copyItems").mockResolvedValue([
      { category: "character", id: "p-00000001", from: "first" },
      { category: "character", id: "p-00000002", from: "second" },
    ]);
    await act(async () => card("first").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    await act(async () => card("second").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    await act(async () => card("first").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await duplicate();
    expect(api.copyItems).toHaveBeenCalledWith("default", "default", [
      { category: "character", id: "first" }, { category: "character", id: "second" },
    ]);
    expect(container.textContent).toContain("Duplicated 2");
  });

  it("shows duplication errors instead of claiming success", async () => {
    vi.spyOn(api, "copyItems").mockRejectedValue(new Error("Copy failed"));
    await act(async () => card("first").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await duplicate();
    expect(container.textContent).toContain("Copy failed");
    expect(container.textContent).not.toContain("Duplicated 1");
  });
});
