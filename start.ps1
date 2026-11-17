$ErrorActionPreference = "Stop"

# 1. Auto-discover Python, Node.js (standard, fnm, nvm), and Scoop shims (FFmpeg) if not already on PATH
$CandidateDirs = @(
    "$env:LOCALAPPDATA\Python\bin",
    "$env:LOCALAPPDATA\Programs\Python\Python312",
    "$env:USERPROFILE\scoop\shims"
)
if (Test-Path "$env:APPDATA\fnm\node-versions") {
    Get-ChildItem "$env:APPDATA\fnm\node-versions\*\installation" -ErrorAction SilentlyContinue | ForEach-Object {
        $CandidateDirs += $_.FullName
    }
}
foreach ($p in $CandidateDirs) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) {
        $env:PATH = "$p;$env:PATH"
    }
}

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $RootDir "backend"
$FrontendDir = Join-Path $RootDir "frontend"

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  MovieTime — Self-Hosted SMB Local Media Streamer   " -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan

# 2. Check FFmpeg (Non-blocking — starts immediately and installs FFmpeg in background if missing)
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "[i] FFmpeg not yet installed — starting web app immediately using built-in SVG poster & Direct Play mode." -ForegroundColor Yellow
    Write-Host "    (To install FFmpeg later for .mkv/.avi transcoding, run: scoop install ffmpeg)" -ForegroundColor Gray
} else {
    Write-Host "[OK] FFmpeg detected: $((Get-Command ffmpeg).Source)" -ForegroundColor Green
}

# 3. Ensure Python virtual environment & dependencies
Set-Location $BackendDir
$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Host "[*] Creating Python virtual environment in backend\.venv..." -ForegroundColor Yellow
    python -m venv .venv
    & $VenvPython -m pip install -r requirements.txt
}

# 4. Ensure Frontend production bundle is built (`frontend/dist`)
$DistIndex = Join-Path $FrontendDir "dist\index.html"
if (-not (Test-Path $DistIndex)) {
    Write-Host "[*] Building frontend UI bundle..." -ForegroundColor Yellow
    Set-Location $FrontendDir
    npm.cmd install
    npm.cmd run build
}

# 5. Launch unified FastAPI + Frontend server on http://localhost:8000
Set-Location $BackendDir
Write-Host ""
Write-Host "[READY] Starting MovieTime Web App at: http://localhost:8000" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor Gray
Write-Host ""

Start-Job -ScriptBlock {
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/scan/status" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
            Start-Process "http://localhost:8000"
            break
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
} | Out-Null
& $VenvPython -m uvicorn main:app --host 0.0.0.0 --port 8000
