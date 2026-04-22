# Telegram Local Bot API Server Setup

This project uses Telegram Local Bot API Server for large files. Do not configure the worker against `https://api.telegram.org` for the MVP path.

Official references:

- Bot API local server behavior: https://core.telegram.org/bots/api#using-a-local-bot-api-server
- Server implementation: https://github.com/tdlib/telegram-bot-api

## Why Local Server

Telegram Local Bot API Server can:

- Download files without the cloud Bot API size limit.
- Upload files up to 2000 MB.
- Return an absolute local `file_path` from `getFile`, so the worker can import files from local storage.
- Use local HTTP endpoints such as `http://127.0.0.1:8081`.

## Prerequisites

1. Create a Telegram bot with BotFather and keep the bot token.
2. Create Telegram application credentials at `https://my.telegram.org/apps` and keep `api_id` and `api_hash`.
3. Build or install `tdlib/telegram-bot-api`.
4. Create a local data directory for the server.
5. Create a local Obsidian test vault for early development.

## Windows Example

Use the official build instructions generator from the Telegram server repository when installing the binary. After `telegram-bot-api.exe` is available:

```powershell
$env:TELEGRAM_API_ID="123456"
$env:TELEGRAM_API_HASH="your_api_hash"

telegram-bot-api `
  --local `
  --api-id $env:TELEGRAM_API_ID `
  --api-hash $env:TELEGRAM_API_HASH `
  --http-port 8081 `
  --dir "C:\telegram-bot-api\data"
```

Confirm the server is listening:

```powershell
Invoke-RestMethod "http://127.0.0.1:8081/bot$env:TELEGRAM_BOT_TOKEN/getMe" -Method Post
```

## Move The Bot To The Local Server

Telegram documents that a bot should be logged out from the cloud Bot API server before switching to a local server.

With the cloud endpoint:

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/logOut" -Method Post
```

Then use only the local base URL in `.env`:

```text
TELEGRAM_BOT_API_BASE_URL=http://127.0.0.1:8081
```

If the bot has an old webhook, remove it before polling:

```powershell
Invoke-RestMethod "http://127.0.0.1:8081/bot$env:TELEGRAM_BOT_TOKEN/deleteWebhook" -Method Post -Body '{"drop_pending_updates":false}' -ContentType "application/json"
```

## Worker Configuration

Create `.env` from `.env.example` and fill at least:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_BOT_API_BASE_URL=http://127.0.0.1:8081
TELEGRAM_ALLOWED_USER_IDS=
INGEST_RUNTIME_DIR=./runtime
SQLITE_DB_PATH=./runtime/ingest.db
OBSIDIAN_VAULT_PATH=
OBSIDIAN_RAW_ROOT=raw
```

`TELEGRAM_LOCAL_FILES_ROOT` is optional. In local mode, `getFile` can return an absolute local path. If your server returns relative paths, set `TELEGRAM_LOCAL_FILES_ROOT` to the server file storage root.

## Start Checks

The worker startup check currently verifies:

- Required environment values are present.
- `getMe` works against `TELEGRAM_BOT_API_BASE_URL`.
- `getWebhookInfo` works.
- The base URL is not `https://api.telegram.org`.

Later Sprints will add a stronger local file import smoke check once file import exists.

## Current Development Commands

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run worker:dev
```

`npm run worker:dev` requires a configured local server and `.env` values. Until the real polling loop exists, it only runs startup checks.
