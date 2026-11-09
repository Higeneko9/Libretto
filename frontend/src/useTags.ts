import { useMemo } from "react";
import { useStore } from "./store";
import { buildTagIndex, tagName, tagPath } from "./tags";

/** The active library's tag index plus display helpers for the current locale. */
export function useTags() {
  const tags = useStore((s) => s.tags);
  const locale = useStore((s) => s.ui.locale);
  return useMemo(() => {
    const idx = buildTagIndex(tags);
    return { idx, locale, name: (id: string) => tagName(idx, id, locale), path: (id: string) => tagPath(idx, id, locale) };
  }, [tags, locale]);
}
