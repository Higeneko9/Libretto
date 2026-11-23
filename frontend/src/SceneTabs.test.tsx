import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { SceneTabs } from "./SceneTabs";
import { useStore } from "./store";
import { runGenerate, useGeneration } from "./generation";

let container: HTMLDivElement;
let root: Root;
let previous: ReturnType<typeof useStore.getState>;
const scenes = [
  { id: "one", name: "One", updated_at: "", starter: 1 },
  { id: "two", name: "Two", updated_at: "", starter: 2 },
];
const graph = (name: string) => ({
  nodes: [{ id: "generate", type: "generate", position: { x: 0, y: 0 }, data: { name } }],
  edges: [],
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previous = useStore.getState();
  vi.spyOn(api, "scene").mockImplementation(async (id) => ({ id, name: id, graph: graph(id) }));
  vi.spyOn(api, "saveScene").mockResolvedValue({});
  vi.spyOn(api, "saveUi").mockResolvedValue({});
  vi.spyOn(api, "ui").mockResolvedValue({});
  vi.spyOn(api, "scenes").mockResolvedValue(scenes);
  useStore.setState({
    sceneReady: false, tabsBusy: false, activeId: "one", scenes,
    nodes: graph("one").nodes, edges: [], scenePrompt: "", sceneNegative: "",
    ui: { ...previous.ui, locale: "en-US", openScenes: ["one", "two"], recentScenes: [], activeScene: "one", closedAllScenes: false },
    refreshPresets: vi.fn().mockResolvedValue(undefined),
    refreshLibraries: vi.fn().mockResolvedValue(undefined),
    refreshProfiles: vi.fn().mockResolvedValue(undefined),
    refreshOrganization: vi.fn().mockResolvedValue(undefined),
  });
  useStore.setState({ sceneReady: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SceneTabs />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStore.setState({ sceneReady: false });
  useStore.setState(previous);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function menuOn(name: string) {
  const tab = [...container.querySelectorAll(".scene-tab")].find((item) => item.textContent?.includes(name));
  if (!tab) throw new Error(`Missing tab ${name}`);
  await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
}

async function clickMenu(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".ctx-menu button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Missing action ${label}`);
  await act(async () => button.click());
}

it("closes other tabs around the right-clicked inactive scene after saving", async () => {
  await act(async () => useStore.getState().setScenePrompt("unsaved edit"));
  await menuOn("Two");
  await clickMenu("Close other tabs");
  expect(api.saveScene).toHaveBeenCalledWith("one", expect.objectContaining({ graph: expect.objectContaining({ scene_prompt: "unsaved edit" }) }));
  expect(useStore.getState()).toMatchObject({ activeId: "two", sceneReady: true, ui: { openScenes: ["two"], activeScene: "two" } });
  expect(useStore.getState().nodes[0].data.name).toBe("two");
});

it("closes all tabs without deleting scenes and reopens a closed scene", async () => {
  await menuOn("One");
  await clickMenu("Close all tabs");
  expect(useStore.getState()).toMatchObject({ activeId: null, nodes: [], sceneReady: true, ui: { openScenes: [], activeScene: null, closedAllScenes: true } });
  expect(useStore.getState().scenes).toHaveLength(2);
  await act(async () => container.querySelector<HTMLButtonElement>(".scene-tabs > button")!.click());
  await clickMenu("Two");
  expect(useStore.getState()).toMatchObject({ activeId: "two", ui: { openScenes: ["two"], closedAllScenes: false } });
});

it.each([true, false])("closes the last tab without opening or creating a replacement (other scene exists: %s)", async (otherSceneExists) => {
  const create = vi.spyOn(api, "createScene");
  await act(async () => {
    useStore.setState((state) => ({
      scenes: otherSceneExists ? scenes : [scenes[0]],
      ui: { ...state.ui, openScenes: ["one"] },
    }));
    useStore.getState().setScenePrompt("latest edit");
  });
  await act(async () => container.querySelector<HTMLButtonElement>(".tab-close")!.click());
  expect(api.saveScene).toHaveBeenCalledWith("one", expect.objectContaining({ graph: expect.objectContaining({ scene_prompt: "latest edit" }) }));
  expect(api.scene).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(useStore.getState()).toMatchObject({ activeId: null, nodes: [], sceneReady: true, ui: { openScenes: [], activeScene: null, closedAllScenes: true, recentScenes: ["one"] } });
  const saved = useStore.getState().ui;
  vi.mocked(api.ui).mockResolvedValue(saved);
  await act(async () => useStore.getState().initScenes());
  expect(useStore.getState()).toMatchObject({ activeId: null, ui: { openScenes: [] } });
  await act(async () => useStore.getState().openScene("one"));
  expect(useStore.getState()).toMatchObject({ activeId: "one", ui: { openScenes: ["one"], closedAllScenes: false } });
});

it("keeps the last tab open if saving fails", async () => {
  await act(async () => {
    useStore.setState((state) => ({ ui: { ...state.ui, openScenes: ["one"] } }));
    useStore.getState().setScenePrompt("important edit");
  });
  vi.mocked(api.saveScene).mockRejectedValueOnce(new Error("save failed"));
  await act(async () => container.querySelector<HTMLButtonElement>(".tab-close")!.click());
  expect(container.textContent).toContain("save failed");
  expect(useStore.getState()).toMatchObject({ activeId: "one", scenePrompt: "important edit", ui: { openScenes: ["one"], recentScenes: [] } });
  await act(async () => container.querySelector<HTMLButtonElement>(".tab-close")!.click());
  expect(useStore.getState().activeId).toBeNull();
});

it("keeps all tabs and the edited graph when autosave fails, and retries on close", async () => {
  vi.mocked(api.saveScene).mockRejectedValueOnce(new Error("save failed"));
  await act(async () => useStore.getState().setScenePrompt("important edit"));
  await menuOn("One");
  await clickMenu("Close all tabs");
  expect(container.textContent).toContain("save failed");
  expect(useStore.getState()).toMatchObject({ activeId: "one", scenePrompt: "important edit", ui: { openScenes: ["one", "two"] } });
  await menuOn("One");
  await clickMenu("Close all tabs");
  expect(api.saveScene).toHaveBeenCalledTimes(2);
  expect(useStore.getState().activeId).toBeNull();
});

it("waits for an in-flight save and blocks concurrent tab operations", async () => {
  let finish!: () => void;
  vi.mocked(api.saveScene).mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve({}); }));
  await act(async () => useStore.getState().setScenePrompt("pending"));
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  let closing!: Promise<void>;
  await act(async () => { closing = useStore.getState().closeAllScenes(); });
  expect(useStore.getState()).toMatchObject({ activeId: "one", tabsBusy: true });
  await expect(useStore.getState().openScene("two")).rejects.toThrow("already in progress");
  await act(async () => { finish(); await closing; });
  expect(useStore.getState()).toMatchObject({ activeId: null, tabsBusy: false });
});

it("restores an intentional empty tab list at startup but opens starters on first run", async () => {
  await act(async () => useStore.getState().closeAllScenes());
  const saved = useStore.getState().ui;
  vi.mocked(api.ui).mockResolvedValue(saved);
  await act(async () => useStore.getState().initScenes());
  expect(useStore.getState()).toMatchObject({ activeId: null, sceneReady: true, ui: { openScenes: [] } });
  expect(api.scene).not.toHaveBeenCalled();

  vi.mocked(api.ui).mockResolvedValue({ ...saved, closedAllScenes: false });
  await act(async () => useStore.getState().initScenes());
  expect(useStore.getState()).toMatchObject({ activeId: "one", ui: { openScenes: ["one", "two"] } });
});

it("keeps the active tab when closing others and disables that action for a single tab", async () => {
  await menuOn("One");
  await clickMenu("Close other tabs");
  expect(api.scene).not.toHaveBeenCalled();
  expect(useStore.getState().ui.openScenes).toEqual(["one"]);
  await menuOn("One");
  const button = [...container.querySelectorAll<HTMLButtonElement>(".ctx-menu button")].find((item) => item.textContent === "Close other tabs");
  expect(button?.disabled).toBe(true);
});

it("keeps the active scene and tabs when loading the retained tab fails", async () => {
  vi.mocked(api.scene).mockRejectedValueOnce(new Error("load failed"));
  await menuOn("Two");
  await clickMenu("Close other tabs");
  expect(container.textContent).toContain("load failed");
  expect(useStore.getState()).toMatchObject({ activeId: "one", ui: { openScenes: ["one", "two"] }, tabsBusy: false });
});

it("prevents generation and palette additions after closing all tabs", async () => {
  const generate = vi.spyOn(api, "generate");
  await act(async () => useStore.getState().closeAllScenes());
  await act(async () => {
    useStore.getState().addNodeFocused("prompt", { text: "not added" });
    await runGenerate();
  });
  expect(useStore.getState().nodes).toEqual([]);
  expect(generate).not.toHaveBeenCalled();
  expect(useGeneration.getState().error).toContain("No scene open");
  useGeneration.setState({ error: "" });
});

it("restores the editor when a scene is created from the empty state", async () => {
  await act(async () => useStore.getState().closeAllScenes());
  const created = { id: "new", name: "New", graph: graph("new") };
  vi.spyOn(api, "createScene").mockResolvedValue(created);
  await act(async () => useStore.getState().newScene("New"));
  expect(useStore.getState()).toMatchObject({ activeId: "new", sceneReady: true, ui: { openScenes: ["new"], closedAllScenes: false } });
  expect(useStore.getState().nodes[0].data.name).toBe("new");
});

it("lists at most eight closed scenes in most-recently-closed order", async () => {
  const manyScenes = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, name: `Scene ${i}`, updated_at: "" }));
  await act(async () => useStore.setState((state) => ({
    scenes: manyScenes,
    activeId: "s0",
    ui: { ...state.ui, openScenes: manyScenes.map((scene) => scene.id), activeScene: "s0" },
  })));
  for (let i = 1; i <= 10; i++) {
    await act(async () => useStore.getState().closeScene(`s${i}`));
  }
  await act(async () => container.querySelector<HTMLButtonElement>(".scene-tabs > button")!.click());
  expect(container.textContent).toContain("Recent scenes");
  const labels = [...container.querySelectorAll<HTMLButtonElement>(".ctx-menu button")].map((button) => button.textContent);
  expect(labels.slice(-8)).toEqual(["Scene 10", "Scene 9", "Scene 8", "Scene 7", "Scene 6", "Scene 5", "Scene 4", "Scene 3"]);
  expect(labels).not.toContain("Scene 2");
});

it("removes reopened scenes and moves them to the top when closed again", async () => {
  await act(async () => useStore.getState().closeAllScenes());
  expect(useStore.getState().ui.recentScenes).toEqual(["one", "two"]);
  await act(async () => useStore.getState().openScene("one"));
  expect(useStore.getState().ui.recentScenes).toEqual(["two"]);
  await act(async () => useStore.getState().openScene("two"));
  await act(async () => useStore.getState().closeScene("one"));
  expect(useStore.getState().ui.recentScenes).toEqual(["one"]);
  await act(async () => useStore.getState().closeAllScenes());
  expect(useStore.getState().ui.recentScenes).toEqual(["two", "one"]);
});

it("persists recent scenes across startup and omits scenes deleted from the outline", async () => {
  await act(async () => useStore.getState().closeAllScenes());
  const saved = useStore.getState().ui;
  expect(JSON.parse(localStorage.getItem("LB_Ui")!).recentScenes).toEqual(["one", "two"]);
  vi.mocked(api.ui).mockResolvedValue(saved);
  await act(async () => useStore.getState().initScenes());
  expect(useStore.getState().ui.recentScenes).toEqual(["one", "two"]);

  vi.mocked(api.scenes).mockResolvedValue([scenes[1]]);
  vi.spyOn(api, "shows").mockResolvedValue([]);
  vi.spyOn(api, "organizationHistory").mockResolvedValue({ undo: 0, redo: 0, revision: 0 });
  useStore.setState({ refreshOrganization: previous.refreshOrganization });
  await act(async () => useStore.getState().refreshOrganization());
  expect(useStore.getState().ui.recentScenes).toEqual(["two"]);
});
