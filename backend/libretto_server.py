"""Entry point for the PyInstaller bundle (see build_backend.py)."""

import multiprocessing

from libretto.server import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
