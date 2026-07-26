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

REM --- 2) Ollama: ensure it runs with Cascade-compatible settings ---
REM The env below is applied when THIS script starts `ollama serve`. IMPORTANT: if Ollama is already
REM running we LEAVE IT ALONE — the loaded model and its KV/prefix cache live in the Ollama process, so
REM they SURVIVE a Cascade restart (your next request is a cache hit). Restarting Ollama here would
REM destroy that cache on every launch. To apply changed settings run:  start-cascade.cmd ollama-restart
set "OLLAMA_KEEP_ALIVE=2h"
REM   ^ default is 5m: the model unloads after 5 idle minutes and the KV cache dies with it — the exact
REM     "restarted Cascade, came back later, everything re-prefills" pain. 2h is proven on this box
REM     (0 reloads across whole builds). Use -1 to NEVER unload (holds VRAM until reboot).
set "OLLAMA_FLASH_ATTENTION=1"
set "OLLAMA_KV_CACHE_TYPE=q8_0"
set "OLLAMA_NUM_PARALLEL=1"
REM   ^ MUST stay 1: parallel slots SPLIT the context window between them (2 slots on 131k = 65k each)
REM     and compete for the prefix cache. Cascade is a single-user client — one slot, full window.
set "OLLAMA_MAX_LOADED_MODELS=2"
REM   ^ the builder model + nomic-embed-text must co-reside (memory recall embeds per turn, ADR-074);
REM     1 would evict the builder on every embed = a full model reload per recall.

if /i "%~1"=="ollama-restart" (
  echo [..]  ollama-restart requested - stopping Ollama to apply the env above...
  taskkill /f /im "ollama app.exe" >nul 2>&1
  taskkill /f /im ollama.exe >nul 2>&1
  timeout /t 2 >nul
)

curl -s --max-time 2 http://127.0.0.1:11434/api/version >nul 2>&1
if !errorlevel! equ 0 (
  echo [ok]  Ollama already running - left untouched ^(loaded model + KV cache preserved^).
  echo       ^(settings changed? run: start-cascade.cmd ollama-restart^)
  goto ollamadone
)
echo [..]  Ollama not up - starting `ollama serve` with Cascade settings...
start "Ollama" /min cmd /c "ollama serve"
set /a otries=0
:waitollama
curl -s --max-time 2 http://127.0.0.1:11434/api/version >nul 2>&1
if !errorlevel! equ 0 (
  echo [ok]  Ollama ready ^(keep_alive=2h, flash_attn, kv q8_0, parallel 1, max_loaded 2^).
  goto ollamadone
)
set /a otries+=1
if !otries! geq 10 (
  echo [warn] Ollama still not answering after ~20s - continuing ^(local models may fail^).
  goto ollamadone
)
timeout /t 2 >nul
goto waitollama
:ollamadone
echo.

REM --- 3) Server window: ws://localhost:4319  (+ preview proxy 4320) ---
REM Output is TEE'd to logs\server.log: a console window scrolls away and is gone, which is exactly what
REM happened when a build died mid-turn and the stack trace went with it. Tee-Object keeps the live view.
if not exist "%REPO%\logs" mkdir "%REPO%\logs"
echo [..]  Starting server...  (log: %REPO%\logs\server.log)
REM Tee-Object on Windows PowerShell 5.1 has no -Encoding and writes UTF-16, which makes the log awkward to
REM grep; Out-File -Encoding utf8 per line keeps it plain text while still echoing to the window.
start "Cascade Server" cmd /k "cd /d %REPO%\packages\server && powershell -NoProfile -Command "npm run dev 2>&1 ^| ForEach-Object { $_; $_ ^| Out-File -FilePath '%REPO%\logs\server.log' -Append -Encoding utf8 }""

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
