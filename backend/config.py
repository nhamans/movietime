"""
Bootstrap configuration manager.
Stores the configured master SMB root path and optional credentials locally in
`backend/bootstrap_config.json`, while the primary SQLite database (`media_library.db`)
and generated thumbnails (`/.media_cache/thumbnails/`) are stored directly inside
`SMB_ROOT/.media_cache/` as required by the specification so the library state is
portable and self-contained on the router HDD.
"""

import json
import os
import pathlib
from typing import Optional
from pydantic import BaseModel

BACKEND_DIR = pathlib.Path(__file__).resolve().parent
BOOTSTRAP_CONFIG_FILE = BACKEND_DIR / "bootstrap_config.json"
DEFAULT_DEMO_MEDIA_DIR = BACKEND_DIR / "demo_media"


class BootstrapConfig(BaseModel):
    smb_path: str = str(DEFAULT_DEMO_MEDIA_DIR)
    smb_username: Optional[str] = ""
    smb_password: Optional[str] = ""
    smb_domain: Optional[str] = ""
    auto_scan_interval_hours: int = 0  # 0 = disabled, e.g. 6 = every 6 hours
    network_profile: str = "vpn_high_latency"  # 'vpn_high_latency' | 'local_lan'
    cpu_profile: str = "auto"  # 'auto' | 'low_power' | 'balanced' | 'high_performance'


def ensure_demo_media_dir() -> pathlib.Path:
    """Create a realistic local sample directory structure so the app runs out-of-the-box before SMB is configured."""
    DEFAULT_DEMO_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    (DEFAULT_DEMO_MEDIA_DIR / ".media_cache" / "thumbnails").mkdir(parents=True, exist_ok=True)
    for folder in [
        "movies/Sci-Fi",
        "movies/Action",
        "tv-series/Breaking Bad/Season 1",
        "music-videos/Live Sessions",
        "special/Private Vault",
    ]:
        (DEFAULT_DEMO_MEDIA_DIR / folder).mkdir(parents=True, exist_ok=True)
    return DEFAULT_DEMO_MEDIA_DIR


def load_bootstrap_config() -> BootstrapConfig:
    ensure_demo_media_dir()
    if BOOTSTRAP_CONFIG_FILE.exists():
        try:
            data = json.loads(BOOTSTRAP_CONFIG_FILE.read_text(encoding="utf-8"))
            return BootstrapConfig(**data)
        except Exception:
            pass
    cfg = BootstrapConfig(smb_path=str(DEFAULT_DEMO_MEDIA_DIR))
    save_bootstrap_config(cfg)
    return cfg


def save_bootstrap_config(cfg: BootstrapConfig) -> None:
    BOOTSTRAP_CONFIG_FILE.write_text(
        json.dumps(cfg.model_dump(), indent=2),
        encoding="utf-8",
    )
