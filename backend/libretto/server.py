"""Launcher used by the packaged builds (and handy for `python -m libretto.server`).

Prints `LIBRETTO_URL=http://host:port` once the server is listening so a wrapper such as
the Electron app can find it, even when the preferred port was taken.
"""

import argparse
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path


def default_data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "Libretto"


def free_port(host: str, preferred: int) -> int:
    for port in (preferred, 0):
        with socket.socket() as probe:
            try:
                probe.bind((host, port))
                return probe.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("no free port")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="libretto-server", description="Run the Libretto server")
    parser.add_argument("--data-dir", help="folder for libraries, scenes, history and backups (default: per-user folder when installed)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, help="preferred port (default: the saved setting, else 8000); a free port is used if it is taken")
    parser.add_argument("--comfy-url", help="ComfyUI address, used until one is saved in Settings")
    parser.add_argument("--open", action="store_true", help="open the browser when ready")
    args = parser.parse_args(argv)

    frozen = getattr(sys, "frozen", False)
    data_dir = args.data_dir or (str(default_data_dir()) if frozen and "LB_UGC_ROOT" not in os.environ else None)
    if data_dir:
        os.environ["LB_UGC_ROOT"] = str(Path(data_dir) / "ugc")
        os.environ.setdefault("LB_BACKUP_ROOT", str(Path(data_dir) / "backups"))
    if args.comfy_url:
        os.environ["LB_COMFY_URL"] = args.comfy_url

    import uvicorn

    from .config import DEFAULT_PORT, LB_UgcRoot, load_user_settings
    from .main import create_app

    preferred = args.port or int(load_user_settings(LB_UgcRoot() / "settings.json").get("port") or DEFAULT_PORT)
    port = free_port(args.host, preferred)
    url = f"http://{args.host}:{port}"

    server = uvicorn.Server(uvicorn.Config(create_app(), host=args.host, port=port, log_level="info"))

    def announce() -> None:
        while not server.started:
            if server.should_exit:
                return
            threading.Event().wait(0.1)
        print(f"LIBRETTO_URL={url}", flush=True)
        if args.open:
            webbrowser.open(url)

    threading.Thread(target=announce, daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
