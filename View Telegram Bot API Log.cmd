@echo off
setlocal

set "PROJECT=/home/tony/workspace/telegram-local-ingest"

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo wsl.exe was not found. Install or enable WSL first.
  pause
  exit /b 1
)

echo Opening Telegram Local Bot API Server log...
echo Project: %PROJECT%
echo.

wsl.exe bash -lc "cd %PROJECT% && bash scripts/tail-bot-api-log.sh"

echo.
echo Log viewer closed.
pause
