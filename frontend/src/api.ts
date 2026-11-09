import type { AppSettings, BackupInfo, Category, CategoryConfig, CategoryKindInfo, LibraryInfo, Preset, Profile, Run, SceneMeta, SceneSnapList, Snapshot, WorkflowFile } from "./types";
import type { Tag } from "./tags";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface Graph {
  nodes: unknown[];
  edges: unknown[];
  name?: string;
  library?: string;
  scene_prompt?: string;
  scene_negative?: string;
}

// The active library is a module-level setting so every library call (and thumbnail URL) is scoped to it.
let activeLibrary = "default";
export const setApiLibrary = (id: string) => {
  activeLibrary = id;
};
const lib = (url: string, library = activeLibrary) => `${url}${url.includes("?") ? "&" : "?"}lib=${encodeURIComponent(library)}`;

// New tag names typed in the UI are stored under this locale.
let activeLocale = "und";
export const setApiLocale = (locale: string) => {
  activeLocale = locale;
};

export const api = {
  backups: () => call<BackupInfo[]>("/api/backups"),
  createBackup: (note: string, includeHistory: boolean) =>
    call<BackupInfo>("/api/backups", json("POST", { note, include_history: includeHistory })),
  restoreBackup: (id: string, mode: "merge" | "replace", includeHistory: boolean) =>
    call<{ restored: Record<string, number>; runs: number; safety_backup: string }>(
      `/api/backups/${id}/restore`,
      json("POST", { mode, include_history: includeHistory }),
    ),
  deleteBackup: (id: string) => call<unknown>(`/api/backups/${id}`, { method: "DELETE" }),
  backupDownloadUrl: (id: string) => `/api/backups/${id}/download`,
  importBackup: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<BackupInfo>("/api/backups/import", { method: "POST", body: form });
  },
  settings: () => call<AppSettings>("/api/settings"),
  ui: () => call<Record<string, any>>("/api/ui"),
  saveUi: (ui: object) => call<object>("/api/ui", json("PUT", ui)),
  saveSettings: (body: Partial<AppSettings>) => call<AppSettings>("/api/settings", json("PUT", body)),
  testComfy: (comfy_url: string) => call<{ ok: boolean; url?: string; version?: string; error?: string }>("/api/settings/test", json("POST", { comfy_url })),
  health: () => call<{ comfyui: string; version?: string; error?: string }>("/api/health"),
  profiles: () => call<Profile[]>("/api/profiles"),
  patchProfile: (id: string, changes: Partial<Profile>) => call<Profile>(`/api/profiles/${id}`, json("PATCH", changes)),
  deleteProfile: (id: string) => call<unknown>(`/api/profiles/${id}`, { method: "DELETE" }),
  comfyWorkflows: () => call<WorkflowFile[]>("/api/comfy/workflows"),
  importWorkflow: (path: string, format?: string, keepPositive = false, keepNegative = true) =>
    call<{ profile: Profile; warnings: string[] }>(
      "/api/comfy/workflows/import",
      json("POST", { path, format, keep_positive: keepPositive, keep_negative: keepNegative }),
    ),
  libraries: () => call<LibraryInfo[]>("/api/libraries"),
  createLibrary: (name: string, copyFrom?: string) =>
    call<{ id: string }>("/api/libraries", json("POST", { name, copy_from: copyFrom || null })),
  renameLibrary: (id: string, name: string, names?: Record<string, string>) => call<{ id: string; name: string }>(`/api/libraries/${id}`, json("PATCH", { name, names })),
  deleteLibrary: (id: string) => call<unknown>(`/api/libraries/${id}`, { method: "DELETE" }),
  tags: () => call<Tag[]>(lib("/api/tags")),
  patchTag: (id: string, body: { locale?: string; name?: string; remove_locale?: string; parent?: string | null }) =>
    call<Tag>(lib(`/api/tags/${id}`), json("PATCH", body)),
  deleteTag: (id: string) => call<unknown>(lib(`/api/tags/${id}`), { method: "DELETE" }),
  exportLibraryUrl: (id: string) => `/api/libraries/${id}/export`,
  importLibrary: (file: File, name: string) => {
    const form = new FormData();
    form.append("file", file);
    return call<{ id: string }>(`/api/libraries/import?name=${encodeURIComponent(name)}`, { method: "POST", body: form });
  },
  copyItems: (target: string, source: string, items: { category: Category; id: string }[]) =>
    call<{ category: Category; id: string; from: string }[]>(`/api/libraries/${target}/copy`, json("POST", { source, items })),
  categories: (library?: string) => call<CategoryConfig[]>(lib("/api/categories", library)),
  saveCategories: (items: CategoryConfig[], purge = false) => call<CategoryConfig[]>(lib(`/api/categories${purge ? "?purge=true" : ""}`), json("PUT", items)),
  categoryKinds: () => call<CategoryKindInfo[]>("/api/category-kinds"),
  presets: (category: Category, library?: string) => call<Preset[]>(lib(`/api/library/${category}`, library)),
  savePreset: (category: Category, preset: Partial<Preset>, id?: string) =>
    call<Preset>(lib(`${id ? `/api/library/${category}/${id}` : `/api/library/${category}`}?locale=${encodeURIComponent(activeLocale)}`), json(id ? "PUT" : "POST", preset)),
  deletePreset: (category: Category, id: string, library?: string) =>
    call<unknown>(lib(`/api/library/${category}/${id}`, library), { method: "DELETE" }),
  restorePreset: (category: Category, id: string, library?: string) =>
    call<Preset>(lib(`/api/library/${category}/${id}/restore`, library), { method: "POST" }),
  importWildcard: (category: Category, text: string) =>
    call<Preset[]>(lib(`/api/library/${category}/import-wildcard`), json("POST", { text })),
  uploadThumbnail: (category: Category, id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<Preset>(lib(`/api/library/${category}/${id}/thumbnail`), { method: "POST", body: form });
  },
  thumbnailFromRun: (category: Category, id: string, runId: string, image: string, library?: string) =>
    call<Preset>(lib(`/api/library/${category}/${id}/thumbnail/from-run`, library), json("POST", { run_id: runId, image })),
  thumbnailUrl: (category: Category, id: string, profile?: string, bust?: number, library?: string) =>
    lib(`/api/library/${category}/${id}/thumbnail?${profile ? `profile=${profile}&` : ""}v=${bust ?? 0}`, library),
  scenes: () => call<SceneMeta[]>("/api/scenes"),
  scene: (id: string) => call<{ id: string; name: string; graph: Graph }>(`/api/scenes/${id}`),
  createScene: (name: string, graph?: Graph) =>
    call<{ id: string; name: string; graph: Graph }>("/api/scenes", json("POST", { name, graph })),
  saveScene: (id: string, body: { name?: string; names?: Record<string, string>; graph?: Graph }) =>
    call<unknown>(`/api/scenes/${id}`, { ...json("PUT", body), keepalive: true }),
  deleteScene: (id: string) => call<unknown>(`/api/scenes/${id}`, { method: "DELETE" }),
  compile: (graph: Graph) =>
    call<{ positive: string; negative: string; picks: { node_id: string; name: string }[] }>(
      "/api/compile",
      json("POST", { graph }),
    ),
  generate: (graph: Graph, sceneId?: string | null) =>
    call<Run[]>("/api/generate", json("POST", { graph, scene_id: sceneId ?? null })),
  sceneSnaps: (sceneId: string) => call<SceneSnapList>(`/api/scenes/${sceneId}/snaps`),
  sceneSnapThumbUrl: (sceneId: string, version: number, bust: string) => `/api/scenes/${sceneId}/snaps/${version}/thumbnail?v=${encodeURIComponent(bust)}`,
  applySceneSnap: (sceneId: string, version: number) =>
    call<{ graph: Graph }>(`/api/scenes/${sceneId}/snaps/${version}/apply`, { method: "POST" }),
  keepSceneSnap: (sceneId: string, version: number, keep: boolean) =>
    call<unknown>(`/api/scenes/${sceneId}/snaps/${version}`, json("PATCH", { keep })),
  renameSceneSnap: (sceneId: string, version: number, name: string) =>
    call<unknown>(`/api/scenes/${sceneId}/snaps/${version}`, json("PATCH", { name })),
  deleteSceneSnap: (sceneId: string, version: number) =>
    call<unknown>(`/api/scenes/${sceneId}/snaps/${version}`, { method: "DELETE" }),
  setSceneSnapMax: (sceneId: string, max: number) =>
    call<SceneSnapList>(`/api/scenes/${sceneId}/snap-settings`, json("PUT", { max })),
  runs: () => call<Run[]>("/api/runs?limit=1000"),
  snapshot: (id: string) => call<Snapshot>(`/api/runs/${id}/snapshot`),
  cancelAll: () => call<{ cancelled: string[] }>("/api/queue/cancel", { method: "POST" }),
  requeue: (id: string) => call<Run>(`/api/runs/${id}/requeue`, { method: "POST" }),
  deleteRun: (id: string) => call<unknown>(`/api/runs/${id}`, { method: "DELETE" }),
  imageUrl: (runId: string, name: string) => `/api/runs/${runId}/images/${encodeURIComponent(name)}`,
};
