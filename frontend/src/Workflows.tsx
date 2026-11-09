import { useEffect, useState } from "react";
import { api } from "./api";
import { backdropClose } from "./backdropClose";
import { useT } from "./i18n/useT";
import { useStore } from "./store";
import type { WorkflowFile } from "./types";

export function WorkflowDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [files, setFiles] = useState<WorkflowFile[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [keepPositive, setKeepPositive] = useState(false);
  const [keepNegative, setKeepNegative] = useState(true);
  const [message, setMessage] = useState("");
  const nodes = useStore((s) => s.nodes);
  const { updateNode, refreshProfiles } = useStore.getState();

  const load = () =>
    api
      .comfyWorkflows()
      .then(setFiles)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const useProfile = async (profileId: string) => {
    const generate = nodes.find((n) => n.type === "generate");
    if (generate) updateNode(generate.id, { profile: profileId, checkpoint: "", width: undefined, height: undefined, steps: undefined, cfg: undefined, sampler: "", scheduler: "" });
    onClose();
  };

  const importFile = async (file: WorkflowFile, use: boolean) => {
    setBusy(file.path);
    setError("");
    setMessage("");
    try {
      const result = await api.importWorkflow(file.path, undefined, keepPositive, keepNegative);
      await refreshProfiles();
      await load();
      if (use) await useProfile(result.profile.id);
      else setMessage(t("workflows.imported", { name: result.profile.name, format: result.profile.format }) + (result.warnings.length ? t("workflows.warnings", { list: result.warnings.join("; ") }) : ""));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const visible = files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="modal" {...backdropClose(onClose)}>
      <div className="modal-body wide" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2>{t("workflows.title")}</h2>
        <p className="muted">
          {t("workflows.intro")}
        </p>
        <div className="row">
          <input placeholder={t("workflows.search")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={keepNegative} onChange={(e) => setKeepNegative(e.target.checked)} /> {t("workflows.keepNegative")}
          </label>
          <label className="check" title={t("workflows.keepPositiveTitle")}>
            <input type="checkbox" checked={keepPositive} onChange={(e) => setKeepPositive(e.target.checked)} /> {t("workflows.keepPositive")}
          </label>
        </div>
        {error && <pre className="error">{error}</pre>}
        {message && <p className="muted">{message}</p>}
        <div className="wf-list">
          {visible.map((f) => (
            <div key={f.path} className="wf-row">
              <span className="clip wide-clip" title={f.path}>
                {f.path.replace(/\.json$/, "")}
              </span>
              {f.profile_id && <span className="pill ok">{t("workflows.importedBadge")}</span>}
              {f.profile_id && <button onClick={() => useProfile(f.profile_id!)}>{t("workflows.use")}</button>}
              <button disabled={busy === f.path} onClick={() => importFile(f, !f.profile_id)}>
                {busy === f.path ? "…" : f.profile_id ? t("workflows.reimport") : t("workflows.importUse")}
              </button>
            </div>
          ))}
          {visible.length === 0 && !error && <p className="muted">{t("workflows.none")}</p>}
        </div>
      </div>
    </div>
  );
}
