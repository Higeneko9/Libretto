# Libretto: System Design

Libretto generates image-generation prompts from high-level building blocks
(character, costume, pose, emotion, props, location, situation, art style, lighting, view) that are
arranged as nodes on a drag-and-drop canvas. It compiles the graph into a
prompt for the selected model family and runs it on a local ComfyUI server.

## Goals

- Compose a scene by dropping nodes (for example Nancy + white onepiece + house + smiling).
- Every node is configurable.
- Compile prompts according to the target model profile (SD/SDXL, Pony, Flux, natural-language models, and so on).
- Queue generation on a local ComfyUI (Ubuntu server) and show results.
- Reproduce any result exactly from a saved snapshot.
- Random-pick collections (for example a pool of costumes).
- Thumbnails for visual selection of presets.

## Architecture

```
[Node editor UI] -> [Prompt compiler (backend)] -> [ComfyUI API] -> [Result gallery]
   (browser)         (model-profile aware)         (ubuntu server)
```

## Technology stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Frontend | React + TypeScript + Vite | |
| Node editor | React Flow (`@xyflow/react`) | Alternatives: Rete.js, LiteGraph.js |
| State / UI | Zustand, Tailwind or shadcn/ui | |
| Backend | Python + FastAPI | Runs beside ComfyUI on the Ubuntu box |
| Storage | SQLite + YAML/JSON files | Library files are git-friendly |
| Generation | ComfyUI HTTP/WebSocket API | |

## ComfyUI integration

- `POST /prompt`: queue a workflow (API-format JSON template with injected prompt, seed, size, and so on).
- `WS /ws`: progress and completion events.
- `GET /history/{prompt_id}`: outputs of a run.
- `GET /view?filename=...`: fetch images.
- Export workflows with "Save (API Format)"; keep one template per model family.

## Node types

Character, Costume, Location, Situation, Style, Lighting, Camera/View,
Collection (random pool), and an Output/Generate node.

Each node has a typed schema. Example, Character:
`{ name, appearance tags, LoRA, trigger words, negative tags, thumbnail }`.

Reusable presets live in a library; instances on the canvas are configurable
copies of a preset.

## Model profiles

A profile is defined per model family and contains:

- Prompt format: weighted tags such as `(tag:1.2)`, or natural-language sentences.
- Ordering rules, quality-tag prefixes, negative-prompt template.
- ComfyUI workflow template path.
- Defaults for resolution, sampler, steps, CFG.

## Prompt compiler

1. Walk the node graph and resolve collections (see below).
2. Each node exposes structured fields.
3. A per-profile renderer turns the fields into tags or prose.
4. Optional: a local LLM (for example Ollama) rewrites the result into natural language for Flux-style models.
5. The UI shows a live preview and allows manual override.

## Generation flow

1. User clicks Generate.
2. Backend resolves randomness, compiles the prompt, and writes a snapshot.
3. The workflow template is filled and queued in ComfyUI.
4. Progress streams to the UI over WebSocket.
5. Images are fetched, stored, and shown in the gallery.

Batch runs and variations (sweeping one field, such as costume) are supported.

## Reproducible snapshots

Each generation saves `snapshot.json` next to the image and indexes it in SQLite.

Contents:

- Resolved seed (random seeds are converted to a concrete value before queuing).
- Sampler, scheduler, steps, CFG, denoise, width, height, batch size.
- Models, VAE, LoRAs (with strengths), ControlNets, and SHA256 hashes of the files.
- Final compiled positive and negative prompts, and the node graph.
- The exact API-format workflow JSON sent to `/prompt`.
- Environment: ComfyUI version/commit, PyTorch, CUDA, GPU, custom node versions.
- Timestamp and ComfyUI `prompt_id`.

A "Regenerate" action restores the graph and re-queues the saved workflow.

Limits: bit-exact results need the same GPU, driver, and PyTorch versions,
unchanged model files, and deterministic samplers (ancestral `_a` samplers and
some attention backends can vary). Test a fixed seed twice to verify.

ComfyUI also embeds the workflow in PNG metadata, which serves as a backup.

Extras: variation mode (change one field of a snapshot), locked seed toggle,
and a snapshot diff view.

## Collections (random pools)

A Collection node plugs into the same input as a single node of that category
(for example Costume) and picks one item per generation.

- Items are full presets with an optional weight and tags.
- Pick modes: random, sequential, shuffle without repeats, fixed.
- Tag filters and "exclude last N" to avoid repeats.
- In a batch, each image gets its own pick.
- Collections can nest (for example Outfits > Summer, Winter).
- Works for any category: location, lighting, situation, expression, camera.
- Wildcard-style `.txt` import (one entry per line).

Reproducibility: the pick is resolved at queue time from a separate
**pick-seed**, and the chosen item ID and resolved text are stored in the
snapshot. Replaying a snapshot yields the same pick; the pick-seed and image
seed can be re-rolled independently.

## Thumbnails

- Shown on node cards, in a library grid (search and tag filters, drag to canvas), on Collection items (the picked item is highlighted after a run), and in the history gallery.
- Created by: "Set as thumbnail" on a result, auto-generated preview with a fixed seed and neutral settings (bulk action for a collection), or manual upload.
- Stored next to the preset, for example `costumes/white-onepiece.yaml` and `costumes/white-onepiece.webp`, resized to about 256px WebP. Originals stay in the history store.
- A preset can hold several thumbnails, tagged by model profile, with one primary.
- Thumbnail generation info (model, seed, source snapshot ID) is recorded.

## Library layout (proposed)

```
ugc/libraries/<library-id>/
  characters/
  costumes/
  locations/
  situations/
  styles/
  lighting/
  views/
profiles/          # built-in model profiles + workflow template
samples/default/   # seed for the default library
ugc/               # all user content (git-ignored): libraries, scenes, profiles, data
data/              # SQLite DB, history images, snapshots
```

## Conventions

- Project-specific build and configuration identifiers use the `LB_` prefix (for example `LB_ScratchRoot`, `LB_ArtifactsRoot`) to distinguish them from generic names.

## Roadmap

1. FastAPI service that sends a hardcoded template to ComfyUI and returns the image.
2. React Flow canvas with 2-3 node types and one model profile.
3. Remaining nodes, profiles, libraries, snapshots, and history.
4. Collections and the pick-seed.
5. Thumbnails and the library browser.
6. Batch runs, variations, snapshot diff.

## Open questions

- Which model families to support first.
- Whether the optional LLM rewrite step is wanted in the first release.

## Libraries and scenes (v1.1)

Libraries live in `ugc/libraries/<id>/<category>/` and are selected per scene (`?lib=` on library routes). Scenes (named node graphs, called *scenes* to avoid confusion with ComfyUI workflows) live in `ugc/scenes/<id>.json` and carry `library`, `scene_prompt` and `scene_negative`. Output overrides: `output_prefix` rewrites SaveImage `filename_prefix`; `output_dir` receives a local copy.
