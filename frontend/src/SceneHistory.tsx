import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { askConfirm, askText } from "./ask";
import { applyClick, prune, selectAll, type SelectionState } from "./selection";
import { useT } from "./i18n/useT";
import { useStore } from "./store";
import { useWheelResize } from "./wheelResize";
import type { SceneSnap, SceneSnapList } from "./types";

const EMPTY: SelectionState = { selected: new Set(), anchor: null };

export function SceneHistory() {
  const t = useT();
  const sceneId = useStore((s) => s.activeId);
  const thumbSize = useStore((s) => s.ui.historyThumb);
  const gridRef = useRef<HTMLDivElement>(null);
  useWheelResize(gridRef, "historyThumb", 40, 256);
  // refetch when generations start/finish: that is when snapshots appear and their thumbnails change
  const runSignature = useStore((s) => s.runs.map((r) => `${r.id}:${r.status}`).join(","));
  const [list, setList] = useState<SceneSnapList | null>(null);
  const [selection, setSelection] = useState<SelectionState>(EMPTY);
  const [selectMode, setSelectMode] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!sceneId) return;
    try {
      const next = await api.sceneSnaps(sceneId);
      if (useStore.getState().activeId === sceneId) setList(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sceneId]);

  useEffect(() => {
    setList(null);
    setSelection(EMPTY);
    setCurrent(null);
    setError("");
  }, [sceneId]);

  useEffect(() => {
    void refresh();
  }, [refresh, runSignature]);

  const items = list?.items ?? [];
  const ids = useMemo(() => items.map((i) => String(i.version)), [items]);
  useEffect(() => setSelection((s) => prune(s, ids)), [ids]);

  if (!sceneId) return null;
  const count = selection.selected.size;

  const guarded = async (action: () => Promise<unknown>) => {
    try {
      setError("");
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
    await refresh();
  };

  const apply = (snap: SceneSnap) =>
    guarded(async () => {
      const { graph } = await api.applySceneSnap(sceneId, snap.version);
      await useStore.getState().applySceneGraph(graph);
      setCurrent(snap.version);
      if (snap.run_id) useStore.getState().showRun(snap.run_id);
    });

  const rename = async (snap: SceneSnap) => {
    const name = await askText(t("sceneHistory.renamePrompt", { version: snap.version }), snap.name ?? "");
    if (name !== null) await guarded(() => api.renameSceneSnap(sceneId, snap.version, name));
  };

  const toggleKeep = (snap: SceneSnap) => guarded(() => api.keepSceneSnap(sceneId, snap.version, !snap.keep));

  const deleteSelected = async () => {
    const targets = items.filter((i) => selection.selected.has(String(i.version)));
    if (targets.length === 0) return;
    const kept = targets.filter((i) => i.keep).length;
    const note = kept ? t("sceneHistory.deleteMarkedKeep", { kept }) : "";
    if (!(await askConfirm(t(targets.length === 1 ? "sceneHistory.deleteConfirmOne" : "sceneHistory.deleteConfirmMany", { count: targets.length, note }), t("sceneHistory.deleteOk")))) return;
    setSelection(EMPTY);
    void guarded(() => Promise.all(targets.map((i) => api.deleteSceneSnap(sceneId, i.version))));
  };

  const click = (event: React.MouseEvent, snap: SceneSnap) => {
    const next = applyClick(selection, ids, String(snap.version), {
      ctrl: event.ctrlKey || event.metaKey,
      shift: event.shiftKey,
      toggleMode: selectMode,
    });
    if (next) {
      event.preventDefault();
      setSelection(next);
    } else {
      void apply(snap);
    }
  };

  const changeMax = (value: number) => {
    const max = Math.max(1, Math.min(1000, Math.floor(value) || 1));
    void guarded(async () => setList(await api.setSceneSnapMax(sceneId, max)));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(selectAll(ids));
    } else if (event.key === "Escape") {
      setSelection(EMPTY);
    } else if (event.key === "Delete" && count > 0) {
      void deleteSelected();
    }
  };

  return (
    <details className="scene-history" open>
      <summary>
        {t("sceneHistory.title")}{" "}
        <span className="muted">
          ({items.length}/{list?.max ?? "…"})
        </span>
      </summary>
      <p className="muted">{t("sceneHistory.hint")}</p>
      <div className="row wrap history-bar">
        <button className={selectMode ? "on" : ""} onClick={() => setSelectMode(!selectMode)} title={t("sceneHistory.selectTitle")}>
          {t("sceneHistory.select")}
        </button>
        <button onClick={() => setSelection(selectAll(ids))} disabled={items.length === 0} title={t("sceneHistory.allTitle")}>
          {t("sceneHistory.all")}
        </button>
        <button onClick={() => setSelection(EMPTY)} disabled={count === 0} title={t("sceneHistory.noneTitle")}>
          {t("sceneHistory.none")}
        </button>
        <button className="danger" onClick={() => void deleteSelected()} disabled={count === 0} title={t("sceneHistory.deleteTitle")}>
          {t("sceneHistory.delete")}{count > 0 ? ` (${count})` : ""}
        </button>
        <div className="spacer" />
        <input type="range" min={40} max={256} value={thumbSize} onChange={(e) => useStore.getState().setUi({ historyThumb: Number(e.target.value) })} title={t("sceneHistory.thumbTitle")} />
        <label className="batch-field" title={t("sceneHistory.maxTitle")}>
          {t("sceneHistory.max")}
          <input key={list?.max} type="number" min={1} max={1000} defaultValue={list?.max ?? 30} onBlur={(e) => changeMax(Number(e.target.value))} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div ref={gridRef} className="history-grid" tabIndex={0} onKeyDown={onKeyDown} style={{ gridTemplateColumns: `repeat(auto-fill, ${thumbSize + 4}px)` }}>
        {items.map((snap) => {
          const selected = selection.selected.has(String(snap.version));
          return (
            <div
              key={snap.version}
              className={`history-item ${selected ? "selected" : ""} ${current === snap.version ? "current" : ""}`}
              onClick={(e) => click(e, snap)}
              title={`${snap.name ? `${snap.name} · ` : ""}v${snap.version} · ${t("sceneHistory.createdUsed", { created: new Date(snap.created_at).toLocaleString(), used: new Date(snap.last_used_at).toLocaleString() })}`}
            >
              {snap.thumb_at ? (
                <img style={{ width: thumbSize, height: thumbSize }} src={api.sceneSnapThumbUrl(sceneId, snap.version, snap.thumb_at)} alt="" loading="lazy" draggable={false} />
              ) : (
                <div className="placeholder" style={{ width: thumbSize, height: thumbSize }}>
                  {t("sceneHistory.noImage")}
                </div>
              )}
              {(selectMode || count > 0) && <span className={`tick ${selected ? "on" : ""}`}>{selected ? "✓" : ""}</span>}
              <button
                className={`keep ${snap.keep ? "on" : ""}`}
                title={snap.keep ? t("sceneHistory.keptTitle") : t("sceneHistory.keepTitle")}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleKeep(snap);
                }}
              >
                📌
              </button>
              <button
                className="rename"
                title={t("sceneHistory.rename")}
                onClick={(e) => {
                  e.stopPropagation();
                  void rename(snap);
                }}
              >
                ✎
              </button>
              <span className="muted history-name" style={{ maxWidth: thumbSize }}>
                {snap.name || `v${snap.version}`}
              </span>
            </div>
          );
        })}
        {items.length === 0 && <p className="muted">{t("sceneHistory.empty")}</p>}
      </div>
    </details>
  );
}
