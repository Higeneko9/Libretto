import { Background, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { AskHost } from "./ask";
import { cancelAll, runGenerate, useGeneration } from "./generation";
import { Inspector } from "./Inspector";
import { CategoryNode, COLORS, CollectionNode, GenerateNode, promptColor, PromptNode } from "./nodes";
import { LB_DRAG_EVENT, LB_DROP_EVENT, type DragPayload } from "./paletteDrag";
import { Palette } from "./Palette";
import { Results } from "./Results";
import { SceneTabs } from "./SceneTabs";
import { Splitter } from "./Splitter";
import { BackupDialog } from "./Backups";
import { SettingsDialog } from "./SettingsDialog";
import { WorkflowDialog } from "./Workflows";
import { useStore } from "./store";
import { useT } from "./i18n/useT";
import { DEFAULT_CATEGORIES, type GraphNodeData } from "./types";

const baseTypes = { collection: CollectionNode, generate: GenerateNode, prompt: PromptNode };

function Toolbar() {
  const t = useT();
  const [health, setHealth] = useState<{ state: "checking" | "ok" | "comfy" | "backend"; version?: string }>({ state: "checking" });
  const [showWorkflows, setShowWorkflows] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { newScene } = useStore.getState();
  const { busy, error } = useGeneration();

  useEffect(() => {
    // first run: ask for the ComfyUI address
    void api.settings().then((s) => {
      if (s.configured !== false) return;
      setShowSettings(true);
      void api.saveSettings({ setup_seen: true }).catch(() => undefined);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const check = () =>
      api
        .health()
        .then((h) => setHealth(h.comfyui === "ok" ? { state: "ok", version: h.version ?? "" } : { state: "comfy" }))
        .catch(() => setHealth({ state: "backend" }));
    void check();
    const handle = setInterval(check, 10000);
    return () => clearInterval(handle);
  }, []);

  const exportGraph = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(useStore.getState().toGraph(), null, 2)], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: "libretto-scene.json" }).click();
    URL.revokeObjectURL(url);
  };

  const importGraph = async (file?: File) => {
    if (file) await newScene(file.name.replace(/\.json$/, ""), JSON.parse(await file.text()));
  };

  return (
    <header>
      <h1>
        Libretto <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{__LB_VERSION__}</span>
      </h1>
      <span className={`pill ${health.state === "ok" ? "ok" : "bad"}`}>
        {health.state === "checking"
          ? t("app.checking")
          : health.state === "ok"
            ? t("app.comfyOk", { version: health.version ?? "" })
            : health.state === "comfy"
              ? t("app.comfyUnreachable")
              : t("app.backendUnreachable")}
      </span>
      <button onClick={() => setShowWorkflows(true)}>{t("app.comfyWorkflows")}</button>
      {showWorkflows && <WorkflowDialog onClose={() => setShowWorkflows(false)} />}
      <button onClick={() => setShowBackups(true)} title={t("app.backupsTitle")}>
        {t("app.backups")}
      </button>
      {showBackups && <BackupDialog onClose={() => setShowBackups(false)} />}
      <button onClick={() => setShowSettings(true)} title={t("app.settingsTitle")}>
        {t("app.settings")}
      </button>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      <div className="spacer" />
      <button onClick={exportGraph}>{t("app.exportScene")}</button>
      <label className="button">
        {t("app.importScene")}
        <input type="file" accept=".json" hidden onChange={(e) => importGraph(e.target.files?.[0])} />
      </label>
      <button className="primary" disabled={busy} onClick={() => void runGenerate()}>
        {busy ? t("app.queuing") : t("app.generate")}
      </button>
      {error && <span className="error-inline">{error}</span>}
    </header>
  );
}

function OrderToggle() {
  const t = useT();
  const generate = useStore((s) => s.nodes.find((n) => n.type === "generate"));
  const update = useStore((s) => s.updateNode);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const { undo, redo } = useStore.getState();
  if (!generate) return null;
  const mode = generate.data.order_mode ?? "category";
  const options = [
    ["category", t("app.orderCategory")],
    ["position", t("app.orderPosition")],
  ] as const;
  return (
    <div className="order-toggle" title={t("app.orderTitle")}>
      <button disabled={!canUndo} onClick={undo} title={t("app.undo")}>
        ↶
      </button>
      <button disabled={!canRedo} onClick={redo} title={t("app.redo")}>
        ↷
      </button>
      <span className="muted">{t("app.promptOrder")}</span>
      {options.map(([value, label]) => (
        <button key={value} className={mode === value ? "on" : ""} onClick={() => update(generate.id, { order_mode: value })}>
          {label}
        </button>
      ))}
    </div>
  );
}

function GenerateBar() {
  const t = useT();
  const { busy } = useGeneration();
  const generateNode = useStore((s) => s.nodes.find((n) => n.type === "generate"));
  const update = useStore((s) => s.updateNode);
  const runs = useStore((s) => s.runs);
  const running = runs.filter((r) => r.status === "running").length;
  const queued = runs.filter((r) => r.status === "queued").length;
  return (
    <div className="generate-bar">
      <button className="primary" disabled={busy} onClick={() => void runGenerate()} title={t("app.queueGenerationTitle")}>
        {busy ? t("app.queuing") : t("app.generatePlay")}
      </button>
      {generateNode && (
        <label className="batch-field" title={t("app.batchTitle")}>
          ×
          <input
            type="number"
            min={1}
            max={999}
            value={generateNode.data.batch ?? 1}
            onChange={(e) => update(generateNode.id, { batch: Math.max(1, Math.min(999, Math.floor(Number(e.target.value)) || 1)) })}
          />
        </label>
      )}
      <span className={running + queued > 0 ? "" : "muted"} title={t("app.runningWaitingTitle")}>
        {running + queued > 0 ? t("app.runningQueued", { running, queued }) : t("app.queueEmpty")}
      </span>
      <button className="danger" disabled={running + queued === 0} onClick={() => void cancelAll()} title={t("app.cancelTitle")}>
        {t("app.cancel")}{running + queued > 0 ? ` (${running + queued})` : ""}
      </button>
    </div>
  );
}

function Canvas() {
  const t = useT();
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, select } = useStore();
  const { screenToFlowPosition, getViewport, setViewport } = useReactFlow();
  const nodeClip = useStore((s) => s.nodeClip);
  const categories = useStore((s) => s.categories);
  const types = nodes.map((n) => n.type).join(",");
  // every category (and any type a scene already uses) renders as a category node
  const nodeTypes = useMemo(() => {
    const ids = new Set([...DEFAULT_CATEGORIES.map((c) => c.id), ...categories.map((c) => c.id), ...types.split(",")]);
    for (const k of Object.keys(baseTypes)) ids.delete(k);
    return { ...Object.fromEntries([...ids].filter(Boolean).map((c) => [c, CategoryNode])), ...baseTypes };
  }, [categories, types]);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);

  // scroll to a node just added from the palette, keeping the current zoom
  const focusId = useStore((s) => s.focusId);
  const { getNode, setCenter, getZoom } = useReactFlow();
  useEffect(() => {
    if (!focusId) return;
    const node = getNode(focusId);
    if (node) {
      const w = node.measured?.width ?? node.width ?? 220;
      const h = node.measured?.height ?? node.height ?? 120;
      void setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: getZoom(), duration: 300 });
    }
    useStore.setState({ focusId: null });
  }, [focusId, getNode, setCenter, getZoom]);

  // Auto-scroll while a palette item is dragged: arms once the pointer reaches the canvas interior, keeps going outside it, and uses the same edge zone/speed as React Flow's node-drag auto-pan.
  useEffect(() => {
    const EDGE = 40;
    const SPEED = 15;
    let pos: { x: number; y: number } | null = null;
    let armed = false;
    let frame = 0;
    const velocity = (v: number, min: number, max: number) =>
      v < min ? Math.min(Math.max(Math.abs(v - min), 1), min) / min : v > max ? -Math.min(Math.max(Math.abs(v - max), 1), min) / min : 0;
    const tick = () => {
      frame = 0;
      const rect = document.querySelector(".canvas")?.getBoundingClientRect();
      if (!pos || !rect) return;
      // arm only once the pointer is inside the canvas and clear of the auto-scroll edge zones
      const calm = pos.x >= rect.left + EDGE && pos.x <= rect.right - EDGE && pos.y >= rect.top + EDGE && pos.y <= rect.bottom - EDGE;
      if (calm) armed = true;
      if (armed) {
        const dx = velocity(pos.x - rect.left, EDGE, rect.width - EDGE) * SPEED;
        const dy = velocity(pos.y - rect.top, EDGE, rect.height - EDGE) * SPEED;
        if (dx || dy) {
          const vp = getViewport();
          void setViewport({ ...vp, x: vp.x + dx, y: vp.y + dy });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    const onDrag = (event: Event) => {
      pos = (event as CustomEvent<{ x: number; y: number } | null>).detail;
      if (!pos) {
        armed = false;
        cancelAnimationFrame(frame);
        frame = 0;
      } else if (!frame) frame = requestAnimationFrame(tick);
    };
    window.addEventListener(LB_DRAG_EVENT, onDrag);
    return () => {
      window.removeEventListener(LB_DRAG_EVENT, onDrag);
      cancelAnimationFrame(frame);
    };
  }, [getViewport, setViewport]);

  useEffect(() => {
    const onDrop = (event: Event) => {
      const { x, y, payload } = (event as CustomEvent<{ x: number; y: number; payload: DragPayload }>).detail;
      const hit = document
        .elementsFromPoint(x, y)
        .find((el) => el instanceof HTMLElement && el.classList.contains("react-flow__node"));
      const origin = screenToFlowPosition({ x, y });
      if (payload.extra?.length) {
        // a multi-selection is placed as a block of new nodes; nothing is replaced
        const before = new Set(useStore.getState().nodes.map((n) => n.id));
        [payload, ...payload.extra].forEach((item, i) =>
          useStore.getState().addNode(item.type, item.data as GraphNodeData, { x: origin.x + (i % 3) * 240, y: origin.y + Math.floor(i / 3) * 130 }),
        );
        // leave the dropped block selected so it can be moved together
        useStore.setState((s) => ({
          nodes: s.nodes.map((n) => ({ ...n, selected: !before.has(n.id) })),
          selectedId: null,
        }));
        return;
      }
      useStore.getState().addNode(payload.type, payload.data as GraphNodeData, origin, hit?.getAttribute("data-id") ?? undefined);
    };
    window.addEventListener(LB_DROP_EVENT, onDrop);
    return () => window.removeEventListener(LB_DROP_EVENT, onDrop);
  }, [screenToFlowPosition]);

  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={(c) => useStore.getState().nodes.find((n) => n.id === c.target)?.type === "generate"}
        onNodeClick={(_, node) => select(node.id)}
        onPaneClick={() => select(null)}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          const selected = useStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);
          setMenu({ x: e.clientX, y: e.clientY, ids: selected.includes(node.id) ? selected : [node.id] });
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY, ids: [] });
        }}
        deleteKeyCode={["Delete", "Backspace"]}
        selectionKeyCode={["Control", "Shift"]}
        multiSelectionKeyCode={["Control", "Meta", "Shift"]}
        fitView
        colorMode="dark"
      >
        <Background />
        <Controls />
        <Panel position="top-center">
          <OrderToggle />
        </Panel>
        <Panel position="bottom-center">
          <GenerateBar />
        </Panel>
        <MiniMap nodeColor={(n) => (n.type === "prompt" ? promptColor(n.data as { polarity?: string; category?: string }) : (COLORS[n.type ?? ""] ?? "#888"))} pannable zoomable />
      </ReactFlow>
      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
          <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 150) }} onClick={() => setMenu(null)}>
            {menu.ids.length > 0 && (
              <>
                {(() => {
                  const movable = menu.ids.filter((id) => useStore.getState().nodes.find((n) => n.id === id)?.type !== "generate");
                  const n = movable.length;
                  return (
                    <>
                      <button disabled={n === 0} onClick={() => useStore.getState().copyNodes(movable)}>
                        {t("app.copy")}{n > 1 ? ` (${n})` : ""}
                      </button>
                      <button
                        disabled={n === 0}
                        onClick={() => {
                          useStore.getState().copyNodes(movable);
                          useStore.getState().removeNodes(movable);
                        }}
                      >
                        {t("app.cut")}{n > 1 ? ` (${n})` : ""}
                      </button>
                      <button
                        disabled={n === 0}
                        onClick={() => {
                          const s = useStore.getState();
                          s.copyNodes(movable);
                          const at = useStore.getState().nodeClip.reduce((m, c) => ({ x: Math.min(m.x, c.position.x), y: Math.min(m.y, c.position.y) }), { x: Infinity, y: Infinity });
                          s.pasteNodes({ x: at.x + 40, y: at.y + 40 });
                        }}
                      >
                        {t("app.duplicate")}{n > 1 ? ` (${n})` : ""}
                      </button>
                      <button disabled={n === 0} onClick={() => useStore.getState().removeNodes(movable)}>
                        {t("app.delete")}{n > 1 ? ` (${n})` : ""}
                      </button>
                    </>
                  );
                })()}
                <hr />
              </>
            )}
            <button disabled={nodeClip.length === 0} onClick={() => useStore.getState().pasteNodes(screenToFlowPosition({ x: menu.x, y: menu.y }))}>
              {t("app.paste")}{nodeClip.length > 0 ? ` (${nodeClip.length})` : ""}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function App() {
  const t = useT();
  const initScenes = useStore((s) => s.initScenes);
  const ready = useStore((s) => s.sceneReady);
  const activeId = useStore((s) => s.activeId);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const [error, setError] = useState("");
  useEffect(() => {
    initScenes().catch((e: Error) => setError(e.message));
  }, [initScenes]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      // leave native text undo alone inside form fields
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
      } else if (key === "y") {
        event.preventDefault();
        useStore.getState().redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const style = {
    "--results-w": `${ui.resultsW}px`,
    "--inspector-w": `${ui.inspectorW}px`,
    "--library-h": `${ui.libraryH}px`,
  } as React.CSSProperties;

  return (
    <ReactFlowProvider>
      <div className="app" style={style}>
        <Toolbar />
        <SceneTabs />
        {ready ? <Canvas key={activeId} /> : <div className="canvas muted">{error || t("app.loading")}</div>}
        <div className="inspector-wrap">
          <Splitter axis="x" className="edge-left" value={ui.inspectorW} min={240} max={800} direction={-1} onChange={(v) => setUi({ inspectorW: v })} />
          <Inspector />
        </div>
        <Results />
        <Palette />
        <AskHost />
      </div>
    </ReactFlowProvider>
  );
}