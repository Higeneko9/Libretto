import { useEffect, useState } from "react";
import { api } from "./api";
import { askConfirm } from "./ask";
import { backdropClose } from "./backdropClose";
import { useT } from "./i18n/useT";
import { libraryName, useStore } from "./store";
import { normalizeLocale, pickName } from "./tags";
import type { CategoryConfig, CategoryKind, CategoryKindInfo } from "./types";

// Ids double as folder names, so they are opaque: the label is free text (any language) and can change later.
function uniqueId(_label: string, items: CategoryConfig[]) {
  const taken = new Set(items.flatMap((c) => [c.id, c.folder]));
  let id: string;
  do id = `c-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
  while (taken.has(id));
  return id;
}

export function CategoriesDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const kindHelp = (k: CategoryKind) => t(`categories.kind_${k}`);
  const library = useStore((s) => s.library);
  const locale = normalizeLocale(useStore((s) => s.ui.locale));
  const libraries = useStore((s) => s.libraries);
  const stored = useStore((s) => s.categories);
  const [items, setItems] = useState<CategoryConfig[]>(() => stored.map((c) => ({ ...c })));
  const [kinds, setKinds] = useState<CategoryKindInfo[]>([]);
  const [newKind, setNewKind] = useState<CategoryKind>("attribute");
  const [message, setMessage] = useState("");
  const [purge, setPurge] = useState(false);
  const counts = libraries.find((l) => l.id === library)?.counts ?? {};

  const remove = async (i: number) => {
    const c = items[i];
    const n = counts[c.id] ?? 0;
    if (n && !(await askConfirm(t(n === 1 ? "categories.deleteConfirmOne" : "categories.deleteConfirmMany", { label: c.label, n }), t("categories.delete")))) return;
    if (n) setPurge(true);
    setItems(items.filter((_, j) => j !== i));
  };

  useEffect(() => {
    void api.categoryKinds().then(setKinds);
  }, []);

  const patch = (i: number, change: Partial<CategoryConfig>) => setItems(items.map((c, j) => (j === i ? { ...c, ...change } : c)));
  const move = (i: number, delta: number) => {
    const next = [...items];
    const to = i + delta;
    if (to < 0 || to >= next.length) return;
    [next[i], next[to]] = [next[to], next[i]];
    setItems(next);
  };

  const add = () => {
    const info = kinds.find((k) => k.id === newKind);
    const label = t("categories.newCategory");
    const id = uniqueId(label, items);
    setItems([
      ...items,
      { id, names: { [locale]: label }, label, kind: newKind, color: info?.color ?? "#9aa0ad", folder: id, locked: false, can_belong: info?.can_belong ?? false, has_color: false, template: "{text}" },
    ]);
  };

  const save = async () => {
    try {
      await api.saveCategories(items, purge);
      await useStore.getState().refreshPresets();
      await useStore.getState().refreshLibraries();
      setMessage(t("categories.saved"));
      onClose();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <div className="modal" {...backdropClose(onClose)}>
      <div className="modal-body wide" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2>{t("categories.title", { library: libraryName(libraries, library) })}</h2>
        <p className="muted">{t("categories.intro")}</p>
        <div className="cat-list">
          {items.map((c, i) => (
            <div key={c.id} className="row cat-row">
              <input type="color" value={c.color} onChange={(e) => patch(i, { color: e.target.value })}               title={t("categories.color")} />
                            <input type="text" value={c.names[locale] ?? ""} placeholder={pickName(c.names, locale) ?? c.id} onChange={(e) => patch(i, { names: { ...c.names, [locale]: e.target.value }, label: e.target.value || (pickName(c.names, locale) ?? c.id) })} title={t("categories.idTitle", { id: c.id })} />
                            <button className="icon-btn" disabled={Object.keys(c.names).filter((l) => l !== locale && c.names[l]).length === 0 || !c.names[locale]} title={t("categories.removeName", { locale })} onClick={() => { const { [locale]: _gone, ...rest } = c.names; patch(i, { names: rest }); }}>⌫</button>
                            <span className="muted kind-name" title={kindHelp(c.kind)}>
                {c.kind}
              </span>
                            <label title={t("categories.belongsTip")}>
                              <input type="checkbox" checked={c.can_belong} onChange={(e) => patch(i, { can_belong: e.target.checked })} /> {t("categories.belongsTo")}
              </label>
                            <label title={t("categories.hasColorTip")}>
                              <input type="checkbox" checked={c.has_color} onChange={(e) => patch(i, { has_color: e.target.checked })} /> {t("categories.hasColor")}
              </label>
                            <label title={t("categories.lockedTip")}>
                              <input type="checkbox" checked={c.locked} onChange={(e) => patch(i, { locked: e.target.checked })} /> {t("categories.locked")}
              </label>
              <button disabled={i === 0} onClick={() => move(i, -1)}>
                ▲
              </button>
              <button disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                ▼
              </button>
              <button className="danger" disabled={c.locked} title={c.locked ? t("categories.unlockToDelete") : t("categories.deleteTip")} onClick={() => void remove(i)}>
                🗑
              </button>
            </div>
          ))}
        </div>
        <div className="row">
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as CategoryKind)} title={kindHelp(newKind)}>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.id}
              </option>
            ))}
          </select>
          <button onClick={add}>{t("categories.add")}</button>
          <span style={{ flex: 1 }} />
          {message && <span className="muted">{message}</span>}
          <button className="primary" onClick={() => void save()}>
            {t("categories.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
