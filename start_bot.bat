@echo off
title Soul Terminal & Solana Early Trending Bot (Turbo Engine)
cd /d "%~dp0"
echo ============================================================
echo   ⚡ SOUL TERMINAL & SOLANA EARLY TRENDING BOT (@solearlytrending)
echo   High-Performance Real-Time Engine (Sub-Second Latency)
echo ============================================================
echo [1/2] Ensuring port 3001 is ready...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo [2/2] Launching Bot Runner & High-Speed Radar Engine...
echo.
call npx tsx --dns-result-order=ipv4first src/index.ts
pause
