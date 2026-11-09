export interface Tag {
  id: string;
  /** display names keyed by BCP 47 locale; "und" is the neutral fallback */
  names: Record<string, string>;
  parent: string | null;
}

export const UND = "und";

export const normalizeLocale = (locale: string | undefined | null): string => {
  const parts = (locale ?? "").trim().split(/[-_]/).filter(Boolean);
  if (!parts.length || !/^[A-Za-z]{2,3}$/.test(parts[0])) return UND;
  return [parts[0].toLowerCase(), ...parts.slice(1).map((p) => (/^[A-Za-z]{2}$/.test(p) ? p.toUpperCase() : /^[A-Za-z]{4}$/.test(p) ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))].join("-");
};

const base = (locale: string) => locale.split("-")[0].toLowerCase();

/** Name for a locale: exact, same language, neutral "und", English, then whatever exists. */
export function pickName(names: Record<string, string>, locale: string): string | undefined {
  const entries = Object.entries(names);
  const wanted = normalizeLocale(locale);
  return (
    names[wanted] ??
    entries.find(([l]) => base(l) === base(wanted))?.[1] ??
    names[UND] ??
    entries.find(([l]) => base(l) === "en")?.[1] ??
    entries[0]?.[1]
  );
}

/** Translation of an original name for a locale (exact or same language only), if it differs from the original. */
export function translatedName(name: string, names: Record<string, string> | undefined, locale: string): string | undefined {
  const wanted = normalizeLocale(locale);
  const hit = names?.[wanted] ?? Object.entries(names ?? {}).find(([l]) => l !== UND && base(l) === base(wanted))?.[1];
  return hit && hit.trim() && hit.trim() !== name ? hit.trim() : undefined;
}

/** "Translation (Original)" when a translation exists for the locale, else the original name. */
export function presetTitle(name: string, names: Record<string, string> | undefined, locale: string): string {
  const tr = translatedName(name, names, locale);
  return tr ? `${tr} (${name})` : name;
}

/** Set (or clear, when empty) the display name for one locale, keeping the other languages. */
/** Text a search should match: the original, the current language's name, then the neutral and English names. */
export function searchNames(name: string, names: Record<string, string> | undefined, locale: string): string {
  const wanted = normalizeLocale(locale);
  const hits = Object.entries(names ?? {}).filter(([l]) => l === wanted || l === UND || base(l) === base(wanted) || base(l) === "en");
  return [name, ...hits.map(([, n]) => n)].join(" ");
}

export function withName(names: Record<string, string> | undefined, locale: string, text: string): Record<string, string> {
  const key = normalizeLocale(locale);
  const next = { ...(names ?? {}) };
  if (text.trim()) next[key] = text.trim();
  else delete next[key];
  return next;
}

export interface TagIndex {
  byId: Map<string, Tag>;
  children: Map<string | null, string[]>;
}

export function buildTagIndex(tags: Tag[]): TagIndex {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const children = new Map<string | null, string[]>();
  for (const t of tags) {
    const parent = t.parent && byId.has(t.parent) ? t.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), t.id]);
  }
  return { byId, children };
}

/** Display name; ids this library doesn't know (e.g. a node saved in another library) show as their raw text. */
export const tagName = (idx: TagIndex, id: string, locale: string): string => {
  const tag = idx.byId.get(id);
  return (tag && pickName(tag.names, locale)) || id;
};

export function tagPath(idx: TagIndex, id: string, locale: string): string {
  const parts: string[] = [];
  for (let cur: string | null = id, guard = 0; cur && guard < 32; guard++) {
    parts.unshift(tagName(idx, cur, locale));
    cur = idx.byId.get(cur)?.parent ?? null;
  }
  return parts.join("/");
}

/** The tag and everything nested below it. */
export function tagFamily(idx: TagIndex, id: string): Set<string> {
  const result = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!result.has(cur)) {
      result.add(cur);
      stack.push(...(idx.children.get(cur) ?? []));
    }
  }
  return result;
}

/** True when one of `labels` is `id` or nested below it. */
export const hasTag = (idx: TagIndex, labels: string[], id: string): boolean => {
  const family = tagFamily(idx, id);
  return labels.some((l) => family.has(l));
};

/** Tag id for typed text ("a/b" paths, any locale, case-insensitive); unknown text is returned unchanged so the server creates it. */
export function resolveTagText(idx: TagIndex, text: string): string {
  const trimmed = text.trim();
  if (idx.byId.has(trimmed)) return trimmed;
  let parent: string | null = null;
  for (const part of trimmed.split("/").map((p) => p.trim()).filter(Boolean)) {
    const found: string | undefined = (idx.children.get(parent) ?? []).find((id) => Object.values(idx.byId.get(id)!.names).some((n) => n.toLowerCase() === part.toLowerCase()));
    if (!found) return trimmed;
    parent = found;
  }
  return parent ?? trimmed;
}

/** Comma separated tag names -> ids (known) or raw names (new). */
export const parseTags = (idx: TagIndex, text: string): string[] => [...new Set(text.split(",").map((s) => resolveTagText(idx, s)).filter(Boolean))];

/** All tags as display paths, for suggestion lists; sorted by path. */
export const tagChoices = (idx: TagIndex, locale: string): { id: string; path: string }[] =>
  [...idx.byId.keys()].map((id) => ({ id, path: tagPath(idx, id, locale) })).sort((a, b) => a.path.localeCompare(b.path));
