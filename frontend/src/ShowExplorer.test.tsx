import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import * as ask from "./ask";
import { Results } from "./Results";
import { Inspector } from "./Inspector";
import { ShowExplorer } from "./ShowExplorer";
import { Splitter } from "./Splitter";
import { useStore } from "./store";
import type { Run, ShowOutputPreview } from "./types";

let container: HTMLDivElement;
let root: Root;
let previous: ReturnType<typeof useStore.getState>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previous = useStore.getState();
  vi.spyOn(api, "scene").mockImplementation(async (id) => ({ id, name: "One", graph: { nodes: [], edges: [] } }));
  vi.spyOn(api, "saveUi").mockResolvedValue({});
  vi.spyOn(api, "organizationHistory").mockResolvedValue({ undo: 0, redo: 0, revision: 0 });
  useStore.setState({
    sceneReady: false, activeId: null, focusRun: null,
    outputScope: { kind: "all" },
    organizationHistory: { undo: 0, redo: 0, revision: 0 },
    organizationBusy: false,
    ui: { ...previous.ui, locale: "en-US", openScenes: [] },
    shows: [{ version: 1, id: "show1", name: "The Show", items: [
      { kind: "act", id: "act1", name: "First Act", scene_ids: ["s1"] },
      { kind: "scene", id: "s2" },
    ] }],
    scenes: [
      { id: "s1", name: "One", updated_at: "", show_id: "show1", act_id: "act1" },
      { id: "s2", name: "Two", updated_at: "", show_id: "show1" },
      { id: "s3", name: "Three", updated_at: "" },
    ],
    runs: ["s1", "s2", "s3", null].map((scene_id, i): Run => ({
      id: `r${i}`, scene_id, status: "done", created_at: "", images: [`${i}.png`], profile: "p",
      seed: 1, positive: "", parent_id: null, error: null, prompt_id: null,
    })),
    refreshRuns: vi.fn().mockResolvedValue(undefined),
    refreshPresets: vi.fn().mockResolvedValue(undefined),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<><ShowExplorer /><Results /></>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStore.setState(previous);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".explorer-tree button")]
    .find((b) => b.textContent?.replace(/\s+/g, " ").trim().endsWith(label));
  if (!button) throw new Error(`Missing explorer item: ${label}`);
  await act(async () => button.click());
}

const resultIds = () => [...container.querySelectorAll("[data-run-id]")].map((e) => e.getAttribute("data-run-id"));

it("filters results by show, act and scene, and opens scene selections as tabs", async () => {
  expect(resultIds()).toEqual(["r0", "r1", "r2", "r3"]);
  await click("The Show");
  expect(resultIds()).toEqual(["r0", "r1"]);
  expect(useStore.getState().activeId).toBeNull();
  await click("First Act");
  expect(resultIds()).toEqual(["r0"]);
  await click("Two");
  expect(resultIds()).toEqual(["r1"]);
  expect(useStore.getState().activeId).toBe("s2");
  expect(useStore.getState().ui.openScenes).toContain("s2");
  await click("Standalone Scenes");
  expect(resultIds()).toEqual(["r2"]);
  await click("All outputs");
  expect(resultIds()).toHaveLength(4);
});

it("prunes output selection after switching scope and reacts to a scene move", async () => {
  const selectAll = [...container.querySelectorAll<HTMLButtonElement>(".results-bar button")].find((b) => b.textContent === "All")!;
  await act(async () => selectAll.click());
  await click("First Act");
  expect(container.querySelector(".results-bar")?.textContent).toContain("1");
  await act(async () => useStore.setState((state) => ({
    scenes: state.scenes.map((s) => s.id === "s1" ? { ...s, show_id: null, act_id: null } : s),
  })));
  expect(resultIds()).toEqual([]);
  expect(container.querySelector<HTMLButtonElement>(".results-bar .danger")?.disabled).toBe(true);
  await click("Standalone Scenes");
  expect(resultIds()).toEqual(["r0", "r2"]);
});

it("collapses containers without changing output scope", async () => {
  await click("The Show");
  const collapse = container.querySelector<HTMLButtonElement>('[aria-label="Collapse The Show"]')!;
  await act(async () => collapse.click());
  expect(container.querySelector('[title="First Act"]')).toBeNull();
  expect(resultIds()).toEqual(["r0", "r1"]);
  expect(collapse.getAttribute("aria-expanded")).toBe("false");
});

it("resizes the vertical split with mouse and keyboard and persists its height", async () => {
  function Divider() {
    const height = useStore((s) => s.ui.explorerH);
    return <Splitter axis="y" value={height} min={140} max={400} direction={1}
      onChange={(explorerH) => useStore.getState().setUi({ explorerH })} />;
  }
  await act(async () => {
    useStore.getState().setUi({ explorerH: 260 });
    root.render(<Divider />);
  });
  const divider = container.querySelector('[role="separator"]')!;
  await act(async () => {
    divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 100, button: 0 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientY: 300 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
  });
  expect(useStore.getState().ui.explorerH).toBe(400);
  expect(document.body.style.userSelect).toBe("");
  await act(async () => divider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp", shiftKey: true })));
  expect(useStore.getState().ui.explorerH).toBe(350);
  expect(JSON.parse(localStorage.getItem("LB_Ui")!).explorerH).toBe(350);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(api.saveUi).toHaveBeenCalledWith(expect.objectContaining({ explorerH: 350 }));
});

it("waits for an in-flight autosave before copying a scene", async () => {
  let finishSave!: () => void;
  const saving = new Promise<void>((resolve) => { finishSave = resolve; });
  vi.spyOn(api, "saveScene").mockReturnValue(saving);
  vi.spyOn(api, "placeScene").mockResolvedValue({ id: "copy" });
  vi.spyOn(api, "scenes").mockResolvedValue(useStore.getState().scenes);
  vi.spyOn(api, "shows").mockResolvedValue(useStore.getState().shows);
  await act(async () => {
    useStore.setState({ activeId: "s1", sceneReady: true });
    useStore.getState().setScenePrompt("The latest edit");
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(api.saveScene).toHaveBeenCalledWith("s1", expect.objectContaining({
    graph: expect.objectContaining({ scene_prompt: "The latest edit" }),
  }));
  const operation = useStore.getState().organize(() => api.placeScene("s1", { copy: true }));
  expect(api.placeScene).not.toHaveBeenCalled();
  await act(async () => {
    finishSave();
    await operation;
  });
  expect(api.placeScene).toHaveBeenCalledWith("s1", { copy: true });
});

const row = (key: string) => {
  const element = container.querySelector<HTMLButtonElement>(`button[data-outline-key="${key}"]`);
  if (!element) throw new Error(`Missing outline row: ${key}`);
  return element;
};

const hover = (element: Element) => element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

async function contextMenu(key: string) {
  await act(async () => row(key).dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 100, clientY: 100,
  })));
}

async function menuClick(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label);
  if (!button) throw new Error(`Missing menu action: ${label}`);
  await act(async () => button.click());
}

function renameInput() {
  const field = container.querySelector<HTMLInputElement>(".explorer-rename");
  if (!field) throw new Error("Missing inline rename input");
  return field;
}

async function renameValue(value: string) {
  await act(async () => {
    const field = renameInput();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renameKey(key: string, options: KeyboardEventInit = {}) {
  await act(async () => renameInput().dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true, cancelable: true, key, ...options,
  })));
}

async function doubleClick(key: string) {
  await act(async () => row(key).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
}

function mockOrganizationRefresh() {
  vi.spyOn(api, "scenes").mockResolvedValue(useStore.getState().scenes);
  vi.spyOn(api, "shows").mockResolvedValue(useStore.getState().shows);
}

async function openSettings() {
  await contextMenu("show:show1");
  await menuClick("Show settings…");
}

async function selectLayout(value: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function settingsButton(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) => item.textContent === label);
  if (!button) throw new Error(`Missing settings button: ${label}`);
  await act(async () => button.click());
}

it("offers settings only for shows, without changing the open scene or result scope", async () => {
  const preview = vi.spyOn(api, "showOutputPreview").mockResolvedValue({ examples: [] });
  const save = vi.spyOn(api, "saveShowSettings");
  await click("Three");
  for (const key of ["act:act1", "scene:s2"]) {
    await contextMenu(key);
    expect(container.querySelector('[role="menu"]')?.textContent).not.toContain("Show settings…");
  }
  await openSettings();
  expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe("Show settings — The Show");
  expect(container.querySelector<HTMLSelectElement>('[role="dialog"] select')?.value).toBe("workflow");
  expect(preview).not.toHaveBeenCalled();
  expect(useStore.getState().activeId).toBe("s3");
  expect(useStore.getState().outputScope).toEqual({ kind: "scene", id: "s3" });
  await settingsButton("Save");
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(row("show:show1"));
});

it("previews output layouts and example scenes, then saves through organization history", async () => {
  vi.spyOn(api, "showOutputPreview").mockResolvedValue({ examples: [
    { scene_id: "s1", name: "One", prefix: "the-show/01-first-act/01-one" },
    { scene_id: "s2", name: "Two", prefix: "the-show/01-two" },
  ] });
  const updated = { ...useStore.getState().shows[0], output_layout: "show_act_scene" as const };
  vi.spyOn(api, "saveShowSettings").mockResolvedValue(updated);
  mockOrganizationRefresh();
  vi.mocked(api.shows).mockResolvedValue([updated]);
  vi.mocked(api.organizationHistory).mockResolvedValue({ undo: 1, redo: 0, revision: 1 });
  await openSettings();
  await selectLayout("show_act_scene");
  expect(api.showOutputPreview).toHaveBeenCalledWith("show1", "show_act_scene");
  expect(container.querySelector(".show-output-prefix")?.textContent).toBe("the-show/01-first-act/01-one");
  await act(async () => {
    const select = container.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')[1];
    select.value = "s2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector(".show-output-prefix")?.textContent).toBe("the-show/01-two");
  expect(api.saveShowSettings).not.toHaveBeenCalled();
  await settingsButton("Save");
  expect(api.saveShowSettings).toHaveBeenCalledWith("show1", "show_act_scene");
  expect(useStore.getState().shows[0].output_layout).toBe("show_act_scene");
  expect(useStore.getState().organizationHistory.undo).toBe(1);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(row("show:show1"));
});

it("allows settings on an empty show and cancels drafts with Escape", async () => {
  vi.spyOn(api, "showOutputPreview").mockResolvedValue({ examples: [] });
  const save = vi.spyOn(api, "saveShowSettings");
  await openSettings();
  await selectLayout("show_scene");
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Add a scene to preview its output path.");
  await act(async () => container.querySelector('[role="dialog"] select')!.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
  ));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("ignores stale output previews after switching layouts", async () => {
  let finish!: (result: ShowOutputPreview) => void;
  vi.spyOn(api, "showOutputPreview")
    .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ examples: [{ scene_id: "s1", name: "One", prefix: "new-layout" }] });
  await openSettings();
  await selectLayout("show_scene");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading output preview…");
  await selectLayout("show_act_scene");
  expect(container.querySelector(".show-output-prefix")?.textContent).toBe("new-layout");
  await act(async () => finish({ examples: [{ scene_id: "s1", name: "One", prefix: "obsolete-layout" }] }));
  expect(container.querySelector(".show-output-prefix")?.textContent).toBe("new-layout");
});

it("surfaces preview failures instead of showing an incorrect path", async () => {
  vi.spyOn(api, "showOutputPreview").mockRejectedValue(new Error("Cannot read show outline"));
  await openSettings();
  await selectLayout("show_scene");
  expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("Cannot read show outline");
  expect(container.querySelector(".show-output-prefix")).toBeNull();
  expect([...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) => item.textContent === "Save")?.disabled).toBe(true);
  await selectLayout("workflow");
  expect(container.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
});

it("keeps a failed settings draft available for retry", async () => {
  vi.spyOn(api, "showOutputPreview").mockResolvedValue({ examples: [] });
  vi.spyOn(api, "saveShowSettings")
    .mockRejectedValueOnce(new Error("Cannot write show outline"))
    .mockResolvedValue({ ...useStore.getState().shows[0], output_layout: "show_scene" });
  mockOrganizationRefresh();
  await openSettings();
  await selectLayout("show_scene");
  await settingsButton("Save");
  expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("Cannot write show outline");
  expect(container.querySelector<HTMLSelectElement>('[role="dialog"] select')?.value).toBe("show_scene");
  await settingsButton("Save");
  expect(api.saveShowSettings).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("shows whether Generate output settings inherit or override the show's layout", async () => {
  vi.spyOn(api, "sceneSnaps").mockResolvedValue({ max: 30, default_max: 30, items: [] });
  await act(async () => {
    useStore.setState((s) => ({
      activeId: "s1", selectedId: "g",
      shows: s.shows.map((show) => ({ ...show, output_layout: "show_act_scene" })),
      nodes: [{ id: "g", type: "generate", data: { profile: "p", output_prefix: "  " }, position: { x: 0, y: 0 } }],
    }));
    root.render(<Inspector />);
  });
  expect(container.textContent).toContain("Inherited from show “The Show”: Show / Act / Scene.");
  await act(async () => useStore.getState().updateNode("g", { output_prefix: "manual/image" }));
  expect(container.textContent).toContain("This prefix overrides show “The Show” output layout: Show / Act / Scene.");
  await act(async () => useStore.setState({ activeId: "s3" }));
  expect(container.textContent).not.toContain("Inherited from show");
  expect(container.textContent).not.toContain("This prefix overrides show");
});

async function drag(source: string, target: string, fraction: number) {
  const dataTransfer = { setData: vi.fn(), effectAllowed: "none", dropEffect: "none" };
  const sourceRow = row(source);
  const targetRow = row(target);
  vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 200, 40));
  const event = (type: string) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: 100 + 40 * fraction });
    Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
    return e;
  };
  await act(async () => sourceRow.dispatchEvent(event("dragstart")));
  const over = event("dragover");
  await act(async () => targetRow.dispatchEvent(over));
  const marker = targetRow.className;
  await act(async () => targetRow.dispatchEvent(event("drop")));
  await act(async () => sourceRow.dispatchEvent(event("dragend")));
  return { over, marker, dataTransfer };
}

it("keeps actions in right-click menus and applies them to the clicked item without opening it", async () => {
  expect(container.querySelector(".explorer-actions")).toBeNull();
  await click("Three");
  vi.spyOn(api, "renameShow").mockResolvedValue({ ...useStore.getState().shows[0], name: "Renamed Show" });
  mockOrganizationRefresh();
  await contextMenu("show:show1");
  expect(container.querySelector('[role="menu"]')).not.toBeNull();
  expect(useStore.getState().outputScope).toEqual({ kind: "scene", id: "s3" });
  expect(container.querySelector('[role="menuitem"]')).toBe(document.activeElement);
  await menuClick("Rename");
  expect(renameInput().value).toBe("The Show");
  await renameValue("Renamed Show");
  await renameKey("Enter");
  expect(api.renameShow).toHaveBeenCalledWith("show1", "Renamed Show");
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(useStore.getState().outputScope).toEqual({ kind: "scene", id: "s3" });
});

it.each(["act:act1", "scene:s2"])("edits %s inline and saves on blur", async (key) => {
  vi.spyOn(api, "renameAct").mockResolvedValue({ kind: "act", id: "act1", name: "Updated", scene_ids: ["s1"] });
  vi.spyOn(api, "saveScene").mockResolvedValue({});
  mockOrganizationRefresh();
  await doubleClick(key);
  expect(renameInput()).toBe(document.activeElement);
  expect(renameInput().selectionStart).toBe(0);
  expect(renameInput().selectionEnd).toBe(renameInput().value.length);
  expect(renameInput().closest("button")).toBeNull();
  await renameValue("  Updated  ");
  await act(async () => renameInput().blur());
  if (key.startsWith("act:")) {
    expect(api.renameAct).toHaveBeenCalledWith("show1", "act1", "Updated");
  } else {
    expect(api.saveScene).toHaveBeenCalledWith("s2", { name: "Two", names: { "en-US": "Updated" } });
  }
  expect(container.querySelector(".explorer-rename")).toBeNull();
});

it("cancels inline editing on Escape without saving from the resulting blur", async () => {
  const save = vi.spyOn(api, "renameShow");
  await doubleClick("show:show1");
  await renameValue("Discard this");
  await act(async () => {
    const field = renameInput();
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector(".explorer-rename")).toBeNull();
  expect(row("show:show1")).toBe(document.activeElement);
});

it("skips unchanged names instead of creating an undo step", async () => {
  const save = vi.spyOn(api, "renameShow");
  await doubleClick("show:show1");
  await renameValue("  The Show  ");
  await renameKey("Enter");
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector(".explorer-rename")).toBeNull();
});

it("rejects a blank name without losing the editor and accepts a correction", async () => {
  vi.spyOn(api, "renameShow").mockResolvedValue({ ...useStore.getState().shows[0], name: "Corrected" });
  mockOrganizationRefresh();
  await doubleClick("show:show1");
  await renameValue("   ");
  await act(async () => renameInput().blur());
  expect(api.renameShow).not.toHaveBeenCalled();
  expect(renameInput().getAttribute("aria-invalid")).toBe("true");
  expect(container.querySelector(".explorer-error")?.textContent).toBe("Name cannot be empty.");
  await renameValue("Corrected");
  await renameKey("Enter");
  expect(api.renameShow).toHaveBeenCalledWith("show1", "Corrected");
});

it("retains a failed rename draft so it can be corrected or retried", async () => {
  const save = vi.spyOn(api, "renameShow")
    .mockRejectedValueOnce(new Error("Cannot write show outline"))
    .mockResolvedValue({ ...useStore.getState().shows[0], name: "Retry" });
  mockOrganizationRefresh();
  await doubleClick("show:show1");
  await renameValue("Retry");
  await renameKey("Enter");
  expect(renameInput().value).toBe("Retry");
  expect(renameInput().readOnly).toBe(false);
  expect(container.querySelector(".explorer-error")?.textContent).toBe("Cannot write show outline");
  await renameKey("Enter");
  expect(save).toHaveBeenCalledTimes(2);
  expect(container.querySelector(".explorer-rename")).toBeNull();
});

it("commits only once when Enter is followed by blur while saving", async () => {
  let finish!: (show: ReturnType<typeof useStore.getState>["shows"][number]) => void;
  const pending = new Promise<ReturnType<typeof useStore.getState>["shows"][number]>((resolve) => { finish = resolve; });
  vi.spyOn(api, "renameShow").mockReturnValue(pending);
  mockOrganizationRefresh();
  await doubleClick("show:show1");
  await renameValue("Once");
  await renameKey("Enter");
  expect(renameInput().readOnly).toBe(true);
  await act(async () => renameInput().blur());
  expect(api.renameShow).toHaveBeenCalledOnce();
  await act(async () => finish({ ...useStore.getState().shows[0], name: "Once" }));
  expect(container.querySelector(".explorer-rename")).toBeNull();
});

it.each(["en-US", "ja-JP"] as const)("updates the %s scene display name without replacing its original or other translations", async (locale) => {
  await act(async () => useStore.setState((s) => ({
    ui: { ...s.ui, locale },
    scenes: s.scenes.map((scene) => scene.id === "s2"
      ? { ...scene, names: { "en-US": "Displayed", "ja-JP": "Other language" } } : scene),
  })));
  vi.spyOn(api, "saveScene").mockResolvedValue({});
  mockOrganizationRefresh();
  await doubleClick("scene:s2");
  expect(renameInput().value).toBe(locale === "en-US" ? "Displayed" : "Other language");
  await renameValue("New display name");
  await act(async () => useStore.setState((s) => ({
    ui: { ...s.ui, locale: locale === "en-US" ? "ja-JP" : "en-US" },
  })));
  await renameKey("Enter");
  expect(api.saveScene).toHaveBeenCalledWith("s2", {
    name: "Two", names: { "en-US": "Displayed", "ja-JP": "Other language", [locale]: "New display name" },
  });
});

it("starts F2 renaming only over the outline and blocks dragging while editing", async () => {
  await click("First Act");
  hover(row("act:act1"));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F2" })));
  expect(renameInput().value).toBe("First Act");
  expect(row("scene:s2").draggable).toBe(false);
  const drag = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
  await act(async () => row("scene:s2").dispatchEvent(drag));
  expect(drag.defaultPrevented).toBe(true);
  await renameKey("Escape");
  hover(container.querySelector(".results-wrap")!);
  await act(async () => row("act:act1").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F2" })));
  expect(container.querySelector(".explorer-rename")).toBeNull();
});

it("does not commit Enter used to finish IME composition", async () => {
  vi.spyOn(api, "renameShow").mockResolvedValue({ ...useStore.getState().shows[0], name: "Composed" });
  mockOrganizationRefresh();
  await doubleClick("show:show1");
  await renameValue("Composed");
  await renameKey("Enter", { isComposing: true });
  expect(api.renameShow).not.toHaveBeenCalled();
  await renameKey("Enter");
  expect(api.renameShow).toHaveBeenCalledOnce();
});

it("allows double-click renaming while the first scene click is still opening it", async () => {
  let finish!: (scene: Awaited<ReturnType<typeof api.scene>>) => void;
  vi.mocked(api.scene).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => row("scene:s2").click());
  expect(row("scene:s2").disabled).toBe(false);
  expect(row("scene:s2").draggable).toBe(false);
  await contextMenu("scene:s2");
  expect(container.querySelector('[role="menu"]')).toBeNull();
  await doubleClick("scene:s2");
  expect(renameInput().value).toBe("Two");
  expect(renameInput().readOnly).toBe(false);
  await renameKey("Escape");
  await act(async () => finish({ id: "s2", name: "Two", graph: { nodes: [], edges: [] } }));
  expect(useStore.getState().activeId).toBe("s2");
});

it("keeps the original and translated scene-name dialog available", async () => {
  vi.spyOn(ask, "askNames").mockResolvedValue({ name: "Original", display: "Translated" });
  vi.spyOn(api, "saveScene").mockResolvedValue({});
  mockOrganizationRefresh();
  await contextMenu("scene:s2");
  await menuClick("Edit original / translated names…");
  expect(ask.askNames).toHaveBeenCalledWith("Rename", "Two", "", "en-US");
  expect(api.saveScene).toHaveBeenCalledWith("s2", { name: "Original", names: { "en-US": "Translated" } });
});

it.each(["show:show1", "act:act1", "scene:s2"])("omits redundant movement actions from the %s menu", async (key) => {
  await contextMenu(key);
  const labels = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
  expect(labels).not.toContain("Move to…");
  expect(labels).not.toContain("Move up");
  expect(labels).not.toContain("Move down");
  if (!key.startsWith("show:")) {
    expect(labels).toContain("Copy to…");
    expect(labels).toContain("Duplicate…");
  }
});

it.each(["act:act1", "scene:s2"])("keeps Copy To working for %s without changing the selected scope", async (key) => {
  vi.spyOn(api, "placeAct").mockResolvedValue({ kind: "act", id: "copy", name: "First Act", scene_ids: [] });
  vi.spyOn(api, "placeScene").mockResolvedValue({ id: "copy" });
  mockOrganizationRefresh();
  await contextMenu(key);
  await menuClick("Copy to…");
  const form = container.querySelector<HTMLFormElement>(".explorer-transfer")!;
  expect(form.querySelector("h2")?.textContent).toContain("Copy");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  if (key.startsWith("act:")) {
    expect(api.placeAct).toHaveBeenCalledWith("show1", "act1", expect.objectContaining({ show_id: "show1", copy: true }));
  } else {
    expect(api.placeScene).toHaveBeenCalledWith("s2", expect.objectContaining({ copy: true }));
  }
  expect(container.querySelector(".explorer-transfer")).toBeNull();
  expect(useStore.getState().outputScope).toEqual({ kind: "all" });
});

it("opens menus from the keyboard, navigates actions, and restores focus on Escape", async () => {
  const target = row("act:act1");
  target.focus();
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "F10", shiftKey: true })));
  const first = document.activeElement;
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
  expect(document.activeElement).not.toBe(first);
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(target);
});

it("undoes and redoes organization from the context menu and refreshes the tree", async () => {
  const updated = { undo: 0, redo: 1, revision: 2 };
  await act(async () => useStore.setState({ organizationHistory: { undo: 1, redo: 0, revision: 1 } }));
  vi.spyOn(api, "undoOrganization").mockResolvedValue(updated);
  vi.spyOn(api, "redoOrganization").mockResolvedValue({ undo: 1, redo: 0, revision: 3 });
  mockOrganizationRefresh();
  vi.mocked(api.organizationHistory).mockResolvedValue(updated);
  await contextMenu("show:show1");
  expect(container.querySelector<HTMLButtonElement>('[title^="Redo the last"]')?.disabled).toBe(true);
  await menuClick("Undo organization");
  expect(api.undoOrganization).toHaveBeenCalledWith(1);
  expect(useStore.getState().organizationHistory).toEqual(updated);
  await contextMenu("show:show1");
  await menuClick("Redo organization");
  expect(api.redoOrganization).toHaveBeenCalledWith(2);
});

it.each([
  { key: "z", ctrlKey: true, shiftKey: false, redo: false },
  { key: "z", metaKey: true, shiftKey: true, redo: true },
  { key: "y", ctrlKey: true, shiftKey: false, redo: true },
])("handles scoped organization shortcuts: $key / redo=$redo", async ({ redo, ...keys }) => {
  await act(async () => useStore.setState({ organizationHistory: { undo: 1, redo: 1, revision: 4 } }));
  vi.spyOn(api, "undoOrganization").mockResolvedValue({ undo: 0, redo: 2, revision: 5 });
  vi.spyOn(api, "redoOrganization").mockResolvedValue({ undo: 2, redo: 0, revision: 5 });
  mockOrganizationRefresh();
  const canvasUndo = vi.fn();
  window.addEventListener("keydown", canvasUndo);
  try {
    hover(row("show:show1"));
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...keys });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(canvasUndo).not.toHaveBeenCalled();
    expect(redo ? api.redoOrganization : api.undoOrganization).toHaveBeenCalledWith(4);
    hover(container.querySelector(".results-wrap")!);
    await act(async () => row("show:show1").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...keys })));
    expect(canvasUndo).toHaveBeenCalledOnce();
    expect(redo ? api.redoOrganization : api.undoOrganization).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("keydown", canvasUndo);
  }
});

it("does not divert native text undo or empty outline history to canvas undo", async () => {
  hover(row("show:show1"));
  const field = document.createElement("input");
  container.querySelector(".show-explorer")!.append(field);
  const native = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true });
  await act(async () => field.dispatchEvent(native));
  expect(native.defaultPrevented).toBe(false);
  const empty = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true });
  await act(async () => row("show:show1").dispatchEvent(empty));
  expect(empty.defaultPrevented).toBe(true);
});

it("deletes the selected outline item only while the pointer is over the outline", async () => {
  await click("First Act");
  const nodes = useStore.getState().nodes;
  vi.spyOn(ask, "askConfirm").mockResolvedValue(true);
  vi.spyOn(api, "deleteAct").mockResolvedValue({});
  mockOrganizationRefresh();
  hover(row("show:show1"));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Delete" })));
  expect(api.deleteAct).toHaveBeenCalledWith("show1", "act1");
  expect(useStore.getState().nodes).toBe(nodes);
  hover(container.querySelector(".results-wrap")!);
  await act(async () => row("act:act1").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Delete" })));
  expect(api.deleteAct).toHaveBeenCalledOnce();
});

it("routes Results selection shortcuts by hover rather than outline focus", async () => {
  const outline = row("show:show1");
  outline.focus();
  hover(container.querySelector(".results-wrap")!);
  await act(async () => outline.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a", ctrlKey: true })));
  expect(container.querySelectorAll(".result.selected")).toHaveLength(4);
  hover(outline);
  await act(async () => container.querySelector(".results")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })));
  expect(container.querySelectorAll(".result.selected")).toHaveLength(4);
});

it("closes a tab removed by undo without resaving or recreating it", async () => {
  await act(async () => useStore.setState({
    activeId: "s2", ui: { ...useStore.getState().ui, openScenes: ["s2"] },
    organizationHistory: { undo: 1, redo: 0, revision: 1 },
  }));
  vi.spyOn(api, "undoOrganization").mockResolvedValue({ undo: 0, redo: 1, revision: 2 });
  vi.spyOn(api, "scenes").mockResolvedValue([]);
  vi.spyOn(api, "shows").mockResolvedValue([]);
  const create = vi.spyOn(api, "createScene");
  const save = vi.spyOn(api, "saveScene");
  await contextMenu("scene:s2");
  await menuClick("Undo organization");
  expect(useStore.getState().activeId).toBeNull();
  expect(useStore.getState().ui.openScenes).toEqual([]);
  expect(create).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("shows failed undo errors and keeps the available history", async () => {
  await act(async () => useStore.setState({ organizationHistory: { undo: 1, redo: 0, revision: 1 } }));
  vi.spyOn(api, "undoOrganization").mockRejectedValue(new Error("File changed on disk"));
  await contextMenu("show:show1");
  await menuClick("Undo organization");
  expect(container.querySelector(".explorer-error")?.textContent).toBe("File changed on disk");
  expect(useStore.getState().organizationHistory.undo).toBe(1);
  expect(useStore.getState().organizationBusy).toBe(false);
});

it("keeps a selected act's output scope when undo moves it back between shows", async () => {
  await act(async () => useStore.setState({
    outputScope: { kind: "act", id: "act1", show_id: "show1" },
    organizationHistory: { undo: 1, redo: 0, revision: 1 },
  }));
  vi.spyOn(api, "undoOrganization").mockResolvedValue({ undo: 0, redo: 1, revision: 2 });
  vi.spyOn(api, "scenes").mockResolvedValue([]);
  vi.spyOn(api, "shows").mockResolvedValue([{
    version: 1, id: "show2", name: "Original Show", items: [
      { kind: "act", id: "act1", name: "First Act", scene_ids: [] },
    ],
  }]);
  await contextMenu("act:act1");
  await menuClick("Undo organization");
  expect(useStore.getState().outputScope).toEqual({ kind: "act", id: "act1", show_id: "show2" });
});

it("creates scenes in the right-clicked container rather than the current selection", async () => {
  vi.spyOn(ask, "askText").mockResolvedValue("Created");
  const newScene = vi.fn().mockResolvedValue(undefined);
  await act(async () => useStore.setState({ newScene, outputScope: { kind: "standalone" } }));
  await contextMenu("act:act1");
  await menuClick("New scene");
  expect(newScene).toHaveBeenCalledWith("Created");
  expect(useStore.getState().outputScope).toEqual({ kind: "act", id: "act1", show_id: "show1" });
});

it("drops a scene into an act with a container highlight and stable scene ID", async () => {
  vi.spyOn(api, "placeScene").mockResolvedValue({ id: "s2" });
  mockOrganizationRefresh();
  const result = await drag("scene:s2", "act:act1", 0.5);
  expect(result.over.defaultPrevented).toBe(true);
  expect(result.marker).toContain("drop-inside");
  expect(result.dataTransfer.dropEffect).toBe("move");
  expect(api.placeScene).toHaveBeenCalledWith("s2", { show_id: "show1", act_id: "act1" });
  expect(container.querySelector(".drop-inside")).toBeNull();
  expect(useStore.getState().activeId).toBeNull();
});

it("uses edge drops to reorder mixed siblings and supports standalone destinations", async () => {
  vi.spyOn(api, "placeScene").mockResolvedValue({ id: "s2" });
  mockOrganizationRefresh();
  const result = await drag("scene:s2", "act:act1", 0.05);
  expect(result.marker).toContain("drop-before");
  expect(api.placeScene).toHaveBeenLastCalledWith("s2", { show_id: "show1", index: 0 });
  await drag("scene:s2", "standalone:", 0.5);
  expect(api.placeScene).toHaveBeenLastCalledWith("s2", { index: 1 });
});

it("persists show ordering and rejects dragging an act into its descendant", async () => {
  const second = { version: 1 as const, id: "show2", name: "Second", items: [] };
  await act(async () => useStore.setState((s) => ({ shows: [...s.shows, second] })));
  vi.spyOn(api, "placeShow").mockResolvedValue(second);
  vi.spyOn(api, "placeAct").mockResolvedValue({ kind: "act", id: "act1", name: "First Act", scene_ids: ["s1"] });
  mockOrganizationRefresh();
  const result = await drag("show:show2", "show:show1", 0.05);
  expect(result.marker).toContain("drop-before");
  expect(api.placeShow).toHaveBeenCalledWith("show2", 0);
  const invalid = await drag("act:act1", "scene:s1", 0.05);
  expect(invalid.over.defaultPrevented).toBe(false);
  expect(api.placeAct).not.toHaveBeenCalled();
});
