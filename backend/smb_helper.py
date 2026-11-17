"""
SMB & Local Filesystem Abstraction Layer.
Supports:
1. Windows UNC paths (`\\\\10.10.10.10\\Videos` or `\\\\192.168.1.10\\Videos`) with optional `net use` credential mounting
   or `smbprotocol` session registration (`smbclient.register_session`).
2. Linux mounted CIFS paths (`/mnt/smb/videos`) or SMB URLs (`smb://10.10.10.10/Videos`).
3. Direct local filesystem paths for testing / mounted network drives.
"""

import os
import platform
import re
import subprocess
from pathlib import Path
from typing import Dict, Optional, Tuple

try:
    import smbclient  # from smbprotocol
    HAS_SMBPROTOCOL = True
except ImportError:
    HAS_SMBPROTOCOL = False


def normalize_smb_root_path(raw_path: str) -> str:
    """
    Normalize user-provided SMB or local path.
    Converts `smb://10.10.10.10/Videos` to `\\\\10.10.10.10\\Videos` on Windows
    or keeps standard POSIX path on Linux.
    """
    path = raw_path.strip()
    if path.lower().startswith("smb://"):
        cleaned = path[6:].strip("/")
        if platform.system().lower() == "windows":
            return "\\\\" + cleaned.replace("/", "\\")
        return "/" + cleaned
    return path


def extract_unc_server_and_share(path: str) -> Optional[Tuple[str, str]]:
    """
    Extract (server, share) from a UNC path like `\\\\10.10.10.10\\Videos\\subfolder`.
    """
    normalized = path.replace("/", "\\")
    match = re.match(r"^\\\\([^\\]+)\\([^\\]+)", normalized)
    if match:
        return match.group(1), match.group(2)
    return None


def connect_smb_share(
    smb_path: str,
    username: Optional[str] = None,
    password: Optional[str] = None,
    domain: Optional[str] = None,
) -> Tuple[bool, str, Path]:
    """
    Establishes access to the SMB share if credentials/UNC path are provided,
    and verifies read/write capability on `SMB_ROOT/.media_cache/`.
    Returns `(success, message, resolved_root_path)`.
    """
    norm_path = normalize_smb_root_path(smb_path)
    unc_info = extract_unc_server_and_share(norm_path)

    # 1. If UNC path + credentials provided, register session via smbprotocol and/or Windows `net use`
    if unc_info and username and password:
        server, share = unc_info
        if HAS_SMBPROTOCOL:
            try:
                auth_user = f"{domain}\\{username}" if domain else username
                smbclient.register_session(
                    server,
                    username=auth_user,
                    password=password,
                    connection_timeout=8,
                )
            except Exception:
                pass

        if platform.system().lower() == "windows":
            share_root = f"\\\\{server}\\{share}"
            user_arg = f"/user:{domain}\\{username}" if domain else f"/user:{username}"
            try:
                subprocess.run(
                    ["net", "use", share_root, password, user_arg, "/persistent:no"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
            except Exception:
                pass

    root = Path(norm_path)
    try:
        if not root.exists():
            return False, f"Path does not exist or is unreachable: {norm_path}", root

        cache_dir = root / ".media_cache"
        thumbs_dir = cache_dir / "thumbnails"
        thumbs_dir.mkdir(parents=True, exist_ok=True)

        # Verify write permission inside SMB_ROOT/.media_cache
        probe_file = cache_dir / ".write_test"
        probe_file.write_text("ok", encoding="utf-8")
        probe_file.unlink(missing_ok=True)

        db_path = cache_dir / "media_library.db"
        return (
            True,
            f"Connected to {norm_path}. Read/write verified for {db_path}.",
            root,
        )
    except PermissionError as exc:
        return False, f"Permission denied accessing '{norm_path}': {exc}", root
    except OSError as exc:
        return False, f"OS/Network error accessing '{norm_path}': {exc}", root
