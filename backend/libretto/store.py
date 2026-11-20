from __future__ import annotations

import json
import sqlite3
import threading
import logging
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt_id TEXT,
    profile TEXT,
    seed INTEGER,
    positive TEXT,
    parent_id TEXT,
    error TEXT,
    images TEXT NOT NULL DEFAULT '[]'
);
"""


class RunStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        # columns added after the first release
        existing = {row["name"] for row in self._conn.execute("PRAGMA table_info(runs)")}
        for column, kind in (("started_at", "TEXT"), ("finished_at", "TEXT"), ("duration_s", "REAL"), ("scene_id", "TEXT")):
            if column not in existing:
                self._conn.execute(f"ALTER TABLE runs ADD COLUMN {column} {kind}")
        self._conn.commit()

    def insert(self, run: dict) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO runs (id, created_at, status, prompt_id, profile, seed, positive, parent_id, scene_id) "
                "VALUES (:id, :created_at, :status, :prompt_id, :profile, :seed, :positive, :parent_id, :scene_id)",
                {"parent_id": None, "scene_id": None, **run},
            )
            self._conn.commit()

    def update(self, run_id: str, **fields) -> None:
        if "images" in fields:
            fields["images"] = json.dumps(fields["images"])
        assignments = ", ".join(f"{k} = :{k}" for k in fields)
        with self._lock:
            self._conn.execute(f"UPDATE runs SET {assignments} WHERE id = :id", {"id": run_id, **fields})
            self._conn.commit()

    def delete(self, run_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            self._conn.commit()

    @staticmethod
    def _row(row: sqlite3.Row) -> dict:
        data = dict(row)
        data["images"] = json.loads(data["images"])
        return data

    def get(self, run_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return self._row(row) if row else None

    def list(self, limit: int | None = 100, status: str | None = None) -> list[dict]:
        query, args = "SELECT * FROM runs", []
        if status:
            query += " WHERE status = ?"
            args.append(status)
        query += " ORDER BY created_at DESC"
        if limit is not None:
            query += " LIMIT ?"
            args.append(limit)
        with self._lock:
            rows = self._conn.execute(query, args).fetchall()
        return [self._row(r) for r in rows]

    def index_scene_ids(self, snapshots_root: Path) -> None:
        """Recover only explicit ownership from older snapshots; never infer it from names."""
        with self._lock:
            rows = self._conn.execute("SELECT id FROM runs WHERE scene_id IS NULL").fetchall()
            for row in rows:
                path = snapshots_root / row["id"] / "snapshot.json"
                if snapshots_root.resolve() not in path.resolve().parents:
                    logging.getLogger(__name__).warning("Invalid snapshot location for run %s", row["id"])
                    continue
                if not path.is_file():
                    continue
                try:
                    snapshot = json.loads(path.read_text(encoding="utf-8"))
                    scene_id = snapshot.get("scene_id") or (snapshot.get("scene") or {}).get("id")
                except (OSError, ValueError, AttributeError) as exc:
                    logging.getLogger(__name__).warning("Cannot read scene ownership for run %s: %s", row["id"], exc)
                    continue
                if isinstance(scene_id, str):
                    self._conn.execute("UPDATE runs SET scene_id = ? WHERE id = ?", (scene_id, row["id"]))
            self._conn.commit()

    def export_rows(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM runs ORDER BY created_at").fetchall()
        return [self._row(r) for r in rows]

    def import_rows(self, rows: list[dict], replace: bool = False) -> int:
        """Add runs from a backup without touching existing ones; runs that were still active become cancelled."""
        with self._lock:
            if replace:
                self._conn.execute("DELETE FROM runs WHERE status NOT IN ('queued', 'running')")
            columns = [r["name"] for r in self._conn.execute("PRAGMA table_info(runs)")]
            added = 0
            for row in rows:
                row = {**row, "images": json.dumps(row.get("images", []))}
                if row.get("status") in ("queued", "running"):
                    row["status"] = "cancelled"
                values = {c: row.get(c) for c in columns}
                if values.get("id") is None or values.get("created_at") is None:
                    continue
                values["images"] = values["images"] or "[]"
                cursor = self._conn.execute(
                    f"INSERT OR IGNORE INTO runs ({", ".join(columns)}) VALUES ({", ".join(":" + c for c in columns)})",
                    values,
                )
                added += cursor.rowcount
            self._conn.commit()
        return added

    def active(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at"
            ).fetchall()
        return [self._row(r) for r in rows]
