@echo off
setlocal EnableDelayedExpansion

set "PROJECT=/home/tony/workspace/telegram-local-ingest"

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo wsl.exe was not found. Install or enable WSL first.
  pause
  exit /b 1
)

echo Stopping Telegram Local Ingest solution services...
echo Project: %PROJECT%
echo.

wsl.exe bash -lc "cd %PROJECT% && bash scripts/stop-local-stack.sh"
set "STOP_STATUS=%ERRORLEVEL%"

echo.
echo Done. The solution stop command has finished.
pause
exit /b %STOP_STATUS%
