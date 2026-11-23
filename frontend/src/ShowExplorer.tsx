import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { api, type OutlineMoveRef } from "./api";
import { askConfirm, askNames, askText } from "./ask";
import { backdropClose } from "./backdropClose";
import { useT } from "./i18n/useT";
import { usePanelShortcuts } from "./panelShortcuts";
import { ShowSettings } from "./ShowSettings";
import { outlineDrop, outlineItems, outlineSiblings, sceneDestination, showItems, standaloneScenes, topLevelSelection, type DropPosition, type OutlineDrop, type OutlineItem } from "./showOutline";
import { useStore } from "./store";
import { translatedName, withName } from "./tags";
import type { OutputScope, ScenePlace, Show } from "./types";

type Menu = { target: OutputScope; x: number; y: number };
type InlineRename = { target: OutlineItem; original: string; value: string; locale: string };
const itemKey = (item: OutputScope) => `${item.kind}:${"id" in item ? item.id : ""}`;
const displayName = (item: { name: string; names?: Record<string, string> }, locale: string) =>
  translatedName(item.name, item.names, locale) ?? item.name;

function OutlineIcon({ kind }: { kind: "show" | "act" | "scene" | "standalone" }) {
  return <svg className={`explorer-icon explorer-icon-${kind}`} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "show" ? <><path d="M3 4h18v16H3zM3 5c0 5 2 7 5 8l2-8M21 5c0 5-2 7-5 8l-2-8M3 20c2-3 4-4 6-4h6c2 0 4 1 6 4" /></>
      : kind === "act" ? <><path d="M12 5c-2-2-5-2-9-1v14c4-1 7-1 9 1 2-2 5-2 9-1V4c-4-1-7-1-9 1zM12 5v14" /></>
      : kind === "scene" ? <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4l3 5M15 4l3 5" /></>
      : <><path d="M3 6h7l2 2h9v11H3z" /></>}
  </svg>;
}

export function ShowExplorer() {
  const t = useT();
  const scenes = useStore((s) => s.scenes);
  const shows = useStore((s) => s.shows);
  const scope = useStore((s) => s.outputScope);
  const locale = useStore((s) => s.ui.locale);
  const history = useStore((s) => s.organizationHistory);
  const organizationBusy = useStore((s) => s.organizationBusy);
  const { setOutputScope, openScene, newScene, renameScene, deleteScene, organize, refreshOrganization, undoOrganization, redoOrganization } = useStore.getState();
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [error, setError] = useState("");
  const [deletedHierarchy, setDeletedHierarchy] = useState<{ name: string; revision: number; historyId: string } | null>(null);
  const [working, setBusy] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const mutationBusy = working || organizationBusy;
  const busy = mutationBusy || navigating;
  const explorerRef = useRef<HTMLElement>(null);
  const opening = useRef(false);
  const [editing, setEditing] = useState<InlineRename | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renamePhase = useRef<"editing" | "saving" | null>(null);
  const renameFocus = useRef<OutlineItem | null>(null);
  const errorId = useId();
  const editingKey = editing ? itemKey(editing.target) : null;
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOrigin = useRef<HTMLElement | null>(null);
  const dragSource = useRef<OutlineItem | null>(null);
  const dragSources = useRef<OutlineItem[]>([]);
  const [moveSelection, setMoveSelection] = useState<Set<string>>(new Set());
  const selectionAnchor = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; position: DropPosition } | null>(null);
  const [copyTarget, setCopyTarget] = useState<OutputScope | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<Show | null>(null);
  const [destination, setDestination] = useState("");
  const actionTarget = copyTarget ?? menu?.target ?? scope;
  const selectedScene = actionTarget.kind === "scene" ? scenes.find((s) => s.id === actionTarget.id) : undefined;
  const showId = actionTarget.kind === "show" ? actionTarget.id : actionTarget.kind === "act" ? actionTarget.show_id : selectedScene?.show_id;
  const show = shows.find((s) => s.id === showId);
  const act = actionTarget.kind === "act" ? show?.items.filter((i) => i.kind === "act").find((i) => i.id === actionTarget.id) : undefined;
  const namedItem = selectedScene ?? act ?? (actionTarget.kind === "show" ? show : undefined);
  const label = namedItem ? displayName(namedItem, locale) : "";
  const actionable = "id" in actionTarget;
  const copyable = actionTarget.kind === "scene" || actionTarget.kind === "act";
  const destinations: { key: string; label: string; place: ScenePlace }[] = [
    ...(actionTarget.kind === "scene" ? [{ key: "", label: t("showExplorer.standalone"), place: {} }] : []),
    ...shows.flatMap((s) => [
      { key: s.id, label: displayName(s, locale), place: { show_id: s.id } },
      ...(actionTarget.kind === "scene" ? s.items.filter((i) => i.kind === "act").map((a) => ({
        key: a.id, label: `${displayName(s, locale)} / ${displayName(a, locale)}`, place: { show_id: s.id, act_id: a.id },
      })) : []),
    ]),
  ];

  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!settingsTarget) menuOrigin.current?.focus();
  }, [settingsTarget]);

  useEffect(() => {
    if (deletedHierarchy && (history.revision !== deletedHierarchy.revision || !history.undo)) setDeletedHierarchy(null);
  }, [deletedHierarchy, history]);

  useEffect(() => {
    const available = new Set(outlineItems(shows, scenes).map(itemKey));
    setMoveSelection((previous) => {
      const next = new Set([...previous].filter((key) => available.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [shows, scenes]);

  useEffect(() => {
    if (editingKey) {
      renameInput.current?.focus();
      renameInput.current?.select();
    } else if (renameFocus.current) {
      explorerRef.current?.querySelector<HTMLButtonElement>(`button[data-outline-key="${itemKey(renameFocus.current)}"]`)?.focus();
      renameFocus.current = null;
    }
  }, [editingKey]);

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (document.activeElement === document.body) explorerRef.current?.focus();
    }
  };
  const replay = (redo: boolean) => {
    closeMenu();
    void perform(redo ? redoOrganization : undoOrganization);
  };
  usePanelShortcuts(explorerRef, (event) => {
    if (event.altKey) return;
    if (event.key === "F2" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!event.repeat) startRename(actionTarget, label);
      return;
    }
    if (event.key === "Delete" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!editing && !copyTarget && !busy && actionable && !event.repeat) {
        if (moveSelection.size > 1) setError(t("showExplorer.singleDeleteOnly"));
        else menuAction(remove);
      }
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    event.preventDefault();
    const redo = key === "y" || event.shiftKey;
    if (!editing && !copyTarget && !busy && (redo ? history.redo : history.undo)) replay(redo);
  });
  const toggle = (id: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const expand = (...ids: string[]) => setCollapsed((previous) => {
    const next = new Set(previous);
    ids.forEach((id) => next.delete(id));
    return next;
  });
  const selected = (target: OutputScope) => scope.kind === target.kind && ("id" in scope && "id" in target ? scope.id === target.id : true);
  const choose = (target: OutputScope) => {
    if (busy || editing || opening.current) return;
    if (target.kind === "scene") {
      opening.current = true;
      setNavigating(true);
      setError("");
      void openScene(target.id)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => { opening.current = false; setNavigating(false); });
    } else setOutputScope(target);
  };
  const createShow = async () => {
    const name = (await askText(t("showExplorer.newShow"), t("showExplorer.defaultShow")))?.trim();
    if (!name) return;
    await organize(async () => {
      const created = await api.createShow(name);
      setOutputScope({ kind: "show", id: created.id });
    });
  };
  const createAct = async () => {
    if (!show) return;
    const name = (await askText(t("showExplorer.newAct"), t("showExplorer.defaultAct")))?.trim();
    if (!name) return;
    await organize(async () => {
      const created = await api.createAct(show.id, name);
      setOutputScope({ kind: "act", show_id: show.id, id: created.id });
    });
    expand(show.id);
  };
  const createScene = async () => {
    const name = (await askText(t("sceneTabs.newScenePrompt"), t("sceneTabs.defaultSceneName", { n: scenes.length + 1 })))?.trim();
    if (name) {
      const place = sceneDestination(actionTarget, scenes);
      setOutputScope(actionTarget);
      await newScene(name);
      expand(...(place.show_id ? [place.show_id, ...(place.act_id ? [place.act_id] : [])] : ["standalone"]));
    }
  };
  const renameNames = async () => {
    if (!namedItem) return;
    const names = await askNames(t("sceneTabs.rename"), namedItem.name, translatedName(namedItem.name, namedItem.names, locale) ?? "", locale);
    if (!names?.name.trim()) return;
    const original = names.name.trim();
    const translations = withName(namedItem.names, locale, names.display);
    if (actionTarget.kind === "scene") await renameScene(actionTarget.id, original, translations);
    else if (actionTarget.kind === "act") await organize(() => api.renameAct(actionTarget.show_id, actionTarget.id, original, translations));
    else if (actionTarget.kind === "show") await organize(() => api.renameShow(actionTarget.id, original, translations));
  };
  const startRename = (target: OutputScope, name: string) => {
    if (!("id" in target) || mutationBusy || editing || copyTarget) return;
    closeMenu();
    finishDrag();
    setError("");
    renamePhase.current = "editing";
    setEditing({ target, original: name, value: name, locale });
  };
  const finishRename = (edit: InlineRename, restoreFocus: boolean) => {
    renamePhase.current = null;
    renameFocus.current = restoreFocus ? edit.target : null;
    setEditing(null);
    setError("");
  };
  const saveRename = async (restoreFocus: boolean) => {
    if (!editing || renamePhase.current !== "editing") return;
    const edit = editing;
    const name = edit.value.trim();
    if (!name) {
      setError(t("showExplorer.emptyName"));
      return;
    }
    if (name === edit.original) {
      finishRename(edit, restoreFocus);
      return;
    }
    renamePhase.current = "saving";
    try {
      await perform(async () => {
        const { target } = edit;
        if (target.kind === "scene") {
          const scene = useStore.getState().scenes.find((s) => s.id === target.id);
          if (!scene) throw new Error(t("showExplorer.missingScene", { id: target.id }));
          await renameScene(scene.id, scene.name, withName(scene.names, edit.locale, name));
        } else {
          await organize(async () => {
            const parent = useStore.getState().shows.find((s) => s.id === (target.kind === "show" ? target.id : target.show_id));
            const item = target.kind === "show" ? parent
              : parent?.items.filter((entry) => entry.kind === "act").find((entry) => entry.id === target.id);
            if (!item) throw new Error(t("showExplorer.missingItem", { id: target.id }));
            const names = withName(item.names, edit.locale, name);
            if (target.kind === "act") await api.renameAct(target.show_id, target.id, item.name, names);
            else await api.renameShow(target.id, item.name, names);
          });
        }
        finishRename(edit, restoreFocus);
      });
    } finally {
      if (renamePhase.current === "saving") renamePhase.current = "editing";
    }
  };
  const copyTo = async (destination: ScenePlace, name?: string) => {
    if (actionTarget.kind === "scene") {
      await organize(() => api.placeScene(actionTarget.id, { ...destination, copy: true, name }));
    } else if (actionTarget.kind === "act") {
      await organize(() => api.placeAct(actionTarget.show_id, actionTarget.id, { ...destination, copy: true, name }));
    }
  };
  const position = actionable ? outlineSiblings(actionTarget, shows, scenes).indexOf(actionTarget.id) : -1;
  const currentPlace = actionTarget.kind === "act" ? { show_id: actionTarget.show_id } : sceneDestination(actionTarget, scenes);
  const duplicate = async () => {
    const name = (await askText(t("sceneTabs.copyNamePrompt", { name: label }), t("sceneTabs.copySuffix", { name: label })))?.trim();
    if (name) await copyTo({ ...currentPlace, ...(position >= 0 ? { index: position + 1 } : {}) }, name);
  };
  const remove = async () => {
    if (!(await askConfirm(t(selectedScene ? "sceneTabs.deleteConfirm" : "showExplorer.deleteGroupConfirm", { name: label }), t("sceneTabs.deleteOk")))) return;
    if (selectedScene) await deleteScene(selectedScene.id);
    else if (actionTarget.kind === "act") await organize(() => api.deleteAct(actionTarget.show_id, actionTarget.id));
    else if (actionTarget.kind === "show") await organize(() => api.deleteShow(actionTarget.id));
  };
  const removeHierarchy = async () => {
    if (actionTarget.kind !== "show" && actionTarget.kind !== "act") return;
    const target = actionTarget;
    const sceneIds = scenes.filter((scene) => target.kind === "show"
      ? scene.show_id === target.id : scene.show_id === target.show_id && scene.act_id === target.id).map((scene) => scene.id);
    const actIds = target.kind === "show" ? show?.items.filter((item) => item.kind === "act").map((item) => item.id) ?? [] : [target.id];
    let deleted = false;
    try {
      const result = await organize(async () => {
        const response = await (target.kind === "show"
          ? api.deleteShowHierarchy(target.id, sceneIds, actIds) : api.deleteActHierarchy(target.show_id, target.id, sceneIds));
        deleted = true;
        return response;
      });
      setDeletedHierarchy({ name: label, revision: result.history.revision, historyId: result.history_id });
    } catch (e) {
      if (!deleted) throw e;
      throw new Error(t("showExplorer.deletedRefreshFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };
  const closeMenu = () => {
    setMenu(null);
    menuOrigin.current?.focus();
  };
  const openMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, target: OutputScope) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy || editing || copyTarget) return;
    menuOrigin.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ target, x: "clientX" in event ? event.clientX : rect.left + 20, y: "clientY" in event ? event.clientY : rect.bottom });
  };
  const menuAction = (action: () => Promise<unknown>) => {
    closeMenu();
    void perform(action);
  };
  const startCopy = () => {
    setDestination(actionTarget.kind === "act" ? showId ?? "" : "");
    setCopyTarget(actionTarget);
    closeMenu();
  };
  const finishDrag = () => {
    dragSource.current = null;
    dragSources.current = [];
    setDropTarget(null);
  };
  const selectForMove = (target: OutlineItem, event: MouseEvent<HTMLElement>) => {
    const key = itemKey(target);
    if (event.shiftKey && selectionAnchor.current) {
      const visible = outlineItems(shows, scenes, collapsed);
      const first = visible.findIndex((item) => itemKey(item) === selectionAnchor.current);
      const last = visible.findIndex((item) => itemKey(item) === key);
      if (first >= 0 && last >= 0) {
        setMoveSelection(new Set(visible.slice(Math.min(first, last), Math.max(first, last) + 1).map(itemKey)));
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setMoveSelection((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    } else setMoveSelection(new Set([key]));
    selectionAnchor.current = key;
  };
  const moveRef = (item: OutputScope): OutlineMoveRef => {
    if (item.kind !== "scene") return item;
    const scene = scenes.find((entry) => entry.id === item.id);
    return { ...item, show_id: scene?.show_id ?? null, act_id: scene?.act_id ?? null };
  };
  const validDrop = (target: OutputScope, position: DropPosition) =>
    dragSources.current.length > 0 && dragSources.current.every((source) => outlineDrop(source, target, position, shows, scenes));
  const dropPosition = (event: DragEvent<HTMLElement>, target: OutputScope): DropPosition => {
    if (target.kind === "all" || target.kind === "standalone") return "inside";
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / Math.max(1, rect.height);
    if (dragSource.current?.kind !== "show" && (target.kind === "show" || target.kind === "act") && fraction > 0.25 && fraction < 0.75) return "inside";
    return fraction < 0.5 ? "before" : "after";
  };
  const executeDrop = async (drop: OutlineDrop, sources: OutlineItem[], target: OutputScope, position: DropPosition) => {
    await organize(async () => {
      if (sources.length > 1) {
        if (!history.history_id) throw new Error(t("showExplorer.refreshBeforeMove"));
        await api.moveOutline(sources.map(moveRef), moveRef(target), position, history.revision, history.history_id);
        return;
      }
      const { source } = drop;
      if (source.kind === "show" && "index" in drop) await api.placeShow(source.id, drop.index);
      else if ("place" in drop) {
        if (source.kind === "scene") await api.placeScene(source.id, drop.place);
        else if (source.kind === "act") {
          await api.placeAct(source.show_id, source.id, drop.place);
          if (scope.kind === "act" && scope.id === source.id && drop.place.show_id) setOutputScope({ kind: "act", id: source.id, show_id: drop.place.show_id });
        }
      }
    });
  };
  const rowProps = (target: OutputScope) => ({
    "data-outline-key": itemKey(target),
    "aria-haspopup": "menu" as const,
    draggable: !busy && !editing && "id" in target,
    onContextMenu: (event: MouseEvent<HTMLElement>) => openMenu(event, target),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") openMenu(event, target);
    },
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      if (!("id" in target) || busy || editing) { event.preventDefault(); return; }
      const selectedItems = moveSelection.has(itemKey(target))
        ? outlineItems(shows, scenes).filter((item) => moveSelection.has(itemKey(item))) : [target];
      dragSources.current = topLevelSelection(selectedItems, scenes);
      dragSource.current = dragSources.current[0] ?? target;
      if (!moveSelection.has(itemKey(target))) {
        setMoveSelection(new Set([itemKey(target)]));
        selectionAnchor.current = itemKey(target);
      }
      setMenu(null);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-libretto-outline", JSON.stringify(target));
    },
    onDragEnd: finishDrag,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      const position = dropPosition(event, target);
      if (busy || editing || !dragSource.current || !validDrop(target, position)) {
        setDropTarget(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const key = itemKey(target);
      setDropTarget((previous) => previous?.key === key && previous.position === position ? previous : { key, position });
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) {
        setDropTarget((previous) => previous?.key === itemKey(target) ? null : previous);
      }
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      const position = dropPosition(event, target);
      const sources = dragSources.current;
      const drop = validDrop(target, position) && sources.length ? outlineDrop(sources[0], target, position, shows, scenes) : null;
      finishDrag();
      if (!drop || busy || editing) return;
      event.preventDefault();
      explorerRef.current?.focus();
      if (position === "inside") setCollapsed((previous) => {
        const next = new Set(previous);
        next.delete("id" in target ? target.id : target.kind);
        return next;
      });
      void perform(() => executeDrop(drop, sources, target, position));
    },
  });
  const dropClass = (target: OutputScope) => dropTarget?.key === itemKey(target) ? ` drop-${dropTarget.position}` : "";
  const itemButton = (target: OutputScope, name: string, type: string) => {
    if (target.kind === "all") return null;
    const moveSelected = moveSelection.has(itemKey(target)) && (moveSelection.size > 1 || !selected(target));
    const className = `explorer-item explorer-item-${target.kind} ${selected(target) ? "on" : ""}${moveSelected ? " move-selected" : ""}${dropClass(target)}`;
    if (editing && editingKey === itemKey(target)) return (
      <div {...rowProps(target)} className={className}>
        <OutlineIcon kind={target.kind} />
        <input ref={renameInput} className="explorer-rename" value={editing.value} readOnly={mutationBusy}
          aria-label={t("showExplorer.editName", { name: editing.original })} aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined} title={t("showExplorer.inlineHint")}
          onChange={(event) => {
            if (renamePhase.current !== "editing") return;
            setEditing({ ...editing, value: event.currentTarget.value });
            setError("");
          }}
          onBlur={() => void saveRename(false)}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing || renamePhase.current !== "editing") return;
            if (event.key === "Enter") { event.preventDefault(); void saveRename(true); }
            else if (event.key === "Escape") { event.preventDefault(); finishRename(editing, true); }
          }} />
      </div>
    );
    return <button {...rowProps(target)} className={className} aria-pressed={selected(target)} disabled={mutationBusy}
      aria-label={type ? `${type}: ${name}` : name}
      aria-description={moveSelected ? t("showExplorer.selectedForMove") : undefined}
      onClick={(event) => {
        if (event.detail >= 2) return;
        if ("id" in target) selectForMove(target, event);
        else setMoveSelection(new Set());
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey) choose(target);
      }} title={name}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); startRename(target, name); }}>
      <OutlineIcon kind={target.kind} /><span className="explorer-name">{name}</span>
    </button>;
  };
  const sceneRow = (id: string) => {
    const scene = scenes.find((s) => s.id === id);
    if (!scene) return <li key={id} className="error">{t("showExplorer.missingScene", { id })}</li>;
    const name = translatedName(scene.name, scene.names, locale) ?? scene.name;
    const target: OutputScope = { kind: "scene", id };
    return <li key={id}><div className="explorer-group explorer-leaf">
      <span className="explorer-toggle-spacer" aria-hidden="true" />
      {itemButton(target, name, t("showExplorer.scene"))}
    </div></li>;
  };
  const groupButton = (target: OutputScope, name: string, key: string, type: string) => (
    <div className="explorer-group" {...rowProps(target)}>
      <button className="explorer-toggle" aria-label={t(collapsed.has(key) ? "showExplorer.expand" : "showExplorer.collapse", { name })} aria-expanded={!collapsed.has(key)} disabled={busy || !!editing} onClick={() => toggle(key)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d={collapsed.has(key) ? "M6 3.5 10.5 8 6 12.5" : "M3.5 6 8 10.5 12.5 6"} /></svg>
      </button>
      {itemButton(target, name, type)}
    </div>
  );

  return (
    <section ref={explorerRef} tabIndex={0} className="show-explorer" data-shortcut-panel="outline" aria-label={t("showExplorer.title")}
      onContextMenu={(event) => openMenu(event, { kind: "all" })}>
      <div className="explorer-heading"><strong>{t("showExplorer.title")}</strong><span className="muted">{t("showExplorer.manageHint")}</span></div>
      <nav className={`explorer-tree${dropClass({ kind: "all" })}`} aria-label={t("showExplorer.title")}
        {...rowProps({ kind: "all" })} tabIndex={0}>
        <button {...rowProps({ kind: "all" })} className={`explorer-item ${scope.kind === "all" ? "on" : ""}${dropClass({ kind: "all" })}`} aria-pressed={scope.kind === "all"} disabled={busy} onClick={() => { setMoveSelection(new Set()); choose({ kind: "all" }); }}>{t("showExplorer.allOutputs")}</button>
        <ul>
          <li>
            {groupButton({ kind: "standalone" }, t("showExplorer.standalone"), "standalone", "")}
            {!collapsed.has("standalone") && <ul>{standaloneScenes(scenes).map((s) => sceneRow(s.id))}</ul>}
          </li>
          {shows.map((s) => {
            return <li key={s.id}>
              {groupButton({ kind: "show", id: s.id }, displayName(s, locale), s.id, t("showExplorer.show"))}
              {!collapsed.has(s.id) && <ul>
                {showItems(s, scenes).map((item) => item.kind === "scene" ? sceneRow(item.id) : <li key={item.id}>
                  {groupButton({ kind: "act", id: item.id, show_id: s.id }, displayName(item, locale), item.id, t("showExplorer.act"))}
                  {!collapsed.has(item.id) && <ul>{item.scene_ids.map(sceneRow)}</ul>}
                </li>)}
              </ul>}
            </li>;
          })}
        </ul>
      </nav>
      {menu && <>
        <div className="ctx-backdrop" onClick={closeMenu} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); closeMenu(); }} />
        <div ref={menuRef} className="ctx-menu explorer-menu" role="menu" aria-label={t("showExplorer.actions")}
          style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 220)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 380)) }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const current = buttons.findIndex((button) => button === document.activeElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}>
          <button role="menuitem" onClick={() => menuAction(createShow)}>{t("showExplorer.newShowAction")}</button>
          {show && <button role="menuitem" onClick={() => menuAction(createAct)}>{t("showExplorer.newActAction")}</button>}
          <button role="menuitem" onClick={() => menuAction(createScene)}>{t("sceneTabs.newScene")}</button>
          {actionable && <>
            <hr />
            <button role="menuitem" onClick={() => startRename(actionTarget, label)}>{t("showExplorer.rename")}</button>
            {actionTarget.kind === "show" && show && <button role="menuitem" onClick={() => {
              setSettingsTarget(show);
              closeMenu();
            }}>{t("showExplorer.settings")}</button>}
            {namedItem && <button role="menuitem" onClick={() => menuAction(renameNames)}>{t("showExplorer.renameNames")}</button>}
            {copyable && <>
              <button role="menuitem" onClick={() => menuAction(duplicate)}>{t("sceneTabs.duplicate")}</button>
              <button role="menuitem" onClick={startCopy}>{t("showExplorer.copy")}</button>
            </>}
            <hr />
            <button role="menuitem" className="danger" disabled={moveSelection.size > 1 && moveSelection.has(itemKey(actionTarget))}
              title={moveSelection.size > 1 && moveSelection.has(itemKey(actionTarget)) ? t("showExplorer.singleDeleteOnly") : undefined}
              onClick={() => menuAction(remove)}>{t("sceneTabs.delete")}</button>
            {(actionTarget.kind === "show" || actionTarget.kind === "act") &&
              <button role="menuitem" className="danger" disabled={moveSelection.size > 1 && moveSelection.has(itemKey(actionTarget))}
                title={moveSelection.size > 1 && moveSelection.has(itemKey(actionTarget)) ? t("showExplorer.singleDeleteOnly") : undefined}
                onClick={() => menuAction(removeHierarchy)}>{t("showExplorer.deleteHierarchy")}</button>}
          </>}
          <hr />
          <button role="menuitem" disabled={busy || !history.undo} onClick={() => replay(false)} title={t("showExplorer.undoTip")}>{t("showExplorer.undo")}</button>
          <button role="menuitem" disabled={busy || !history.redo} onClick={() => replay(true)} title={t("showExplorer.redoTip")}>{t("showExplorer.redo")}</button>
          <hr />
          <button role="menuitem" onClick={() => menuAction(refreshOrganization)}>{t("showExplorer.refresh")}</button>
        </div>
      </>}
      {error && <div id={errorId} className="error explorer-error" role="alert">{error}</div>}
      {deletedHierarchy && history.undo > 0 && history.revision === deletedHierarchy.revision &&
        <div className="explorer-notice" role="status">
          <span>{t("showExplorer.hierarchyDeleted", { name: deletedHierarchy.name })}</span>
          <button disabled={busy} onClick={() => {
            const revision = deletedHierarchy.revision;
            void perform(async () => {
              await organize(() => api.undoOrganization(revision, deletedHierarchy.historyId));
              setDeletedHierarchy(null);
            });
          }}>{t("showExplorer.undoAction")}</button>
          <button disabled={busy} aria-label={t("showExplorer.dismissNotice")} onClick={() => setDeletedHierarchy(null)}>×</button>
        </div>}
      {settingsTarget && <ShowSettings show={settingsTarget} onClose={() => setSettingsTarget(null)} />}
      {copyTarget && <div className="modal" {...backdropClose(() => !busy && setCopyTarget(null))}>
        <form className="modal-body explorer-transfer" onSubmit={(e) => {
          e.preventDefault();
          const target = destinations.find((d) => d.key === destination);
          if (target) void perform(async () => { await copyTo(target.place); setCopyTarget(null); });
        }}>
          <h2>{t("showExplorer.copyTitle", { name: label })}</h2>
          <label>{t("showExplorer.destination")}
            <select autoFocus value={destination} disabled={busy} onChange={(e) => setDestination(e.target.value)}>
              {destinations.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </label>
          <p className="muted">{t("showExplorer.copyHint")}</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row">
            <button type="submit" disabled={busy || !destinations.some((d) => d.key === destination)}>{t("showExplorer.copy")}</button>
            <button type="button" disabled={busy} onClick={() => setCopyTarget(null)}>{t("showExplorer.cancel")}</button>
          </div>
        </form>
      </div>}
    </section>
  );
}
