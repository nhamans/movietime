"""
FastAPI Backend for Self-Hosted SMB Local Media Streaming Web App.
Enforces:
- SQLite DB and thumbnails inside `SMB_ROOT/.media_cache/`
- Dynamic Folder-to-UI mapping (Level 1 -> Segments, Level 2+ -> Categories)
- Strict `"special"` folder visibility rule across all navigation, listing, search,
  watch history, and streaming endpoints (`show_special_folder` default = False).
- Dual-mode streaming engine (`/api/stream/{video_id}`) with HTTP 206 Direct Play
  and on-the-fly FFmpeg remuxing/transcoding + subtitle/audio track inspection.
"""

import asyncio
import json
import shutil
import subprocess
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import (
    BootstrapConfig,
    load_bootstrap_config,
    save_bootstrap_config,
)
from database import get_active_paths, get_db_connection, init_db
from scanner import (
    extract_mkv_or_mp4_duration_fast,
    format_folder_display_name,
    generate_preview_frame,
    generate_seek_thumbnail,
    generate_thumbnail,
    probe_media_file,
    run_library_scan,
    scanner_state,
)
from smb_helper import connect_smb_share, normalize_smb_root_path
from streamer import (
    build_direct_play_response,
    build_ffmpeg_transcode_response,
    get_detected_cpu_info,
    is_direct_play_compatible,
    preview_extraction_semaphore,
    probe_smb_file_speed,
    terminate_all_ffmpeg_processes,
    throughput_tracker,
)


class SettingsUpdateRequest(BaseModel):
    smb_path: Optional[str] = None
    smb_username: Optional[str] = None
    smb_password: Optional[str] = None
    smb_domain: Optional[str] = None
    show_special_folder: Optional[bool] = None
    auto_scan_interval_hours: Optional[int] = None
    network_profile: Optional[str] = None  # 'vpn_high_latency' | 'local_lan'
    cpu_profile: Optional[str] = None  # 'auto' | 'low_power' | 'balanced' | 'high_performance'


class SmbTestRequest(BaseModel):
    smb_path: str
    smb_username: Optional[str] = ""
    smb_password: Optional[str] = ""
    smb_domain: Optional[str] = ""


class WatchProgressUpdate(BaseModel):
    progress_seconds: float
    is_completed: Optional[bool] = None


_periodic_scan_task: Optional[asyncio.Task] = None


async def _periodic_scanner_loop() -> None:
    """Background loop that triggers periodic library scans if configured (e.g., every 6 hours)."""
    while True:
        await asyncio.sleep(60)
        try:
            cfg = load_bootstrap_config()
            interval_hours = cfg.auto_scan_interval_hours
            if interval_hours <= 0 or scanner_state.is_scanning:
                continue

            conn = await get_db_connection()
            try:
                async with conn.execute("SELECT last_scan_at FROM settings WHERE id = 1") as cur:
                    row = await cur.fetchone()
                    last_scan_str = row["last_scan_at"] if row else None
            finally:
                await conn.close()

            if not last_scan_str:
                await run_library_scan()
                continue

            try:
                last_dt = datetime.strptime(last_scan_str, "%Y-%m-%d %H:%M:%S").replace(
                    tzinfo=timezone.utc
                )
                elapsed_hours = (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600.0
                if elapsed_hours >= interval_hours:
                    await run_library_scan()
            except Exception:
                pass
        except asyncio.CancelledError:
            break
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _periodic_scan_task
    await init_db()
    # Perform initial scan in background if database is empty so startup is instantaneous
    conn = await get_db_connection()
    try:
        async with conn.execute("SELECT COUNT(*) AS cnt FROM videos") as cur:
            row = await cur.fetchone()
            count = row["cnt"] if row else 0
    finally:
        await conn.close()

    if count == 0:
        asyncio.create_task(run_library_scan())

    _periodic_scan_task = asyncio.create_task(_periodic_scanner_loop())
    yield
    if _periodic_scan_task:
        _periodic_scan_task.cancel()
    terminate_all_ffmpeg_processes()


app = FastAPI(
    title="MovieTime SMB Media Streaming API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def get_show_special_flag(conn) -> bool:
    async with conn.execute("SELECT show_special_folder FROM settings WHERE id = 1") as cur:
        row = await cur.fetchone()
        return bool(row["show_special_folder"]) if row else False


def serialize_video_row(row: Any) -> Dict[str, Any]:
    d = dict(row)
    ext = d.get("extension", "")
    vcodec = d.get("video_codec", "unknown")
    acodec = d.get("audio_codec", "unknown")
    direct_play = is_direct_play_compatible(ext, vcodec, acodec)
    return {
        "id": d["id"],
        "file_path": d["file_path"],
        "raw_filename": d["raw_filename"],
        "clean_title": d["clean_title"],
        "segment": d["segment"],
        "segment_display": format_folder_display_name(d["segment"]),
        "category": d["category"],
        "category_display": " / ".join(
            format_folder_display_name(part.strip()) for part in d["category"].split("/")
        ),
        "is_special": bool(d["is_special"]),
        "extension": ext,
        "duration_seconds": float(d.get("duration_seconds") or 0.0),
        "resolution": d.get("resolution") or "1080p",
        "video_codec": vcodec,
        "audio_codec": acodec,
        "thumbnail_path": d.get("thumbnail_path"),
        "thumbnail_url": f"/api/thumbnails/{d['id']}",
        "file_size_bytes": int(d.get("file_size_bytes") or 0),
        "created_at": d.get("created_at"),
        "progress_seconds": float(d.get("progress_seconds") or 0.0),
        "is_completed": bool(d.get("is_completed") or False),
        "last_watched_at": d.get("last_watched_at"),
        "stream_mode": "direct" if direct_play else "transcode",
    }


@app.get("/api/navigation")
async def get_navigation():
    """
    Returns dynamic top-level segments (Level 1 folders), categories per segment (Level 2+ folders),
    available resolutions, and file extensions.
    Strictly hides `is_special = 1` records and `special` segments/categories when `show_special_folder = False`.
    """
    conn = await get_db_connection()
    try:
        show_special = await get_show_special_flag(conn)
        where_clause = "" if show_special else "WHERE is_special = 0"

        # Level 1 segments
        async with conn.execute(
            f"""
            SELECT segment, COUNT(*) as video_count, MAX(is_special) as has_special
            FROM videos
            {where_clause}
            GROUP BY segment
            ORDER BY segment COLLATE NOCASE ASC
            """
        ) as cur:
            seg_rows = await cur.fetchall()

        segments = []
        for r in seg_rows:
            seg_name = r["segment"]
            if not show_special and seg_name.lower() == "special":
                continue
            segments.append(
                {
                    "id": seg_name,
                    "name": format_folder_display_name(seg_name),
                    "count": r["video_count"],
                    "is_special": seg_name.lower() == "special",
                }
            )

        # Level 2+ categories grouped by segment
        async with conn.execute(
            f"""
            SELECT segment, category, COUNT(*) as video_count
            FROM videos
            {where_clause}
            GROUP BY segment, category
            ORDER BY category COLLATE NOCASE ASC
            """
        ) as cur:
            cat_rows = await cur.fetchall()

        categories_by_segment: Dict[str, List[Dict[str, Any]]] = {}
        all_categories_map: Dict[str, int] = {}

        for r in cat_rows:
            seg_name = r["segment"]
            cat_name = r["category"]
            if not show_special and (
                seg_name.lower() == "special"
                or any(p.strip().lower() == "special" for p in cat_name.split("/"))
            ):
                continue

            categories_by_segment.setdefault(seg_name, []).append(
                {
                    "id": cat_name,
                    "name": " / ".join(
                        format_folder_display_name(p.strip()) for p in cat_name.split("/")
                    ),
                    "count": r["video_count"],
                }
            )
            all_categories_map[cat_name] = all_categories_map.get(cat_name, 0) + r["video_count"]

        # Distinct extensions and resolutions for filter dropdowns
        async with conn.execute(
            f"SELECT DISTINCT extension FROM videos {where_clause} ORDER BY extension ASC"
        ) as cur:
            extensions = [row["extension"] for row in await cur.fetchall() if row["extension"]]

        async with conn.execute(
            f"SELECT DISTINCT resolution FROM videos {where_clause} ORDER BY resolution ASC"
        ) as cur:
            resolutions = [row["resolution"] for row in await cur.fetchall() if row["resolution"]]

        return {
            "show_special_folder": show_special,
            "segments": segments,
            "categories_by_segment": categories_by_segment,
            "all_categories": [
                {
                    "id": k,
                    "name": " / ".join(format_folder_display_name(p.strip()) for p in k.split("/")),
                    "count": v,
                }
                for k, v in sorted(all_categories_map.items())
            ],
            "extensions": extensions,
            "resolutions": resolutions,
        }
    finally:
        await conn.close()


@app.get("/api/videos")
async def list_videos(
    segment: Optional[str] = Query(None, description="Level 1 segment filter"),
    category: Optional[str] = Query(None, description="Level 2+ category filter"),
    search: Optional[str] = Query(None, description="Instant search query"),
    extension: Optional[str] = Query(None, description="File extension filter e.g. .mkv, .mp4"),
    resolution: Optional[str] = Query(None, description="Resolution filter e.g. 1080p, 4K"),
    sort_by: str = Query("recent", description="recent | alpha | duration"),
):
    """
    Multi-faceted video listing and instant search endpoint.
    Strictly excludes `is_special = 1` records unless `show_special_folder` is enabled in Settings.
    """
    conn = await get_db_connection()
    try:
        show_special = await get_show_special_flag(conn)
        conditions: List[str] = []
        params: List[Any] = []

        if not show_special:
            conditions.append("v.is_special = 0")

        if segment and segment.lower() != "all":
            conditions.append("LOWER(v.segment) = LOWER(?)")
            params.append(segment)

        if category and category.lower() != "all":
            conditions.append("LOWER(v.category) = LOWER(?)")
            params.append(category)

        if extension and extension.lower() != "all":
            ext_norm = extension if extension.startswith(".") else f".{extension}"
            conditions.append("LOWER(v.extension) = LOWER(?)")
            params.append(ext_norm)

        if resolution and resolution.lower() != "all":
            conditions.append("LOWER(v.resolution) = LOWER(?)")
            params.append(resolution)

        if search and search.strip():
            q = f"%{search.strip()}%"
            conditions.append(
                "(v.clean_title LIKE ? COLLATE NOCASE OR v.raw_filename LIKE ? COLLATE NOCASE OR v.file_path LIKE ? COLLATE NOCASE OR v.category LIKE ? COLLATE NOCASE)"
            )
            params.extend([q, q, q, q])

        where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        if sort_by == "alpha":
            order_sql = "ORDER BY v.clean_title COLLATE NOCASE ASC"
        elif sort_by == "duration":
            order_sql = "ORDER BY v.duration_seconds DESC, v.clean_title COLLATE NOCASE ASC"
        else:
            order_sql = "ORDER BY v.created_at DESC, v.id DESC"

        query = f"""
            SELECT
                v.*,
                w.progress_seconds,
                w.is_completed,
                w.updated_at AS last_watched_at
            FROM videos v
            LEFT JOIN watch_history w ON w.video_id = v.id
            {where_sql}
            {order_sql}
        """
        async with conn.execute(query, params) as cur:
            rows = await cur.fetchall()

        return {
            "total": len(rows),
            "show_special_folder": show_special,
            "videos": [serialize_video_row(r) for r in rows],
        }
    finally:
        await conn.close()


@app.get("/api/continue-watching")
async def get_continue_watching():
    """
    Returns in-progress videos ordered by most recently watched.
    Respects `show_special_folder` state so restricted videos immediately disappear when disabled.
    """
    conn = await get_db_connection()
    try:
        show_special = await get_show_special_flag(conn)
        special_filter = "" if show_special else "AND v.is_special = 0"

        query = f"""
            SELECT
                v.*,
                w.progress_seconds,
                w.is_completed,
                w.updated_at AS last_watched_at
            FROM watch_history w
            JOIN videos v ON v.id = w.video_id
            WHERE w.progress_seconds > 5
              AND w.is_completed = 0
              {special_filter}
            ORDER BY w.updated_at DESC
            LIMIT 20
        """
        async with conn.execute(query) as cur:
            rows = await cur.fetchall()

        return {
            "videos": [serialize_video_row(r) for r in rows],
        }
    finally:
        await conn.close()


@app.get("/api/videos/{video_id}")
async def get_video_details(video_id: int):
    """
    Fetch single video details, available subtitle/audio tracks, and the "Next Video in Folder"
    for seamless binge-watching.
    Blocks access if `is_special = 1` and `show_special_folder = False`.
    """
    conn = await get_db_connection()
    try:
        show_special = await get_show_special_flag(conn)
        async with conn.execute(
            """
            SELECT
                v.*,
                w.progress_seconds,
                w.is_completed,
                w.updated_at AS last_watched_at
            FROM videos v
            LEFT JOIN watch_history w ON w.video_id = v.id
            WHERE v.id = ?
            """,
            (video_id,),
        ) as cur:
            row = await cur.fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Video not found")

        if bool(row["is_special"]) and not show_special:
            raise HTTPException(
                status_code=403,
                detail="Access restricted: 'special' folder content is currently hidden in Settings.",
            )

        smb_root, _, _, _, _ = get_active_paths()
        full_video_path = smb_root / Path(row["file_path"])
        video_data = serialize_video_row(row)

        # Move duration header probe into background task so `/api/videos/{id}` never blocks!
        if video_data["duration_seconds"] <= 0 and full_video_path.exists():
            async def _bg_probe(vid: int, vpath: Path):
                try:
                    fast_dur = await asyncio.to_thread(extract_mkv_or_mp4_duration_fast, vpath)
                    probed = await asyncio.to_thread(probe_media_file, vpath)
                    final_dur = probed["duration_seconds"] if probed["duration_seconds"] > 0 else fast_dur
                    if final_dur > 0:
                        c = await get_db_connection()
                        try:
                            await c.execute(
                                """
                                UPDATE videos
                                SET duration_seconds = ?, resolution = ?, video_codec = ?, audio_codec = ?
                                WHERE id = ?
                                """,
                                (
                                    final_dur,
                                    probed["resolution"],
                                    probed["video_codec"],
                                    probed["audio_codec"],
                                    vid,
                                ),
                            )
                            await c.commit()
                        finally:
                            await c.close()
                except Exception:
                    pass

            asyncio.create_task(_bg_probe(video_id, full_video_path))

        # Find sibling videos in the same segment & category for "Next Episode / Next Video in Folder"
        special_cond = "" if show_special else "AND v.is_special = 0"
        async with conn.execute(
            f"""
            SELECT
                v.*,
                w.progress_seconds,
                w.is_completed,
                w.updated_at AS last_watched_at
            FROM videos v
            LEFT JOIN watch_history w ON w.video_id = v.id
            WHERE v.segment = ? AND v.category = ? {special_cond}
            ORDER BY v.file_path COLLATE NOCASE ASC
            """,
            (row["segment"], row["category"]),
        ) as cur:
            sibling_rows = await cur.fetchall()

        siblings = [serialize_video_row(s) for s in sibling_rows]
        next_video = None
        prev_video = None
        for idx, s in enumerate(siblings):
            if s["id"] == video_id:
                if idx + 1 < len(siblings):
                    next_video = siblings[idx + 1]
                if idx - 1 >= 0:
                    prev_video = siblings[idx - 1]
                break

        # Discover external .srt / .vtt subtitles ONLY if we don't have to scan a slow VPN directory synchronously
        subtitles = []

        video_data["next_video"] = next_video
        video_data["prev_video"] = prev_video
        video_data["folder_playlist"] = siblings
        video_data["subtitles"] = subtitles

        # Run a quick 256 KB SMB connection speed probe so the player can display
        # live connection speed (KB/s / Mbps) and automatically pick the best quality tier!
        if full_video_path.exists():
            probe_info = await asyncio.to_thread(
                probe_smb_file_speed,
                full_video_path,
                float(video_data.get("duration_seconds") or 0.0),
                int(video_data.get("file_size_bytes") or 0),
                video_data["stream_mode"] == "direct",
            )
            video_data["connection_probe"] = probe_info

        return video_data
    finally:
        await conn.close()


@app.get("/api/subtitles/{video_id}")
async def stream_subtitle_vtt(video_id: int, file: Optional[str] = Query(None)):
    """
    Serves `.vtt` or converts `.srt` to `WebVTT` on the fly for the HTML5 video player.
    """
    conn = await get_db_connection()
    try:
        show_special = await get_show_special_flag(conn)
        async with conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Video not found")
        if bool(row["is_special"]) and not show_special:
            raise HTTPException(status_code=403, detail="Special folder content is hidden")

        smb_root, _, _, _, _ = get_active_paths()
        video_path = smb_root / Path(row["file_path"])
        if not file:
            raise HTTPException(status_code=404, detail="Subtitle filename required")

        candidate = (video_path.parent / file).resolve()
        if candidate.parent != video_path.parent.resolve() or not candidate.exists():
            raise HTTPException(status_code=404, detail="Subtitle file not found")

        raw_text = candidate.read_text(encoding="utf-8", errors="replace")
        if candidate.suffix.lower() == ".srt":
            # Convert SRT comma timestamps (00:01:20,000) to WebVTT dot timestamps (00:01:20.000)
            import re

            vtt_body = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", raw_text)
            vtt_content = "WEBVTT\n\n" + vtt_body
        else:
            vtt_content = raw_text

        return Response(content=vtt_content, media_type="text/vtt")
    finally:
        await conn.close()


@app.get("/api/thumbnails/{video_id}")
async def get_video_thumbnail(video_id: int):
    """
    Serves the generated poster thumbnail from `SMB_ROOT/.media_cache/thumbnails/`.
    If only the instant SVG placeholder exists so far, triggers a background task to
    lazily extract the real `.jpg` frame without blocking the HTTP response.
    """
    conn = await get_db_connection()
    try:
        show_special = await get_show_special_flag(conn)
        async with conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Video not found")
        if bool(row["is_special"]) and not show_special:
            raise HTTPException(status_code=403, detail="Special folder content is hidden")

        smb_root, cache_dir, _, _, _ = get_active_paths()
        thumbnails_dir = cache_dir / "thumbnails"
        video_path = smb_root / Path(row["file_path"])
        thumb_rel = row["thumbnail_path"]

        # Check if a real .jpg thumbnail already exists in `.media_cache/thumbnails/`
        import hashlib
        digest = hashlib.md5(row["file_path"].encode("utf-8")).hexdigest()[:16]
        jpg_candidate = thumbnails_dir / f"{digest}.jpg"
        if jpg_candidate.exists() and jpg_candidate.stat().st_size > 0:
            return FileResponse(str(jpg_candidate), media_type="image/jpeg")

        if thumb_rel:
            thumb_full = smb_root / Path(thumb_rel)
            if thumb_full.exists():
                media_type = (
                    "image/svg+xml"
                    if thumb_full.suffix.lower() == ".svg"
                    else "image/jpeg"
                )
                return FileResponse(str(thumb_full), media_type=media_type)

        raise HTTPException(status_code=404, detail="Thumbnail not found")
    finally:
        await conn.close()


@app.get("/api/previews/{video_id}")
async def get_video_preview_frame(
    video_id: int,
    frame: int = Query(1, ge=1, le=6, description="Preview frame sequence number (1..6)"),
):
    """
    Serves a 6-step hover preview frame sequence (`frame=1..6`) cached inside
    `SMB_ROOT/.media_cache/thumbnails/`.
    Strictly enforces `show_special_folder` visibility rules.
    """
    conn = await get_db_connection()
    try:
        show_special = await get_show_special_flag(conn)
        async with conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Video not found")
        if bool(row["is_special"]) and not show_special:
            raise HTTPException(status_code=403, detail="Special folder content is hidden")

        smb_root, cache_dir, _, _, _ = get_active_paths()
        video_path = smb_root / Path(row["file_path"])
        thumbnails_dir = cache_dir / "thumbnails"

        # Serialize FFmpeg preview extractions (max 1 at a time) so hovering quickly over
        # cards never overloads a low-spec laptop's CPU or SMB connection
        async with preview_extraction_semaphore:
            frame_path, media_type = await asyncio.to_thread(
                generate_preview_frame,
                video_path,
                thumbnails_dir,
                row["file_path"],
                row["clean_title"],
                row["segment"],
                row["resolution"] or "1080p",
                float(row["duration_seconds"] or 0.0),
                frame,
            )
        return FileResponse(
            str(frame_path),
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )
    finally:
        await conn.close()


@app.get("/api/seek-thumb/{video_id}")
async def get_seek_thumbnail(
    video_id: int,
    t: float = Query(0.0, ge=0.0, description="Seekbar hover timestamp in seconds"),
):
    """
    Serves a mini 240x135 thumbnail for the seekbar hover tooltip at timestamp `t` (seconds),
    quantized to 30s intervals and cached inside `SMB_ROOT/.media_cache/thumbnails/`.
    """
    conn = await get_db_connection()
    try:
        show_special = await get_show_special_flag(conn)
        async with conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Video not found")
        if bool(row["is_special"]) and not show_special:
            raise HTTPException(status_code=403, detail="Special folder content is hidden")

        smb_root, cache_dir, _, _, _ = get_active_paths()
        video_path = smb_root / Path(row["file_path"])
        thumbnails_dir = cache_dir / "thumbnails"

        async with preview_extraction_semaphore:
            thumb_path, media_type = await asyncio.to_thread(
                generate_seek_thumbnail,
                video_path,
                thumbnails_dir,
                row["file_path"],
                row["clean_title"],
                float(row["duration_seconds"] or 0.0),
                t,
            )
        return FileResponse(
            str(thumb_path),
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )
    finally:
        await conn.close()


@app.get("/api/stream/{video_id}")
async def stream_video(
    video_id: int,
    request: Request,
    start: float = Query(0.0, description="Seek start timestamp in seconds for transcoding"),
    mode: Optional[str] = Query(None, description="Optional override: direct | transcode"),
    quality: str = Query("original", description="Quality preset: original | 1080p | 720p | 480p"),
    audio_track: int = Query(0, description="Audio stream index for multi-audio MKVs"),
):
    """
    Universal Video Streaming & Transcoding Endpoint (`/api/stream/{video_id}`).
    - Blocks playback with HTTP 403 if `is_special = 1` and `show_special_folder = False`.
    - Uses Direct Play (HTTP 206 Partial Content byte-range requests) for browser-native files
      when `quality == 'original'`.
    - Uses On-the-Fly FFmpeg Remuxing/Transcoding (`-c:v copy` or `libx264` -> fragmented MP4)
      for `.mkv`, `.avi`, `.flv`, unsupported codecs, or when a lower bitrate quality preset
      (`1080p` 8Mbps, `720p` 4Mbps, `480p` 1.5Mbps) is chosen for smooth Blu-ray streaming.
    """
    conn = await get_db_connection()
    try:
        show_special = await get_show_special_flag(conn)
        async with conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)) as cur:
            row = await cur.fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Video not found")

        # Strict enforcement of Restricted "special" Folder Visibility Rule (Section 2.4)
        if bool(row["is_special"]) and not show_special:
            raise HTTPException(
                status_code=403,
                detail="Playback blocked: 'special' folder content is currently disabled in Settings.",
            )

        smb_root, _, _, _, _ = get_active_paths()
        full_path = smb_root / Path(row["file_path"])
        if not full_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Media file not found at {full_path}",
            )

        ext = row["extension"] or full_path.suffix.lower()
        vcodec = row["video_codec"] or "unknown"
        acodec = row["audio_codec"] or "unknown"
        quality_norm = (quality or "original").lower()
        cfg = load_bootstrap_config()
        net_profile = cfg.network_profile or "vpn_high_latency"
        cpu_prof = cfg.cpu_profile or "auto"

        use_direct = is_direct_play_compatible(ext, vcodec, acodec)
        # Keep native .mp4/.webm files on HTTP 206 Direct Play when quality is 'original' or 'auto'
        # so 1-2 Mbps MP4 movies stream directly with zero FFmpeg startup overhead!
        if mode == "transcode" or start > 0 or audio_track > 0 or quality_norm not in {"original", "auto"}:
            use_direct = False
        elif mode == "direct":
            use_direct = True

        if use_direct:
            return await build_direct_play_response(
                full_path, request, ext, network_profile=net_profile
            )
        return await build_ffmpeg_transcode_response(
            full_path,
            request,
            video_codec=vcodec,
            audio_codec=acodec,
            start_seconds=start,
            audio_stream_index=audio_track,
            quality=quality_norm,
            network_profile=net_profile,
            cpu_profile=cpu_prof,
        )
    finally:
        await conn.close()


@app.post("/api/watch-history/{video_id}")
async def update_watch_history(video_id: int, payload: WatchProgressUpdate):
    """
    Auto-saves playback progress every 10 seconds to SQLite `watch_history` table.
    Marks `is_completed = 1` if progress reaches >= 92% of total video duration.
    """
    conn = await get_db_connection()
    try:
        async with conn.execute(
            "SELECT id, duration_seconds FROM videos WHERE id = ?", (video_id,)
        ) as cur:
            video = await cur.fetchone()
        if not video:
            raise HTTPException(status_code=404, detail="Video not found")

        duration = float(video["duration_seconds"] or 0.0)
        progress = max(0.0, float(payload.progress_seconds))
        if payload.is_completed is not None:
            completed = payload.is_completed
        else:
            completed = duration > 0 and (progress / duration) >= 0.92

        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        await conn.execute(
            """
            INSERT INTO watch_history (video_id, progress_seconds, is_completed, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
                progress_seconds = excluded.progress_seconds,
                is_completed = excluded.is_completed,
                updated_at = excluded.updated_at
            """,
            (video_id, progress, 1 if completed else 0, now_str),
        )
        await conn.commit()
        return {
            "video_id": video_id,
            "progress_seconds": progress,
            "is_completed": bool(completed),
            "updated_at": now_str,
        }
    finally:
        await conn.close()


@app.delete("/api/watch-history/{video_id}")
async def clear_watch_history_item(video_id: int):
    conn = await get_db_connection()
    try:
        await conn.execute("DELETE FROM watch_history WHERE video_id = ?", (video_id,))
        await conn.commit()
        return {"status": "removed", "video_id": video_id}
    finally:
        await conn.close()


@app.get("/api/settings")
async def get_settings():
    """
    Returns current SMB configuration, `show_special_folder` toggle state,
    database path inside `SMB_ROOT/.media_cache/media_library.db`, and library stats.
    """
    cfg = load_bootstrap_config()
    smb_root, cache_dir, db_path, is_reachable, conn_msg = get_active_paths()
    conn = await get_db_connection()
    try:
        async with conn.execute("SELECT * FROM settings WHERE id = 1") as cur:
            s_row = await cur.fetchone()

        async with conn.execute(
            "SELECT COUNT(*) AS total, SUM(CASE WHEN is_special = 1 THEN 1 ELSE 0 END) AS special_cnt FROM videos"
        ) as cur:
            counts = await cur.fetchone()

        show_special = bool(s_row["show_special_folder"]) if s_row else False
        last_scan_at = s_row["last_scan_at"] if s_row else None
        auto_scan_hours = (
            int(s_row["auto_scan_interval_hours"])
            if s_row and "auto_scan_interval_hours" in s_row.keys()
            else cfg.auto_scan_interval_hours
        )

        net_profile = (
            s_row["network_profile"]
            if s_row and "network_profile" in s_row.keys() and s_row["network_profile"]
            else (cfg.network_profile or "vpn_high_latency")
        )
        cpu_prof = (
            s_row["cpu_profile"]
            if s_row and "cpu_profile" in s_row.keys() and s_row["cpu_profile"]
            else (cfg.cpu_profile or "auto")
        )
        cpu_info = get_detected_cpu_info(cpu_prof)

        return {
            "smb_path": s_row["smb_path"] if s_row else cfg.smb_path,
            "smb_username": s_row["smb_username"] if s_row else (cfg.smb_username or ""),
            "has_password": bool(
                (s_row["smb_password"] if s_row else "") or cfg.smb_password
            ),
            "smb_domain": cfg.smb_domain or "",
            "show_special_folder": show_special,
            "auto_scan_interval_hours": auto_scan_hours,
            "network_profile": net_profile,
            "cpu_profile": cpu_prof,
            "cpu_info": cpu_info,
            "last_scan_at": last_scan_at,
            "resolved_smb_root": str(smb_root),
            "database_file_path": str(db_path),
            "thumbnails_dir_path": str(cache_dir / "thumbnails"),
            "smb_connected": is_reachable,
            "connection_message": conn_msg,
            "ffmpeg_installed": bool(shutil.which("ffmpeg")),
            "ffprobe_installed": bool(shutil.which("ffprobe")),
            "total_indexed_videos": int(counts["total"] or 0),
            "special_indexed_videos": int(counts["special_cnt"] or 0),
            "scanner": scanner_state.to_dict(),
        }
    finally:
        await conn.close()


@app.put("/api/settings")
async def update_settings(payload: SettingsUpdateRequest):
    """
    Updates SMB configuration and/or `show_special_folder` visibility toggle.
    Persists immediately in SQLite `settings` table inside `SMB_ROOT/.media_cache/media_library.db`
    without requiring a full rescan when toggling `show_special_folder`.
    """
    cfg = load_bootstrap_config()

    if payload.smb_path is not None and payload.smb_path.strip():
        cfg.smb_path = normalize_smb_root_path(payload.smb_path.strip())
    if payload.smb_username is not None:
        cfg.smb_username = payload.smb_username.strip()
    if payload.smb_password is not None and payload.smb_password != "********":
        cfg.smb_password = payload.smb_password
    if payload.smb_domain is not None:
        cfg.smb_domain = payload.smb_domain.strip()
    if payload.auto_scan_interval_hours is not None:
        cfg.auto_scan_interval_hours = max(0, int(payload.auto_scan_interval_hours))
    if payload.network_profile is not None and payload.network_profile in {"vpn_high_latency", "local_lan"}:
        cfg.network_profile = payload.network_profile
    if payload.cpu_profile is not None and payload.cpu_profile in {"auto", "low_power", "balanced", "high_performance"}:
        cfg.cpu_profile = payload.cpu_profile

    save_bootstrap_config(cfg)

    conn = await get_db_connection()
    try:
        async with conn.execute("SELECT * FROM settings WHERE id = 1") as cur:
            current = await cur.fetchone()

        new_show_special = (
            payload.show_special_folder
            if payload.show_special_folder is not None
            else (bool(current["show_special_folder"]) if current else False)
        )
        new_auto_scan = (
            payload.auto_scan_interval_hours
            if payload.auto_scan_interval_hours is not None
            else cfg.auto_scan_interval_hours
        )
        new_net_profile = (
            payload.network_profile
            if payload.network_profile in {"vpn_high_latency", "local_lan"}
            else (cfg.network_profile or "vpn_high_latency")
        )
        new_cpu_profile = (
            payload.cpu_profile
            if payload.cpu_profile in {"auto", "low_power", "balanced", "high_performance"}
            else (cfg.cpu_profile or "auto")
        )

        await conn.execute(
            """
            UPDATE settings
            SET smb_path = ?,
                smb_username = ?,
                smb_password = ?,
                show_special_folder = ?,
                auto_scan_interval_hours = ?,
                network_profile = ?,
                cpu_profile = ?
            WHERE id = 1
            """,
            (
                cfg.smb_path,
                cfg.smb_username or "",
                cfg.smb_password or "",
                1 if new_show_special else 0,
                new_auto_scan,
                new_net_profile,
                new_cpu_profile,
            ),
        )
        await conn.commit()
    finally:
        await conn.close()

    return await get_settings()


@app.post("/api/settings/test-connection")
async def test_smb_connection(payload: SmbTestRequest):
    """
    Tests read/write access to the user-entered SMB path and verifies ability to create
    `SMB_ROOT/.media_cache/media_library.db`.
    """
    ok, msg, resolved_root = await asyncio.to_thread(
        connect_smb_share,
        payload.smb_path,
        payload.smb_username,
        payload.smb_password,
        payload.smb_domain,
    )
    return {
        "success": ok,
        "message": msg,
        "resolved_root": str(resolved_root),
        "expected_db_path": str(resolved_root / ".media_cache" / "media_library.db"),
    }


@app.post("/api/scan")
async def trigger_library_scan(background_tasks: BackgroundTasks, wait: bool = Query(False)):
    """
    Triggers a library scan across `SMB_ROOT`.
    If `wait=true`, waits for completion and returns final statistics; otherwise runs in background
    and streams progress via `/api/scan/status`.
    """
    if scanner_state.is_scanning:
        return scanner_state.to_dict()

    if wait:
        return await run_library_scan()

    background_tasks.add_task(run_library_scan)
    return {
        "status": "started",
        "scanner": scanner_state.to_dict(),
    }


@app.get("/api/scan/status")
async def get_scan_status():
    return scanner_state.to_dict()


@app.get("/api/network/telemetry")
async def get_network_telemetry():
    """
    Returns real-time SMB / stream transfer speed (`KB/s` and `Mbps`) so the video player
    can display live network speed in the control bar and preparing overlay.
    """
    return throughput_tracker.to_dict()


# Serve built frontend static bundle (`frontend/dist`) so the entire app runs on one port (8000)
FRONTEND_DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if FRONTEND_DIST_DIR.exists():
    assets_dir = FRONTEND_DIST_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa_frontend(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API endpoint not found")
        candidate = FRONTEND_DIST_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(str(candidate))
        index_html = FRONTEND_DIST_DIR / "index.html"
        if index_html.is_file():
            return FileResponse(str(index_html))
        raise HTTPException(status_code=404, detail="Frontend build not found")

