import copy
import json
import os
import random
import shutil
from urllib.parse import quote
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .backups import Backups
from .comfy import ComfyClient
from .compiler import compile_graph
from .config import (
    DEFAULT_PORT,
    LB_PROJECT_ROOT,
    LB_LoadSettings,
    LB_Settings,
    load_user_settings,
    normalize_comfy_url,
    save_user_settings,
)
from .generator import Generator
from .importer import analyze, build_profile, slugify, ui_to_api
from .libraries import DEFAULT_LIBRARY, Libraries
from . import categories as cats
from .library import Library
from .profiles import load_profiles, profile_path, save_profile
from .scenes import Scenes
from .scene_snaps import SceneSnaps
from .store import RunStore


class ImportBody(BaseModel):
    path: str
    format: str | None = None
    keep_positive: bool = False
    keep_negative: bool = True


class GraphBody(BaseModel):
    graph: dict


class BackupBody(BaseModel):
    note: str = ""
    include_history: bool = False


class RestoreBody(BaseModel):
    mode: str = "merge"
    include_history: bool = True


class TextBody(BaseModel):
    text: str


class ThumbnailFromRun(BaseModel):
    run_id: str
    image: str
    profile: str | None = None


class SettingsBody(BaseModel):
    comfy_url: str | None = None
    port: int | None = None
    setup_seen: bool | None = None


class NewLibrary(BaseModel):
    name: str
    copy_from: str | None = None


class TagPatch(BaseModel):
    locale: str | None = None
    name: str | None = None
    remove_locale: str | None = None
    parent: str | None = None


class RenameBody(BaseModel):
    name: str
    names: dict | None = None


class CopyItems(BaseModel):
    source: str
    items: list[dict]


class SceneBody(BaseModel):
    name: str | None = None
    names: dict | None = None
    graph: dict | None = None


class GenerateBody(BaseModel):
    graph: dict
    scene_id: str | None = None


class SnapPatch(BaseModel):
    keep: bool | None = None
    name: str | None = None


class SnapSettings(BaseModel):
    max: int


def create_app(settings: LB_Settings | None = None, comfy: ComfyClient | None = None, start_worker: bool = True) -> FastAPI:
    settings = settings or LB_LoadSettings()
    libraries = Libraries(settings.LibrariesRoot, LB_PROJECT_ROOT / "samples" / "default")
    scenes = Scenes(settings.ScenesRoot, LB_PROJECT_ROOT / "samples" / "scenes")
    scene_snaps = SceneSnaps(settings.SceneSnapsRoot, settings.SceneSnapMax)
    profiles = load_profiles(settings.ProfilesRoot, settings.UserProfilesRoot)
    comfy = comfy or ComfyClient(settings.ComfyUrl)
    store = RunStore(settings.DbPath)
    generator = Generator(settings, libraries, profiles, comfy, store, scene_snaps)
    backups = Backups(
        settings.BackupsRoot or settings.DataRoot.parent / "backups",
        {"libraries": settings.LibrariesRoot, "scenes": settings.ScenesRoot, "profiles": settings.UserProfilesRoot},
        settings.SnapshotsRoot,
        store.export_rows,
        store.import_rows,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if start_worker:
            generator.start_worker()
            if os.environ.get("LB_AUTO_BACKUP", "1") != "0":
                try:
                    backups.auto_backup()
                except Exception:  # a failed automatic backup must never stop the server
                    pass
        yield
        generator.stop_worker()

    app = FastAPI(title="Libretto", lifespan=lifespan)
    app.state.generator = generator

    def guard(call):
        try:
            return call()
        except FileNotFoundError:
            raise HTTPException(404, "not found")
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    def error_label(exc: Exception) -> str:
        # a short fixed label, never the exception text, so internals are not exposed to the client
        name = exc.__class__.__name__
        if isinstance(exc, ValueError):
            return "invalid address"
        if "Timeout" in name:
            return "timed out"
        if "Connect" in name or isinstance(exc, OSError):
            return "connection refused or host not found"
        return name

    @app.get("/api/health")
    def health():
        try:
            stats = comfy.system_stats()
            return {"comfyui": "ok", "version": stats.get("system", {}).get("comfyui_version")}
        except Exception as exc:
            return {"comfyui": "unreachable", "error": error_label(exc)}

    def settings_payload(saved: dict) -> dict:
        # `configured` is false only until the first-run dialog has been shown or an address saved
        configured = bool(saved.get("comfy_url") or saved.get("setup_seen") or os.environ.get("LB_COMFY_URL"))
        return {"comfy_url": comfy.base_url, "port": int(saved.get("port") or DEFAULT_PORT), "configured": configured}

    @app.get("/api/settings")
    def get_settings():
        return settings_payload(load_user_settings(settings.SettingsFile))

    @app.put("/api/settings")
    def put_settings(body: SettingsBody):
        def run():
            saved = load_user_settings(settings.SettingsFile)
            if body.comfy_url is not None:
                saved["comfy_url"] = normalize_comfy_url(body.comfy_url)
                comfy.set_base_url(saved["comfy_url"])
            if body.port is not None:
                if not 1 <= body.port <= 65535:
                    raise ValueError("port must be between 1 and 65535")
                saved["port"] = body.port
            if body.setup_seen is not None:
                saved["setup_seen"] = body.setup_seen
            if settings.SettingsFile:
                save_user_settings(settings.SettingsFile, saved)
            return settings_payload(saved)

        return guard(run)

    @app.get("/api/ui")
    def get_ui():
        ui = load_user_settings(settings.SettingsFile).get("ui")
        return ui if isinstance(ui, dict) else {}

    @app.put("/api/ui")
    def put_ui(body: dict[str, Any]):
        # layout preferences live next to the data so they survive a changed port or browser profile
        if settings.SettingsFile:
            saved = load_user_settings(settings.SettingsFile)
            saved["ui"] = body
            save_user_settings(settings.SettingsFile, saved)
        return body

    @app.post("/api/settings/test")
    def test_settings(body: SettingsBody):
        import httpx

        try:
            url = normalize_comfy_url(body.comfy_url or "")
            stats = httpx.get(f"{url}/system_stats", timeout=5).json()
            return {"ok": True, "url": url, "version": stats.get("system", {}).get("comfyui_version")}
        except Exception as exc:
            return {"ok": False, "error": error_label(exc)}

    @app.get("/api/profiles")
    def get_profiles():
        return list(profiles.values())

    @app.patch("/api/profiles/{profile_id}")
    def patch_profile(profile_id: str, changes: dict):
        profile = profiles.get(profile_id)
        if profile is None:
            raise HTTPException(404, "not found")
        allowed = {"name", "format", "quality_prefix", "negative_template", "use_negative", "defaults", "order", "natural"}
        if changes.get("format") not in (None, "tags", "natural"):
            raise HTTPException(400, "format must be tags or natural")
        profile.update({k: v for k, v in changes.items() if k in allowed})
        save_profile(settings.UserProfilesRoot, profile)
        return profile

    @app.delete("/api/profiles/{profile_id}")
    def delete_profile(profile_id: str):
        profile = profiles.get(profile_id)
        if profile is None:
            raise HTTPException(404, "not found")
        if not profile.get("source"):
            raise HTTPException(400, "built-in profiles cannot be deleted")
        profile_path(settings.UserProfilesRoot, profile).unlink(missing_ok=True)
        (settings.UserProfilesRoot / profile["workflow_template"]).unlink(missing_ok=True)
        del profiles[profile_id]
        return {"deleted": profile_id}

    # ---- ComfyUI workflows -------------------------------------------
    @app.get("/api/comfy/workflows")
    def list_comfy_workflows():
        try:
            files = comfy.list_workflows()
        except Exception as exc:
            raise HTTPException(502, f"could not reach ComfyUI: {exc}")
        imported = {p["source"]["path"]: pid for pid, p in profiles.items() if p.get("source")}
        return [{"path": f["path"], "modified": f.get("modified"), "profile_id": imported.get(f["path"])} for f in files]

    @app.post("/api/comfy/workflows/import")
    def import_comfy_workflow(body: ImportBody):
        def run():
            try:
                ui = comfy.get_workflow(body.path)
            except Exception as exc:
                raise ValueError(f"could not fetch workflow: {exc}")
            cache: dict[str, dict | None] = {}

            def object_info(node_type: str):
                if node_type not in cache:
                    cache[node_type] = comfy.object_info(node_type)
                return cache[node_type]

            api = ui_to_api(ui, object_info)
            analysis = analyze(api, body.keep_positive, body.keep_negative)
            profile_id = "wf-" + slugify(body.path.removesuffix(".json"))
            template_file = f"{profile_id}.json"
            template_path = settings.UserProfilesRoot / template_file
            template_path.parent.mkdir(parents=True, exist_ok=True)
            template_path.write_text(json.dumps(api, indent=2), encoding="utf-8")
            profile = build_profile(body.path.removesuffix(".json"), body.path, template_file, analysis, body.format)
            profile["id"] = profile_id
            save_profile(settings.UserProfilesRoot, profile)
            profiles[profile_id] = profile
            return {"profile": profile, "warnings": analysis["warnings"]}

        return guard(run)

    def get_lib(lib: str = Query(DEFAULT_LIBRARY)) -> Library:
        return guard(lambda: libraries.get(lib))

    @app.get("/api/categories")
    def get_categories(library: Library = Depends(get_lib)):
        return library.categories()

    @app.put("/api/categories")
    def put_categories(items: list[dict], purge: bool = False, library: Library = Depends(get_lib)):
        return guard(lambda: library.set_categories(items, purge))

    @app.get("/api/category-kinds")
    def get_category_kinds():
        return [{"id": k, **v} for k, v in cats.KINDS.items()]

    # ---- libraries ----------------------------------------------------
    @app.get("/api/libraries")
    def list_libraries():
        return libraries.list()

    @app.post("/api/libraries")
    def create_library(body: NewLibrary):
        return guard(lambda: libraries.create(body.name, body.copy_from))

    @app.patch("/api/libraries/{library_id}")
    def rename_library(library_id: str, body: RenameBody):
        return guard(lambda: libraries.rename(library_id, body.name, body.names))

    @app.delete("/api/libraries/{library_id}")
    def delete_library(library_id: str):
        guard(lambda: libraries.delete(library_id))
        return {"deleted": library_id}

    @app.get("/api/libraries/{library_id}/export")
    def export_library(library_id: str):
        data = guard(lambda: libraries.export_zip(library_id))
        filename = quote(libraries.name_of(library_id) + ".zip")
        return Response(data, media_type="application/zip", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"})

    @app.post("/api/libraries/import")
    async def import_library(file: UploadFile = File(...), name: str | None = Query(None)):
        data = await file.read()
        stem = name or Path(file.filename or "library").stem
        return guard(lambda: libraries.import_zip(stem, data))

    @app.post("/api/libraries/{target}/copy")
    def copy_library_items(target: str, body: CopyItems):
        return guard(lambda: libraries.copy_items(body.source, target, body.items))

    # ---- tags ---------------------------------------------------------
    @app.get("/api/tags")
    def list_tags(library: Library = Depends(get_lib)):
        return library.tags.list()

    @app.patch("/api/tags/{tag_id}")
    def patch_tag(tag_id: str, body: TagPatch, library: Library = Depends(get_lib)):
        def run():
            if body.name is not None:
                library.tags.rename(tag_id, body.locale, body.name)
            if body.remove_locale:
                library.tags.remove_name(tag_id, body.remove_locale)
            if "parent" in body.model_fields_set:
                library.tags.move(tag_id, body.parent)
            return library.tags.get(tag_id)

        return guard(run)

    @app.delete("/api/tags/{tag_id}")
    def delete_tag(tag_id: str, library: Library = Depends(get_lib)):
        guard(lambda: library.delete_tag(tag_id))
        return {"deleted": tag_id}

    # ---- library presets ---------------------------------------------
    @app.get("/api/library/{category}")
    def list_presets(category: str, library: Library = Depends(get_lib)):
        return guard(lambda: library.list(category))

    @app.post("/api/library/{category}")
    def create_preset(category: str, preset: dict, locale: str | None = Query(None), library: Library = Depends(get_lib)):
        return guard(lambda: library.create(category, preset, locale))

    @app.put("/api/library/{category}/{preset_id}")
    def update_preset(category: str, preset_id: str, preset: dict, locale: str | None = Query(None), library: Library = Depends(get_lib)):
        return guard(lambda: library.update(category, preset_id, preset, locale))

    @app.post("/api/library/{category}/{preset_id}/restore")
    def restore_preset(category: str, preset_id: str, library: Library = Depends(get_lib)):
        return guard(lambda: library.restore(category, preset_id))

    @app.delete("/api/library/{category}/{preset_id}")
    def delete_preset(category: str, preset_id: str, library: Library = Depends(get_lib)):
        guard(lambda: library.delete(category, preset_id))
        return {"deleted": preset_id}

    @app.post("/api/library/{category}/import-wildcard")
    def import_wildcard(category: str, body: TextBody, library: Library = Depends(get_lib)):
        return guard(lambda: library.import_wildcard(category, body.text))

    @app.get("/api/library/{category}/{preset_id}/thumbnail")
    def get_thumbnail(category: str, preset_id: str, profile: str | None = Query(None), library: Library = Depends(get_lib)):
        def run():
            if profile:
                specific = library.thumb_path(category, preset_id, profile)
                if specific.exists():
                    return specific
            path = library.thumb_path(category, preset_id)
            if not path.exists():
                raise FileNotFoundError(preset_id)
            return path

        return FileResponse(guard(run), media_type="image/webp", headers={"Cache-Control": "no-cache"})

    @app.post("/api/library/{category}/{preset_id}/thumbnail")
    async def upload_thumbnail(
        category: str,
        preset_id: str,
        file: UploadFile = File(...),
        profile: str | None = Query(None),
        library: Library = Depends(get_lib),
    ):
        data = await file.read()
        guard(lambda: library.set_thumbnail(category, preset_id, data, profile, {"upload": file.filename}))
        return library.get(category, preset_id)

    @app.post("/api/library/{category}/{preset_id}/thumbnail/from-run")
    def thumbnail_from_run(category: str, preset_id: str, body: ThumbnailFromRun, library: Library = Depends(get_lib)):
        def run():
            image = _image_path(body.run_id, body.image)
            snapshot = generator.read_snapshot(body.run_id)
            source = {
                "run_id": body.run_id,
                "image": body.image,
                "profile": snapshot["profile"],
                "seed": snapshot["params"].get("seed"),
            }
            data = image.read_bytes()
            library.set_thumbnail(category, preset_id, data, body.profile or snapshot["profile"])
            library.set_thumbnail(category, preset_id, data, None, source)
            return library.get(category, preset_id)

        return guard(run)

    # ---- scenes -------------------------------------------------------
    @app.get("/api/backups")
    def list_backups():
        return backups.list()

    @app.post("/api/backups")
    def create_backup(body: BackupBody):
        return guard(lambda: backups.create(body.note, body.include_history))

    @app.post("/api/backups/import")
    async def import_backup(file: UploadFile = File(...), note: str = Query("")):
        data = await file.read()
        return guard(lambda: backups.import_zip(data, note))

    @app.get("/api/backups/{backup_id}/download")
    def download_backup(backup_id: str):
        path = guard(lambda: backups.file(backup_id))
        return FileResponse(path, filename=f"libretto-backup-{backup_id}.zip", media_type="application/zip")

    @app.post("/api/backups/{backup_id}/restore")
    def restore_backup(backup_id: str, body: RestoreBody):
        result = guard(lambda: backups.restore(backup_id, body.mode, body.include_history))
        profiles.clear()
        profiles.update(load_profiles(settings.ProfilesRoot, settings.UserProfilesRoot))
        return result

    @app.delete("/api/backups/{backup_id}")
    def delete_backup(backup_id: str):
        guard(lambda: backups.delete(backup_id))
        return {"deleted": backup_id}

    @app.get("/api/scenes")
    def list_scenes():
        return scenes.list()

    @app.post("/api/scenes")
    def create_scene(body: SceneBody):
        return guard(lambda: scenes.create(body.name or "Scene", body.graph))

    @app.get("/api/scenes/{scene_id}")
    def get_scene(scene_id: str):
        return guard(lambda: scenes.get(scene_id))

    @app.put("/api/scenes/{scene_id}")
    def update_scene(scene_id: str, body: SceneBody):
        return guard(lambda: scenes.update(scene_id, body.name, body.graph, body.names))

    @app.delete("/api/scenes/{scene_id}")
    def delete_scene(scene_id: str):
        guard(lambda: scenes.delete(scene_id))
        scene_snaps.delete_scene(scene_id)
        return {"deleted": scene_id}

    # ---- automatic scene snapshots -----------------------------------
    @app.get("/api/scenes/{scene_id}/snaps")
    def list_scene_snaps(scene_id: str):
        return guard(lambda: scene_snaps.list(scene_id))

    @app.put("/api/scenes/{scene_id}/snap-settings")
    def set_scene_snap_settings(scene_id: str, body: SnapSettings):
        return guard(lambda: scene_snaps.set_max(scene_id, body.max))

    @app.get("/api/scenes/{scene_id}/snaps/{version}/thumbnail")
    def get_scene_snap_thumbnail(scene_id: str, version: int):
        path = guard(lambda: scene_snaps.thumbnail_path(scene_id, version))
        return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "no-cache"})

    @app.post("/api/scenes/{scene_id}/snaps/{version}/apply")
    def apply_scene_snap(scene_id: str, version: int):
        return {"graph": guard(lambda: scene_snaps.apply(scene_id, version))}

    @app.patch("/api/scenes/{scene_id}/snaps/{version}")
    def patch_scene_snap(scene_id: str, version: int, body: SnapPatch):
        def run():
            item = None
            if body.keep is not None:
                item = scene_snaps.set_keep(scene_id, version, body.keep)
            if body.name is not None:
                item = scene_snaps.set_name(scene_id, version, body.name)
            return item

        return guard(run)

    @app.delete("/api/scenes/{scene_id}/snaps/{version}")
    def delete_scene_snap(scene_id: str, version: int):
        guard(lambda: scene_snaps.delete(scene_id, version))
        return {"deleted": version}

    # ---- compile / generate ------------------------------------------
    @app.post("/api/compile")
    def compile_preview(body: GraphBody):
        def run():
            from .compiler import find_generate_node

            options = find_generate_node(body.graph).get("data", {})
            profile = profiles.get(options.get("profile"))
            if profile is None:
                raise ValueError(f"unknown profile: {options.get('profile')}")
            state = copy.deepcopy(generator._load_state())
            compiled = compile_graph(body.graph, generator.library_for(body.graph), profile, random.randrange(2**31), state)
            return {
                "positive": compiled.positive,
                "negative": compiled.negative,
                "loras": compiled.loras,
                "picks": compiled.picks,
            }

        return guard(run)

    @app.post("/api/generate")
    def generate(body: GenerateBody):
        return guard(lambda: generator.generate(body.graph, body.scene_id))

    # ---- runs ---------------------------------------------------------
    def _image_path(run_id: str, name: str) -> Path:
        folder = (generator.snapshot_dir(run_id) / "images").resolve()
        path = (folder / name).resolve()
        if folder not in path.parents or not path.is_file():
            raise FileNotFoundError(name)
        return path

    @app.get("/api/runs")
    def list_runs(limit: int = 100, status: str | None = None):
        return store.list(limit, status)

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str):
        run = store.get(run_id)
        if run is None:
            raise HTTPException(404, "not found")
        return run

    @app.get("/api/runs/{run_id}/snapshot")
    def get_snapshot(run_id: str):
        return guard(lambda: generator.read_snapshot(run_id))

    @app.get("/api/runs/{run_id}/images/{name}")
    def get_image(run_id: str, name: str):
        return FileResponse(guard(lambda: _image_path(run_id, name)))

    @app.delete("/api/runs/{run_id}")
    def delete_run(run_id: str):
        run = store.get(run_id)
        if run is None:
            raise HTTPException(404, "not found")
        if run["status"] in ("queued", "running"):
            raise HTTPException(409, "run is still active")
        store.delete(run_id)
        shutil.rmtree(generator.snapshot_dir(run_id), ignore_errors=True)
        return {"deleted": run_id}

    @app.post("/api/runs/{run_id}/cancel")
    def cancel_run(run_id: str):
        if store.get(run_id) is None:
            raise HTTPException(404, "not found")
        return {"cancelled": guard(lambda: generator.cancel(run_id))}

    @app.post("/api/queue/cancel")
    def cancel_all():
        return {"cancelled": guard(lambda: generator.cancel())}

    @app.post("/api/runs/{run_id}/requeue")
    def requeue(run_id: str):
        return guard(lambda: generator.requeue(run_id))

    frontend = LB_PROJECT_ROOT / "frontend" / "dist"
    if frontend.exists():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    return app


def app_factory() -> FastAPI:
    return create_app()
