import { useEffect, useMemo, useRef, useState } from "react";
import { applyClick, prune, selectAll, type SelectionState } from "./selection";
import { api } from "./api";
import { parseTags, presetTitle, searchNames, translatedName } from "./tags";
import { useTags } from "./useTags";
import { LibrariesDialog } from "./LibrariesDialog";
import { askConfirm, askText } from "./ask";
import { CategoriesDialog } from "./CategoriesDialog";
import { buildCategoryTree, buildSections, flattenTags, parseKey, toggleCategory, toggleTag, UNTAGGED, type TreeNode } from "./libraryTree";
import { beginPaletteDrag, type DragPayload } from "./paletteDrag";
import { COLORS, NEGATIVE_COLOR, Thumb } from "./nodes";
import { useT } from "./i18n/useT";
import { PresetPane, type PaneItem } from "./PresetPane";
import { Splitter } from "./Splitter";
import { libraryName, useStore } from "./store";
import { useWheelResize } from "./wheelResize";
import { type Category, type GraphNodeData, type Preset } from "./types";

export function presetPayload(category: Category, p: Preset, lib?: string): { type: string; data: GraphNodeData } {
  return {
    type: category,
    data: {
      presetId: p.id,
      lib,
      name: p.name,
      names: p.names,
      description: p.description,
      negative: p.negative,
      emphasis: 1,
      lora: p.lora,
      labels: p.labels,
      weight: p.weight,
    },
  };
}

const itemKey = (category: Category, id: string) => `${category}|${id}`;
const splitItem = (key: string) => {
  const i = key.indexOf("|");
  return { category: key.slice(0, i) as Category, id: key.slice(i + 1) };
};

const SCROLL_MS = 350;
let scrollFrame = 0;

/** Scroll to an element in a fixed time (speed scales with distance), easing in and out. */
function scrollToSection(container: HTMLElement, target: HTMLElement, offset = 0) {
  cancelAnimationFrame(scrollFrame);
  const from = container.scrollTop;
  const to = from + target.getBoundingClientRect().top - container.getBoundingClientRect().top - offset;
  const dest = Math.max(0, Math.min(to, container.scrollHeight - container.clientHeight));
  if (Math.abs(dest - from) < 1) return;
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / SCROLL_MS);
    const eased = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    container.scrollTop = from + (dest - from) * eased;
    if (k < 1) scrollFrame = requestAnimationFrame(step);
  };
  scrollFrame = requestAnimationFrame(step);
}

type DeletedItems = { library: string; items: { category: Category; id: string }[] };

export function Palette() {
  const t = useT();
  const refresh = useStore((s) => s.refreshPresets);
  const presets = useStore((s) => s.presets);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const library = useStore((s) => s.library);
  const libraries = useStore((s) => s.libraries);
  const setLibrary = useStore((s) => s.setLibrary);
  const addNode = useStore((s) => s.addNode);
  const clip = useStore((s) => s.presetClip);
  const setClip = useStore((s) => s.setPresetClip);
  const [manage, setManage] = useState(false);
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<SelectionState>({ selected: new Set(), anchor: null });
  const [selectMode, setSelectMode] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [message, setMessage] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const undoStack = useRef<DeletedItems[]>([]);
  const redoStack = useRef<DeletedItems[]>([]);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const syncHistory = () => setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });
  const hover = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useWheelResize(wrapRef, "libThumb", 40, 180);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // N toggles the property pane while the pointer is over the library
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hover.current || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "n") return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      setUi({ propsOpen: !useStore.getState().ui.propsOpen });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setUi]);

  const [editCats, setEditCats] = useState(false);
  const categoryList = useStore((s) => s.categories);
  const CATEGORIES = useMemo(() => categoryList.map((c) => c.id), [categoryList]);
  const labelOf = (c: Category) => categoryList.find((x) => x.id === c)?.label ?? c;
  const tags = useTags();
  const trees = useMemo(() => Object.fromEntries(CATEGORIES.map((c) => [c, flattenTags(buildCategoryTree(c, presets[c] ?? [], tags.idx, tags.locale))])) as Record<Category, TreeNode[]>, [presets, CATEGORIES, tags]);
  const sections = useMemo(() => buildSections(ui.libSel, presets, CATEGORIES, tags.idx, tags.locale, (c) => categoryList.find((x) => x.id === c)?.label ?? c), [ui.libSel, presets, CATEGORIES, categoryList, tags]);
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      sections.map((s) => ({
        ...s,
        presets: s.presets.filter((p) => !needle || `${searchNames(p.name, p.names, tags.locale)} ${p.labels.map((id) => `${tags.path(id)} ${searchNames("", tags.idx.byId.get(id)?.names, tags.locale)}`).join(" ")}`.toLowerCase().includes(needle)),
      })),
    [sections, needle, tags],
  );
  const ids = useMemo(() => shown.flatMap((s) => s.presets.map((p) => itemKey(s.category, p.id))), [shown]);
  const allIds = useMemo(() => CATEGORIES.flatMap((c) => (presets[c] ?? []).map((p) => itemKey(c, p.id))), [presets, CATEGORIES]);
  const count = selection.selected.size;
  const canPaste = !!clip && clip.items.length > 0;
  const selectedCats = CATEGORIES.filter((c) => ui.libSel.some((k) => parseKey(k).category === c));

  useEffect(() => {
    setSelection((current) => prune(current, allIds));
  }, [allIds]);

  const clear = () => setSelection({ selected: new Set(), anchor: null });
  const emptyDown = useRef(false);
  const isEmptyArea = (target: EventTarget) => !(target as HTMLElement).closest(".card, button, input, select, textarea, label, .ctx-menu");

  const toggleCat = (category: Category, multi: boolean) => setUi({ libSel: toggleCategory(useStore.getState().ui.libSel, category, multi) });
  const toggleTagButton = (category: Category, path: string, multi: boolean) => setUi({ libSel: toggleTag(useStore.getState().ui.libSel, category, path, multi) });

  const refreshCategories = async (cats: Category[]) => {
    await Promise.all([...new Set(cats)].map((c) => refresh(c)));
  };

  const toggleOne = (key: string) => {
    const next = new Set(selection.selected);
    if (!next.delete(key)) next.add(key);
    setSelection({ selected: next, anchor: key });
  };

  const copySelected = (cut: boolean) => {
    if (count === 0) return;
    setClip({ library, items: [...selection.selected].map(splitItem), cut });
    setMessage(t(cut ? "palette.cutDone" : "palette.copiedDone", { n: count }));
  };

  const pasteClip = async () => {
    if (!clip || clip.items.length === 0) return;
    try {
      if (clip.cut && clip.library === library) {
        setClip(null);
        setMessage(t("palette.alreadyHere"));
        return;
      }
      const done = await api.copyItems(library, clip.library, clip.items);
      if (clip.cut) {
        await Promise.allSettled(clip.items.map((i) => api.deletePreset(i.category, i.id, clip.library)));
        setClip(null);
      }
      const { refreshLibraries, bumpThumbs } = useStore.getState();
      await Promise.all([refreshCategories(clip.items.map((i) => i.category)), refreshLibraries()]);
      bumpThumbs();
      setSelection({ selected: new Set(done.map((d) => itemKey(d.category as Category, d.id))), anchor: null });
      setMessage(t(clip.cut ? "palette.pastedMoved" : "palette.pasted", { n: done.length }));
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const deleteItems = async (items: { category: Category; id: string }[]) => {
    const results = await Promise.allSettled(items.map((i) => api.deletePreset(i.category, i.id)));
    const done = items.filter((_, n) => results[n].status === "fulfilled");
    if (done.length) {
      undoStack.current.push({ library, items: done });
      redoStack.current = [];
      syncHistory();
    }
    clear();
    await refreshCategories(items.map((i) => i.category));
    void useStore.getState().refreshLibraries();
  };

  // undo/redo for library deletes: files are moved to the library's trash, so restoring is lossless
  const replay = async (from: DeletedItems[], to: DeletedItems[], restore: boolean) => {
    const action = from.pop();
    if (!action) return;
    const results = await Promise.allSettled(
      action.items.map((i) => (restore ? api.restorePreset(i.category, i.id, action.library) : api.deletePreset(i.category, i.id, action.library))),
    );
    const done = action.items.filter((_, n) => results[n].status === "fulfilled");
    if (done.length) to.push({ ...action, items: done });
    syncHistory();
    const failed = action.items.length - done.length;
    setMessage(t(restore ? "palette.restored" : "palette.deletedAgain", { n: done.length }) + (failed ? t("palette.failedSuffix", { n: failed }) : ""));
    if (action.library === useStore.getState().library) {
      await refreshCategories(action.items.map((i) => i.category));
      useStore.getState().bumpThumbs();
      void useStore.getState().refreshLibraries();
      if (restore) setSelection({ selected: new Set(done.map((i) => itemKey(i.category, i.id))), anchor: null });
    }
  };
  const undoDelete = () => replay(undoStack.current, redoStack.current, true);
  const redoDelete = () => replay(redoStack.current, undoStack.current, false);

  const deleteSelected = async () => {
    if (count === 0) return;
    if (!(await askConfirm(t(count === 1 ? "palette.deleteItemsOne" : "palette.deleteItemsMany", { n: count }), t("palette.delete")))) return;
    await deleteItems([...selection.selected].map(splitItem));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const redo = mod && ((key === "z" && e.shiftKey) || key === "y");
    const undo = mod && key === "z" && !e.shiftKey;
    // only claim the shortcut when there is something to undo here; otherwise the canvas undo runs
    if (undo && undoStack.current.length) (e.preventDefault(), e.stopPropagation(), void undoDelete());
    else if (redo && redoStack.current.length) (e.preventDefault(), e.stopPropagation(), void redoDelete());
    else if (mod && key === "a") (e.preventDefault(), setSelection(selectAll(ids)));
    else if (mod && key === "c") (e.preventDefault(), copySelected(false));
    else if (mod && key === "x") (e.preventDefault(), copySelected(true));
    else if (mod && key === "v") (e.preventDefault(), void pasteClip());
    else if (e.key === "Delete") void deleteSelected();
    else if (e.key === "Escape") clear();
  };

  const openMenu = (e: React.MouseEvent, key?: string) => {
    e.preventDefault();
    if (key && !selection.selected.has(key)) setSelection({ selected: new Set([key]), anchor: key });
    setMenu({ x: e.clientX, y: e.clientY });
  };

  /** Dragging one of several selected cards drags them all. */
  const selectionPayload = (key: string): DragPayload | null => {
    if (selection.selected.size < 2 || !selection.selected.has(key)) return null;
    const list = [...selection.selected]
      .map(splitItem)
      .map((i) => ({ i, p: (presets[i.category] ?? []).find((x) => x.id === i.id) }))
      .filter((x) => !!x.p)
      .map((x) => presetPayload(x.i.category, x.p!, library));
    return list.length < 2 ? null : { ...list[0], extra: list.slice(1) };
  };

  /** Dragging Random while several cards of its category are selected makes a collection of just those. */
  const randomPayload = (category: Category, path: string | undefined): DragPayload => {
    const ids = [...selection.selected].map(splitItem).filter((i) => i.category === category).map((i) => i.id);
    if (ids.length > 1) return { type: "collection", data: { category, mode: "random", item_ids: ids } };
    return { type: "collection", data: { category, mode: "random", ...(path && path !== UNTAGGED ? { filter_labels: [path] } : {}) } };
  };

  const cardClick = (e: React.MouseEvent, key: string) => {
    // the card being edited counts as selected when starting a multi-selection
    const base: SelectionState = selection.selected.size === 0 && active && active !== key && ids.includes(active) ? { selected: new Set([active]), anchor: active } : selection;
    setActive(key);
    const next = applyClick(base, ids, key, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, toggleMode: selectMode });
    if (next) {
      e.preventDefault();
      setSelection(next);
    }
  };

  const editTags = async (category: Category, p: Preset) => {
    const text = await askText(t("palette.tagsPrompt", { name: p.name }), p.labels.map(tags.path).join(", "));
    if (text === null) return;
    await api.savePreset(category, { ...p, labels: parseTags(tags.idx, text) }, p.id);
    await refresh(category);
  };

  const renameTag = async (id: string) => {
    const current = tags.name(id);
    const text = await askText(t("palette.renameTagPrompt", { tag: tags.path(id), locale: tags.locale }), current);
    if (text === null) return;
    const name = text.trim();
    if (name === current) return;
    if (!name) {
      if (!(await askConfirm(t("palette.deleteTagConfirm", { tag: tags.path(id) }), t("palette.delete")))) return;
      await api.deleteTag(id);
    } else {
      await api.patchTag(id, { locale: tags.locale, name });
    }
    await useStore.getState().refreshPresets();
  };

  const rename = async (category: Category, p: Preset) => {
    const name = (await askText(t("palette.renamePrompt", { name: p.name }), p.name))?.trim();
    if (!name || name === p.name) return;
    await api.savePreset(category, { ...p, name }, p.id);
    await refresh(category);
  };

  const remove = async (category: Category, p: Preset) => {
    if (!(await askConfirm(t("palette.deletePresetConfirm", { name: p.name }), t("palette.delete")))) return;
    await deleteItems([{ category, id: p.id }]);
  };

  // new presets and imports go to the first selected section, tagged with its path
  const target = sections[0];
  const create = async () => {
    if (!target) return;
    const name = (await askText(t("palette.newPresetPrompt", { category: labelOf(target.category) })))?.trim();
    if (!name) return;
    await api.savePreset(target.category, { name, keywords: name, description: name, labels: target.path && target.path !== UNTAGGED ? [target.path] : [] });
    await refresh(target.category);
  };

  const importList = async (file?: File) => {
    if (!file || !target) return;
    await api.importWildcard(target.category, await file.text());
    await refresh(target.category);
  };

  const size = ui.libThumb;
  const gridStyle = { gridTemplateColumns: `repeat(auto-fill, minmax(${size + 8}px, 1fr))` };
  const selecting = selectMode || count > 0;
  const paneItems = useMemo<PaneItem[]>(() => {
    const keys = selection.selected.size > 1 ? [...selection.selected] : active ? [active] : [];
    return keys.map(splitItem).filter((i) => (presets[i.category] ?? []).some((p) => p.id === i.id));
  }, [selection, active, presets]);
  const paneKey = `${library}/${paneItems.map((i) => itemKey(i.category, i.id)).sort().join(",")}`;

  return (
    <div ref={wrapRef} className="palette-wrap" onMouseEnter={() => (hover.current = true)} onMouseLeave={() => (hover.current = false)}>
      <Splitter axis="y" className="edge-top" value={ui.libraryH} min={150} max={900} direction={-1} onChange={(v) => setUi({ libraryH: v })} />
      <section className="lib-main">
        <div className="row wrap lib-bar">
          <select value={library} onChange={(e) => void setLibrary(e.target.value)} title={t("palette.activeLibrary")}>
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {(translatedName(l.name, l.names, tags.locale) ?? l.name)}
              </option>
            ))}
          </select>
          <button onClick={() => setManage(true)} title={t("palette.manageLibraries")}>
            …
          </button>
          {manage && <LibrariesDialog onClose={() => setManage(false)} />}
          <button onClick={() => setEditCats(true)} title={t("palette.editCategories")}>
            ⚙
          </button>
          {editCats && <CategoriesDialog onClose={() => setEditCats(false)} />}
          <button disabled={!history.undo} onClick={() => void undoDelete()} title={t("palette.undoTip")}>
            ↶
          </button>
          <button disabled={!history.redo} onClick={() => void redoDelete()} title={t("palette.redoTip")}>
            ↷
          </button>
          <span className="lib-name" title={t("palette.activeLibraryName", { name: libraryName(libraries, library, tags.locale) })}>
            {libraryName(libraries, library, tags.locale)}
          </span>
          {(["positive", "negative"] as const).map((polarity) => (
            <div
              key={polarity}
              className="card prompt-card"
              style={{ borderColor: polarity === "negative" ? NEGATIVE_COLOR : COLORS.prompt }}
              onPointerDown={(e) => beginPaletteDrag(e, { type: "prompt", data: { text: "", polarity, placement: "inline" } }, t(polarity === "positive" ? "palette.positivePrompt" : "palette.negativePrompt"))}
              onDoubleClick={() => addNode("prompt", { text: "", polarity, placement: "inline" }, { x: 120, y: 80 })}
              title={t("palette.dragPrompt")}
            >
              ✍ {polarity === "positive" ? "+" : "−"}
            </div>
          ))}
          <input placeholder={t("palette.searchPlaceholder")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <input type="range" min={40} max={180} value={size} onChange={(e) => setUi({ libThumb: Number(e.target.value) })} title={t("palette.thumbSize")} />
          <button onClick={create} disabled={!target} title={t("palette.newPreset")}>
            +
          </button>
          <label className="button" title={t("palette.importWildcard")}>
            ⇪<input type="file" accept=".txt" hidden onChange={(e) => importList(e.target.files?.[0])} />
          </label>
          <button className={selectMode ? "on" : ""} onClick={() => setSelectMode(!selectMode)} title={t("palette.selectMode")}>
            ☑
          </button>
          <button onClick={() => setSelection(selectAll(ids))} disabled={ids.length === 0} title={t("palette.selectAllTip")}>
            {t("palette.all")}
          </button>
          <button onClick={clear} disabled={count === 0} title={t("palette.clearTip")}>
            {t("palette.none")}
          </button>
          <button onClick={() => copySelected(false)} disabled={count === 0} title={t("palette.copyTip")}>
            ⧉
          </button>
          <button onClick={() => copySelected(true)} disabled={count === 0} title={t("palette.cutTip")}>
            ✂
          </button>
          <button onClick={() => void pasteClip()} disabled={!canPaste} title={canPaste ? t("palette.pasteTip", { n: clip!.items.length, library: libraryName(libraries, clip!.library, tags.locale) }) : t("palette.pasteEmptyTip")}>
            📋
          </button>
          <button className="danger" onClick={() => void deleteSelected()} disabled={count === 0} title={t("palette.deleteTip")}>
            🗑
          </button>
          {(count > 0 || message) && (
            <span className="muted">
              {count > 0 && t("palette.nSelected", { n: count })}
              {count > 0 && message && " · "}
              {message}
            </span>
          )}
        </div>
        <nav className="lib-cats">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              className={selectedCats.includes(c) ? "on" : ""}
              style={{ borderBottomColor: COLORS[c] }}
              title={t("palette.showCategory", { label: labelOf(c) })}
              onClick={(e) => toggleCat(c, e.ctrlKey || e.metaKey)}
            >
              {labelOf(c)} <span className="muted">{presets[c]?.length ?? 0}</span>
            </button>
          ))}
        </nav>
        {selectedCats.some((c) => trees[c].length > 0) && (
          <nav className="lib-cats lib-tags">
            {selectedCats.map((c) =>
              trees[c].length === 0 ? null : (
                <span key={c} className="tag-group">
                  <span className="tag-group-name" style={{ borderLeftColor: COLORS[c] }}>
                    {labelOf(c)}
                  </span>
                  {trees[c].map((n) => (
                    <button
                      key={n.key}
                      className={ui.libSel.includes(n.key) ? "on" : ""}
                      title={t("palette.showTag", { tag: n.path === UNTAGGED ? t("palette.untagged") : tags.path(n.path), category: labelOf(c) })}
                      onClick={(e) => toggleTagButton(c, n.path, e.ctrlKey || e.metaKey)}
                      onContextMenu={(e) => {
                        if (n.path === UNTAGGED) return;
                        e.preventDefault();
                        void renameTag(n.path);
                      }}
                    >
                      {n.name} <span className="muted">{n.count}</span>
                    </button>
                  ))}
                </span>
              ),
            )}
          </nav>
        )}
        <div
          className={`lib-scroll ${selecting ? "selecting" : ""}`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => openMenu(e)}
          onPointerDown={(e) => (emptyDown.current = isEmptyArea(e.target))}
          onClick={(e) => {
            if (emptyDown.current && isEmptyArea(e.target)) clear();
            emptyDown.current = false;
          }}
        >
          {shown.length > 1 && (
            <nav className="lib-jump">
              {shown.map((s) => (
                <button
                  key={s.key}
                  style={{ borderBottomColor: COLORS[s.category] }}
                  title={t("palette.jumpTo", { title: s.title })}
                  onClick={(e) => {
                    const section = document.getElementById(`lb-sec-${s.key}`);
                    const container = (e.currentTarget as HTMLElement).closest<HTMLElement>(".lib-scroll");
                    if (section && container) scrollToSection(container, section, (e.currentTarget as HTMLElement).parentElement!.offsetHeight);
                  }}
                >
                  {s.title} <span className="muted">{s.presets.length}</span>
                </button>
              ))}
            </nav>
          )}
          {shown.length === 0 && <p className="muted">{t("palette.selectCategory")}</p>}
          {shown.map((s) => (
            <div key={s.key} id={`lb-sec-${s.key}`} className="lib-section">
              <h3 style={{ borderLeftColor: COLORS[s.category] }}>
                {s.title} <span className="muted">({s.presets.length})</span>
              </h3>
              <div className="grid" style={gridStyle}>
                {s.path !== UNTAGGED && (
                <div
                  className="card"
                  style={{ width: "auto", justifyContent: "center", textAlign: "center", minHeight: size }}
                  onPointerDown={(e) =>
                    {
                    const payload = randomPayload(s.category, s.path);
                    beginPaletteDrag(e, payload, payload.data.item_ids ? t("palette.randomOfSelected", { n: (payload.data.item_ids as string[]).length }) : t("palette.randomTitle", { title: s.title }));
                  }
                  }
                  onDoubleClick={() =>
                    addNode("collection", { category: s.category, mode: "random", ...(s.path && s.path !== UNTAGGED ? { filter_labels: [s.path] } : {}) }, { x: 120, y: 80 })
                  }
                  title={t("palette.randomTip", { title: s.title })}
                >
                  🎲 {t("palette.random")}
                </div>
                )}
                {s.presets.map((p) => {
                  const key = itemKey(s.category, p.id);
                  const picked = selection.selected.has(key);
                  return (
                    <div
                      key={key}
                      className={`card ${picked ? "picked" : ""}`}
                      onPointerDown={(e) => {
                        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                        const multi = selectionPayload(key);
                        beginPaletteDrag(e, multi ?? presetPayload(s.category, p, library), multi ? t("palette.nItems", { n: 1 + multi.extra!.length }) : presetTitle(p.name, p.names, tags.locale));
                      }}
                      onClick={(e) => cardClick(e, key)}
                      onContextMenu={(e) => (e.stopPropagation(), openMenu(e, key))}
                      onDoubleClick={() => {
                        const { type, data } = presetPayload(s.category, p, library);
                        addNode(type, data, { x: 120, y: 80 });
                      }}
                      title={`${presetTitle(p.name, p.names, tags.locale)}\n${p.keywords}`}
                    >
                      <div className="thumb-wrap">
                        <Thumb category={s.category} id={p.id} size={size} lib={library} />
                        <button className={`card-act tl ${picked ? "on" : ""}`} title={t("palette.select")} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), toggleOne(key))}>
                          {picked ? "✓" : "☐"}
                        </button>
                        <button className="card-act bl" title={t("palette.rename")} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), void rename(s.category, p))}>
                          ✎
                        </button>
                        <button className="card-act br" title={t("palette.deleteFromLibrary")} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), void remove(s.category, p))}>
                          🗑
                        </button>
                        <button
                          className="tag-badge"
                          title={t("palette.tagsTip", { tags: p.labels.map(tags.path).join(", ") || t("palette.noneLower") })}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => (e.stopPropagation(), void editTags(s.category, p))}
                        >
                          🏷 {p.labels.length || ""}
                        </button>
                      </div>
                      {(() => {
                        const shown = translatedName(p.name, p.names, tags.locale);
                        return (
                          <>
                            <span className="clip" style={{ maxWidth: size }}>
                              {shown ?? p.name}
                            </span>
                            {shown && (
                              <span className="clip muted" style={{ maxWidth: size }}>
                                {p.name}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {menu && (
          <>
            <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
            <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 190) }} onClick={() => setMenu(null)}>
              <button disabled={count === 0} onClick={() => copySelected(false)}>
                {t("palette.copy")}
              </button>
              <button disabled={count === 0} onClick={() => copySelected(true)}>
                {t("palette.cut")}
              </button>
              <button disabled={!canPaste} onClick={() => void pasteClip()}>
                {t("palette.paste")}{canPaste ? t("palette.pasteDetail", { n: clip!.items.length, library: libraryName(libraries, clip!.library, tags.locale) }) : ""}
              </button>
              <hr />
              <button disabled={count === 0} onClick={() => void deleteSelected()}>
                {t("palette.delete")}
              </button>
              <button onClick={() => setSelection(selectAll(ids))}>{t("palette.selectAll")}</button>
            </div>
          </>
        )}
      </section>
      {ui.propsOpen ? (
        <aside className="lib-props" style={{ width: ui.propsW }}>
          <Splitter axis="x" className="edge-left" value={ui.propsW} min={220} max={700} direction={-1} onChange={(v) => setUi({ propsW: v })} />
          <div className="lib-props-head">
            <strong>{t("palette.presetProperties")}</strong>
            <button onClick={() => setUi({ propsOpen: false })} title={t("palette.hide")}>
              ▸
            </button>
          </div>
          <div className="lib-props-body">
            {paneItems.length > 0 ? (
              <PresetPane key={paneKey} items={paneItems} />
            ) : (
              <p className="muted">{t("palette.propsHint")}</p>
            )}
          </div>
        </aside>
      ) : (
        <button className="lib-props-open" onClick={() => setUi({ propsOpen: true })} title={t("palette.propsOpen")}>
          ◂
        </button>
      )}
    </div>
  );
}
