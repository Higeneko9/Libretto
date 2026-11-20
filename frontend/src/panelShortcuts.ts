import { useEffect, useRef, type RefObject } from "react";

type Handler = (event: KeyboardEvent) => void;
const panels = new Map<RefObject<HTMLElement | null>, RefObject<Handler>>();
let pointer: { x: number; y: number; target: Element | null } | null = null;

const trackPointer = (event: MouseEvent) => {
  pointer = { x: event.clientX, y: event.clientY, target: event.target instanceof Element ? event.target : null };
};
const clearPointer = () => { pointer = null; };
const leaveWindow = (event: MouseEvent) => { if (!event.relatedTarget) clearPointer(); };

function routeKey(event: KeyboardEvent) {
  const target = event.target instanceof Element ? event.target : null;
  if (event.defaultPrevented || event.isComposing || target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
  const hit = pointer && (document.elementFromPoint ? document.elementFromPoint(pointer.x, pointer.y) : pointer.target);
  const panel = hit?.closest<HTMLElement>("[data-shortcut-panel]");
  const overlays = document.querySelectorAll(".modal, .fullscreen-view");
  const blocked = document.body.classList.contains("lb-dragging") || !!document.querySelector(".ask-box, .ctx-menu") ||
    (overlays.length > 0 && panel?.closest(".modal, .fullscreen-view") !== overlays[overlays.length - 1]);
  if (!blocked && panel?.isConnected) {
    for (const [ref, handler] of panels) {
      if (ref.current === panel) {
        handler.current(event);
        break;
      }
    }
  }
  // React Flow also handles node movement and selection on the focused element.
  if (target?.closest(".react-flow__node, .react-flow__nodesselection-rect") &&
      (blocked || target.closest("[data-shortcut-panel]") !== panel) &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Escape"].includes(event.key)) event.preventDefault();
  if (event.defaultPrevented) event.stopImmediatePropagation();
}

export function usePanelShortcuts(ref: RefObject<HTMLElement | null>, handler: Handler) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (panels.size === 0) {
      window.addEventListener("pointermove", trackPointer, true);
      window.addEventListener("mouseover", trackPointer, true);
      window.addEventListener("mouseout", leaveWindow, true);
      window.addEventListener("blur", clearPointer);
      window.addEventListener("keydown", routeKey, true);
    }
    panels.set(ref, latest);
    return () => {
      panels.delete(ref);
      if (panels.size === 0) {
        window.removeEventListener("pointermove", trackPointer, true);
        window.removeEventListener("mouseover", trackPointer, true);
        window.removeEventListener("mouseout", leaveWindow, true);
        window.removeEventListener("blur", clearPointer);
        window.removeEventListener("keydown", routeKey, true);
        clearPointer();
      }
    };
  }, [ref]);
}
