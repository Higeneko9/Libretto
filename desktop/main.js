const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const isWin = process.platform === "win32";
const repoRoot = path.resolve(__dirname, "..");
let backend = null;
let backendLog = "";
let quitting = false;
let mainWindow = null;

function backendCommand() {
  const args = [];
  if (app.isPackaged) {
    args.push("--data-dir", app.getPath("userData"));
    return { cmd: path.join(process.resourcesPath, "backend", isWin ? "libretto-server.exe" : "libretto-server"), args, cwd: process.resourcesPath };
  }
  // development: run the Python sources from the repo (data stays in the repo's ugc folder unless LB_DESKTOP_DATA is set)
  if (process.env.LB_DESKTOP_DATA) args.push("--data-dir", process.env.LB_DESKTOP_DATA);
  const venv = path.join(repoRoot, "backend", ".venv", isWin ? "Scripts/python.exe" : "bin/python");
  const python = fs.existsSync(venv) ? venv : isWin ? "python" : "python3";
  return { cmd: python, args: ["-m", "libretto.server", ...args], cwd: path.join(repoRoot, "backend") };
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd } = backendCommand();
    backend = spawn(cmd, args, { cwd, windowsHide: true });
    const timer = setTimeout(() => reject(new Error("The Libretto server did not start in time.")), 60000);
    let buffer = "";
    backend.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/LIBRETTO_URL=(\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    backend.stderr.on("data", (chunk) => {
      backendLog = (backendLog + chunk).slice(-4000);
    });
    backend.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    backend.on("exit", (code) => {
      clearTimeout(timer);
      backend = null;
      if (!quitting) reject(new Error(`The Libretto server stopped (exit code ${code}).`));
    });
  });
}

function stopBackend() {
  quitting = true;
  if (backend) backend.kill();
}

// Ctrl + wheel and Ctrl + / - / 0 zoom the whole UI like a browser; the level is remembered between runs
const zoomFile = () => path.join(app.getPath("userData"), "zoom.json");
const MIN_ZOOM = -3;
const MAX_ZOOM = 5;

function setupZoom(win) {
  const contents = win.webContents;
  const apply = (level) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level));
    contents.setZoomLevel(clamped);
    try {
      fs.writeFileSync(zoomFile(), JSON.stringify({ level: clamped }));
    } catch {
      /* not being able to remember the zoom is harmless */
    }
  };
  contents.on("did-finish-load", () => {
    try {
      contents.setZoomLevel(Number(JSON.parse(fs.readFileSync(zoomFile(), "utf8")).level) || 0);
    } catch {
      /* no saved zoom yet */
    }
  });
  contents.on("zoom-changed", (_event, direction) => apply(contents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5)));
  contents.on("before-input-event", (_event, input) => {
    const zoomKey = input.type === "keyDown" && (input.control || input.meta) && !input.alt && ["=", "+", "-", "0"].includes(input.key);
    // Keep renderer key events intact so the canvas can release its selection modifiers.
    contents.setIgnoreMenuShortcuts(zoomKey);
    if (!zoomKey) return;
    if (input.key === "=" || input.key === "+") apply(contents.getZoomLevel() + 0.5);
    else if (input.key === "-") apply(contents.getZoomLevel() - 0.5);
    else if (input.key === "0") apply(0);
  });
}

const windowFile = () => path.join(app.getPath("userData"), "window.json");

function savedWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowFile(), "utf8"));
    const { screen } = require("electron");
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width && s.x + s.width > a.x && s.y < a.y + a.height && s.y + s.height > a.y;
    });
    if (s.width >= 600 && s.height >= 400) return { width: s.width, height: s.height, ...(visible ? { x: s.x, y: s.y } : {}), maximized: !!s.maximized };
  } catch {
    /* no saved window state yet */
  }
  return null;
}

function trackWindowState(win, initial) {
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    try {
      fs.writeFileSync(windowFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch {
      /* not being able to remember the window is harmless */
    }
  };
  let timer;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on("resize", later);
  win.on("move", later);
  win.on("maximize", later);
  win.on("unmaximize", later);
  win.on("close", save);
  if (initial && initial.maximized) win.maximize();
}

function createWindow(url) {
  const initial = savedWindowState();
  mainWindow = new BrowserWindow({
    width: initial ? initial.width : 1500,
    height: initial ? initial.height : 950,
    ...(initial && initial.x !== undefined ? { x: initial.x, y: initial.y } : {}),
    backgroundColor: "#16181d",
    title: "Libretto",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  trackWindowState(mainWindow, initial);
  const local = new URL(url).origin;
  // links to other sites open in the normal browser, never inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== local) {
      event.preventDefault();
      if (/^https?:/.test(target)) void shell.openExternal(target);
    }
  });
  setupZoom(mainWindow);
  mainWindow.on("closed", () => (mainWindow = null));
  void mainWindow.loadURL(url, { extraHeaders: "Cache-Control: no-cache\n" });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      createWindow(await startBackend());
    } catch (err) {
      dialog.showErrorBox("Libretto could not start", `${err.message}\n\n${backendLog}`);
      stopBackend();
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", stopBackend);
}
