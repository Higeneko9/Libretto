import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { useT } from "./i18n/useT";

export type AskAnchor = { left: number; top: number; bottom: number };

interface Request {
  message: string;
  initial: string;
  confirm?: string;
  pair?: { display: string; locale: string; error?: string; resolve: (value: { name: string; display: string } | null) => void };
  x: number;
  y: number;
  anchor?: AskAnchor;
  resolve: (value: string | null) => void;
}

let pointer = { x: window.innerWidth / 2, y: window.innerHeight / 3 };
let show: ((r: Request) => void) | null = null;

window.addEventListener("pointerdown", (e) => (pointer = { x: e.clientX, y: e.clientY }), true);

/** Replacement for window.prompt that opens next to the last pointer press (the action that triggered it). */
export function askText(message: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(window.prompt(message, initial));
    show({ message, initial, ...pointer, resolve });
  });
}

/** Rename dialog with the original name plus its display name for one UI language. */
export function askNames(message: string, name: string, display: string, locale: string, error?: string, anchor?: AskAnchor): Promise<{ name: string; display: string } | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(null);
    show({ message, initial: name, pair: { display, locale, error, resolve }, ...pointer, anchor, resolve: () => {} });
  });
}

/** Replacement for window.confirm that opens next to the last pointer press. `okLabel` names the action, e.g. "Delete". */
export function askConfirm(message: string, okLabel = t("ask.ok")): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(window.confirm(message));
    show({ message, initial: "", confirm: okLabel, ...pointer, resolve: (v) => resolve(v !== null) });
  });
}

export function AskHost() {
  const tr = useT();
  const [req, setReq] = useState<Request | null>(null);
  const [value, setValue] = useState("");
  const [display, setDisplay] = useState("");
  const [nameError, setNameError] = useState(false);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const okButton = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    show = (r) => {
      setValue(r.initial);
      setDisplay(r.pair?.display ?? "");
      setNameError(false);
      setPosition(null);
      setReq(r);
    };
    return () => {
      show = null;
    };
  }, []);

  useEffect(() => {
    if (req?.confirm !== undefined) okButton.current?.focus();
    else input.current?.select();
  }, [req]);

  useLayoutEffect(() => {
    if (!req?.anchor || !form.current) return;
    const { width, height } = form.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(req.anchor.left, window.innerWidth - width - 8));
    const below = req.anchor.bottom + 4;
    const preferredTop = below + height <= window.innerHeight - 8 ? below : req.anchor.top - height - 4;
    setPosition({ left, top: Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8)) });
  }, [req, nameError]);

  if (!req) return null;
  const close = (result: string | null) => {
    if (req.pair) req.pair.resolve(result === null ? null : { name: value, display });
    else req.resolve(result);
    setReq(null);
  };
  return (
    <>
      <div className="ctx-backdrop ask-back" onClick={() => close(null)} onContextMenu={(e) => (e.preventDefault(), close(null))} />
      <form
        ref={form}
        className="ask-box"
        style={req.anchor ? position ?? { left: req.anchor.left, top: req.anchor.bottom + 4 }
          : { left: Math.max(8, Math.min(req.x - 20, window.innerWidth - 360)), top: Math.max(8, Math.min(req.y + 8, window.innerHeight - 230)) }}
        onSubmit={(e) => {
          e.preventDefault();
          if (req.pair && !value.trim()) {
            setNameError(true);
            input.current?.focus();
            return;
          }
          close(value);
        }}
      >
        <label style={{ whiteSpace: "pre-line" }}>{req.message}</label>
        {req.pair && <label>{tr("ask.name")}</label>}
        {req.confirm === undefined ? (
          <input ref={input} autoFocus value={value} aria-invalid={nameError} aria-describedby={nameError ? errorId : undefined}
            onChange={(e) => { setValue(e.target.value); setNameError(false); }} onKeyDown={(e) => e.key === "Escape" && close(null)} />
        ) : null}
        {nameError && <p id={errorId} className="error" role="alert">{tr("ask.emptyName")}</p>}
        {req.pair?.error && <p className="error" role="alert">{req.pair.error}</p>}
        {req.pair && (
          <>
            <label>{tr("ask.displayName", { locale: req.pair.locale })}</label>
            <input value={display} onChange={(e) => setDisplay(e.target.value)} onKeyDown={(e) => e.key === "Escape" && close(null)} />
          </>
        )}
        <div className="ask-actions">
          <button type="button" onClick={() => close(null)}>
            {tr("ask.cancel")}
          </button>
          <button ref={okButton} className={req.confirm !== undefined && /delete|remove|削除/i.test(req.confirm) ? "danger" : "primary"} type="submit" onKeyDown={(e) => e.key === "Escape" && close(null)}>
            {req.confirm ?? tr("ask.ok")}
          </button>
        </div>
      </form>
    </>
  );
}
