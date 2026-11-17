@echo off
echo Stopping MovieTime server on port 8000...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$conns = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue; " ^
  "if ($conns) { $conns | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host '[OK] MovieTime server stopped.' -ForegroundColor Green } else { Write-Host '[i] No server is currently running on port 8000.' -ForegroundColor Yellow }; " ^
  "Get-Process ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
pause
