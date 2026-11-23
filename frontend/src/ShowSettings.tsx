import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import { backdropClose } from "./backdropClose";
import { useT } from "./i18n/useT";
import { translatedName } from "./tags";
import { useStore } from "./store";
import { SHOW_OUTPUT_LAYOUTS, type Show, type ShowOutputLayout, type ShowOutputPreview } from "./types";

type Preview =
  | { status: "loading" }
  | { status: "ready"; examples: ShowOutputPreview["examples"] }
  | { status: "error"; message: string };

export function ShowSettings({ show, onClose }: { show: Show; onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  const busy = useStore((s) => s.organizationBusy);
  const locale = useStore((s) => s.ui.locale);
  const [layout, setLayout] = useState<ShowOutputLayout>(show.output_layout ?? "workflow");
  const [sceneId, setSceneId] = useState(useStore.getState().activeId);
  const [preview, setPreview] = useState<Preview>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (layout === "workflow") {
      setPreview({ status: "ready", examples: [] });
      return;
    }
    let current = true;
    setPreview({ status: "loading" });
    api.showOutputPreview(show.id, layout).then(
      (result) => { if (current) setPreview({ status: "ready", examples: result.examples }); },
      (reason) => { if (current) setPreview({ status: "error", message: reason instanceof Error ? reason.message : String(reason) }); },
    );
    return () => { current = false; };
  }, [show.id, layout]);

  const example = preview.status === "ready"
    ? preview.examples.find((item) => item.scene_id === sceneId) ?? preview.examples[0]
    : undefined;
  const close = () => { if (!savingRef.current && !busy) onClose(); };
  return <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}
    {...backdropClose(close)}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }}>
    <form className="modal-body explorer-transfer" onSubmit={async (event) => {
      event.preventDefault();
      if (savingRef.current || busy || preview.status !== "ready") return;
      if (layout === (show.output_layout ?? "workflow")) { onClose(); return; }
      savingRef.current = true;
      setSaving(true);
      setError("");
      try {
        await useStore.getState().organize(() => api.saveShowSettings(show.id, layout));
        onClose();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    }}>
      <h2 id={titleId}>{t("showExplorer.settingsTitle", { name: translatedName(show.name, show.names, locale) ?? show.name })}</h2>
      <label className="field">
        <span>{t("showExplorer.outputLayout")}</span>
        <select autoFocus value={layout} disabled={saving || busy} onChange={(event) => {
          const value = SHOW_OUTPUT_LAYOUTS.find((item) => item === event.currentTarget.value);
          if (value) { setLayout(value); setError(""); }
        }}>
          {SHOW_OUTPUT_LAYOUTS.map((value) => <option key={value} value={value}>{t(`showExplorer.layout_${value}`)}</option>)}
        </select>
      </label>
      {preview.status === "loading" && <p role="status">{t("showExplorer.previewLoading")}</p>}
      {preview.status === "error" && <p className="error" role="alert">{preview.message}</p>}
      {preview.status === "ready" && (layout === "workflow"
        ? <p className="muted">{t("showExplorer.workflowOutput")}</p>
        : example ? <>
          {preview.examples.length > 1 && <label className="field">
            <span>{t("showExplorer.previewScene")}</span>
            <select value={example.scene_id} disabled={saving || busy} onChange={(event) => setSceneId(event.currentTarget.value)}>
              {preview.examples.map((item) => <option key={item.scene_id} value={item.scene_id}>{item.name}</option>)}
            </select>
          </label>}
          <div className="field">
            <span>{t("showExplorer.previewPrefix")}</span>
            <code className="show-output-prefix">{example.prefix}</code>
          </div>
        </> : <p className="muted">{t("showExplorer.emptyPreview")}</p>)}
      <p className="muted">{t("showExplorer.outputRules")}</p>
      {layout !== "workflow" && <p className="muted">{t("showExplorer.outputNumbering")}</p>}
      <p className="muted">{t("showExplorer.futureOutputs")}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions row">
        <button type="button" disabled={saving || busy} onClick={close}>{t("showExplorer.cancel")}</button>
        <button type="submit" className="primary" disabled={saving || busy || preview.status !== "ready"}>
          {t(saving ? "showExplorer.saving" : "showExplorer.save")}
        </button>
      </div>
    </form>
  </div>;
}
