import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE, LANGUAGES, resolveLanguage, tableOf, translator } from "./index";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n", () => {
  it("picks the closest supported language", () => {
    expect(resolveLanguage("ja")).toBe("ja-JP");
    expect(resolveLanguage("ja_JP")).toBe("ja-JP");
    expect(resolveLanguage("en-GB")).toBe("en-US");
    expect(resolveLanguage("fr-FR")).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
  });

  it("every language has every key, with the same placeholders", () => {
    const reference = tableOf(DEFAULT_LANGUAGE);
    for (const { code } of LANGUAGES) {
      const table = tableOf(code);
      expect(Object.keys(table).sort(), code).toEqual(Object.keys(reference).sort());
      for (const [key, text] of Object.entries(table)) expect(placeholders(text), `${code} ${key}`).toEqual(placeholders(reference[key]));
    }
  });

  it("fills placeholders and falls back to the key", () => {
    const ja = translator("ja-JP");
    expect(ja("settings.connected", { version: "1.2", url: "http://x" })).toContain("http://x");
    expect(ja("no.such.key")).toBe("no.such.key");
  });
});
