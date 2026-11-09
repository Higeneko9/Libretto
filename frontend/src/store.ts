import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { create } from "zustand";
import { api, setApiLibrary, setApiLocale, type Graph } from "./api";
import { resolveLanguage, setLanguage, t } from "./i18n";
import { pickName, translatedName, type Tag } from "./tags";
import {
  COLORS,
  DEFAULT_CATEGORIES,
  type Category,
  type CategoryConfig,
  type GraphNodeData,
  type LibraryInfo,
  type Preset,
  type PresetClip,
  type Profile,
  type Run,
  type SceneMeta,
} from "./types";

export type LbNode = Node<GraphNodeData>;

const LEGACY_KEY = "LB_Graph";
const UI_KEY = "LB_Ui";
const DEFAULT_LIBRARY = "default";
let counter = Date.now();
const nextId = (prefix: string) => `${prefix}-${(counter++).toString(36)}`;

const categoryOf = (type: string | undefined, data: GraphNodeData) => (type === "collection" ? data.category : type);

const BASE_COLOR_KEYS = new Set(["collection", "generate", "prompt"]);
/** Point the shared COLORS table at the library's categories (nodes of unknown categories keep their built-in color). */
function syncColors(categories: CategoryConfig[]) {
  for (const key of Object.keys(COLORS)) if (!BASE_COLOR_KEYS.has(key)) delete COLORS[key];
  for (const c of DEFAULT_CATEGORIES) COLORS[c.id] = c.color;
  for (const c of categories) COLORS[c.id] = c.color;
}

// Nodes are interchangeable when they are item/collection nodes of the same category.
export function sameCategory(aType: string | undefined, aData: GraphNodeData, bType: string, bData: GraphNodeData): boolean {
  const skip = (t: string | undefined) => t === "prompt" || t === "generate";
  if (skip(aType) || skip(bType)) return false;
  const category = categoryOf(bType, bData);
  return !!category && categoryOf(aType, aData) === category;
}

export interface UiPrefs {
  resultsW: number;
  inspectorW: number;
  libraryH: number;
  propsOpen: boolean;
  propsW: number;
  resultsThumb: number;
  libThumb: number;
  historyThumb: number;
  libSel: string[];
  openScenes: string[];
  activeScene: string | null;
  /** display language (one of i18n LANGUAGES); also the language new tag names are stored under */
  locale: string;
}

const defaultUi: UiPrefs = {
  resultsW: 380,
  inspectorW: 340,
  libraryH: 320,
  propsOpen: false,
  propsW: 300,
  resultsThumb: 110,
  libThumb: 72,
  historyThumb: 72,
  libSel: ["character"],
  openScenes: [],
  activeScene: null,
  locale: resolveLanguage(typeof navigator === "undefined" ? "" : navigator.language),
};

function loadUi(): UiPrefs {
  let ui = defaultUi;
  try {
    ui = { ...defaultUi, ...JSON.parse(localStorage.getItem(UI_KEY) ?? "{}") };
  } catch {
    // keep defaults
  }
  ui = { ...ui, locale: resolveLanguage(ui.locale) };
  setApiLocale(ui.locale);
  setLanguage(ui.locale);
  return ui;
}

const defaultGenerate = (): LbNode => ({
  id: "generate",
  type: "generate",
  position: { x: 640, y: 160 },
  data: { profile: "sdxl", batch: 1, seed: -1, seed_locked: false, pick_seed: -1, pick_locked: false },
});

const LEGACY_PROMPT_FIELDS = [
  ["prepend_positive", "positive", "prepend"],
  ["append_positive", "positive", "append"],
  ["prepend_negative", "negative", "prepend"],
  ["append_negative", "negative", "append"],
] as const;

// Older scenes stored prepend/append text on the Generate node; turn those into prompt nodes.
export function migrateLegacyPrompts(nodes: LbNode[], edges: Edge[]): { nodes: LbNode[]; edges: Edge[] } {
  const generate = nodes.find((n) => n.type === "generate");
  if (!generate || !LEGACY_PROMPT_FIELDS.some(([key]) => (generate.data[key] ?? "").trim())) return { nodes, edges };
  const added: LbNode[] = [];
  const newEdges: Edge[] = [];
  LEGACY_PROMPT_FIELDS.forEach(([key, polarity, placement], i) => {
    const text = (generate.data[key] ?? "").trim();
    if (!text) return;
    const id = nextId("prompt");
    added.push({ id, type: "prompt", position: { x: generate.position.x - 320, y: generate.position.y + i * 110 }, data: { text, polarity, placement } });
    newEdges.push({ id: `${id}->${generate.id}`, source: id, target: generate.id });
  });
  const cleaned = nodes.map((n) =>
    n === generate
      ? { ...n, data: { ...n.data, prepend_positive: undefined, append_positive: undefined, prepend_negative: undefined, append_negative: undefined } }
      : n,
  );
  return { nodes: [...cleaned, ...added], edges: [...edges, ...newEdges] };
}

/** Display name of a library; ids are opaque, so never show them. */
export function libraryName(libraries: { id: string; name: string; names?: Record<string, string> }[], id: string, locale?: string): string {
  const l = libraries.find((x) => x.id === id);
  return l ? (locale ? translatedName(l.name, l.names, locale) ?? l.name : l.name) : id;
}

/** Resolve each category's display label for a UI language. */
export const withLabels = (categories: CategoryConfig[], locale: string): CategoryConfig[] =>
  categories.map((c) => ({ ...c, label: pickName(c.names ?? {}, locale) ?? c.label ?? c.id }));

/** Config of a category in the active library, falling back to the built-in defaults, then to a plain custom category. */
export function categoryInfo(id: string | undefined): CategoryConfig {
  const state = useStore.getState();
  const found = id ? [...state.categories, ...withLabels(DEFAULT_CATEGORIES, state.ui.locale)].find((c) => c.id === id) : undefined;
  return found ?? { id: id ?? "", names: {}, label: id ?? "", kind: "custom", color: COLORS.prompt, folder: id ?? "", locked: false, can_belong: false, has_color: false, template: "{text}" };
}

export const isCharacterNode = (n: LbNode) => categoryInfo(categoryOf(n.type, n.data)).kind === "group_head";
export const characterLabel = (n: LbNode) => (n.type === "collection" ? t("store.randomCharacter") : n.data.name || categoryInfo(n.type).label.toLowerCase());
/** True when a node of this category may belong to a group head such as a character. */
export const canBelong = (category: string | undefined) => categoryInfo(category).can_belong;

const emptyGraph = (library = DEFAULT_LIBRARY): Graph => ({
  nodes: [defaultGenerate()],
  edges: [],
  library,
  scene_prompt: "",
  scene_negative: "",
});

interface State {
  nodes: LbNode[];
  edges: Edge[];
  library: string;
  scenePrompt: string;
  sceneNegative: string;
  selectedId: string | null;
  categories: CategoryConfig[];
  presets: Partial<Record<Category, Preset[]>>;
  tags: Tag[];
  profiles: Profile[];
  libraries: LibraryInfo[];
  runs: Run[];
  thumbVersion: number;
  presetClip: PresetClip | null;
  setPresetClip: (clip: PresetClip | null) => void;
  ui: UiPrefs;
  scenes: SceneMeta[];
  activeId: string | null;
  sceneReady: boolean;
  onNodesChange: (changes: NodeChange<LbNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  select: (id: string | null) => void;
  addNode: (type: string, data: GraphNodeData, position: { x: number; y: number }, replaceId?: string) => void;
  updateNode: (id: string, patch: Partial<GraphNodeData>) => void;
  updateNodes: (ids: string[], patch: Partial<GraphNodeData>) => void;
  removeNode: (id: string) => void;
  nodeClip: LbNode[];
  copyNodes: (ids: string[]) => void;
  pasteNodes: (at: { x: number; y: number }) => void;
  removeNodes: (ids: string[]) => void;
  setScenePrompt: (value: string) => void;
  setSceneNegative: (value: string) => void;
  toGraph: () => Graph;
  refreshPresets: (category?: Category) => Promise<void>;
  refreshCategories: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshLibraries: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  bumpThumbs: () => void;
  setLibrary: (id: string) => Promise<void>;
  setUi: (patch: Partial<UiPrefs>) => void;
  initScenes: () => Promise<void>;
  openScene: (id: string) => Promise<void>;
  closeScene: (id: string) => Promise<void>;
  newScene: (name?: string, graph?: Graph) => Promise<void>;
  renameScene: (id: string, name: string, names?: Record<string, string>) => Promise<void>;
  deleteScene: (id: string) => Promise<void>;
  /** Ask the output pane to scroll to a run (if it still exists). */
  focusRun: { id: string; n: number } | null;
  showRun: (id: string) => void;
  /** Replace the active scene's content (e.g. from a saved snapshot); undoable. */
  applySceneGraph: (graph: Graph) => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

// ---- undo/redo (per scene; rapid edits like drags and typing coalesce into one step) ----
interface Snap {
  nodes: LbNode[];
  edges: Edge[];
  scenePrompt: string;
  sceneNegative: string;
  sig: string;
}

const HISTORY_LIMIT = 100;
let undoStack: Snap[] = [];
let redoStack: Snap[] = [];
let committed: Snap | null = null;
let commitTimer: ReturnType<typeof setTimeout> | null = null;
let restoring = false;

const takeSnap = (s: Pick<State, "nodes" | "edges" | "scenePrompt" | "sceneNegative">): Snap => ({
  nodes: s.nodes,
  edges: s.edges,
  scenePrompt: s.scenePrompt,
  sceneNegative: s.sceneNegative,
  // selection and measured sizes are deliberately left out so they don't create history entries
  sig: JSON.stringify([
    s.nodes.map((n) => [n.id, n.type, n.position, { ...n.data, lastPick: undefined }]),
    s.edges.map((e) => [e.source, e.target]),
    s.scenePrompt,
    s.sceneNegative,
  ]),
});

const syncHistoryFlags = () =>
  useStore.setState({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });

export function resetHistory() {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = null;
  undoStack = [];
  redoStack = [];
  committed = takeSnap(useStore.getState());
  syncHistoryFlags();
}

function commitHistory() {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = null;
  const current = takeSnap(useStore.getState());
  if (!committed || current.sig === committed.sig) return;
  undoStack.push(committed);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  committed = current;
  redoStack = [];
  syncHistoryFlags();
}

function restoreSnap(snap: Snap) {
  restoring = true;
  const selectedId = useStore.getState().selectedId;
  const keep = snap.nodes.some((n) => n.id === selectedId) ? selectedId : null;
  useStore.setState({
    nodes: snap.nodes.map((n) => ({ ...n, selected: n.id === keep })),
    edges: snap.edges,
    scenePrompt: snap.scenePrompt,
    sceneNegative: snap.sceneNegative,
    selectedId: keep,
  });
  restoring = false;
  committed = takeSnap(useStore.getState());
  syncHistoryFlags();
}

function stepHistory(from: Snap[], to: Snap[]) {
  commitHistory();
  const target = from.pop();
  if (!target || !committed) return;
  to.push(committed);
  restoreSnap(target);
}

const sceneName = (scenes: SceneMeta[], id: string | null) => scenes.find((s) => s.id === id)?.name ?? t("store.sceneFallback");

// ---- autosave of the active scene ------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function saveNow() {
  const { activeId, sceneReady, toGraph } = useStore.getState();
  if (!activeId || !sceneReady) return;
  await api.saveScene(activeId, { graph: toGraph() });
}

export async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveNow();
  }
}

export const useStore = create<State>((set, get) => {
  const initialUi = loadUi();
  const applyGraph = async (graph: Graph, keepHistory = false, reload = true) => {
    const rawNodes = graph.nodes as LbNode[];
    const rawEdges = graph.edges as Edge[];
    const { nodes: migrated, edges: migratedEdges } = migrateLegacyPrompts(rawNodes, rawEdges);
    const nodes = migrated.length ? migrated : [defaultGenerate()];
    const edges = migratedEdges.map((e) => ({ ...e, id: e.id ?? `${e.source}->${e.target}` }));
    let library = graph.library || DEFAULT_LIBRARY;
    if (!get().libraries.some((l) => l.id === library)) library = DEFAULT_LIBRARY;
    // keep the library pane as is when the scene uses the same library (avoids a flash)
    const libraryChanged = library !== get().library;
    setApiLibrary(library);
    set({
      nodes,
      edges,
      library,
      scenePrompt: graph.scene_prompt ?? "",
      sceneNegative: graph.scene_negative ?? "",
      selectedId: null,
      ...(libraryChanged ? { presets: {}, tags: [] } : {}),
    });
    if (!keepHistory) resetHistory();
    // same library and already loaded (e.g. restoring a snapshot): the palette data is current, so skip the refetch
    if (reload || libraryChanged || Object.keys(get().presets).length === 0) await get().refreshPresets();
    if (libraryChanged) get().bumpThumbs();
  };

  const persistOpen = (openScenes: string[], activeScene: string | null) => get().setUi({ openScenes, activeScene });

  return {
    nodes: [],
    edges: [],
    library: DEFAULT_LIBRARY,
    scenePrompt: "",
    sceneNegative: "",
    selectedId: null,
    categories: withLabels(DEFAULT_CATEGORIES, initialUi.locale),
    presets: {},
    tags: [],
    profiles: [],
    libraries: [],
    runs: [],
    thumbVersion: Date.now(), // unique per page load so URLs cached by earlier sessions are never reused
    presetClip: null,
    setPresetClip: (presetClip) => set({ presetClip }),
    ui: initialUi,
    scenes: [],
    activeId: null,
    sceneReady: false,
    canUndo: false,
    canRedo: false,
    undo: () => stepHistory(undoStack, redoStack),
    redo: () => stepHistory(redoStack, undoStack),
    onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
    onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
    onConnect: (connection) => set({ edges: addEdge(connection, get().edges) }),
    select: (id) => set({ selectedId: id }),
    addNode: (type, data, position, replaceId) => {
      const target = replaceId ? get().nodes.find((n) => n.id === replaceId) : undefined;
      if (target && sameCategory(target.type, target.data, type, data)) {
        set({
          // the replacement keeps the character it belonged to
          nodes: get().nodes.map((n) => (n.id === target.id ? { ...n, type, data: target.data.owner ? { ...data, owner: target.data.owner } : data } : n)),
          selectedId: target.id,
        });
        return;
      }
      const id = nextId(type);
      const node: LbNode = { id, type, position, data };
      const generate = get().nodes.find((n) => n.type === "generate");
      const edges =
        type !== "generate" && generate
          ? addEdge({ source: id, target: generate.id, sourceHandle: null, targetHandle: null }, get().edges)
          : get().edges;
      set({ nodes: [...get().nodes, node], edges, selectedId: id });
    },
    updateNodes: (ids, patch) =>
      set({ nodes: get().nodes.map((n) => (ids.includes(n.id) ? { ...n, data: { ...n.data, ...patch } } : n)) }),
    updateNode: (id, patch) =>
      set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)) }),
    removeNode: (id) =>
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id),
        selectedId: null,
      }),
    nodeClip: [],
    copyNodes: (ids) => set({ nodeClip: get().nodes.filter((n) => ids.includes(n.id) && n.type !== "generate").map((n) => structuredClone({ ...n, selected: false })) }),
    pasteNodes: (at) => {
      const clip = get().nodeClip;
      if (clip.length === 0) return;
      const minX = Math.min(...clip.map((n) => n.position.x));
      const minY = Math.min(...clip.map((n) => n.position.y));
      const generate = get().nodes.find((n) => n.type === "generate");
      const added = clip.map((n) => ({
        ...structuredClone(n),
        id: nextId(n.type ?? "node"),
        position: { x: at.x + n.position.x - minX, y: at.y + n.position.y - minY },
        selected: true,
      }));
      const newEdges = generate ? added.map((n) => ({ id: `${n.id}->${generate.id}`, source: n.id, target: generate.id })) : [];
      set({
        nodes: [...get().nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...added],
        edges: [...get().edges, ...newEdges],
        selectedId: added.length === 1 ? added[0].id : null,
      });
    },
    removeNodes: (ids) =>
      set({
        nodes: get().nodes.filter((n) => !ids.includes(n.id) || n.type === "generate"),
        edges: get().edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)),
        selectedId: null,
      }),
    setScenePrompt: (value) => set({ scenePrompt: value }),
    setSceneNegative: (value) => set({ sceneNegative: value }),
    toGraph: () => ({
      nodes: get().nodes.map((n) => ({ id: n.id, type: n.type, data: n.data, position: n.position })),
      edges: get().edges.map((e) => ({ source: e.source, target: e.target })),
      name: sceneName(get().scenes, get().activeId),
      library: get().library,
      scene_prompt: get().scenePrompt,
      scene_negative: get().sceneNegative,
    }),
    refreshCategories: async () => {
      const library = get().library;
      const categories = await api.categories();
      if (get().library !== library) return;
      syncColors(categories);
      set({ categories: withLabels(categories, get().ui.locale) });
    },
    refreshPresets: async (category) => {
      const library = get().library;
      if (!category) await get().refreshCategories();
      if (get().library !== library) return;
      const categories = category ? [category] : get().categories.map((c) => c.id);
      const lists = await Promise.all(categories.map((c) => api.presets(c)));
      if (get().library !== library) return;
      // after the lists: loading presets may convert old text tags into tag records
      const tags = await api.tags();
      if (get().library !== library) return;
      set({ tags, presets: { ...get().presets, ...Object.fromEntries(categories.map((c, i) => [c, lists[i]])) } });
    },
    refreshTags: async () => {
      const library = get().library;
      const tags = await api.tags();
      if (get().library === library) set({ tags });
    },
    refreshProfiles: async () => set({ profiles: await api.profiles() }),
    refreshLibraries: async () => set({ libraries: await api.libraries() }),
    refreshRuns: async () => set({ runs: await api.runs() }),
    bumpThumbs: () => set({ thumbVersion: get().thumbVersion + 1 }),
    setLibrary: async (id) => {
      if (id === get().library) return;
      setApiLibrary(id);
      set({ library: id, presets: {}, tags: [] });
      await get().refreshPresets();
      get().bumpThumbs();
    },
    setUi: (patch) => {
      const ui = { ...get().ui, ...patch };
      if (patch.locale) {
        setApiLocale(patch.locale);
        setLanguage(patch.locale);
      }
      localStorage.setItem(UI_KEY, JSON.stringify(ui));
      set(patch.locale ? { ui, categories: withLabels(get().categories, ui.locale) } : { ui });
    },

    initScenes: async () => {
      await Promise.all([get().refreshLibraries(), get().refreshProfiles()]);
      let scenes = await api.scenes();
      if (scenes.length === 0) {
        // first run with scenes: carry over the graph that used to live in localStorage
        let legacy: Graph | null = null;
        try {
          const saved = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "");
          if (Array.isArray(saved.nodes) && saved.nodes.some((n: LbNode) => n.type === "generate")) legacy = saved;
        } catch {
          /* no legacy graph */
        }
        await api.createScene(t("store.sceneN", { n: 1 }), { ...emptyGraph(), ...legacy, library: DEFAULT_LIBRARY });
        localStorage.removeItem(LEGACY_KEY);
        scenes = await api.scenes();
      }
      const { openScenes, activeScene } = get().ui;
      const open = openScenes.filter((id) => scenes.some((s) => s.id === id));
      if (open.length === 0) {
        // first run: open the shipped example scenes so they are easy to find
        const starters = scenes.filter((s) => s.starter != null).sort((a, b) => a.starter! - b.starter!);
        open.push(...starters.map((s) => s.id));
      }
      const active = activeScene && open.includes(activeScene) ? activeScene : (open[0] ?? scenes[0].id);
      if (!open.includes(active)) open.push(active);
      const scene = await api.scene(active);
      set({ scenes, activeId: active });
      persistOpen(open, active);
      await applyGraph(scene.graph);
      set({ sceneReady: true });
    },
    openScene: async (id) => {
      if (id === get().activeId) return;
      await flushSave();
      const scene = await api.scene(id);
      const open = get().ui.openScenes.includes(id) ? get().ui.openScenes : [...get().ui.openScenes, id];
      set({ activeId: id });
      persistOpen(open, id);
      await applyGraph(scene.graph);
    },
    closeScene: async (id) => {
      const open = get().ui.openScenes.filter((s) => s !== id);
      if (id !== get().activeId) return persistOpen(open, get().activeId);
      await flushSave();
      if (open.length === 0) {
        const fallback = get().scenes.find((s) => s.id !== id);
        if (!fallback) return get().newScene(t("store.sceneN", { n: 1 }));
        open.push(fallback.id);
      }
      const index = get().ui.openScenes.indexOf(id);
      const next = open[Math.min(index, open.length - 1)];
      const scene = await api.scene(next);
      set({ activeId: next });
      persistOpen(open, next);
      await applyGraph(scene.graph);
    },
    newScene: async (name, graph) => {
      await flushSave();
      const created = await api.createScene(name || t("store.sceneN", { n: get().scenes.length + 1 }), graph ?? emptyGraph(get().library));
      const scenes = await api.scenes();
      set({ scenes, activeId: created.id });
      persistOpen([...get().ui.openScenes, created.id], created.id);
      await applyGraph(created.graph);
    },
    applySceneGraph: (graph) => {
      // the batch count belongs to the current Generate click, not the saved scene content
      const batch = get().nodes.find((n) => n.type === "generate")?.data.batch;
      const nodes = (graph.nodes as LbNode[]).map((n) => (n.type === "generate" && batch !== undefined ? { ...n, data: { ...n.data, batch } } : n));
      return applyGraph({ ...graph, nodes }, true, false);
    },
    focusRun: null,
    showRun: (id) => set({ focusRun: { id, n: (get().focusRun?.n ?? 0) + 1 } }),
    renameScene: async (id, name, names) => {
      await api.saveScene(id, { name, names });
      set({ scenes: await api.scenes() });
    },
    deleteScene: async (id) => {
      if (id === get().activeId) {
        await get().closeScene(id);
      } else {
        persistOpen(
          get().ui.openScenes.filter((s) => s !== id),
          get().activeId,
        );
      }
      await api.deleteScene(id);
      set({ scenes: await api.scenes() });
    },
  };
});

useStore.subscribe((state, prev) => {
  const contentChanged =
    state.nodes !== prev.nodes ||
    state.edges !== prev.edges ||
    state.scenePrompt !== prev.scenePrompt ||
    state.sceneNegative !== prev.sceneNegative;
  if (contentChanged && state.sceneReady && !restoring) {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(commitHistory, 400);
  }
  const changed =
    state.nodes !== prev.nodes ||
    state.edges !== prev.edges ||
    state.library !== prev.library ||
    state.scenePrompt !== prev.scenePrompt ||
    state.sceneNegative !== prev.sceneNegative;
  if (!changed || !state.sceneReady || state.activeId !== prev.activeId) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, 600);
});

window.addEventListener("beforeunload", () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    void saveNow();
  }
});
