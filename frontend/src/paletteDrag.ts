import type React from "react";

export const LB_DROP_EVENT = "lb-palette-drop";
/** Pointer position while a palette item is dragged (null when the drag ends); drives canvas auto-scroll. */
export const LB_DRAG_EVENT = "lb-palette-drag";
const announce = (pos: { x: number; y: number } | null) => window.dispatchEvent(new CustomEvent(LB_DRAG_EVENT, { detail: pos }));
const DRAG_THRESHOLD = 5;

export interface DragPayload {
  type: string;
  data: Record<string, unknown>;
  /** More nodes dropped together with this one (dragging a multi-selection). */
  extra?: { type: string; data: Record<string, unknown> }[];
}

/**
 * Pointer-based drag from the palette to the canvas. Native HTML5 drag-and-drop is
 * flaky (the browser can swallow the drag, e.g. when it starts on an image), so the
 * card tracks the pointer itself and announces where it was released.
 */
export function beginPaletteDrag(event: React.PointerEvent, payload: DragPayload, label: string): void {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let ghost: HTMLDivElement | null = null;

  const move = (e: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = label;
      document.body.appendChild(ghost);
      document.body.classList.add("lb-dragging");
    }
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 12}px`;
    announce({ x: e.clientX, y: e.clientY });
  };

  const finish = (e: PointerEvent | null) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key);
    const dragged = ghost !== null;
    ghost?.remove();
    announce(null);
    if (dragged) {
      // a drag that ends on the tag button must not also count as a click on it
      const swallow = (ev: Event) => ev.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    }
    document.body.classList.remove("lb-dragging");
    if (!dragged || !e) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    if (over?.closest(".canvas")) {
      window.dispatchEvent(new CustomEvent(LB_DROP_EVENT, { detail: { x: e.clientX, y: e.clientY, payload } }));
    }
  };
  const up = (e: PointerEvent) => finish(e);
  const cancel = () => finish(null);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") finish(null);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key);
}
