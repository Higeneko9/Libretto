import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Graph } from "./api";
import { askConfirm } from "./ask";
import { backdropClose } from "./backdropClose";
import { PromptBox } from "./Inspector";
import { applyClick, prune, selectAll, type SelectionState } from "./selection";
import { Splitter } from "./Splitter";
import { useStore } from "./store";
import { useT } from "./i18n/useT";
import { useWheelResize } from "./wheelResize";
import type { Category, Run, Snapshot } from "./types";

interface ThumbTarget {
  category: Category;
  id: string;
  name: string;
  lib?: string;
}

function targets(snapshot: Snapshot): ThumbTarget[] {
  const found = new Map<string, ThumbTarget>();
  for (const p of snapshot.picks) found.set(`${p.category}/${p.item_id}`, { category: p.category, id: p.item_id, name: p.name });
  const nodes = snapshot.graph.nodes as { id: string; type: string; data: { presetId?: string; name?: string; disabled?: boolean; lib?: string } }[];
  const generate = nodes.find((n) => n.type === "generate");
  const wired = new Set((snapshot.graph.edges as { source: string; target: string }[]).filter((e) => e.target === generate?.id).map((e) => e.source));
  for (const n of nodes) {
    // disabled or unconnected nodes did not take part in this generation
    if (n.data?.disabled || !wired.has(n.id)) continue;
    if (n.data?.presetId && n.type !== "collection" && n.type !== "generate" && n.type !== "prompt") {
      found.set(`${n.type}/${n.data.presetId}`, { category: n.type as Category, id: n.data.presetId, name: n.data.name ?? n.data.presetId, lib: n.data.lib });
    }
  }
  return [...found.values()];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
}

function Detail({ run, onClose, onNav }: { run: Run; onClose: () => void; onNav: (delta: number) => Run | null }) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [message, setMessage] = useState("");
  const { newScene, bumpThumbs, refreshPresets, refreshRuns } = useStore.getState();
  const [picked, setImage] = useState(run.images[0]);
  const image = run.images.includes(picked) ? picked : run.images[0];
  const [full, setFull] = useState(false);
  const [cover, setCover] = useState(false);

  const enterFull = () => {
    if (run.images.length === 0) return;
    setFull(true);
    void document.documentElement.requestFullscreen?.().catch(() => {});
  };
  const exitFull = () => {
    setFull(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    setImage(run.images[0]);
    setMessage("");
    setSize(null);
    let stale = false;
    void api.snapshot(run.id).then((s) => !stale && setSnapshot(s));
    return () => {
      stale = true;
    };
  }, [run.id]);

  const restore = (vary: boolean) => {
    if (!snapshot) return;
    const graph = structuredClone(snapshot.graph) as { nodes: { type: string; data: Record<string, unknown> }[]; edges: unknown[] };
    for (const n of graph.nodes) {
      if (n.type === "generate") {
        // unlocked variation re-rolls; restore pins the exact seeds
        n.data.seed = vary ? -1 : snapshot.params.seed;
        n.data.seed_locked = !vary;
        n.data.pick_seed = vary ? -1 : snapshot.pick_seed;
        n.data.pick_locked = !vary;
        n.data.batch = 1;
      }
    }
    // open as a new scene so the current one is left untouched
    void newScene(t(vary ? "results.variationName" : "results.restoreName", { id: run.id.slice(0, 6) }), graph as Graph);
    onClose();
  };

  const canDelete = run.status !== "queued" && run.status !== "running";
  const remove = async () => {
    if (!canDelete) return;
    if (!(await askConfirm(t("results.deleteConfirm"), t("results.deleteLabel")))) return;
    const next = onNav(1) ?? onNav(-1);
    await api.deleteRun(run.id);
    await refreshRuns();
    if (!next) onClose();
  };

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "Escape") (full ? exitFull : onClose)();
    else if (e.key === "ArrowLeft") onNav(-1);
    else if (e.key === "ArrowRight") onNav(1);
    else if (e.key === "Delete" && !full) void remove();
    else if (e.key.toLowerCase() === "c" && full) setCover((v) => !v);
    else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey) (full ? exitFull : enterFull)();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const setThumb = async (target: ThumbTarget) => {
    await api.thumbnailFromRun(target.category, target.id, run.id, image, target.lib);
    bumpThumbs();
    if (!target.lib || target.lib === useStore.getState().library) await refreshPresets(target.category);
    setMessage(t("results.thumbnailSet", { name: target.name }));
  };

  if (full && image) {
    return (
      <div className={`fullscreen-view${cover ? " cover" : ""}`} onClick={exitFull} title={t("results.fullscreenExitHint")}>
        <img src={api.imageUrl(run.id, image)} alt="" />
      </div>
    );
  }

  return (
    <div className="modal" {...backdropClose(onClose)}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <div className="modal-scroll">
        {run.images.length > 0 && (
          <img
            className="big zoomable"
            src={api.imageUrl(run.id, image)}
            alt=""
            title={t("results.fullscreenHint")}
            onClick={enterFull}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        )}
        {run.images.length > 1 && (
          <div className="row">
            {run.images.map((name) => (
              <img key={name} className="thumb" style={{ width: 48, height: 48 }} src={api.imageUrl(run.id, name)} onClick={() => setImage(name)} alt="" />
            ))}
          </div>
        )}
        {snapshot && (
          <>
            <p>
              <strong>{snapshot.profile}</strong> · {t("results.seedInfo", { seed: String(snapshot.params.seed), pickSeed: snapshot.pick_seed })}
              {size && <> · {size.w}×{size.h}px</>}
              {run.duration_s != null && <> · {t("results.generatedIn", { time: formatDuration(run.duration_s) })}</>}
            </p>
            {run.finished_at && <p className="muted">{t("results.finished", { date: new Date(run.finished_at).toLocaleString() })}</p>}
            {snapshot.picks.length > 0 && <p>{t("results.picks", { picks: snapshot.picks.map((p) => `${p.category}: ${p.name}`).join(", ") })}</p>}
            <PromptBox text={snapshot.prompt.positive} />
            {snapshot.prompt.negative && <PromptBox text={snapshot.prompt.negative} negative />}
            {run.images.length > 0 && (
              <div className="row wrap">
                {targets(snapshot).map((target) => (
                  <button key={`${target.category}/${target.id}`} onClick={() => setThumb(target)}>
                    {t("results.setAsThumbnail", { target: `${target.category}/${target.name}` })}
                  </button>
                ))}
              </div>
            )}
            {message && <p className="muted">{message}</p>}
          </>
        )}
        {run.error && <pre className="error">{run.error}</pre>}
        </div>
        <div className="modal-actions row wrap">
          <button onClick={() => onNav(-1)} title={t("results.previous")}>
            ◀
          </button>
          <button onClick={() => onNav(1)} title={t("results.next")}>
            ▶
          </button>
          {run.images.length > 0 && (
            <button onClick={enterFull} title={t("results.fullscreenShort")}>
              ⛶ {t("results.fullscreen")}
            </button>
          )}
          {snapshot && (
            <>
              <button
                onClick={async () => {
                  await api.requeue(run.id);
                  await refreshRuns();
                  onClose();
                }}
              >
                {t("results.regenerateExactly")}
              </button>
              <button onClick={() => restore(false)}>{t("results.restoreGraph")}</button>
              <button onClick={() => restore(true)}>{t("results.makeVariation")}</button>
            </>
          )}
          {canDelete && (
            <button className="danger" onClick={() => void remove()} title={t("results.deleteEntryHint")}>
              {t("results.deleteEntry")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Results() {
  const t = useT();
  const runs = useStore((s) => s.runs);
  const refresh = useStore((s) => s.refreshRuns);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionState>({ selected: new Set(), anchor: null });
  const [selectMode, setSelectMode] = useState(false);
  const [message, setMessage] = useState("");
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  const ids = useMemo(() => runs.map((r) => r.id), [runs]);

  useEffect(() => {
    void refresh();
    const handle = setInterval(() => void refresh(), active ? 1500 : 8000);
    return () => clearInterval(handle);
  }, [active, refresh]);

  useEffect(() => {
    setSelection((current) => prune(current, ids));
  }, [ids]);

  const open = runs.find((r) => r.id === openId) ?? null;
  const navigate = (delta: number): Run | null => {
    const i = runs.findIndex((r) => r.id === openId);
    const next = runs[i + delta];
    if (next) setOpenId(next.id);
    return next ?? null;
  };

  const width = useStore((s) => s.ui.resultsW);
  const size = useStore((s) => s.ui.resultsThumb);
  const setUi = useStore((s) => s.setUi);
  const count = selection.selected.size;
  const gridRef = useRef<HTMLDivElement>(null);
  const focusRun = useStore((s) => s.focusRun);
  const [flash, setFlash] = useState<string | null>(null);

  // scroll to a run requested elsewhere (e.g. when a scene history version is loaded) if it still exists
  useEffect(() => {
    if (!focusRun || !runs.some((r) => r.id === focusRun.id)) return;
    const el = gridRef.current?.querySelector(`[data-run-id="${CSS.escape(focusRun.id)}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(focusRun.id);
    const handle = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(handle);
    // only react to new requests, not to run list refreshes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRun]);

  useWheelResize(gridRef, "resultsThumb", 60, 640);

  const click = (event: React.MouseEvent, run: Run) => {
    const next = applyClick(selection, ids, run.id, {
      ctrl: event.ctrlKey || event.metaKey,
      shift: event.shiftKey,
      toggleMode: selectMode,
    });
    if (next) {
      event.preventDefault();
      setSelection(next);
    } else {
      setOpenId(run.id);
    }
  };

  const clear = () => setSelection({ selected: new Set(), anchor: null });

  const deleteSelected = async () => {
    const targets = runs.filter((r) => selection.selected.has(r.id));
    const busy = targets.filter((r) => r.status === "queued" || r.status === "running");
    const deletable = targets.filter((r) => !busy.includes(r));
    if (deletable.length === 0) {
      setMessage(t("results.cantDeleteBusy"));
      return;
    }
    if (!(await askConfirm(t(deletable.length === 1 ? "results.deleteConfirmOne" : "results.deleteConfirmMany", { count: deletable.length }), t("results.deleteLabel")))) return;
    const results = await Promise.allSettled(deletable.map((r) => api.deleteRun(r.id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    setMessage(
      [failed && t("results.failedCount", { count: failed }), busy.length && t("results.skippedCount", { count: busy.length })].filter(Boolean).join(", "),
    );
    clear();
    await refresh();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(selectAll(ids));
    } else if (event.key === "Escape") {
      clear();
    } else if (event.key === "Delete" && count > 0) {
      void deleteSelected();
    }
  };

  return (
    <div className="results-wrap">
      <Splitter axis="x" className="edge" value={width} min={200} max={1000} direction={1} onChange={(v) => setUi({ resultsW: v })} />
      <div className="results-bar">
        <button className={selectMode ? "on" : ""} onClick={() => setSelectMode(!selectMode)} title={t("results.selectModeHint")}>
          ☑ {t("results.select")}
        </button>
        <button onClick={() => setSelection(selectAll(ids))} disabled={runs.length === 0} title={t("results.selectAllHint")}>
          {t("results.all")}
        </button>
        <button onClick={clear} disabled={count === 0} title={t("results.clearHint")}>
          {t("results.none")}
        </button>
        <button className="danger" onClick={() => void deleteSelected()} disabled={count === 0} title={t("results.deleteSelectedHint")}>
          🗑 {t("results.delete")}{count > 0 ? ` (${count})` : ""}
        </button>
        <span className="muted">
          {count > 0 ? t("results.selectedOf", { count, total: runs.length }) : t("results.entries", { count: runs.length })}
          {message && ` · ${message}`}
        </span>
        <div className="spacer" />
        <span className="muted">{t("results.size")}</span>
        <input type="range" min={60} max={640} value={size} onChange={(e) => setUi({ resultsThumb: Number(e.target.value) })} title={t("results.thumbSizeHint")} />
      </div>
      <div
        className="results"
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={{ gridTemplateColumns: `repeat(auto-fill, ${size}px)` }}
      >
        {runs.map((run) => {
          const selected = selection.selected.has(run.id);
          return (
            <div
              key={run.id}
              className={`result ${run.status} ${selected ? "selected" : ""} ${flash === run.id ? "flash" : ""}`}
              data-run-id={run.id}
              onClick={(e) => click(e, run)}
              title={run.positive}
            >
              {run.images[0] ? (
                <img style={{ width: size, height: size }} src={api.imageUrl(run.id, run.images[0])} alt="" loading="lazy" draggable={false} />
              ) : (
                <div className="placeholder" style={{ width: size, height: size }}>
                  {t(`results.status_${run.status}`)}
                </div>
              )}
              {(selectMode || count > 0) && <span className={`tick ${selected ? "on" : ""}`}>{selected ? "✓" : ""}</span>}
              {run.images.length > 1 && <span className="badge">{run.images.length}</span>}
              <span className="muted">#{run.seed}</span>
            </div>
          );
        })}
        {runs.length === 0 && <p className="muted">{t("results.noGenerations")}</p>}
      </div>
      {open && <Detail run={open} onClose={() => setOpenId(null)} onNav={navigate} />}
    </div>
  );
}
