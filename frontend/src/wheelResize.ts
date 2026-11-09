import { useEffect, type RefObject } from "react";
import { useStore, type UiPrefs } from "./store";

type ThumbKey = "libThumb" | "resultsThumb" | "historyThumb";

/**
 * Shift + wheel over `ref` resizes thumbnails stored in the ui state.
 * Native non-passive listener: React wheel handlers are passive and cannot preventDefault.
 * (Ctrl + wheel is left alone: the desktop app uses it to zoom the whole UI, like a browser.)
 */
export function useWheelResize(ref: RefObject<HTMLElement | null>, key: ThumbKey, min: number, max: number) {
  useEffect(() => {
    // listen on the document so the element may mount later than this hook runs
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey || !(e.target instanceof Node) || !ref.current?.contains(e.target)) return;
      e.preventDefault();
      const delta = e.deltaY || e.deltaX; // some systems turn Shift + wheel into horizontal scrolling
      if (!delta) return;
      const current = useStore.getState().ui[key];
      const next = Math.round(Math.max(min, Math.min(max, current * (delta < 0 ? 1.1 : 1 / 1.1))));
      if (next !== current) useStore.getState().setUi({ [key]: next } as Partial<UiPrefs>);
    };
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, [ref, key, min, max]);
}
