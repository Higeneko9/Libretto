"""Build the self-contained Libretto server with PyInstaller.

    python build_backend.py            # needs: pip install -r requirements.txt pyinstaller; frontend built (npm run build)

Output: dist/libretto-server/ (run libretto-server[.exe] inside it). The profiles, sample library and
frontend build are bundled as read-only resources.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def main() -> None:
    frontend = ROOT / "frontend" / "dist"
    if not (frontend / "index.html").exists():
        sys.exit("Build the frontend first: cd frontend && npm install && npm run build")
    data = [(ROOT / "profiles", "profiles"), (ROOT / "samples", "samples"), (frontend, "frontend/dist")]
    args = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "libretto-server",
        "--distpath", str(HERE / "dist"), "--workpath", str(HERE / "build"), "--specpath", str(HERE / "build"),
        "--collect-submodules", "uvicorn", "--collect-submodules", "libretto", "--hidden-import", "multipart",
    ]
    for source, target in data:
        args += ["--add-data", f"{source}{os.pathsep}{target}"]
    args.append(str(HERE / "libretto_server.py"))
    subprocess.run(args, check=True, cwd=HERE)
    print("Built", HERE / "dist" / "libretto-server")


if __name__ == "__main__":
    main()
