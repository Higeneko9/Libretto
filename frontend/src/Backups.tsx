import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { askConfirm } from "./ask";
import { backdropClose } from "./backdropClose";
import { t as tr } from "./i18n";
import { useT } from "./i18n/useT";
import { flushSave } from "./store";
import type { BackupInfo } from "./types";

const formatSize = (bytes: number) =>
  bytes >= 1048576 ? tr("backups.sizeMb", { n: (bytes / 1048576).toFixed(1) }) : tr("backups.sizeKb", { n: Math.max(1, Math.round(bytes / 1024)) });

function describe(b: BackupInfo): string {
  const parts = [tr("backups.libraryFiles", { n: b.counts.libraries }), tr("backups.scenes", { n: b.counts.scenes }), tr("backups.profileFiles", { n: b.counts.profiles })];
  if (b.includes_history) parts.push(tr("backups.runs", { n: b.counts.runs }));
  return parts.join(" · ");
}

export function BackupDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [items, setItems] = useState<BackupInfo[]>([]);
  const [note, setNote] = useState("");
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => setItems(await api.backups()), []);
  useEffect(() => {
    void load().catch((e) => setMessage((e as Error).message));
  }, [load]);

  const run = async (task: () => Promise<string | void>) => {
    setBusy(true);
    setMessage("");
    try {
      const done = await task();
      if (done) setMessage(done);
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      await flushSave();
      const made = await api.createBackup(note, history);
      setNote("");
      return t("backups.created", { id: made.id, size: formatSize(made.size) });
    });

  const restore = async (b: BackupInfo, mode: "merge" | "replace") => {
    const what =
      mode === "merge"
        ? t("backups.mergeNote")
        : t("backups.replaceNote");
    const runs = b.includes_history ? t("backups.historyNote") : "";
    if (!(await askConfirm(t("backups.restoreConfirm", { id: b.id, what, runs }), t("backups.restoreOk")))) return;
    void run(async () => {
      await flushSave();
      await api.restoreBackup(b.id, mode, true);
      window.location.reload();
    });
  };

  const remove = async (b: BackupInfo) => {
    if (await askConfirm(t("backups.deleteConfirm", { id: b.id }), t("backups.deleteOk"))) void run(() => api.deleteBackup(b.id).then(() => undefined));
  };

  const importZip = (file?: File) => file && void run(async () => t("backups.imported", { id: (await api.importBackup(file)).id }));

  return (
    <div className="modal" {...backdropClose(onClose)}>
      <div className="modal-body wide" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2>{t("backups.title")}</h2>
        <p className="muted">
          {t("backups.intro1")}
          <code>backups</code>
          {t("backups.intro2")}
          <code> ugc</code>
          {t("backups.intro3")}
        </p>
        <div className="backup-form">
          <input type="text" placeholder={t("backups.notePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} />
          <label>
            <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> {t("backups.includeHistory")}
          </label>
          <button className="primary" disabled={busy} onClick={() => void create()}>
            {t("backups.create")}
          </button>
          <label className="button">
            {t("backups.importZip")}
            <input type="file" accept=".zip" hidden onChange={(e) => importZip(e.target.files?.[0])} />
          </label>
        </div>
        {message && <p className="muted">{message}</p>}
        <div className="wf-list">
          {items.length === 0 && <p className="muted">{t("backups.none")}</p>}
          {items.map((b) => (
            <div key={b.id} className="backup-row">
              <div className="info">
                <div>
                  <strong>{new Date(b.created_at).toLocaleString()}</strong> <span className={`kind ${b.kind}`}>{b.kind}</span>{" "}
                  <span className="muted">{formatSize(b.size)}</span>
                </div>
                <div className="muted clip">{[b.note, describe(b)].filter(Boolean).join(" — ")}</div>
              </div>
              <button disabled={busy} onClick={() => restore(b, "merge")} title={t("backups.restoreTitle")}>
                {t("backups.restore")}
              </button>
              <button disabled={busy} onClick={() => restore(b, "replace")} title={t("backups.replaceTitle")}>
                {t("backups.replaceAll")}
              </button>
              <a className="button" href={api.backupDownloadUrl(b.id)} title={t("backups.downloadTitle")}>
                ⬇
              </a>
              <button className="danger" disabled={busy} onClick={() => remove(b)} title={t("backups.deleteTitle")}>
                🗑
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
