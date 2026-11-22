import type { OutputScope, Run, SceneMeta, ScenePlace, Show } from "./types";

export function scopeSceneIds(scope: OutputScope, scenes: SceneMeta[]): Set<string> | null {
  if (scope.kind === "all") return null;
  return new Set(scenes.filter((scene) => {
    if (scope.kind === "scene") return scene.id === scope.id;
    if (scope.kind === "show") return scene.show_id === scope.id;
    if (scope.kind === "act") return scene.show_id === scope.show_id && scene.act_id === scope.id;
    return !scene.show_id;
  }).map((scene) => scene.id));
}

export function scopedRuns(runs: Run[], scope: OutputScope, scenes: SceneMeta[]): Run[] {
  const ids = scopeSceneIds(scope, scenes);
  return ids === null ? runs : runs.filter((run) => !!run.scene_id && ids.has(run.scene_id));
}

export function sceneDestination(scope: OutputScope, scenes: SceneMeta[]): ScenePlace {
  if (scope.kind === "show") return { show_id: scope.id };
  if (scope.kind === "act") return { show_id: scope.show_id, act_id: scope.id };
  const scene = scope.kind === "scene" ? scenes.find((s) => s.id === scope.id) : undefined;
  return { show_id: scene?.show_id ?? null, act_id: scene?.act_id ?? null };
}

export function scopeExists(scope: OutputScope, shows: Show[], scenes: SceneMeta[]): boolean {
  if (scope.kind === "scene") return scenes.some((s) => s.id === scope.id);
  if (scope.kind === "show") return shows.some((s) => s.id === scope.id);
  if (scope.kind === "act") return shows.some((s) => s.id === scope.show_id && s.items.some((i) => i.kind === "act" && i.id === scope.id));
  return true;
}

export type OutlineItem = Extract<OutputScope, { id: string }>;
export type DropPosition = "before" | "inside" | "after";
export type OutlineDrop =
  | { source: Extract<OutlineItem, { kind: "show" }>; index: number }
  | { source: Exclude<OutlineItem, { kind: "show" }>; place: ScenePlace };

export const standaloneScenes = (scenes: SceneMeta[]) =>
  scenes.filter((s) => !s.show_id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

export function outlineItems(shows: Show[], scenes: SceneMeta[], collapsed = new Set<string>()): OutlineItem[] {
  const items: OutlineItem[] = collapsed.has("standalone") ? [] : standaloneScenes(scenes).map((scene) => ({ kind: "scene", id: scene.id }));
  for (const show of shows) {
    items.push({ kind: "show", id: show.id });
    if (collapsed.has(show.id)) continue;
    for (const item of showItems(show, scenes)) {
      if (item.kind === "scene") items.push({ kind: "scene", id: item.id });
      else {
        items.push({ kind: "act", id: item.id, show_id: show.id });
        if (!collapsed.has(item.id)) items.push(...item.scene_ids.map((id): OutlineItem => ({ kind: "scene", id })));
      }
    }
  }
  return items.filter((item) => scopeExists(item, shows, scenes));
}

export function topLevelSelection(items: OutlineItem[], scenes: SceneMeta[]): OutlineItem[] {
  const shows = new Set(items.filter((i) => i.kind === "show").map((i) => i.id));
  const acts = new Set(items.filter((i) => i.kind === "act").map((i) => `${i.show_id}:${i.id}`));
  return items.filter((item) => {
    if (item.kind === "show") return true;
    if (item.kind === "act") return !shows.has(item.show_id);
    const scene = scenes.find((s) => s.id === item.id);
    return !scene?.show_id || !shows.has(scene.show_id) && (!scene.act_id || !acts.has(`${scene.show_id}:${scene.act_id}`));
  });
}

export function showItems(show: Show, scenes: SceneMeta[]): Show["items"] {
  const referenced = new Set(show.items.flatMap((i) => i.kind === "scene" ? [i.id] : i.scene_ids));
  return [...show.items, ...scenes.filter((s) => s.show_id === show.id && !referenced.has(s.id))
    .map((s) => ({ kind: "scene" as const, id: s.id }))];
}

export function outlineSiblings(item: OutlineItem, shows: Show[], scenes: SceneMeta[]): string[] {
  if (item.kind === "show") return shows.map((s) => s.id);
  const scene = item.kind === "scene" ? scenes.find((s) => s.id === item.id) : undefined;
  const showId = item.kind === "act" ? item.show_id : scene?.show_id;
  if (!showId) return standaloneScenes(scenes).map((s) => s.id);
  const show = shows.find((s) => s.id === showId);
  if (!show) return [];
  if (scene?.act_id) return show.items.filter((i) => i.kind === "act").find((a) => a.id === scene.act_id)?.scene_ids ?? [];
  return showItems(show, scenes).map((i) => i.id);
}

export function outlineDrop(
  source: OutlineItem, target: OutputScope, position: DropPosition, shows: Show[], scenes: SceneMeta[],
): OutlineDrop | null {
  if (!scopeExists(source, shows, scenes) || !scopeExists(target, shows, scenes)) return null;
  if (source.kind === target.kind && "id" in target && source.id === target.id) return null;
  if (source.kind === "show") {
    if (target.kind === "all" && position === "inside") return { source, index: shows.length - 1 };
    if (target.kind !== "show" || position === "inside") return null;
  } else if (position === "inside") {
    if (target.kind === "show") return { source, place: { show_id: target.id } };
    if (source.kind === "scene" && target.kind === "act") return { source, place: { show_id: target.show_id, act_id: target.id } };
    if (source.kind === "scene" && target.kind === "standalone") {
      return { source, place: { index: standaloneScenes(scenes).filter((s) => s.id !== source.id).length } };
    }
    return null;
  }
  if (!("id" in target) || target.kind === "show" && source.kind !== "show") return null;
  const place = target.kind === "act" ? { show_id: target.show_id } : sceneDestination(target, scenes);
  if (source.kind === "act" && (!place.show_id || place.act_id)) return null;
  const siblings = outlineSiblings(target, shows, scenes);
  const targetIndex = siblings.indexOf(target.id);
  if (targetIndex < 0) return null;
  let index = targetIndex + (position === "after" ? 1 : 0);
  const sourceIndex = siblings.indexOf(source.id);
  if (sourceIndex >= 0 && sourceIndex < index) index--;
  return source.kind === "show" ? { source, index } : { source, place: { ...place, index } };
}
