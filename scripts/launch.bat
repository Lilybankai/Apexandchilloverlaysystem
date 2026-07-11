@echo off
rem ===========================================================================
rem  launch.bat - Apex & Chill Overlay System launcher (Windows)
rem ---------------------------------------------------------------------------
rem  Starts the lightweight overlay server (static overlay files + telemetry
rem  WebSocket broadcast). Add http://127.0.0.1:<port>/ to OBS as a Browser
rem  Source at 1920x1080 - see docs\OBS-SETUP.md.
rem
rem  Usage:
rem    launch.bat            Start on the default port (8080).
rem    launch.bat 9000       Start on port 9000.
rem    launch.bat sim        Force the demo/simulator feed (no game needed).
rem
rem  Environment overrides (see src\server\config.ts) are respected if already
rem  set: APEX_HTTP_PORT, APEX_HOST, APEX_UPDATE_HZ, APEX_FORCE_SIM, APEX_VERBOSE.
rem ===========================================================================
setlocal enableextensions
title Apex ^& Chill Overlay Server

rem This script lives in scripts\; the project root is its parent directory.
pushd "%~dp0.."

rem --- Require Node.js -------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 18+ is required but was not found on your PATH.
  echo         Install the LTS build from https://nodejs.org/ and re-run this.
  echo.
  pause
  popd
  endlocal
  exit /b 1
)

rem --- Parse the optional argument ------------------------------------------
if /i "%~1"=="sim" (
  set "APEX_FORCE_SIM=1"
) else if not "%~1"=="" (
  set "APEX_HTTP_PORT=%~1"
)

rem Default port for the banner + server if not otherwise provided.
if not defined APEX_HTTP_PORT set "APEX_HTTP_PORT=8080"

rem --- Install dependencies on first run ------------------------------------
if not exist "node_modules" (
  echo [apex-overlay] Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. See the output above.
    pause
    popd
    endlocal
    exit /b 1
  )
)

echo.
echo ============================================================
echo   APEX ^& CHILL OVERLAY SERVER
echo.
echo   OBS Browser Source URL ^(size 1920 x 1080^):
echo       http://127.0.0.1:%APEX_HTTP_PORT%/
echo.
echo   Keep this window open while streaming.
echo   Press Ctrl+C in this window to stop the server.
echo ============================================================
echo.

rem 'npm start' runs the TypeScript build (prestart) then launches the server.
rem This call blocks until the server is stopped (Ctrl+C).
call npm start

popd
endlocal
