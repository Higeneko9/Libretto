import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { api } from "./api";
import { askConfirm, askNames, askText } from "./ask";
import { backdropClose } from "./backdropClose";
import { useT } from "./i18n/useT";
import { usePanelShortcuts } from "./panelShortcuts";
import { ShowSettings } from "./ShowSettings";
import { outlineDrop, outlineSiblings, sceneDestination, showItems, standaloneScenes, type DropPosition, type OutlineDrop, type OutlineItem } from "./showOutline";
import { useStore } from "./store";
import { translatedName, withName } from "./tags";
import type { OutputScope, ScenePlace, Show } from "./types";

type Menu = { target: OutputScope; x: number; y: number };
type InlineRename = { target: OutlineItem; original: string; value: string; locale: string };
const itemKey = (item: OutputScope) => `${item.kind}:${"id" in item ? item.id : ""}`;

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
  const [dropTarget, setDropTarget] = useState<{ key: string; position: DropPosition } | null>(null);
  const [copyTarget, setCopyTarget] = useState<OutputScope | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<Show | null>(null);
  const [destination, setDestination] = useState("");
  const actionTarget = copyTarget ?? menu?.target ?? scope;
  const selectedScene = actionTarget.kind === "scene" ? scenes.find((s) => s.id === actionTarget.id) : undefined;
  const showId = actionTarget.kind === "show" ? actionTarget.id : actionTarget.kind === "act" ? actionTarget.show_id : selectedScene?.show_id;
  const show = shows.find((s) => s.id === showId);
  const act = actionTarget.kind === "act" ? show?.items.filter((i) => i.kind === "act").find((i) => i.id === actionTarget.id) : undefined;
  const label = selectedScene ? translatedName(selectedScene.name, selectedScene.names, locale) ?? selectedScene.name : act?.name ?? show?.name ?? "";
  const actionable = "id" in actionTarget;
  const copyable = actionTarget.kind === "scene" || actionTarget.kind === "act";
  const destinations: { key: string; label: string; place: ScenePlace }[] = [
    ...(actionTarget.kind === "scene" ? [{ key: "", label: t("showExplorer.standalone"), place: {} }] : []),
    ...shows.flatMap((s) => [
      { key: s.id, label: s.name, place: { show_id: s.id } },
      ...(actionTarget.kind === "scene" ? s.items.filter((i) => i.kind === "act").map((a) => ({
        key: a.id, label: `${s.name} / ${a.name}`, place: { show_id: s.id, act_id: a.id },
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
      if (!editing && !copyTarget && !busy && actionable && !event.repeat) menuAction(remove);
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
  };
  const createScene = async () => {
    const name = (await askText(t("sceneTabs.newScenePrompt"), t("sceneTabs.defaultSceneName", { n: scenes.length + 1 })))?.trim();
    if (name) {
      setOutputScope(actionTarget);
      await newScene(name);
    }
  };
  const renameNames = async () => {
    if (selectedScene) {
      const names = await askNames(t("sceneTabs.rename"), selectedScene.name, translatedName(selectedScene.name, selectedScene.names, locale) ?? "", locale);
      if (names?.name.trim()) await renameScene(selectedScene.id, names.name.trim(), withName(selectedScene.names, locale, names.display));
    }
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
            if (target.kind === "act") await api.renameAct(target.show_id, target.id, name);
            else await api.renameShow(target.id, name);
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
    setDropTarget(null);
  };
  const dropPosition = (event: DragEvent<HTMLElement>, target: OutputScope): DropPosition => {
    if (target.kind === "all" || target.kind === "standalone") return "inside";
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / Math.max(1, rect.height);
    if (dragSource.current?.kind !== "show" && (target.kind === "show" || target.kind === "act") && fraction > 0.25 && fraction < 0.75) return "inside";
    return fraction < 0.5 ? "before" : "after";
  };
  const executeDrop = async (drop: OutlineDrop) => {
    await organize(async () => {
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
      dragSource.current = target;
      setMenu(null);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-libretto-outline", JSON.stringify(target));
    },
    onDragEnd: finishDrag,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      const position = dropPosition(event, target);
      if (busy || editing || !dragSource.current || !outlineDrop(dragSource.current, target, position, shows, scenes)) {
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
      const drop = dragSource.current && outlineDrop(dragSource.current, target, position, shows, scenes);
      finishDrag();
      if (!drop || busy || editing) return;
      event.preventDefault();
      explorerRef.current?.focus();
      if (position === "inside") setCollapsed((previous) => {
        const next = new Set(previous);
        next.delete("id" in target ? target.id : target.kind);
        return next;
      });
      void perform(() => executeDrop(drop));
    },
  });
  const dropClass = (target: OutputScope) => dropTarget?.key === itemKey(target) ? ` drop-${dropTarget.position}` : "";
  const itemButton = (target: OutputScope, name: string, type: string) => {
    const className = `explorer-item ${selected(target) ? "on" : ""}${dropClass(target)}`;
    if (editing && editingKey === itemKey(target)) return (
      <div {...rowProps(target)} className={className}>
        <span className="muted">{type}</span>
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
      onClick={(event) => { if (event.detail < 2) choose(target); }} title={name}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); startRename(target, name); }}>
      <span className="muted">{type}</span><span className="explorer-name">{name}</span>
    </button>;
  };
  const sceneRow = (id: string) => {
    const scene = scenes.find((s) => s.id === id);
    if (!scene) return <li key={id} className="error">{t("showExplorer.missingScene", { id })}</li>;
    const name = translatedName(scene.name, scene.names, locale) ?? scene.name;
    const target: OutputScope = { kind: "scene", id };
    return <li key={id}>{itemButton(target, name, t("showExplorer.scene"))}</li>;
  };
  const groupButton = (target: OutputScope, name: string, key: string, type: string) => (
    <div className="explorer-group" {...rowProps(target)}>
      <button className="explorer-toggle" aria-label={t(collapsed.has(key) ? "showExplorer.expand" : "showExplorer.collapse", { name })} aria-expanded={!collapsed.has(key)} disabled={busy || !!editing} onClick={() => toggle(key)}>{collapsed.has(key) ? "▸" : "▾"}</button>
      {itemButton(target, name, type)}
    </div>
  );

  return (
    <section ref={explorerRef} tabIndex={0} className="show-explorer" data-shortcut-panel="outline" aria-label={t("showExplorer.title")}
      onContextMenu={(event) => openMenu(event, { kind: "all" })}>
      <div className="explorer-heading"><strong>{t("showExplorer.title")}</strong><span className="muted">{t("showExplorer.manageHint")}</span></div>
      <nav className={`explorer-tree${dropClass({ kind: "all" })}`} aria-label={t("showExplorer.title")}
        {...rowProps({ kind: "all" })} tabIndex={0}>
        <button {...rowProps({ kind: "all" })} className={`explorer-item ${scope.kind === "all" ? "on" : ""}${dropClass({ kind: "all" })}`} aria-pressed={scope.kind === "all"} disabled={busy} onClick={() => choose({ kind: "all" })}>{t("showExplorer.allOutputs")}</button>
        <ul>
          <li>
            {groupButton({ kind: "standalone" }, t("showExplorer.standalone"), "standalone", "")}
            {!collapsed.has("standalone") && <ul>{standaloneScenes(scenes).map((s) => sceneRow(s.id))}</ul>}
          </li>
          {shows.map((s) => {
            return <li key={s.id}>
              {groupButton({ kind: "show", id: s.id }, s.name, s.id, t("showExplorer.show"))}
              {!collapsed.has(s.id) && <ul>
                {showItems(s, scenes).map((item) => item.kind === "scene" ? sceneRow(item.id) : <li key={item.id}>
                  {groupButton({ kind: "act", id: item.id, show_id: s.id }, item.name, item.id, t("showExplorer.act"))}
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
            {selectedScene && <button role="menuitem" onClick={() => menuAction(renameNames)}>{t("showExplorer.renameNames")}</button>}
            {copyable && <>
              <button role="menuitem" onClick={() => menuAction(duplicate)}>{t("sceneTabs.duplicate")}</button>
              <button role="menuitem" onClick={startCopy}>{t("showExplorer.copy")}</button>
            </>}
            <hr />
            <button role="menuitem" className="danger" onClick={() => menuAction(remove)}>{t("sceneTabs.delete")}</button>
          </>}
          <hr />
          <button role="menuitem" disabled={busy || !history.undo} onClick={() => replay(false)} title={t("showExplorer.undoTip")}>{t("showExplorer.undo")}</button>
          <button role="menuitem" disabled={busy || !history.redo} onClick={() => replay(true)} title={t("showExplorer.redoTip")}>{t("showExplorer.redo")}</button>
          <hr />
          <button role="menuitem" onClick={() => menuAction(refreshOrganization)}>{t("showExplorer.refresh")}</button>
        </div>
      </>}
      {error && <div id={errorId} className="error explorer-error" role="alert">{error}</div>}
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
