import { useRef, useState } from "react";
import { api } from "./api";
import { askConfirm, askNames, askText } from "./ask";
import { useT } from "./i18n/useT";
import { useStore } from "./store";
import { presetTitle, translatedName, withName } from "./tags";

type Menu = { x: number; y: number; sceneId?: string; plus?: boolean };

export function SceneTabs() {
  const t = useT();
  const scenes = useStore((s) => s.scenes);
  const openScenes = useStore((s) => s.ui.openScenes);
  const activeId = useStore((s) => s.activeId);
  const locale = useStore((s) => s.ui.locale);
  const { openScene, closeScene, newScene, renameScene, deleteScene } = useStore.getState();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const tabs = openScenes.map((id) => scenes.find((s) => s.id === id)).filter((s) => !!s);
  const closed = scenes.filter((s) => !openScenes.includes(s.id));
  const target = scenes.find((s) => s.id === menu?.sceneId);

  const rename = async (s: { id: string; name: string; names?: Record<string, string> }) => {
    const r = await askNames(t("sceneTabs.rename"), s.name, translatedName(s.name, s.names, locale) ?? "", locale);
    if (!r || !r.name.trim()) return;
    await renameScene(s.id, r.name.trim(), withName(s.names, locale, r.display));
  };

  const duplicate = async (id: string, name: string) => {
    const copyName = (await askText(t("sceneTabs.copyNamePrompt", { name }), t("sceneTabs.copySuffix", { name })))?.trim();
    if (!copyName) return;
    const scene = await api.scene(id);
    await newScene(copyName, scene.graph);
  };

  const create = async () => {
    const name = (await askText(t("sceneTabs.newScenePrompt"), t("sceneTabs.defaultSceneName", { n: scenes.length + 1 })))?.trim();
    if (name) await newScene(name);
  };

  const exportScene = async (id: string, name: string) => {
    const scene = await api.scene(id);
    const url = URL.createObjectURL(new Blob([JSON.stringify(scene.graph, null, 2)], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: `${name}.libretto-scene.json` }).click();
    URL.revokeObjectURL(url);
  };

  const importScene = async (file?: File) => {
    if (!file) return;
    try {
      await newScene(file.name.replace(/\.(libretto-scene\.)?json$/, ""), JSON.parse(await file.text()));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const show = (e: React.MouseEvent, extra: Partial<Menu> = {}) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, ...extra });
  };

  const run = (fn: () => unknown) => () => void Promise.resolve(fn()).catch((e: Error) => setError(e.message));

  return (
    <div className="scene-tabs" onContextMenu={(e) => show(e, { plus: true })}>
      {tabs.map((s) => (
        <div
          key={s.id}
          className={`scene-tab ${s.id === activeId ? "active" : ""}`}
          onClick={() => void openScene(s.id)}
          onContextMenu={(e) => show(e, { sceneId: s.id })}
        >
          <span onDoubleClick={(e) => (void rename(s), e.stopPropagation())} title={`${presetTitle(s.name, s.names, locale)}\n${t("sceneTabs.renameTitle")}`}>
            {translatedName(s.name, s.names, locale) ?? s.name}
          </span>
          <button
            className="tab-close"
            title={t("sceneTabs.closeTab")}
            onClick={(e) => {
              e.stopPropagation();
              void closeScene(s.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button onClick={(e) => show(e, { plus: true })} title={t("sceneTabs.plusTitle")}>
        +
      </button>
      <input ref={fileInput} type="file" accept=".json" hidden onChange={(e) => (void importScene(e.target.files?.[0]), (e.target.value = ""))} />
      {error && <span className="error">{error}</span>}
      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
          <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 260) }} onClick={() => setMenu(null)}>
            {target && (
              <>
                <button onClick={run(() => rename(target))}>{t("sceneTabs.rename")}</button>
                <button onClick={run(() => duplicate(target.id, target.name))}>{t("sceneTabs.duplicate")}</button>
                <button onClick={run(() => exportScene(target.id, target.name))}>{t("sceneTabs.exportJson")}</button>
                <hr />
                <button onClick={() => void closeScene(target.id)}>{t("sceneTabs.closeTab")}</button>
                <button onClick={run(async () => (await askConfirm(t("sceneTabs.deleteConfirm", { name: target.name }), t("sceneTabs.deleteOk"))) && deleteScene(target.id))}>{t("sceneTabs.delete")}</button>
                <hr />
              </>
            )}
            <button onClick={run(create)}>{t("sceneTabs.newScene")}</button>
            <button onClick={() => fileInput.current?.click()}>{t("sceneTabs.importJson")}</button>
            {closed.length > 0 && (
              <>
                <hr />
                <div className="muted" style={{ padding: "2px 10px" }}>
                  {t("sceneTabs.closedScenes")}
                </div>
                {closed.map((s) => (
                  <button key={s.id} onClick={() => void openScene(s.id)} title={t("sceneTabs.reopen")}>
                  {translatedName(s.name, s.names, locale) ?? s.name}
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
