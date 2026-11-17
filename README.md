# MovieTime — Self-Hosted SMB Local Media Streaming Web App

A lightweight, high-performance, self-hosted local media streaming web application designed to index, organize, and stream video files directly from a network SMB share (e.g., `\\10.10.10.10\Videos` or `\\192.168.1.10\Videos`) served via a router-attached HDD or NAS over a LAN or VPN connection.

---

## Key Features & Architecture

1. **Portable Self-Contained Library State on SMB (`SMB_ROOT/.media_cache/`):**
   - Both the SQLite database (`media_library.db`) and generated poster/preview thumbnails (`/.media_cache/thumbnails/`) are stored directly inside the configured master SMB root directory (e.g., `\\10.10.10.10\Videos\.media_cache\media_library.db`).
2. **Dynamic Folder-to-UI Mapping:**
   - **Level 1 Subfolders $\rightarrow$ Top-Level Navigation Segments:** Immediate subfolders inside `SMB_ROOT` (e.g., `movies`, `tv-series`, `music-videos`) automatically become top navigation tabs with clean display formatting (`Music Videos`).
   - **Level 2+ Subfolders $\rightarrow$ Categories / Series Grouping:** Nested folders become filterable categories or series groupings (e.g., `Sci-Fi`, `Breaking Bad / Season 1`), while top-level files default to `Uncategorized`.
3. **Restricted `"special"` Folder Visibility Rule (`show_special_folder = false` by default):**
   - Any folder named `special` (case-insensitive) at **any directory depth** (Level 1 segment or Level 2+ category) is flagged with `is_special = 1` during scanning.
   - While disabled (`false`), `special` segments, categories, and videos are strictly excluded from `/api/navigation`, `/api/videos`, `/api/continue-watching`, search results, and blocked at `/api/stream/{video_id}` (HTTP 403).
   - Toggling **"Show 'Special' Folder Content"** in `/settings` updates SQLite immediately and unlocks `special` content across the UI without requiring a rescan.
4. **Universal Video Streaming, Pre-Flight Speed Probe & Adaptive Engine (`/api/stream/{video_id}`):**
   - **Pre-Flight Connection Speed Probe & Live Speed Meter:** Measures live SMB transfer throughput (`KB/s` / `Mbps`) before starting playback and automatically selects the optimal quality tier (`Original`, `1080p`, `720p`, `480p`, or `360p`), while displaying a live throughput gauge in the player control bar.
   - **Direct Play (HTTP 206 Partial Content):** Streams browser-compatible `.mp4`, `.webm`, and `.m4v` (H.264/AAC) files via byte-range requests (`Accept-Ranges: bytes`) with zero CPU overhead.
   - **On-the-Fly FFmpeg Remuxing / Transcoding:** Automatically spawns an `ffmpeg` subprocess for `.mkv`, `.avi`, `.flv`, or `HEVC`/`AC3`/`DTS` media—supporting both zero-CPU video passthrough (`-c:v copy`) and bitrate-capped downscaling (`1080p`, `720p`, `480p`, `360p`) with time-based seeking (`?start=seconds`), seekbar hover thumbnail previews, and automatic cleanup of orphaned FFmpeg processes.
5. **Hardware-Aware CPU & Network Profiles (`/settings`):**
   - **Auto-Detected CPU Multi-Core Scaling:** Automatically detects host logical CPU cores (e.g., capping at 2 threads on dual-core Intel i3 laptops while scaling up to 6+ parallel threads on 8-thread Intel i7 / Ryzen processors), with manual override options (`Auto`, `Eco / Low-Power`, `Balanced`, `High Performance`).
   - **Network & Storage Profiles:** Switch between **SMB over VPN (High Latency Tunnel)** (uses SQLite `DELETE` journal mode, 2 MB read-ahead buffers, and 1 MB SMB2 pipelined chunks) and **Local Disk / Direct Gigabit LAN** (uses SQLite `WAL` mode and low-latency micro-fragments).

---

## System Requirements

Because MovieTime automatically detects your CPU core count and supports both zero-CPU Direct Play/Remux and multi-core transcoding, it runs smoothly across a wide range of hardware:

| Tier | CPU | RAM | Network / Storage | Recommended Profile in Settings |
| :--- | :--- | :--- | :--- | :--- |
| **Minimum (Entry Laptop / Mini-PC)** | Intel Core i3 / Celeron / Dual-Core (2–4 threads) | 4 GB RAM | Wi-Fi / VPN Tunnel (`2+ Mbps`) | **CPU:** `Auto` or `Eco / Low-Power (2 Threads)`<br>**Quality:** `Original (Copy)` for MP4/H.264 or `360p`/`480p` for MKV |
| **Recommended (Mainstream Laptop / Desktop)** | Intel Core i5 / i7 (8th Gen+) or AMD Ryzen 5 / 7 (8+ threads) | 8 GB+ RAM | Gigabit LAN, Wi-Fi 5/6, or WireGuard/OpenVPN (`5+ Mbps`) | **CPU:** `Auto` or `High Performance Parallel`<br>**Quality:** `Auto Adaptive` or `720p` / `1080p` |

### Required Software Dependencies
- **Node.js**: v18.0+ (LTS recommended)
- **Python**: v3.10+
- **FFmpeg & FFprobe**: v6.0+ on system `PATH`

---

## Quick Start (Open Source — 2 Commands)

Anyone who clones this repository on **Windows, Linux, or macOS** (with Node.js and Python 3.10+ installed) can set up and run the entire application from the root folder with:

```bash
npm install
npm start
```

- **`npm install`** automatically creates `backend/.venv`, installs the Python backend requirements (`requirements.txt`), installs frontend dependencies, and builds the production React UI (`frontend/dist`).
- **`npm start`** launches the unified FastAPI + React web server at **`http://localhost:8000`**.

### Windows One-Click Shortcuts (Optional)
On Windows, you can also double-click or run:
- **`.\start.bat`** — Starts the server and opens `http://localhost:8000` in your browser.
- **`.\stop.bat`** — Stops the server on port `8000` and cleans up any active `ffmpeg` transcoding processes (or press **`Ctrl + C`** in the terminal).

---

## Installing FFmpeg & Connecting SMB Shares

### 1. Install FFmpeg & FFprobe
- **Windows (Scoop, Winget, or Chocolatey):**
  ```powershell
  scoop install ffmpeg
  # or
  winget install Gyan.FFmpeg
  ```
- **Linux (Ubuntu/Debian):**
  ```bash
  sudo apt update && sudo apt install -y ffmpeg cifs-utils
  ```
- **macOS (Homebrew):**
  ```bash
  brew install ffmpeg
  ```

### 2. SMB Network Share Setup (LAN / VPN)

#### Windows (`\\10.10.10.10\Videos` or `\\192.168.1.10\Videos`)
1. Ensure your LAN or VPN connection can reach your SMB host IP (e.g., `10.10.10.10`).
2. In the MovieTime **Settings** page (`http://localhost:8000`), enter `\\10.10.10.10\Videos` (and optional SMB username/password if your router/NAS share is password-protected).
3. Select **SMB over VPN (High Latency Tunnel)** if connecting remotely over a VPN, or **Local Disk / Direct Gigabit LAN** if on your home network.
4. Click **Test SMB Connection** to verify read/write access to `\\10.10.10.10\Videos\.media_cache\media_library.db`, then click **Save Configuration** and **Scan & Sync Library**.

#### Linux (`/mnt/smb/videos`)
Mount the router SMB share via `cifs-utils`:
```bash
sudo mkdir -p /mnt/smb/videos
sudo mount -t cifs //10.10.10.10/Videos /mnt/smb/videos -o username=guest,password=,uid=$(id -u),gid=$(id -g),iocharset=utf8
```
Then set `SMB_ROOT` in MovieTime Settings to `/mnt/smb/videos`.
