import { useEffect, useState } from "react";
import { api } from "./api";
import { backdropClose } from "./backdropClose";
import { LANGUAGES } from "./i18n";
import { useT } from "./i18n/useT";
import { useStore } from "./store";

/** Split a stored address like `http://host:8188` into host (with scheme if https) and port. */
function split(url: string) {
  try {
    const u = new URL(url);
    return { host: u.protocol === "https:" ? `https://${u.hostname}` : u.hostname, port: u.port };
  } catch {
    return { host: url, port: "" };
  }
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const locale = useStore((s) => s.ui.locale);
  const setUi = useStore((s) => s.setUi);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [serverPort, setServerPort] = useState("8000");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const desktop = navigator.userAgent.includes("Electron");

  useEffect(() => {
    void api.settings().then((s) => {
      const parts = split(s.comfy_url);
      setHost(parts.host);
      setPort(parts.port);
      setServerPort(String(s.port));
    });
  }, []);

  const address = () => (port ? `${host}:${port}` : host);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      setMessage(await action());
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = () =>
    run(async () => {
      const r = await api.testComfy(address());
      return r.ok ? t("settings.connected", { version: r.version ?? "", url: r.url ?? "" }) : t("settings.unreachable", { error: r.error ?? "" });
    });

  const save = () =>
    run(async () => {
      const saved = await api.saveSettings({ comfy_url: address(), ...(desktop ? {} : { port: Number(serverPort) }) });
      const parts = split(saved.comfy_url);
      setHost(parts.host);
      setPort(parts.port);
      return t(desktop ? "settings.savedDesktop" : "settings.savedServer");
    });

  return (
    <div className="modal" {...backdropClose(onClose)}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2>{t("settings.title")}</h2>
        <h3>{t("settings.comfyui")}</h3>
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            <span>{t("settings.address")}</span>
            <input type="text" value={host} placeholder="127.0.0.1" onChange={(e) => setHost(e.target.value)} />
          </label>
          <label className="field" style={{ width: 90 }}>
            <span>{t("settings.port")}</span>
            <input type="text" inputMode="numeric" value={port} placeholder="8188" onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>
        <p className="muted">{t("settings.comfyHint")}</p>
        <div className="row">
          <button disabled={busy} onClick={() => { setHost("127.0.0.1"); setPort("8188"); }}           title={t("settings.useLocalTitle")}>
                      {t("settings.useLocal")}
          </button>
          <button disabled={busy || !host} onClick={() => void test()}>
            {t("settings.test")}
          </button>
        </div>
        {message && <p className="muted">{message}</p>}
        {!desktop && (
          <>
            <h3>{t("settings.libretto")}</h3>
            <label className="field">
              <span>{t("settings.preferredPort")}</span>
              <input type="text" inputMode="numeric" value={serverPort} onChange={(e) => setServerPort(e.target.value.replace(/\D/g, ""))} />
            </label>
          </>
        )}
        <label className="field">
          <span>{t("settings.language")}</span>
          <select value={locale} onChange={(e) => setUi({ locale: e.target.value })}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">{t("settings.languageHint")}</p>
        <div className="row">
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>{t("settings.close")}</button>
          <button className="primary" disabled={busy || !host} onClick={() => void save()}>
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
