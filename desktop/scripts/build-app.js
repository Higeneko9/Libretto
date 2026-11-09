// Builds everything the installer needs: the frontend, the PyInstaller server bundle, and copies it to build/backend.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktop = path.resolve(__dirname, "..");
const root = path.resolve(desktop, "..");
const isWin = process.platform === "win32";

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(" ")}  (${path.relative(root, cwd) || "."})`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: isWin && cmd === "npm" });
  if (result.status !== 0) process.exit(result.status || 1);
}

const frontend = path.join(root, "frontend");
if (!fs.existsSync(path.join(frontend, "node_modules"))) run("npm", ["ci"], frontend);
run("npm", ["run", "build"], frontend);

const backend = path.join(root, "backend");
const venvPython = path.join(backend, ".venv", isWin ? "Scripts/python.exe" : "bin/python");
const python = process.env.PYTHON || (fs.existsSync(venvPython) ? venvPython : isWin ? "python" : "python3");
run(python, ["build_backend.py"], backend);

const target = path.join(desktop, "build", "backend");
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
const bundle = path.join(backend, "dist", "libretto-server");
if (isWin) {
  fs.cpSync(bundle, target, { recursive: true });
} else {
  // cpSync rewrites relative symlinks (e.g. macOS _internal/Python) to absolute build paths, which breaks the bundle
  run("cp", ["-R", bundle, target], root);
}
console.log("Backend bundle ready:", target);
