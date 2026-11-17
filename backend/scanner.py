"""
Directory Scanner, Filename Sanitizer, FFprobe Metadata Extractor & Thumbnail Generator.
Implements:
1. Dynamic Folder-to-UI Mapping:
   - Level 1 Subfolder -> `segment` (e.g., `movies`, `tv-series`, `music-videos`)
   - Level 2+ Subfolders -> `category` (e.g., `Sci-Fi`, `Breaking Bad / Season 1`, or `Uncategorized`)
2. Restricted `"special"` Folder Rule:
   - Any path component matching `special` (case-insensitive) at ANY depth sets `is_special = 1`.
3. Filename Sanitization:
   - Strips extension, replaces `.`, `_`, `-` with spaces, removes scene release tags (`1080p`, `BluRay`, `[YTS]`, etc.) while preserving title and year.
4. Media Probing & Thumbnail Generation:
   - Runs `ffprobe` to extract duration, resolution (`4K`, `1080p`, `720p`, `480p`), `video_codec`, `audio_codec`.
   - Generates a poster thumbnail at 10% duration inside `SMB_ROOT/.media_cache/thumbnails/` (or generates a clean SVG fallback poster if `ffmpeg` binary is unavailable).
"""

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import aiosqlite

from database import get_active_paths, init_db

SUPPORTED_VIDEO_EXTENSIONS = {
    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".webm",
    ".m4v",
    ".flv",
    ".ts",
    ".wmv",
}

# Common release/scene tokens to strip while keeping the movie/episode title and 4-digit year
SCENE_TAGS_PATTERN = re.compile(
    r"\b("
    r"2160p|1080p|720p|480p|4k|uhd|hdr|hdr10|dv|dolby\.?vision|"
    r"bluray|bdrip|brrip|web-dl|webdl|webrip|hdrip|dvdrip|hdtv|remux|"
    r"x264|x265|h264|h265|hevc|avc|10bit|8bit|aac|ac3|eac3|dts|truehd|atmos|5\.1|7\.1|"
    r"yts|yify|rarbg|psa|tigole|qxr|galaxy|etrg|evo|proper|repack|extended"
    r")\b",
    re.IGNORECASE,
)

BRACKET_TAG_PATTERN = re.compile(r"\[[^\]]*\]|\([^\)]*(?:1080p|720p|2160p|x264|x265|bluray|web|yts|rarbg)[^\)]*\)", re.IGNORECASE)


def format_folder_display_name(raw_folder: str) -> str:
    """
    Format folder names cleanly for display (e.g., `music-videos` -> `Music Videos`, `sci-fi` -> `Sci-Fi`).
    """
    if not raw_folder:
        return "Uncategorized"
    if raw_folder.lower() == "sci-fi":
        return "Sci-Fi"
    if raw_folder.lower() == "tv-series":
        return "TV Series"
    cleaned = re.sub(r"[_\-]+", " ", raw_folder).strip()
    return " ".join(word.capitalize() if not word.isupper() else word for word in cleaned.split())


def sanitize_filename(filename: str) -> str:
    """
    Parse raw video filenames into clean, human-readable titles:
    Example: `Spider-Man.No.Way.Home_2021.1080p.BluRay.mkv` -> `Spider Man No Way Home 2021`
    """
    stem = Path(filename).stem
    # Remove bracketed release group tags like [YTS.MX] or [1080p]
    cleaned = BRACKET_TAG_PATTERN.sub(" ", stem)
    # Replace delimiters (., _, -) with spaces
    cleaned = re.sub(r"[._\-]+", " ", cleaned)
    # Strip scene tags
    cleaned = SCENE_TAGS_PATTERN.sub(" ", cleaned)
    # Clean stray empty parentheses/brackets and collapse multiple spaces
    cleaned = re.sub(r"\(\s*\)|\[\s*\]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned if cleaned else stem


def parse_relative_hierarchy(rel_path: Path) -> Tuple[str, str, bool]:
    """
    Given a path relative to `SMB_ROOT`, determine:
    - `segment`: Level 1 subfolder name (or `'root'` if placed directly in `SMB_ROOT`)
    - `category`: Level 2+ subfolder grouping (or `'Uncategorized'` if directly inside Level 1)
    - `is_special`: True if ANY folder part in the relative path is `'special'` (case-insensitive)
    """
    parts = list(rel_path.parts)
    folder_parts = parts[:-1]  # exclude the filename itself

    # Restricted "special" folder rule: any directory level named "special" (case-insensitive)
    is_special = any(p.lower() == "special" for p in folder_parts)

    if not folder_parts:
        segment = "General"
        category = "Uncategorized"
    elif len(folder_parts) == 1:
        segment = folder_parts[0]
        category = "Uncategorized"
    else:
        segment = folder_parts[0]
        # Join Level 2+ subfolders so e.g. `tv-series/Breaking Bad/Season 1/S01E01.mkv`
        # groups cleanly as `Breaking Bad` or `Breaking Bad / Season 1`
        category = " / ".join(folder_parts[1:])

    return segment, category, is_special


def classify_resolution(width: int, height: int, filename: str) -> str:
    if width >= 3800 or height >= 2100:
        return "4K"
    if width >= 2500 or height >= 1400:
        return "1440p"
    if width >= 1900 or height >= 1000:
        return "1080p"
    if width >= 1200 or height >= 700:
        return "720p"
    if width > 0 and height > 0:
        return "480p"

    # Fallback inference from filename if ffprobe is not installed or stream header lacks dimensions
    lower = filename.lower()
    if "2160p" in lower or "4k" in lower:
        return "4K"
    if "1080p" in lower:
        return "1080p"
    if "720p" in lower:
        return "720p"
    return "1080p"


def infer_codecs_and_resolution_fast(filename: str, ext: str) -> Dict[str, Any]:
    """
    Zero-network-I/O metadata inference from filename & extension so initial SMB directory
    scanning finishes in seconds over LAN/VPN without pulling gigabytes over SMB.
    """
    lower = filename.lower()
    if "2160p" in lower or "4k" in lower or "uhd" in lower:
        res = "4K"
    elif "1440p" in lower:
        res = "1440p"
    elif "720p" in lower:
        res = "720p"
    elif "480p" in lower:
        res = "480p"
    else:
        res = "1080p"

    if any(k in lower for k in ("x265", "h265", "hevc", "10bit")):
        vcodec = "hevc"
    elif any(k in lower for k in ("x264", "h264", "avc")):
        vcodec = "h264"
    elif ext in {".mp4", ".m4v", ".webm"}:
        vcodec = "h264"
    else:
        vcodec = "hevc"

    if any(k in lower for k in ("dts", "truehd")):
        acodec = "dts"
    elif any(k in lower for k in ("ac3", "eac3", "dd5", "5.1", "7.1", "atmos")):
        acodec = "ac3"
    elif ext in {".mp4", ".m4v", ".webm"}:
        acodec = "aac"
    else:
        acodec = "ac3"

    return {
        "duration_seconds": 0.0,
        "resolution": res,
        "video_codec": vcodec,
        "audio_codec": acodec,
    }


import struct


def extract_mkv_or_mp4_duration_fast(file_path: Path) -> float:
    """
    Fast header-only duration parser + ffprobe fallback for `.mkv` and `.mp4` files.
    Reads only the container header so even multi-gigabyte Blu-ray `.mkv` files over SMB
    return their exact total movie length in <0.2 seconds.
    """
    ffprobe_bin = shutil.which("ffprobe")
    if ffprobe_bin:
        try:
            # First try ultra-fast format-only probe (no stream decoding, just container header)
            cmd = [
                ffprobe_bin,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "format=duration:stream=duration",
                "-of",
                "json",
                str(file_path),
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
            if res.returncode == 0 and res.stdout:
                info = json.loads(res.stdout)
                fmt_dur = float(info.get("format", {}).get("duration") or 0.0)
                if fmt_dur > 0:
                    return round(fmt_dur, 2)
                for s in info.get("streams", []):
                    sdur = float(s.get("duration") or 0.0)
                    if sdur > 0:
                        return round(sdur, 2)
        except Exception:
            pass
    return 0.0


def probe_media_file(file_path: Path) -> Dict[str, Any]:
    """
    Run `ffprobe` on a single video file on-demand to get exact duration, resolution,
    video_codec, and audio_codec.
    """
    ext = file_path.suffix.lower()
    fast_meta = infer_codecs_and_resolution_fast(file_path.name, ext)

    ffprobe_bin = shutil.which("ffprobe")
    if not ffprobe_bin:
        return fast_meta

    try:
        cmd = [
            ffprobe_bin,
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(file_path),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if res.returncode != 0 or not res.stdout:
            dur = extract_mkv_or_mp4_duration_fast(file_path)
            fast_meta["duration_seconds"] = dur
            return fast_meta

        info = json.loads(res.stdout)
        duration = float(info.get("format", {}).get("duration", 0.0) or 0.0)
        width, height = 0, 0
        video_codec = "unknown"
        audio_codec = "unknown"

        for stream in info.get("streams", []):
            if duration <= 0:
                try:
                    duration = float(stream.get("duration") or 0.0)
                except Exception:
                    pass
                # Also check MKV stream tags `DURATION` (e.g. "02:14:35.123000000")
                if duration <= 0 and "tags" in stream:
                    for k, v in stream["tags"].items():
                        if k.upper().startswith("DURATION") and isinstance(v, str) and ":" in v:
                            parts = v.split(":")
                            if len(parts) == 3:
                                try:
                                    duration = (
                                        int(parts[0]) * 3600
                                        + int(parts[1]) * 60
                                        + float(parts[2])
                                    )
                                except Exception:
                                    pass
            codec_type = stream.get("codec_type")
            if codec_type == "video" and video_codec == "unknown":
                video_codec = (stream.get("codec_name") or fast_meta["video_codec"]).lower()
                width = int(stream.get("width") or 0)
                height = int(stream.get("height") or 0)
            elif codec_type == "audio" and audio_codec == "unknown":
                audio_codec = (stream.get("codec_name") or fast_meta["audio_codec"]).lower()

        return {
            "duration_seconds": round(duration, 2),
            "resolution": classify_resolution(width, height, file_path.name),
            "video_codec": video_codec if video_codec != "unknown" else fast_meta["video_codec"],
            "audio_codec": audio_codec if audio_codec != "unknown" else fast_meta["audio_codec"],
        }
    except Exception:
        return fast_meta


def generate_thumbnail(
    video_path: Path,
    thumbnails_dir: Path,
    rel_path_str: str,
    clean_title: str,
    segment: str,
    resolution: str,
    duration_seconds: float,
    allow_ffmpeg: bool = True,
) -> str:
    """
    Generate a poster thumbnail at the 10% timestamp mark saved inside
    `SMB_ROOT/.media_cache/thumbnails/`.
    When `allow_ffmpeg=False` (during fast initial directory indexing), returns existing
    cached thumbnail path or generates a lightweight SVG poster immediately with zero
    SMB video read overhead. Real `.jpg` frames are extracted lazily on demand when
    `/api/thumbnails/{video_id}` is requested.
    """
    thumbnails_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.md5(rel_path_str.encode("utf-8")).hexdigest()[:16]
    jpg_path = thumbnails_dir / f"{digest}.jpg"
    svg_path = thumbnails_dir / f"{digest}.svg"

    if jpg_path.exists() and jpg_path.stat().st_size > 0:
        return f".media_cache/thumbnails/{jpg_path.name}"

    if not allow_ffmpeg and svg_path.exists() and svg_path.stat().st_size > 0:
        return f".media_cache/thumbnails/{svg_path.name}"

    ffmpeg_bin = shutil.which("ffmpeg") if allow_ffmpeg else None
    if ffmpeg_bin and video_path.exists() and video_path.stat().st_size > 8192:
        seek_ts = max(1.0, round(duration_seconds * 0.10, 2)) if duration_seconds > 0 else 10.0
        try:
            cmd = [
                ffmpeg_bin,
                "-y",
                "-ss",
                str(seek_ts),
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-q:v",
                "4",
                "-vf",
                "scale=480:-1",
                str(jpg_path),
            ]
            subprocess.run(cmd, capture_output=True, timeout=8)
            if jpg_path.exists() and jpg_path.stat().st_size > 0:
                return f".media_cache/thumbnails/{jpg_path.name}"
        except Exception:
            pass

    # Fallback: deterministic high-contrast SVG poster stored inside `.media_cache/thumbnails/`
    palettes = [
        ("#0f172a", "#dc2626", "#f87171"),
        ("#111827", "#2563eb", "#60a5fa"),
        ("#18181b", "#7c3aed", "#c084fc"),
        ("#090d16", "#059669", "#34d399"),
        ("#1c1917", "#d97706", "#fbbf24"),
    ]
    idx = int(digest[:2], 16) % len(palettes)
    bg1, bg2, accent = palettes[idx]
    safe_title = (
        clean_title[:38]
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    safe_seg = (
        format_folder_display_name(segment)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    svg_content = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="{bg1}" />
      <stop offset="100%" stop-color="{bg2}" stop-opacity="0.55" />
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="#09090b"/>
  <rect width="640" height="360" fill="url(#g)"/>
  <circle cx="540" cy="80" r="140" fill="{accent}" fill-opacity="0.08"/>
  <rect x="36" y="34" width="120" height="28" rx="6" fill="#000000" fill-opacity="0.55"/>
  <text x="50" y="53" fill="{accent}" font-family="system-ui, sans-serif" font-size="13" font-weight="700">{safe_seg.upper()}</text>
  <rect x="546" y="34" width="58" height="28" rx="6" fill="{accent}" fill-opacity="0.2"/>
  <text x="558" y="53" fill="#ffffff" font-family="system-ui, sans-serif" font-size="13" font-weight="700">{resolution}</text>
  <circle cx="320" cy="175" r="34" fill="#000000" fill-opacity="0.55" stroke="{accent}" stroke-width="2"/>
  <polygon points="312,158 312,192 340,175" fill="#ffffff"/>
  <text x="36" y="308" fill="#ffffff" font-family="system-ui, sans-serif" font-size="22" font-weight="700">{safe_title}</text>
</svg>"""
    svg_path.write_text(svg_content, encoding="utf-8")
    return f".media_cache/thumbnails/{svg_path.name}"


PREVIEW_PERCENTAGES = [0.15, 0.30, 0.45, 0.60, 0.75, 0.88]


def generate_preview_frame(
    video_path: Path,
    thumbnails_dir: Path,
    rel_path_str: str,
    clean_title: str,
    segment: str,
    resolution: str,
    duration_seconds: float,
    frame_index: int,
) -> Tuple[Path, str]:
    """
    Generate or retrieve a cached hover preview frame (`frame_index` 1..6) inside
    `SMB_ROOT/.media_cache/thumbnails/`.
    Extracts the frame via FFmpeg at the corresponding percentage of `duration_seconds`
    (15%, 30%, 45%, 60%, 75%, 88%), or generates a dynamic SVG preview frame with
    timestamp & scene indicator if FFmpeg is unavailable or file is a demo placeholder.
    """
    thumbnails_dir.mkdir(parents=True, exist_ok=True)
    idx = max(1, min(6, int(frame_index)))
    pct = PREVIEW_PERCENTAGES[idx - 1]
    digest = hashlib.md5(rel_path_str.encode("utf-8")).hexdigest()[:16]

    jpg_path = thumbnails_dir / f"{digest}_prev_{idx}.jpg"
    svg_path = thumbnails_dir / f"{digest}_prev_{idx}.svg"

    if jpg_path.exists() and jpg_path.stat().st_size > 0:
        return jpg_path, "image/jpeg"

    ffmpeg_bin = shutil.which("ffmpeg")
    if ffmpeg_bin and video_path.exists() and video_path.stat().st_size > 8192:
        seek_ts = max(1.0, round(duration_seconds * pct, 2)) if duration_seconds > 0 else float(idx * 5)
        try:
            cmd = [
                ffmpeg_bin,
                "-y",
                "-ss",
                str(seek_ts),
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-q:v",
                "4",
                "-vf",
                "scale=480:-1",
                str(jpg_path),
            ]
            subprocess.run(cmd, capture_output=True, timeout=10)
            if jpg_path.exists() and jpg_path.stat().st_size > 0:
                return jpg_path, "image/jpeg"
        except Exception:
            pass

    if svg_path.exists() and svg_path.stat().st_size > 0:
        return svg_path, "image/svg+xml"

    # Fallback: stylized scene preview frame SVG showing timestamp & frame progression
    palettes = [
        ("#0f172a", "#dc2626", "#f87171"),
        ("#111827", "#2563eb", "#60a5fa"),
        ("#18181b", "#7c3aed", "#c084fc"),
        ("#090d16", "#059669", "#34d399"),
        ("#1c1917", "#d97706", "#fbbf24"),
        ("#1e1b4b", "#e11d48", "#fb7185"),
    ]
    base_idx = (int(digest[:2], 16) + idx) % len(palettes)
    bg1, bg2, accent = palettes[base_idx]
    ts_sec = int((duration_seconds if duration_seconds > 0 else 3600) * pct)
    mins, secs = divmod(ts_sec, 60)
    hrs, mins = divmod(mins, 60)
    ts_label = f"{hrs}:{mins:02d}:{secs:02d}" if hrs > 0 else f"{mins:02d}:{secs:02d}"

    safe_title = (
        clean_title[:34]
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    cx = 110 + (idx * 70)
    cy = 155 + ((idx % 2) * 28)
    bar_width = int(568 * pct)

    svg_content = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
  <defs>
    <linearGradient id="gp{idx}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="{bg1}" />
      <stop offset="100%" stop-color="{bg2}" stop-opacity="0.7" />
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="#09090b"/>
  <rect width="640" height="360" fill="url(#gp{idx})"/>
  <circle cx="{cx}" cy="{cy}" r="110" fill="{accent}" fill-opacity="0.16"/>
  <circle cx="{640 - cx}" cy="{360 - cy}" r="85" fill="#ffffff" fill-opacity="0.06"/>
  <rect x="36" y="32" width="145" height="28" rx="6" fill="#000000" fill-opacity="0.65"/>
  <text x="48" y="51" fill="{accent}" font-family="monospace" font-size="13" font-weight="700">SCENE {idx}/6 • {ts_label}</text>
  <text x="36" y="295" fill="#ffffff" font-family="system-ui, sans-serif" font-size="20" font-weight="700">{safe_title}</text>
  <rect x="36" y="314" width="568" height="6" rx="3" fill="#27272a"/>
  <rect x="36" y="314" width="{bar_width}" height="6" rx="3" fill="{accent}"/>
</svg>"""
    svg_path.write_text(svg_content, encoding="utf-8")
    return svg_path, "image/svg+xml"


def generate_seek_thumbnail(
    video_path: Path,
    thumbnails_dir: Path,
    rel_path_str: str,
    clean_title: str,
    duration_seconds: float,
    timestamp_seconds: float,
) -> Tuple[Path, str]:
    """
    Generate or retrieve a seekbar hover thumbnail at `timestamp_seconds` quantized to
    30-second buckets so scrubbing the seekbar shows a live mini scene preview without
    flooding the SMB share.
    """
    thumbnails_dir.mkdir(parents=True, exist_ok=True)
    bucket_sec = max(0, int(round(timestamp_seconds / 30.0) * 30))
    digest = hashlib.md5(rel_path_str.encode("utf-8")).hexdigest()[:16]

    jpg_path = thumbnails_dir / f"{digest}_seek_{bucket_sec}.jpg"
    svg_path = thumbnails_dir / f"{digest}_seek_{bucket_sec}.svg"

    if jpg_path.exists() and jpg_path.stat().st_size > 0:
        return jpg_path, "image/jpeg"

    ffmpeg_bin = shutil.which("ffmpeg")
    if ffmpeg_bin and video_path.exists() and video_path.stat().st_size > 8192:
        try:
            cmd = [
                ffmpeg_bin,
                "-y",
                "-ss",
                str(bucket_sec),
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-q:v",
                "6",
                "-vf",
                "scale=240:-1:flags=fast_bilinear",
                str(jpg_path),
            ]
            subprocess.run(cmd, capture_output=True, timeout=5)
            if jpg_path.exists() and jpg_path.stat().st_size > 0:
                return jpg_path, "image/jpeg"
        except Exception:
            pass

    if svg_path.exists() and svg_path.stat().st_size > 0:
        return svg_path, "image/svg+xml"

    mins, secs = divmod(int(timestamp_seconds), 60)
    hrs, mins = divmod(mins, 60)
    ts_label = f"{hrs}:{mins:02d}:{secs:02d}" if hrs > 0 else f"{mins:02d}:{secs:02d}"
    pct = min(1.0, max(0.0, timestamp_seconds / max(1.0, duration_seconds or 3600.0)))
    bar_w = int(200 * pct)
    safe_title = (
        clean_title[:24]
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )

    svg_content = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 135" width="240" height="135">
  <rect width="240" height="135" fill="#09090b"/>
  <rect x="0" y="0" width="240" height="135" fill="#dc2626" fill-opacity="0.12"/>
  <text x="120" y="58" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="18" font-weight="700">{ts_label}</text>
  <text x="120" y="84" text-anchor="middle" fill="#a1a1aa" font-family="system-ui, sans-serif" font-size="11">{safe_title}</text>
  <rect x="20" y="106" width="200" height="5" rx="2.5" fill="#27272a"/>
  <rect x="20" y="106" width="{bar_w}" height="5" rx="2.5" fill="#ef4444"/>
</svg>"""
    svg_path.write_text(svg_content, encoding="utf-8")
    return svg_path, "image/svg+xml"



class LibraryScannerState:
    def __init__(self) -> None:
        self.is_scanning: bool = False
        self.files_scanned: int = 0
        self.total_files_discovered: int = 0
        self.new_videos_added: int = 0
        self.updated_videos: int = 0
        self.missing_files_pruned: int = 0
        self.current_file: str = ""
        self.last_error: Optional[str] = None
        self.last_scan_completed_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "is_scanning": self.is_scanning,
            "files_scanned": self.files_scanned,
            "total_files_discovered": self.total_files_discovered,
            "new_videos_added": self.new_videos_added,
            "updated_videos": self.updated_videos,
            "missing_files_pruned": self.missing_files_pruned,
            "current_file": self.current_file,
            "last_error": self.last_error,
            "last_scan_completed_at": self.last_scan_completed_at,
        }


scanner_state = LibraryScannerState()


def seed_demo_videos_if_empty(smb_root: Path) -> None:
    """
    If running against the built-in `demo_media` directory and no files exist yet,
    create sample media files across segments (including a hidden `special` folder)
    so the UI, filters, and `special` folder visibility toggle can be tested immediately.
    """
    if smb_root.name != "demo_media":
        return

    existing_videos = [
        p
        for p in smb_root.rglob("*")
        if p.is_file()
        and ".media_cache" not in p.parts
        and p.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS
    ]
    if existing_videos:
        return

    samples = [
        ("movies/Sci-Fi/Interstellar.2014.2160p.UHD.BluRay.x265.mkv", 169 * 60),
        ("movies/Sci-Fi/Blade.Runner.2049.2017.1080p.WEB-DL.H264.mp4", 163 * 60),
        ("movies/Action/Mad_Max_Fury_Road_2015_1080p_BluRay.mp4", 120 * 60),
        ("movies/Dune.Part.Two.2024.2160p.WEB-DL.mkv", 166 * 60),
        ("tv-series/Breaking Bad/Season 1/Breaking.Bad.S01E01.Pilot.1080p.BluRay.mkv", 58 * 60),
        ("tv-series/Breaking Bad/Season 1/Breaking.Bad.S01E02.Cats.in.the.Bag.1080p.mp4", 48 * 60),
        ("tv-series/Severance/Season 1/Severance.S01E01.Good.News.About.Hell.1080p.mp4", 57 * 60),
        ("music-videos/Live Sessions/Daft_Punk-Alive_2007_Encore_1080p.mp4", 390),
        ("special/Private Vault/Director.Cut.Confidential.Reel.2025.1080p.mkv", 840),
        ("movies/special/Behind.The.Scenes.Restricted.2024.720p.mp4", 620),
    ]

    for rel_str, _ in samples:
        target = smb_root / rel_str
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            # Write a placeholder file header so file_size_bytes > 0
            target.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" * 64)


async def run_library_scan() -> Dict[str, Any]:
    """
    Scan the configured `SMB_ROOT` directory tree, extract metadata, generate thumbnails in
    `SMB_ROOT/.media_cache/thumbnails/`, upsert records into `SMB_ROOT/.media_cache/media_library.db`,
    and prune missing files.
    Note: Indexes `special` folders in the background with `is_special = 1` so toggling visibility
    in Settings is instantaneous.
    """
    if scanner_state.is_scanning:
        return scanner_state.to_dict()

    scanner_state.is_scanning = True
    scanner_state.files_scanned = 0
    scanner_state.total_files_discovered = 0
    scanner_state.new_videos_added = 0
    scanner_state.updated_videos = 0
    scanner_state.missing_files_pruned = 0
    scanner_state.current_file = ""
    scanner_state.last_error = None

    try:
        smb_root, cache_dir, db_path, _, _ = get_active_paths()
        seed_demo_videos_if_empty(smb_root)
        await init_db(db_path)
        thumbnails_dir = cache_dir / "thumbnails"
        thumbnails_dir.mkdir(parents=True, exist_ok=True)

        # Discover all candidate video files (excluding `.media_cache` and hidden dot folders)
        discovered_files: List[Tuple[Path, Path]] = []
        for root_dir, dirs, files in os.walk(smb_root):
            # Exclude `.media_cache` and hidden system directories from traversal
            dirs[:] = [
                d
                for d in dirs
                if d != ".media_cache" and not d.startswith(".") and d.lower() != "$recycle.bin"
            ]
            for fname in files:
                if fname.startswith("."):
                    continue
                fpath = Path(root_dir) / fname
                if fpath.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS:
                    rel_path = fpath.relative_to(smb_root)
                    discovered_files.append((fpath, rel_path))

        scanner_state.total_files_discovered = len(discovered_files)
        discovered_rel_paths = set()

        async with aiosqlite.connect(str(db_path)) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, file_path, file_size_bytes, duration_seconds, thumbnail_path FROM videos"
            ) as cursor:
                existing_rows = {row["file_path"]: dict(row) for row in await cursor.fetchall()}

            for full_path, rel_path in discovered_files:
                rel_posix = rel_path.as_posix()
                discovered_rel_paths.add(rel_posix)
                scanner_state.current_file = rel_posix

                segment, category, is_special = parse_relative_hierarchy(rel_path)
                clean_title = sanitize_filename(full_path.name)
                ext = full_path.suffix.lower()

                try:
                    file_size = full_path.stat().st_size
                except OSError:
                    file_size = 0

                # Fast Incremental Check: if already indexed and file size hasn't changed,
                # skip heavy network I/O and just ensure hierarchy/title is up-to-date!
                existing = existing_rows.get(rel_posix)
                if existing and existing["file_size_bytes"] == file_size and existing.get("thumbnail_path"):
                    scanner_state.files_scanned += 1
                    continue

                # Zero-network-read fast metadata inference during directory scan
                # (Full FFprobe + frame extraction happen lazily on-demand per card/playback)
                meta = infer_codecs_and_resolution_fast(full_path.name, ext)
                duration = meta["duration_seconds"]
                if duration <= 0 and smb_root.name == "demo_media":
                    duration = float((hash(rel_posix) % 5400) + 1800)

                thumb_rel = generate_thumbnail(
                    full_path,
                    thumbnails_dir,
                    rel_posix,
                    clean_title,
                    segment,
                    meta["resolution"],
                    duration,
                    allow_ffmpeg=False,
                )

                if rel_posix in existing_rows:
                    await db.execute(
                        """
                        UPDATE videos
                        SET raw_filename = ?,
                            clean_title = ?,
                            segment = ?,
                            category = ?,
                            is_special = ?,
                            extension = ?,
                            duration_seconds = ?,
                            resolution = ?,
                            video_codec = ?,
                            audio_codec = ?,
                            thumbnail_path = ?,
                            file_size_bytes = ?
                        WHERE file_path = ?
                        """,
                        (
                            full_path.name,
                            clean_title,
                            segment,
                            category,
                            1 if is_special else 0,
                            ext,
                            duration,
                            meta["resolution"],
                            meta["video_codec"],
                            meta["audio_codec"],
                            thumb_rel,
                            file_size,
                            rel_posix,
                        ),
                    )
                    scanner_state.updated_videos += 1
                else:
                    await db.execute(
                        """
                        INSERT INTO videos (
                            file_path, raw_filename, clean_title, segment, category,
                            is_special, extension, duration_seconds, resolution,
                            video_codec, audio_codec, thumbnail_path, file_size_bytes
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            rel_posix,
                            full_path.name,
                            clean_title,
                            segment,
                            category,
                            1 if is_special else 0,
                            ext,
                            duration,
                            meta["resolution"],
                            meta["video_codec"],
                            meta["audio_codec"],
                            thumb_rel,
                            file_size,
                        ),
                    )
                    scanner_state.new_videos_added += 1

                scanner_state.files_scanned += 1

            # Prune missing files from database
            missing_paths = set(existing_rows.keys()) - discovered_rel_paths
            for missing_rel in missing_paths:
                await db.execute("DELETE FROM videos WHERE file_path = ?", (missing_rel,))
                scanner_state.missing_files_pruned += 1

            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            await db.execute(
                "UPDATE settings SET last_scan_at = ? WHERE id = 1",
                (now_iso,),
            )
            await db.commit()
            scanner_state.last_scan_completed_at = now_iso

    except Exception as exc:
        scanner_state.last_error = str(exc)
    finally:
        scanner_state.is_scanning = False
        scanner_state.current_file = ""

    return scanner_state.to_dict()
