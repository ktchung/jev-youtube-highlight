import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

from .models import Analysis, TranscriptCue


def fingerprint(value: Any) -> str:
    serialized = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(serialized.encode()).hexdigest()


class Cache:
    """Small atomic SQLite records. Never persist API keys or raw API errors."""

    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS analyses (
                    cache_key TEXT PRIMARY KEY,
                    video_id TEXT NOT NULL,
                    model TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS analyses_video ON analyses(video_id, created_at);
                CREATE TABLE IF NOT EXISTS transcripts (
                    video_id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS scores (
                    cache_key TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                );
            """)

    def _connect(self):
        return sqlite3.connect(self.path, timeout=5)

    def get_analysis(self, cache_key: str) -> Analysis | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT payload FROM analyses WHERE cache_key = ?", (cache_key,)
            ).fetchone()
        return Analysis.model_validate_json(row[0]) if row else None

    def latest_analysis(self, video_id: str, model: str, prompt_version: str) -> Analysis | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT payload FROM analyses WHERE video_id = ? AND model = ? "
                "AND prompt_version = ? ORDER BY created_at DESC LIMIT 1",
                (video_id, model, prompt_version),
            ).fetchone()
        return Analysis.model_validate_json(row[0]) if row else None

    def save_analysis(self, cache_key: str, analysis: Analysis) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO analyses VALUES (?, ?, ?, ?, ?, ?)",
                (
                    cache_key,
                    analysis.video_id,
                    analysis.model,
                    analysis.prompt_version,
                    analysis.created_at,
                    analysis.model_dump_json(),
                ),
            )

    def get_transcript(self, video_id: str) -> tuple[list[TranscriptCue], str] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT payload, source FROM transcripts WHERE video_id = ?", (video_id,)
            ).fetchone()
        if row:
            return [TranscriptCue.model_validate(cue) for cue in json.loads(row[0])], row[1]
        return None

    def save_transcript(self, video_id: str, cues: list[TranscriptCue], source: str) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO transcripts VALUES (?, ?, ?)",
                (video_id, source, json.dumps([cue.model_dump() for cue in cues])),
            )

    def get_score(self, cache_key: str) -> dict | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT payload FROM scores WHERE cache_key = ?", (cache_key,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def save_score(self, cache_key: str, score: dict) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO scores VALUES (?, ?)", (cache_key, json.dumps(score))
            )
