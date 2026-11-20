import { describe, expect, it } from "vitest";
import { outlineDrop, sceneDestination, scopedRuns, standaloneScenes } from "./showOutline";
import type { Run, SceneMeta, Show } from "./types";

const scenes: SceneMeta[] = [
  { id: "s1", name: "One", updated_at: "", show_id: "show1", act_id: "act1" },
  { id: "s2", name: "Two", updated_at: "", show_id: "show1" },
  { id: "s3", name: "Three", updated_at: "" },
];
const runs = ["s1", "s2", "s3", null].map((scene_id, i): Run => ({
  id: `r${i}`, scene_id, status: "done", created_at: "", images: [], profile: "p",
  seed: 1, positive: "", parent_id: null, error: null, prompt_id: null,
}));

describe("output membership", () => {
  it("includes direct and nested scene outputs for a show, but isolates acts and standalone scenes", () => {
    expect(scopedRuns(runs, { kind: "show", id: "show1" }, scenes).map((r) => r.scene_id)).toEqual(["s1", "s2"]);
    expect(scopedRuns(runs, { kind: "act", id: "act1", show_id: "show1" }, scenes).map((r) => r.scene_id)).toEqual(["s1"]);
    expect(scopedRuns(runs, { kind: "scene", id: "s2" }, scenes).map((r) => r.scene_id)).toEqual(["s2"]);
    expect(scopedRuns(runs, { kind: "standalone" }, scenes).map((r) => r.scene_id)).toEqual(["s3"]);
    expect(scopedRuns(runs, { kind: "all" }, scenes)).toEqual(runs);
  });

  describe("outline drag destinations", () => {
    const shows: Show[] = [
      { version: 1, id: "show1", name: "One", items: [
        { kind: "act", id: "act1", name: "Act", scene_ids: ["s1"] },
        { kind: "scene", id: "s2" },
        { kind: "scene", id: "s4" },
      ] },
      { version: 1, id: "show2", name: "Two", items: [] },
      { version: 1, id: "show3", name: "Three", items: [] },
    ];
    const allScenes: SceneMeta[] = [...scenes, { id: "s4", name: "Four", updated_at: "", show_id: "show1" }];

    it("adjusts indices after removing the dragged item, in both directions", () => {
      expect(outlineDrop({ kind: "scene", id: "s2" }, { kind: "scene", id: "s4" }, "after", shows, allScenes))
        .toEqual({ source: { kind: "scene", id: "s2" }, place: { show_id: "show1", act_id: null, index: 2 } });
      expect(outlineDrop({ kind: "scene", id: "s4" }, { kind: "scene", id: "s2" }, "before", shows, allScenes))
        .toEqual({ source: { kind: "scene", id: "s4" }, place: { show_id: "show1", act_id: null, index: 1 } });
      expect(outlineDrop({ kind: "show", id: "show1" }, { kind: "show", id: "show3" }, "after", shows, allScenes))
        .toEqual({ source: { kind: "show", id: "show1" }, index: 2 });
    });

    it("supports entering containers and placing scenes alongside an act", () => {
      const source = { kind: "scene" as const, id: "s2" };
      const target = { kind: "act" as const, id: "act1", show_id: "show1" };
      expect(outlineDrop(source, target, "inside", shows, allScenes)).toEqual({ source, place: { show_id: "show1", act_id: "act1" } });
      expect(outlineDrop(source, target, "before", shows, allScenes)).toEqual({ source, place: { show_id: "show1", index: 0 } });
      expect(outlineDrop(target, { kind: "show", id: "show2" }, "inside", shows, allScenes))
        .toEqual({ source: target, place: { show_id: "show2" } });
      expect(outlineDrop(source, { kind: "standalone" }, "inside", shows, allScenes)).toEqual({ source, place: { index: 1 } });
    });

    it("rejects self drops, nested acts, shows inside shows, and stale items", () => {
      const act = { kind: "act" as const, id: "act1", show_id: "show1" };
      expect(outlineDrop(act, { kind: "scene", id: "s1" }, "before", shows, allScenes)).toBeNull();
      expect(outlineDrop(act, act, "inside", shows, allScenes)).toBeNull();
      expect(outlineDrop(act, { kind: "standalone" }, "inside", shows, allScenes)).toBeNull();
      expect(outlineDrop({ kind: "show", id: "show1" }, { kind: "show", id: "show2" }, "inside", shows, allScenes)).toBeNull();
      expect(outlineDrop({ kind: "scene", id: "missing" }, { kind: "show", id: "show2" }, "inside", shows, allScenes)).toBeNull();
    });

    it("uses explicit standalone order and includes unlisted show scenes as drop anchors", () => {
      expect(standaloneScenes([
        { id: "a", name: "", updated_at: "", order: 2 },
        { id: "b", name: "", updated_at: "", order: 1 },
      ]).map((s) => s.id)).toEqual(["b", "a"]);
      const unlisted = [...allScenes, { id: "unlisted", name: "", updated_at: "", show_id: "show1" }];
      expect(outlineDrop({ kind: "scene", id: "s3" }, { kind: "scene", id: "unlisted" }, "after", shows, unlisted))
        .toEqual({ source: { kind: "scene", id: "s3" }, place: { show_id: "show1", act_id: null, index: 4 } });
    });
  });

  it("moves historical outputs with the scene while copies start empty", () => {
    const moved = scenes.map((s) => s.id === "s1" ? { ...s, show_id: "show2", act_id: "act2" } : s);
    moved.push({ ...moved[0], id: "copy" });
    expect(scopedRuns(runs, { kind: "show", id: "show1" }, moved).map((r) => r.scene_id)).toEqual(["s2"]);
    expect(scopedRuns(runs, { kind: "act", id: "act2", show_id: "show2" }, moved).map((r) => r.scene_id)).toEqual(["s1"]);
    expect(scopedRuns(runs, { kind: "scene", id: "copy" }, moved)).toEqual([]);
    expect(scopedRuns(runs, { kind: "act", id: "act2", show_id: "show1" }, moved)).toEqual([]);
  });

  it("creates scenes in the selected container or alongside the selected scene", () => {
    expect(sceneDestination({ kind: "scene", id: "s1" }, scenes)).toEqual({ show_id: "show1", act_id: "act1" });
    expect(sceneDestination({ kind: "act", id: "act1", show_id: "show1" }, scenes)).toEqual({ show_id: "show1", act_id: "act1" });
    expect(sceneDestination({ kind: "show", id: "show1" }, scenes)).toEqual({ show_id: "show1" });
    expect(sceneDestination({ kind: "standalone" }, scenes)).toEqual({ show_id: null, act_id: null });
  });
});
