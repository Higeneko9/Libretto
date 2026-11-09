# Libretto

Node-based prompt builder and generation front end for a local ComfyUI server.
## Features (v1)

- React Flow canvas with a drag-and-drop library palette; every node is editable and can be saved back as a preset.
- Model profiles (`profiles/*.yaml`; your imported/edited ones in `ugc/profiles/`): SDXL and Pony (tag prompts), Flux (natural language). Each maps to a ComfyUI API-format workflow template.
- **Collection** nodes pick a random item from a category (random/weighted, shuffle, sequential, fixed, label filters, exclude-last-N). With several library cards selected, dragging one of them drops all of them, and dragging a **Random** card makes a collection of just the selected cards of that category.
- Reproducible snapshots: every run stores `ugc/data/snapshots/<id>/snapshot.json` (seed, pick-seed, params, graph, prompts, workflow, model hashes, ComfyUI environment). "Regenerate exactly" re-queues the saved workflow; "Restore graph" and "Make variation" reload it into the canvas.
- Thumbnails (256px WebP) next to each preset, uploaded or set from any generated image; per-profile variants with fallback.
- Live prompt preview, batch generation, history gallery.
- **Scene history**: each Generate saves the scene's graph as a numbered version (skipped when an identical graph is already stored, which is found by hash) with a thumbnail of the generated image. Versions are listed in the Inspector; click one to load it into the scene (undoable), 📌 keeps it from being removed, and the list is capped (per-scene **Max**, default `LB_SCENE_SNAP_MAX`=30) with least-recently-used eviction. Hover a version and press ✎ to give it a name. Thumbnail size has its own slider (or Shift + mouse wheel). Stored in `ugc/data/scene_snaps/<scene>/`.
- **Zoom and thumbnail size**: in the desktop app, Ctrl + mouse wheel (or Ctrl + `+` / `-` / `0`) zooms the whole UI like a browser, and the zoom is remembered. Shift + mouse wheel over the library, the results or the scene history resizes their thumbnails.

## Using your ComfyUI workflows

Click **ComfyUI workflows…** in the header to list workflows saved on the ComfyUI server (`user/default/workflows`).
**Import & use** converts a workflow (UI format) into API format via the server's `/object_info`, detects the
KSampler, positive/negative `CLIPTextEncode`, empty latent and model loader, and registers it as a model profile
(selectable on the Generate node). Libretto injects the compiled prompt, seed, size, sampler settings and checkpoint;
everything else stays as in your workflow. LoRAs from presets are added automatically. Re-import after editing a workflow.
Subgraph-based workflows (e.g. MOSS-Image, Qwen-Image) are flattened automatically. Limits: KSampler-based text-to-image workflows only (no upscaler-only or 3D workflows). If a prompt passes through a prompt-enhancer switch, check its toggle in ComfyUI.

## Install a packaged build

Builds come from the **Build installers** GitHub Actions workflow (run it manually, or push a `v*` tag), which uploads one artifact per package. With the GitHub CLI: `gh run download --repo Higeneko9/Libretto -n <artifact>`. Artifacts expire after 3 days.

Whichever you use, set your ComfyUI address in **⚙ Settings** (it opens by itself on the first run; *Use local* fills `127.0.0.1:8188`, then press *Test connection* and *Save*). Desktop ComfyUI works too; it exposes the same HTTP API, so enter its address and port.

User data (libraries, scenes, history, backups, settings) lives in a per-user folder and is kept when you upgrade. The Windows uninstaller asks whether to delete it too:

| OS | Data folder |
|----|-------------|
| Windows | `%APPDATA%\Libretto` |
| macOS | `~/Library/Application Support/Libretto` |
| Linux | `~/.config/Libretto` (desktop app) or `~/.local/share/Libretto` (server) |

### Desktop app

| OS | Artifact | Install and run |
|----|----------|-----------------|
| Windows | `libretto-desktop-windows` (`.exe`) | Run the installer, then start **Libretto** from the Start menu. SmartScreen may warn because the app is unsigned: *More info → Run anyway*. |
| macOS | `libretto-desktop-macos` (`.dmg`) | Open the `.dmg` and drag **Libretto** to Applications. The app is signed with a Developer ID certificate and notarized by Apple, so it opens normally. macOS may ask for **Local Network** access: allow it when prompted (or enable it under System Settings → Privacy & Security → Local Network) to reach a ComfyUI server on another machine. |
| Debian / Ubuntu | `libretto-desktop-linux-deb` (`.deb`) | `sudo apt install ./Libretto-*.deb`, then start **Libretto** from the app menu or run `libretto-desktop`. Remove with `sudo apt remove libretto-desktop`. |
| Other Linux | `libretto-desktop-linux-appimage` (`.AppImage`) | `chmod +x Libretto-*.AppImage && ./Libretto-*.AppImage`. Needs `libfuse2` on newer Ubuntu releases. |

### Server package (use from any browser)

The same backend and UI without Electron. It prints `LIBRETTO_URL=...` and serves the UI there.

| OS | Artifact | Run |
|----|----------|-----|
| Windows | `libretto-server-windows` | Run `libretto-server.exe --open` from the extracted folder. |
| macOS | `libretto-server-macos-latest` | `tar -xzf libretto-server-macOS.tar.gz && ./backend/libretto-server --open` |
| Linux | `libretto-server-ubuntu-latest` | `tar -xzf libretto-server-Linux.tar.gz && ./backend/libretto-server --open` |

Options: `--port N` (default: the saved port, else 8000, else a free one), `--host 0.0.0.0` (default `127.0.0.1`), `--comfy-url URL`, `--data-dir DIR`, `--open` (open the browser).

To use it from other machines, start it with `--host 0.0.0.0 --port 8000`, allow the port in the firewall (`sudo ufw allow 8000/tcp`), and browse to `http://<server>:8000`. There is no authentication, so only do this on a trusted network, or use an SSH tunnel (`ssh -L 8000:127.0.0.1:8000 user@server`) or a VPN.

### Building the packages yourself

```
cd desktop
npm ci
npm run dist        # builds the frontend and the backend bundle, then the installer for this OS
npm run pack        # unpacked app only, faster for testing
```

Needs Node, Python with `requirements.txt` and `pyinstaller`, and a built frontend (done by the script). Installers can only be built for the OS you run on, which is why CI uses a Windows, macOS and Ubuntu matrix. The backend bundle alone: `python backend/build_backend.py`.

## Run from source

`run.ps1` starts the server against `http://127.0.0.1:8188` (override with `-LB_ComfyUrl`), serving the built UI at http://127.0.0.1:8000.

Manual setup:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt     # Linux: .venv/bin/pip
.venv\Scripts\python -m pytest
$env:LB_COMFY_URL = "http://127.0.0.1:8188"
.venv\Scripts\python -m uvicorn libretto.main:app_factory --factory --port 8000
```

Frontend:

```powershell
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api to :8000
npm run build      # the backend serves frontend/dist at / when it exists
```

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `LB_COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI server |
| `LB_UGC_ROOT` | `ugc/` | Parent of all user-generated content below (git-ignored) |
| `LB_LIBRARIES_ROOT` | `ugc/libraries/` | One sub-folder per library (preset YAML + thumbnails) |
| `LB_SCENES_ROOT` | `ugc/scenes/` | Saved scenes (node graphs), one JSON each |
| `LB_PROFILES_ROOT` | `profiles/` | Built-in model profiles and workflow template (shipped) |
| `LB_USER_PROFILES_ROOT` | `ugc/profiles/` | Imported/edited profiles and their workflow templates |
| `LB_DATA_ROOT` | `ugc/data/` | SQLite history, snapshots, collection state |
| `LB_BACKUP_ROOT` | `backups/` | Where backup zips are written (git-ignored) |
| `LB_AUTO_BACKUP` | on | Set to `0` to disable the daily automatic backup |
| `LB_MODELS_ROOT` | unset | ComfyUI `models/` folder; enables SHA256 hashes of checkpoints and LoRAs in snapshots |

## Adding a model profile

Copy `profiles/sdxl.yaml`, set `format` (`tags` or `natural`), the quality prefix, negative template, defaults,
and a `workflow_template` exported with ComfyUI "Save (API Format)". `injection` maps each parameter
to the node id in that template.

## Notes

- Progress is polled from ComfyUI history/queue (no WebSocket yet).
- Bit-exact reproduction needs the same GPU, drivers, PyTorch and model files; snapshots record these to detect drift.

## Libraries, scenes and output (v1.1)

- **Libraries**: switch between libraries from the palette; *Manage…* creates (optionally copying an existing one), imports/exports (zip) and deletes libraries, and copies selected nodes between libraries.
- **Scenes**: each tab is a separate node graph (like ComfyUI workflows) with its own library, scene prompt/negative and output settings. Scenes autosave to `ugc/scenes/`. Right-click a scene tab to rename, duplicate, export, close or delete it; the **+** button (or right-clicking empty tab space) creates, imports, or reopens a closed scene.
- **Layout**: results browser on the left, graph with the inspector on its right, and the library browser at the bottom; drag pane edges to resize. The library browser has two quick-access rows: category buttons (click to show one, Ctrl-click to add or remove) and, below them, tag buttons for the selected categories (click to narrow to one tag; Ctrl-click to add more). All matching presets show at once; the slider resizes thumbnails. A preset property pane on the right of the library (toggle with `N` while the pointer is over the library, or the small ◂ button at its right edge) edits the clicked preset directly and autosaves. Select several presets (Ctrl/Shift-click) to edit them together: fields whose values differ show a "mixed" badge, typing writes to all, and tags show `n/m` when only some have them. Right-click a node in the graph for Copy / Cut / Duplicate / Delete (applies to all selected nodes), or right-click empty canvas to Paste the copied nodes at that spot. When several categories or tags are selected, a sticky row of jump buttons at the top of the card area scrolls to each section.
- **Output control**: the Generate node's *Output subfolder/prefix* overrides every SaveImage `filename_prefix` (relative to ComfyUI's output folder; `{scene}`, `{profile}`, `{date}` supported), and *Also copy images to local folder* copies results to a folder on this machine.
- **Prompt order**: the toggle at the top of the graph (or the Generate node) switches between category order and canvas position order; category order can be rearranged per Generate node. *Replace entire prompt* ignores everything else.
- **Hair category**: hair styles are their own category (placed right after the character). A hair node has a **hair color** property (pick from the list or type your own). A style's keywords may contain `{color}` (for example `{color} hair, long hair`); without it, `<color> hair` is prepended. On a Collection node the color can be `random`, which picks a color per image from the pick seed, so the same snapshot reproduces the same color.
- **Pose / Emotion / Props categories**: pose is one person's body position, emotion is expression/mood, props are held or nearby objects (interactions between several characters belong in situation). In prompt order they follow costume; profiles saved before these existed place them there automatically.
- **Per-character attributes**: hair, costume, pose, emotion and props nodes (and inline prompt nodes) have a "Belongs to character" setting. Their text is written right behind that character in the prompt, so with several characters each person's tags stay together and are less likely to bleed onto someone else. The Generate node's "Between characters" setting can also insert `BREAK` between characters (tag models). ComfyUI's own text encoders ignore BREAK, so Libretto encodes each segment with its own CLIPTextEncode and joins them with ConditioningConcat when it builds the workflow. Natural-language profiles just keep each character's sentences together. Replacing a node by dropping a preset on it keeps its character. Select several graph nodes (Ctrl/Shift-click, or hold Ctrl or Shift and drag a box on empty canvas, as in ComfyUI) to edit state, character and emphasis for all of them at once; differing values show a "mixed" badge.
- **Configurable categories**: every library has its own category list (⚙ next to the library selector; stored in `categories.yaml` in the library folder). Each category has a stable id, an editable label, a color, a **kind** and flags: *belongs to* (nodes may be grouped under a group head such as a character), *color* (hair-style color picker) and *locked* (prevents deletion; the built-ins start locked, but you can unlock them). Behavior depends on the kind (`group_head`, `attribute`, `situation`, `scene`, `custom`), never on the name, so renaming a category is safe. Add your own (for example "Effects"), reorder them (the order is the default prompt order) and delete empty ones. A scene can mix presets from different libraries: nodes keep their own copy of the preset and remember the library their thumbnail comes from. Copying nodes to another library creates any missing category there.
- **Search tags**: tag presets (e.g. `formal`, `casual`) via the 🏷 button on a library card or the Inspector's tags field. Use `/` for nested tags (`dress/formal`), which appear as their own tag buttons; an item tagged `dress/formal` also matches `dress`. Collection nodes can restrict to tags. Each category also has a "no tags" button listing untagged presets.

- **Prompt nodes**: drag a positive or negative prompt node onto the canvas to add a piece of prompt text. Set its category (node color; inline position) and placement (prepend / inline / append). Negative prompt nodes are dark red.

## Backups

Because `ugc/` is not in git, use **💾 Backups…** in the toolbar. *Create backup* zips your libraries (with thumbnails), scenes and profiles into `backups/` (optionally with generation history and images). A settings-only backup is also taken automatically at startup at most once a day (last 10 auto backups kept). *Restore* merges the backup into the current data; *Replace all* makes it match the backup exactly. Both first take a "pre-restore" safety backup, and the page reloads afterwards. Backups can be downloaded and imported as zips; copy them somewhere off the machine for real safety.

## Tests

- Backend: `cd backend; .\.venv\Scripts\python -m pytest -q`
- Frontend (undo/redo store logic): `cd frontend; npm test`
- **Results browser**: the results panel is a wrapping thumbnail grid with a size slider. Use ☑ Select (or Ctrl/Shift-click; Ctrl+A, Esc, Del when the panel is focused) to multi-select and 🗑 Delete to remove entries.


All user-generated content lives under `ugc/` and is git-ignored. A first run seeds the `default` library from `samples/default` (presets with thumbnails) and two example scenes, *Sample* and *Complex Sample*, from `samples/scenes`. The scenes use the built-in `sdxl` profile; pick your own workflow profile in the Generate node. Only a brand-new data folder is seeded, so deleting the examples keeps them deleted. The sample thumbnails are AI-generated. To refresh the shipped samples from your own data, copy the generic thumbnails and YAML (not the per-profile `id.<profile>.webp` thumbnails) of the `default` library into `samples/default`, and the scene JSON files into `samples/scenes`.

## License

MIT, see [LICENSE](LICENSE).
