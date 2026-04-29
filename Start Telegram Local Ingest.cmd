@echo off
setlocal EnableDelayedExpansion

set "PROJECT=/home/tony/workspace/telegram-local-ingest"

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo wsl.exe was not found. Install or enable WSL first.
  pause
  exit /b 1
)

echo Starting Telegram Local Ingest solution services...
echo Project: %PROJECT%
echo.

wsl.exe bash -lc "cd %PROJECT% && bash scripts/local-stack-status.sh"
set "STACK_STATUS=%ERRORLEVEL%"
echo.

if "%STACK_STATUS%"=="0" (
  echo The local ingest solution is already running.
  pause
  exit /b 0
)

if "%STACK_STATUS%"=="2" (
  echo The local ingest solution appears to be partially running.
  echo.
  echo Continuing with startup to recover missing services.
  echo.
)

wsl.exe bash -lc "cd %PROJECT% && bash scripts/start-local-stack.sh"

echo.
echo Done. The solution services run in WSL background processes.
echo Logs are under /home/tony/workspace/telegram-local-ingest/runtime/logs.
echo Use Stop Telegram Local Ingest.cmd to stop them.
pause
