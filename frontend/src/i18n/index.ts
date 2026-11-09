/**
 * UI string tables live in locales/<language>/<namespace>.json (flat key -> text, `{name}` placeholders).
 * A string is addressed as "<namespace>.<key>"; a missing translation falls back to en-US, then to the key.
 * To add a language: copy the en-US folder, translate the values, and list it in LANGUAGES.
 */
export const DEFAULT_LANGUAGE = "en-US";

export const LANGUAGES = [
  { code: "en-US", label: "English" },
  { code: "ja-JP", label: "日本語" },
] as const;

type Table = Record<string, string>;

const files = import.meta.glob("./locales/*/*.json", { eager: true, import: "default" }) as Record<string, Table>;

const tables: Record<string, Table> = {};
for (const [path, strings] of Object.entries(files)) {
  const [, language, namespace] = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path) ?? [];
  if (!language) continue;
  tables[language] ??= {};
  for (const [key, text] of Object.entries(strings)) tables[language][`${namespace}.${key}`] = text;
}

/** The supported language that best matches a browser/OS locale such as "ja", "ja-JP" or "fr-FR" (English when none does). */
export function resolveLanguage(locale: string | undefined | null): string {
  const wanted = (locale ?? "").replace("_", "-").toLowerCase();
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === wanted);
  if (exact) return exact.code;
  const base = wanted.split("-")[0];
  return LANGUAGES.find((l) => l.code.toLowerCase().split("-")[0] === base)?.code ?? DEFAULT_LANGUAGE;
}

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export function translator(language: string): Translate {
  const table = tables[resolveLanguage(language)] ?? {};
  const fallback = tables[DEFAULT_LANGUAGE] ?? {};
  return (key, params) => {
    const text = table[key] ?? fallback[key] ?? key;
    return params ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole)) : text;
  };
}

// For code outside React (store messages, error text); components use useT() so they re-render on a language change.
let current = translator(DEFAULT_LANGUAGE);
export const setLanguage = (language: string) => {
  current = translator(language);
};
export const t: Translate = (key, params) => current(key, params);

export const tableOf = (language: string): Table => tables[language] ?? {};
