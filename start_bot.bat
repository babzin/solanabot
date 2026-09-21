@echo off
title Soul Terminal & Solana Early Trending Bot
cd /d "%~dp0"
echo ============================================================
echo   SOUL TERMINAL & SOLANA EARLY TRENDING BOT (@solearlytrending)
echo ============================================================
echo [1/3] Ensuring port 3001 is clear...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do (
    echo Freeing port 3001 from previous instance (PID %%a)...
    taskkill /F /PID %%a >nul 2>&1
)

echo [2/3] Verifying dependencies...
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo [3/3] Launching Bot Runner, Webhook Gateway & Daily Discovery...
echo.
call npm start
pause
