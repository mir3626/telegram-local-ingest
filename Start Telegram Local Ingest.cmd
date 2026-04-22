@echo off
setlocal

set "PROJECT=/home/tony/workspace/telegram-local-ingest"

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo wsl.exe was not found. Install or enable WSL first.
  pause
  exit /b 1
)

echo Starting Telegram Local Bot API Server and telegram-local-ingest worker...
echo Project: %PROJECT%
echo.

wsl.exe bash -lc "cd %PROJECT% && bash scripts/start-local-stack.sh"

echo.
echo Done. The stack runs in WSL background processes.
echo Logs are under /home/tony/workspace/telegram-local-ingest/runtime/logs.
echo Run scripts/stop-local-stack.sh in WSL to stop it.
pause
