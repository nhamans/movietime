"""
SQLite Database Layer (`aiosqlite`).
As required by Section 1 & Section 6 of the specification:
- The SQLite database file (`media_library.db`) and generated thumbnails (`/.media_cache/thumbnails/`)
  MUST be stored directly inside the configured master SMB root directory
  (e.g., `\\\\10.10.10.10\\Videos\\.media_cache\\media_library.db`) so the library state is
  portable and self-contained on the router HDD.
- If the configured SMB share is temporarily unreachable, falls back gracefully to a local
  cache path while reporting connection status in `/api/settings`.
"""

import aiosqlite
from pathlib import Path
import time
from typing import Dict, Optional, Tuple

from config import BACKEND_DIR, load_bootstrap_config, save_bootstrap_config
from smb_helper import connect_smb_share, normalize_smb_root_path

# Cache resolved active SMB paths for 60 seconds so API endpoints don't create/delete
# `.write_test` files over the VPN on every single HTTP request!
_cached_paths: Optional[Tuple[Path, Path, Path, bool, str]] = None
_cached_paths_ts: float = 0.0
_cached_smb_path_str: str = ""


def invalidate_active_paths_cache() -> None:
    global _cached_paths, _cached_paths_ts
    _cached_paths = None
    _cached_paths_ts = 0.0


def get_active_paths(force_verify: bool = False) -> Tuple[Path, Path, Path, bool, str]:
    """
    Resolve `(smb_root, cache_dir, db_path, is_smb_reachable, status_message)`.
    Caches the verified path for 60 seconds so normal playback/navigation requests
    never perform blocking SMB write tests over high-latency VPN links.
    """
    global _cached_paths, _cached_paths_ts, _cached_smb_path_str
    cfg = load_bootstrap_config()
    now = time.monotonic()

    if (
        not force_verify
        and _cached_paths is not None
        and _cached_smb_path_str == cfg.smb_path
        and (now - _cached_paths_ts) < 60.0
    ):
        return _cached_paths

    # Fast check if we already know the directory exists without writing `.write_test`
    norm_path = normalize_smb_root_path(cfg.smb_path)
    root_candidate = Path(norm_path)
    if not force_verify and root_candidate.exists():
        cache_dir = root_candidate / ".media_cache"
        db_path = cache_dir / "media_library.db"
        res = (root_candidate, cache_dir, db_path, True, f"Connected to {norm_path}")
        _cached_paths = res
        _cached_paths_ts = now
        _cached_smb_path_str = cfg.smb_path
        return res

    ok, msg, root = connect_smb_share(
        cfg.smb_path,
        username=cfg.smb_username,
        password=cfg.smb_password,
        domain=cfg.smb_domain,
    )
    if ok:
        cache_dir = root / ".media_cache"
        db_path = cache_dir / "media_library.db"
        res = (root, cache_dir, db_path, True, msg)
        _cached_paths = res
        _cached_paths_ts = now
        _cached_smb_path_str = cfg.smb_path
        return res

    # Fallback to local demo_media/.media_cache if remote SMB host is offline
    fallback_root = BACKEND_DIR / "demo_media"
    fallback_cache = fallback_root / ".media_cache"
    (fallback_cache / "thumbnails").mkdir(parents=True, exist_ok=True)
    fallback_db = fallback_cache / "media_library.db"
    res = (fallback_root, fallback_cache, fallback_db, False, msg)
    _cached_paths = res
    _cached_paths_ts = now
    _cached_smb_path_str = cfg.smb_path
    return res


SCHEMA_SQL = """
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=10000;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    smb_path TEXT NOT NULL,
    smb_username TEXT DEFAULT '',
    smb_password TEXT DEFAULT '',
    show_special_folder BOOLEAN NOT NULL DEFAULT 0,
    auto_scan_interval_hours INTEGER NOT NULL DEFAULT 0,
    network_profile TEXT NOT NULL DEFAULT 'vpn_high_latency',
    cpu_profile TEXT NOT NULL DEFAULT 'auto',
    last_scan_at TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    raw_filename TEXT NOT NULL,
    clean_title TEXT NOT NULL,
    segment TEXT NOT NULL,
    category TEXT NOT NULL,
    is_special BOOLEAN NOT NULL DEFAULT 0,
    extension TEXT NOT NULL,
    duration_seconds REAL NOT NULL DEFAULT 0,
    resolution TEXT NOT NULL DEFAULT 'Unknown',
    video_codec TEXT NOT NULL DEFAULT 'unknown',
    audio_codec TEXT NOT NULL DEFAULT 'unknown',
    thumbnail_path TEXT DEFAULT NULL,
    file_size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_videos_segment ON videos(segment);
CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);
CREATE INDEX IF NOT EXISTS idx_videos_is_special ON videos(is_special);
CREATE INDEX IF NOT EXISTS idx_videos_clean_title ON videos(clean_title);

CREATE TABLE IF NOT EXISTS watch_history (
    video_id INTEGER PRIMARY KEY,
    progress_seconds REAL NOT NULL DEFAULT 0,
    is_completed BOOLEAN NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watch_history_updated_at ON watch_history(updated_at DESC);
"""


async def init_db(db_path: Optional[Path] = None) -> Path:
    """Initialize schema and ensure singleton row `id = 1` in `settings` table."""
    if db_path is None:
        _, _, db_path, _, _ = get_active_paths()

    db_path.parent.mkdir(parents=True, exist_ok=True)
    cfg = load_bootstrap_config()

    async with aiosqlite.connect(str(db_path)) as db:
        await db.executescript(SCHEMA_SQL)
        # Ensure `auto_scan_interval_hours` and `network_profile` columns exist on older DBs
        async with db.execute("PRAGMA table_info(settings)") as cursor:
            cols = [row[1] for row in await cursor.fetchall()]
        if "auto_scan_interval_hours" not in cols:
            await db.execute(
                "ALTER TABLE settings ADD COLUMN auto_scan_interval_hours INTEGER NOT NULL DEFAULT 0"
            )
        if "network_profile" not in cols:
            await db.execute(
                "ALTER TABLE settings ADD COLUMN network_profile TEXT NOT NULL DEFAULT 'vpn_high_latency'"
            )
        if "cpu_profile" not in cols:
            await db.execute(
                "ALTER TABLE settings ADD COLUMN cpu_profile TEXT NOT NULL DEFAULT 'auto'"
            )

        async with db.execute("SELECT id FROM settings WHERE id = 1") as cursor:
            row = await cursor.fetchone()
            if not row:
                await db.execute(
                    """
                    INSERT INTO settings (
                        id, smb_path, smb_username, smb_password, show_special_folder, auto_scan_interval_hours, network_profile, cpu_profile, last_scan_at
                    ) VALUES (1, ?, ?, ?, 0, ?, ?, ?, NULL)
                    """,
                    (
                        normalize_smb_root_path(cfg.smb_path),
                        cfg.smb_username or "",
                        cfg.smb_password or "",
                        cfg.auto_scan_interval_hours or 0,
                        cfg.network_profile or "vpn_high_latency",
                        cfg.cpu_profile or "auto",
                    ),
                )
        await db.commit()
    return db_path


async def get_db_connection() -> aiosqlite.Connection:
    _, _, db_path, _, _ = get_active_paths()
    cfg = load_bootstrap_config()
    conn = await aiosqlite.connect(str(db_path), timeout=10.0)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA busy_timeout=10000;")
    if cfg.network_profile == "local_lan":
        await conn.execute("PRAGMA journal_mode=WAL;")
    return conn
