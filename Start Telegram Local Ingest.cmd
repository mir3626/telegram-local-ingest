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

start "Telegram Local Bot API Server" wsl.exe bash -lc "cd %PROJECT% && if [ ! -f .env ]; then echo Missing .env in %PROJECT%; read -r -p 'Press Enter to close...'; exit 1; fi; set -a; . ./.env; set +a; BOT_API_BIN=${TELEGRAM_BOT_API_BIN:-$HOME/.local/bin/telegram-bot-api}; BOT_API_DIR=${TELEGRAM_LOCAL_FILES_ROOT:-$HOME/telegram-bot-api-data}; BOT_API_TEMP=${TELEGRAM_BOT_API_TEMP_DIR:-$HOME/telegram-bot-api-temp}; mkdir -p $BOT_API_DIR $BOT_API_TEMP; if [ ! -x $BOT_API_BIN ]; then echo Missing telegram-bot-api binary: $BOT_API_BIN; read -r -p 'Press Enter to close...'; exit 1; fi; echo Starting $BOT_API_BIN on 127.0.0.1:8081; exec $BOT_API_BIN --api-id=$TELEGRAM_API_ID --api-hash=$TELEGRAM_API_HASH --local --dir=$BOT_API_DIR --temp-dir=$BOT_API_TEMP --http-ip-address=127.0.0.1 --http-port=8081"

timeout /t 3 /nobreak >nul

start "Telegram Local Ingest Worker" wsl.exe bash -lc "cd %PROJECT% && if [ -f $HOME/.nvm/nvm.sh ]; then . $HOME/.nvm/nvm.sh; fi; npm run smoke:ready && npm run worker:dev; echo; read -r -p 'Worker stopped. Press Enter to close...'"

echo Started. Two WSL console windows should now be open.
echo Close those windows to stop the Bot API Server or worker.
pause
