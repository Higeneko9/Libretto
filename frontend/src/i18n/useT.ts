import { useMemo } from "react";
import { useStore } from "../store";
import { translator } from "./index";

/** Translate function for the current UI language; the component re-renders when the language changes. */
export function useT() {
  const locale = useStore((s) => s.ui.locale);
  return useMemo(() => translator(locale), [locale]);
}
