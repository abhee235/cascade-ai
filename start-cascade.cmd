@echo off
setlocal enabledelayedexpansion
REM The repo is wherever THIS script lives (%~dp0), so a clone works without editing anything.
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
title Cascade launcher

echo ============================================
echo    Starting Cascade  (server + web UI)
echo ============================================
echo.

REM --- 1) Docker Desktop: the server runs preview builds in Docker sandboxes ---
docker info >nul 2>&1
if !errorlevel! equ 0 (
  echo [ok]  Docker engine already running.
) else (
  echo [..]  Docker not up - launching Docker Desktop...
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
)

set /a tries=0
:waitdocker
docker info >nul 2>&1
if !errorlevel! equ 0 goto dockerok
set /a tries+=1
if !tries! geq 25 (
  echo [warn] Docker still not ready after ~75s - continuing anyway ^(previews may fail^).
  goto dockerok
)
echo       ...waiting for Docker engine ^(!tries!/25^)
timeout /t 3 >nul
goto waitdocker
:dockerok
echo [ok]  Docker engine ready.
echo.

REM --- 2) Ollama (native Windows app; normally auto-starts in the tray) ---
ollama ps >nul 2>&1 || echo [note] Ollama not responding - open the Ollama app if you want local models.
echo.

REM --- 3) Server window: ws://localhost:4319  (+ preview proxy 4320) ---
REM Output is TEE'd to logs\server.log: a console window scrolls away and is gone, which is exactly what
REM happened when a build died mid-turn and the stack trace went with it. Tee-Object keeps the live view.
if not exist "%REPO%\logs" mkdir "%REPO%\logs"
echo [..]  Starting server...  (log: %REPO%\logs\server.log)
start "Cascade Server" cmd /k "cd /d %REPO%\packages\server && powershell -NoProfile -Command "npm run dev 2>&1 ^| Tee-Object -FilePath '%REPO%\logs\server.log' -Append""

REM --- 4) Web UI window: http://localhost:5319 ---
echo [..]  Starting web UI...
start "Cascade Web" cmd /k "cd /d %REPO%\packages\web && npm run dev"

REM --- 5) Open the browser once Vite has warmed up ---
timeout /t 7 >nul
start "" http://localhost:5319

echo.
echo   Server : ws://localhost:4319
echo   Web UI : http://localhost:5319   (opening in your browser)
echo.
echo Two windows opened (Server + Web). Close them to stop Cascade.
echo You can close THIS window.
pause
