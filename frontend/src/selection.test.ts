import { describe, expect, it } from "vitest";
import { applyClick, prune, selectAll } from "./selection";

const ids = ["a", "b", "c", "d", "e"];
const empty = { selected: new Set<string>(), anchor: null };
const plain = { ctrl: false, shift: false, toggleMode: false };

describe("applyClick", () => {
  it("leaves selection alone on a plain click outside selection mode", () => {
    expect(applyClick(empty, ids, "b", plain)).toBeNull();
  });

  it("toggles on a plain click in selection mode", () => {
    const first = applyClick(empty, ids, "b", { ...plain, toggleMode: true })!;
    expect([...first.selected]).toEqual(["b"]);
    const second = applyClick(first, ids, "b", { ...plain, toggleMode: true })!;
    expect(second.selected.size).toBe(0);
  });

  it("toggles individual items with ctrl", () => {
    let state = applyClick(empty, ids, "a", { ...plain, ctrl: true })!;
    state = applyClick(state, ids, "c", { ...plain, ctrl: true })!;
    expect([...state.selected].sort()).toEqual(["a", "c"]);
    state = applyClick(state, ids, "a", { ...plain, ctrl: true })!;
    expect([...state.selected]).toEqual(["c"]);
  });

  it("selects a range from the anchor with shift, in either direction", () => {
    const anchored = applyClick(empty, ids, "b", { ...plain, ctrl: true })!;
    const forward = applyClick(anchored, ids, "d", { ...plain, shift: true })!;
    expect([...forward.selected].sort()).toEqual(["b", "c", "d"]);
    const backward = applyClick({ ...anchored, anchor: "d" }, ids, "b", { ...plain, shift: true })!;
    expect([...backward.selected].sort()).toEqual(["b", "c", "d"]);
  });

  it("replaces the selection on shift but extends it on ctrl+shift", () => {
    const start = { selected: new Set(["a"]), anchor: "c" };
    expect([...applyClick(start, ids, "e", { ...plain, shift: true })!.selected].sort()).toEqual(["c", "d", "e"]);
    expect([...applyClick(start, ids, "e", { ctrl: true, shift: true, toggleMode: false })!.selected].sort()).toEqual([
      "a",
      "c",
      "d",
      "e",
    ]);
  });

  it("treats shift without an anchor as a single toggle", () => {
    const state = applyClick(empty, ids, "c", { ...plain, shift: true })!;
    expect([...state.selected]).toEqual(["c"]);
  });
});

describe("selectAll / prune", () => {
  it("selects everything", () => {
    expect(selectAll(ids).selected.size).toBe(5);
  });

  it("drops ids that no longer exist and keeps the same object when nothing changed", () => {
    const state = { selected: new Set(["a", "z"]), anchor: "z" };
    const pruned = prune(state, ids);
    expect([...pruned.selected]).toEqual(["a"]);
    expect(pruned.anchor).toBeNull();
    const clean = selectAll(ids);
    expect(prune(clean, ids)).toBe(clean);
  });
});
