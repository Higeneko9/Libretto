import { useEffect, useState } from "react";
import { api } from "./api";
import { askConfirm, askNames, askText } from "./ask";
import { backdropClose } from "./backdropClose";
import { useT } from "./i18n/useT";
import { useStore } from "./store";
import { translatedName, withName } from "./tags";
import { type Category, type CategoryConfig, type Preset } from "./types";

function CopyPanel() {
  const t = useT();
  const libraries = useStore((s) => s.libraries);
  const library = useStore((s) => s.library);
  const locale = useStore((s) => s.ui.locale);
  const { refreshLibraries, refreshPresets, bumpThumbs } = useStore.getState();
  const [source, setSource] = useState(libraries.find((l) => l.id !== library)?.id ?? "");
  const [target, setTarget] = useState(library);
  const [category, setCategory] = useState<Category>("character");
  const [categories, setCategories] = useState<CategoryConfig[]>([]);
  const [items, setItems] = useState<Preset[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!source) return setCategories([]);
    void api.categories(source).then((list) => {
      setCategories(list);
      setCategory((c) => (list.some((x) => x.id === c) ? c : (list[0]?.id ?? c)));
    });
  }, [source]);

  useEffect(() => {
    setPicked(new Set());
    if (source) void api.presets(category, source).then(setItems).catch(() => setItems([]));
    else setItems([]);
  }, [source, category]);

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    setPicked(next);
  };

  const copy = async () => {
    try {
      const done = await api.copyItems(target, source, [...picked].map((id) => ({ category, id })));
      setMessage(t("libraries.copied", { n: done.length }));
      setPicked(new Set());
      await refreshLibraries();
      if (target === library) {
        await refreshPresets(category);
        bumpThumbs();
      }
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <details>
      <summary>{t("libraries.copyNodes")}</summary>
      <div className="row">
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {libraries.map((l) => (
            <option key={l.id} value={l.id}>
              {t("libraries.from", { name: (translatedName(l.name, l.names, locale) ?? l.name) })}
            </option>
          ))}
        </select>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {libraries.map((l) => (
            <option key={l.id} value={l.id}>
              {t("libraries.to", { name: (translatedName(l.name, l.names, locale) ?? l.name) })}
            </option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="checks tall">
        {items.map((p) => (
          <label key={p.id}>
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} /> {p.name}
          </label>
        ))}
      </div>
      <div className="row">
        <button onClick={() => setPicked(new Set(items.map((p) => p.id)))}        >{t("libraries.selectAll")}</button>
        <button disabled={!picked.size || !source || source === target} onClick={() => void copy()}>
                  {t("libraries.copy", { n: picked.size || "" })}
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
    </details>
  );
}

export function LibrariesDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const libraries = useStore((s) => s.libraries);
  const library = useStore((s) => s.library);
  const locale = useStore((s) => s.ui.locale);
  const { refreshLibraries, setLibrary } = useStore.getState();
  const [name, setName] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [error, setError] = useState("");

  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      await refreshLibraries();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal" {...backdropClose(onClose)}>
      <div className="modal-body wide" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2>{t("libraries.title")}</h2>
        <div className="wf-list">
          {libraries.map((l) => (
            <div key={l.id} className="wf-row">
              <span className="clip wide-clip">
                {(translatedName(l.name, l.names, locale) ?? l.name)} {l.id === library &&                 <span className="muted">{t("libraries.active")}</span>}{" "}
                                <span className="muted">{t("libraries.items", { n: Object.values(l.counts).reduce((a, b) => a + b, 0) })}</span>
              </span>
              <button
                onClick={async () => {
                  const r = await askNames(t("libraries.renameTitle"), l.name, translatedName(l.name, l.names, locale) ?? "", locale);
                  if (r && r.name.trim()) void run(() => api.renameLibrary(l.id, r.name.trim(), withName(l.names, locale, r.display)));
                }}
              >
                {t("libraries.rename")}
              </button>
              <button disabled={l.id === library} onClick={() => void setLibrary(l.id)}>
                {t("libraries.use")}
              </button>
              <a className="button" href={api.exportLibraryUrl(l.id)} download>
                {t("libraries.exportZip")}
              </a>
              <button
                className="danger"
                disabled={l.id === "default"}
                onClick={async () => {
                  if (!(await askConfirm(t("libraries.deleteConfirm", { name: l.name }), t("libraries.delete")))) return;
                  void run(async () => {
                    if (l.id === library) await setLibrary("default");
                    await api.deleteLibrary(l.id);
                  });
                }}
              >
                {t("libraries.delete")}
              </button>
            </div>
          ))}
        </div>
        <h3>{t("libraries.createImport")}</h3>
        <div className="row">
          <input placeholder={t("libraries.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">{t("libraries.empty")}</option>
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {t("libraries.copyOf", { name: (translatedName(l.name, l.names, locale) ?? l.name) })}
              </option>
            ))}
          </select>
          <button
            disabled={!name.trim()}
            onClick={() =>
              void run(async () => {
                const created = await api.createLibrary(name.trim(), copyFrom);
                setName("");
                await refreshLibraries();
                await setLibrary(created.id);
              })
            }
          >
            {t("libraries.create")}
          </button>
        </div>
        <div className="row">
          <label className="button">
            {t("libraries.importZip")}
            <input
              type="file"
              accept=".zip"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file)
                  void run(async () => {
                    const created = await api.importLibrary(file, name.trim() || file.name.replace(/\.zip$/i, ""));
                    await refreshLibraries();
                    await setLibrary(created.id);
                  });
              }}
            />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <CopyPanel />
      </div>
    </div>
  );
}
