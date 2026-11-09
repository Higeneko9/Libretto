import { t } from "./i18n";
import { hasTag, tagFamily, tagName, tagPath, type TagIndex } from "./tags";
import type { Category, Preset } from "./types";

export interface TreeNode {
  /** "category" or "category:tagId" */
  key: string;
  category: Category;
  /** tag id, empty for the category root */
  path: string;
  name: string;
  count: number;
  children: TreeNode[];
}

/** Reserved tree path for presets without any tag. */
export const UNTAGGED = "(untagged)";

export const treeKey = (category: Category, path = "") => (path ? `${category}:${path}` : category);

export function parseKey(key: string): { category: Category; path: string } {
  const i = key.indexOf(":");
  return i < 0 ? { category: key as Category, path: "" } : { category: key.slice(0, i) as Category, path: key.slice(i + 1) };
}

/** Build the nested tag tree of one category from the library's tag hierarchy. */
export function buildCategoryTree(category: Category, presets: Preset[], idx: TagIndex, locale: string): TreeNode {
  const root: TreeNode = { key: treeKey(category), category, path: "", name: category, count: presets.length, children: [] };
  const used = new Set<string>();
  for (const p of presets)
    for (const label of p.labels) {
      for (let cur: string | null = label; cur && idx.byId.has(cur) && !used.has(cur); cur = idx.byId.get(cur)!.parent) used.add(cur);
    }
  const build = (parent: string | null): TreeNode[] =>
    (idx.children.get(parent) ?? [])
      .filter((id) => used.has(id))
      .map((id) => ({
        key: treeKey(category, id),
        category,
        path: id,
        name: tagName(idx, id, locale),
        count: presets.filter((p) => hasTag(idx, p.labels, id)).length,
        children: build(id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  root.children = build(null);
  const untagged = presets.filter((p) => p.labels.length === 0).length;
  if (untagged > 0) root.children.push({ key: treeKey(category, UNTAGGED), category, path: UNTAGGED, name: t("libraryTree.noTags"), count: untagged, children: [] });
  return root;
}

/** Remove keys whose ancestor (same category) is also selected, since the ancestor already shows them. */
export function dropCovered(keys: string[], idx: TagIndex): string[] {
  const parsed = keys.map((k) => ({ k, ...parseKey(k) }));
  return parsed
    .filter((a) => !parsed.some((b) => b !== a && b.category === a.category && (b.path === "" ? a.path !== "" : a.path !== b.path && tagFamily(idx, b.path).has(a.path))))
    .map((a) => a.k);
}

export interface Section {
  key: string;
  category: Category;
  path: string;
  title: string;
  presets: Preset[];
}

/** Sections to show for the selected tree keys; a preset appears only once per category. */
export function buildSections(
  keys: string[],
  presets: Partial<Record<Category, Preset[]>>,
  order: readonly Category[],
  idx: TagIndex,
  locale: string,
  labelOf: (category: Category) => string = (c) => c,
): Section[] {
  const seen = new Set<string>();
  const known = (path: string) => path === "" || path === UNTAGGED || idx.byId.has(path);
  // a stored selection may name a tag that no longer exists; fall back to its whole category
  const valid = [...new Set(keys.map((k) => { const { category, path } = parseKey(k); return known(path) ? k : category; }))];
  return dropCovered(valid, idx)
    .map(parseKey)
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || tagPath(idx, a.path, locale).localeCompare(tagPath(idx, b.path, locale)))
    .map(({ category, path }) => {
      const items = (presets[category] ?? []).filter((p) => (!path || (path === UNTAGGED ? p.labels.length === 0 : hasTag(idx, p.labels, path))) && !seen.has(`${category}|${p.id}`));
      items.forEach((p) => seen.add(`${category}|${p.id}`));
      const title = path === UNTAGGED ? `${labelOf(category)} / ${t("libraryTree.noTags")}` : path ? `${labelOf(category)} / ${tagPath(idx, path, locale).replaceAll("/", " / ")}` : labelOf(category);
      return { key: treeKey(category, path), category, path, title, presets: items };
    });
}

/** All tag nodes below a category root, depth first (nested tags follow their parent). */
export function flattenTags(root: TreeNode): TreeNode[] {
  return root.children.flatMap((c) => [c, ...flattenTags(c)]);
}

const keysOf = (sel: string[], category: Category) => sel.filter((k) => parseKey(k).category === category);

/** Category button: plain click selects only that category; Ctrl-click adds it, or removes it with its tags. */
export function toggleCategory(sel: string[], category: Category, multi: boolean): string[] {
  if (!multi) return [category];
  return keysOf(sel, category).length > 0 ? sel.filter((k) => parseKey(k).category !== category) : [...sel, category];
}

/** Tag button: plain click picks only that tag (or clears it); Ctrl-click adds/removes it among several. */
export function toggleTag(sel: string[], category: Category, path: string, multi = false): string[] {
  const key = treeKey(category, path);
  const others = sel.filter((k) => parseKey(k).category !== category);
  const tagsBefore = keysOf(sel, category).filter((k) => k !== category);
  const tags = tagsBefore.includes(key) ? (multi ? tagsBefore.filter((k) => k !== key) : []) : multi ? [...tagsBefore, key] : [key];
  return [...others, ...(tags.length > 0 ? tags : [category])];
}
