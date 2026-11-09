import type React from "react";

interface Props {
  /** "x" resizes horizontally, "y" vertically */
  axis: "x" | "y";
  value: number;
  min: number;
  max: number;
  /** +1 when dragging toward positive coordinates grows the target, -1 when it shrinks it */
  direction: 1 | -1;
  onChange: (value: number) => void;
  className?: string;
}

export function Splitter({ axis, value, min, max, direction, onChange, className = "" }: Props) {
  // Mouse events on window instead of pointer capture: capture was unreliable in Electron on Ubuntu,
  // and window listeners keep working when the cursor leaves the thin splitter.
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const origin = { pos: axis === "x" ? event.clientX : event.clientY, value };
    const cursor = axis === "x" ? "col-resize" : "row-resize";
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";

    const onMove = (e: MouseEvent) => {
      const delta = (axis === "x" ? e.clientX : e.clientY) - origin.pos;
      onChange(Math.round(Math.min(max, Math.max(min, origin.value + delta * direction))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return <div className={`splitter ${axis} ${className}`} onMouseDown={onMouseDown} />;
}
