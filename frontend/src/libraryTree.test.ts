import { describe, expect, it } from "vitest";
import { buildCategoryTree, buildSections, dropCovered, flattenTags, toggleCategory, toggleTag, UNTAGGED } from "./libraryTree";
import { buildTagIndex, hasTag, parseTags, pickName, presetTitle, resolveTagText, searchNames, type Tag, withName } from "./tags";
import type { Preset } from "./types";

const tag = (id: string, names: Record<string, string>, parent: string | null = null): Tag => ({ id, names, parent });
const idx = buildTagIndex([
  tag("t-dress", { und: "dress", ja: "ドレス" }),
  tag("t-formal", { und: "formal" }, "t-dress"),
  tag("t-casual", { und: "casual" }, "t-dress"),
  tag("t-summer", { und: "summer" }),
]);
const p = (id: string, labels: string[]) => ({ id, name: id, labels }) as unknown as Preset;
const presets = [p("a", ["t-formal"]), p("b", ["t-casual", "t-summer"]), p("c", [])];

describe("tags", () => {
  it("shows the translation next to the original only when one exists for the language", () => {
    const names = { "ja-JP": "ナンシー" };
    expect(presetTitle("Nancy", names, "ja-JP")).toBe("ナンシー (Nancy)");
    expect(presetTitle("Nancy", names, "ja")).toBe("ナンシー (Nancy)");
    expect(presetTitle("Nancy", names, "en-US")).toBe("Nancy");
    expect(presetTitle("Nancy", { "ja-JP": "Nancy" }, "ja-JP")).toBe("Nancy");
  });

  it("searches the original, current-language, neutral and English names only", () => {
    const text = searchNames("Nancy", { "ja-JP": "ナンシー", en: "Nan", "fr-FR": "Nanou", und: "N" }, "ja-JP").toLowerCase();
    expect(text).toContain("nancy");
    expect(text).toContain("ナンシー");
    expect(text).toContain("nan");
    expect(text).not.toContain("nanou");
  });

  it("sets and clears one language's display name without touching the others", () => {
    const names = withName({ "en-US": "A" }, "ja_jp", " ビーチ ");
    expect(names).toEqual({ "en-US": "A", "ja-JP": "ビーチ" });
    expect(withName(names, "ja-JP", " ")).toEqual({ "en-US": "A" });
  });

  it("falls back from exact locale to language, neutral, English, then any", () => {
    expect(pickName({ ja: "ド", und: "x" }, "ja-JP")).toBe("ド");
    expect(pickName({ und: "x", en: "e" }, "fr")).toBe("x");
    expect(pickName({ en: "e", de: "d" }, "fr")).toBe("e");
    expect(pickName({ de: "d" }, "fr")).toBe("d");
  });

  it("resolves typed text in any language and matches by ancestor", () => {
    expect(resolveTagText(idx, "ドレス/Formal")).toBe("t-formal");
    expect(resolveTagText(idx, "unknown")).toBe("unknown");
    expect(parseTags(idx, "Dress, dress, new")).toEqual(["t-dress", "new"]);
    expect(hasTag(idx, ["t-formal"], "t-dress")).toBe(true);
    expect(hasTag(idx, ["t-dress"], "t-formal")).toBe(false);
  });
});

describe("library tree", () => {
  it("builds nested nodes with counts", () => {
    const root = buildCategoryTree("costume", presets, idx, "en");
    expect(root.count).toBe(3);
    const dress = root.children.find((c) => c.name === "dress")!;
    expect(dress.count).toBe(2);
    expect(dress.children.map((c) => c.key)).toEqual(["costume:t-casual", "costume:t-formal"]);
  });

  it("lists untagged presets as a separate entry", () => {
    const root = buildCategoryTree("costume", presets, idx, "en");
    const none = root.children.find((c) => c.path === UNTAGGED)!;
    expect(none.count).toBe(1);
    const sections = buildSections([none.key], { costume: presets }, ["costume"], idx, "en");
    expect(sections[0].presets.map((x) => x.id)).toEqual(["c"]);
  });

  it("toggles categories and tags in the quick-access rows", () => {
    expect(toggleCategory(["costume:t-dress"], "hair", false)).toEqual(["hair"]);
    expect(toggleCategory(["costume"], "hair", true)).toEqual(["costume", "hair"]);
    expect(toggleCategory(["costume:t-dress", "hair"], "costume", true)).toEqual(["hair"]);
    expect(toggleTag(["costume", "hair"], "costume", "t-dress")).toEqual(["hair", "costume:t-dress"]);
    expect(toggleTag(["costume:t-dress"], "costume", "t-dress")).toEqual(["costume"]);
    expect(flattenTags(buildCategoryTree("costume", presets, idx, "en")).map((n) => n.name)).toEqual(["dress", "casual", "formal", "summer", "no tags"]);
  });

  it("drops covered keys, lists each preset once and tolerates unknown tags", () => {
    expect(dropCovered(["costume", "costume:t-dress", "hair:x"], idx)).toEqual(["costume", "hair:x"]);
    const sections = buildSections(["costume:t-formal", "costume:t-dress"], { costume: presets }, ["costume"], idx, "en");
    expect(sections).toHaveLength(1);
    expect(sections[0].presets.map((x) => x.id)).toEqual(["a", "b"]);
    expect(buildSections(["costume:gone"], { costume: presets }, ["costume"], idx, "en")[0].presets).toHaveLength(3);
  });
});
