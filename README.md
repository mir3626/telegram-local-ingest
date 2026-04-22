# telegram-local-ingest

Local-first ingest worker for an Obsidian-based LLM wiki.

The project receives raw files and commands through Telegram, imports large files through Telegram Local Bot API Server, stores durable job state in SQLite, writes immutable Obsidian raw bundles, runs RTZR STT for audio, and calls a narrow wiki ingest adapter.

## Architecture

```text
Telegram mobile/desktop
  -> Telegram Bot
  -> Telegram Local Bot API Server (--local)
  -> local worker
  -> SQLite queue
  -> runtime staging/archive
  -> RTZR STT and file processors
  -> Obsidian raw/<date>/<source_id> bundle
  -> wiki ingest adapter
  -> Telegram notify
```

Dropbox is intentionally out of scope for V1. Large files are handled through Telegram Local Bot API Server.

## Repository Layout

```text
apps/worker                 # long-running local worker
packages/core               # job model, config, state machine
packages/telegram           # Telegram Bot API client and update parser
packages/capture            # Telegram update capture and /ingest job creation
packages/importer           # local file import, archive, hashes, duplicate detection
packages/operator           # /status, /retry, /cancel, notify/report message builders
packages/rtzr               # RTZR STT client
packages/vault              # Obsidian raw bundle writer
packages/wiki-adapter       # protected wiki ingest command boundary
docs/context                # project context for AI coding sessions
docs/plans/sprint-roadmap.md
.vibe, .claude, scripts     # vibe-doctor development harness
```

## Requirements

- Node.js 24+
- npm 11+
- Telegram bot token from BotFather
- Telegram `api_id` and `api_hash` from `my.telegram.org`
- Telegram Local Bot API Server from `tdlib/telegram-bot-api`
- SQLite
- ffmpeg
- RTZR API credentials
- Obsidian vault path

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Fill `.env` with local values. Keep `.env` out of git.

See [Telegram Local Bot API Server Setup](docs/operations/telegram-local-bot-api-server.md) before starting the worker.

Run the current scaffold:

```powershell
npm run typecheck
npm test
npm run build
npm run worker:dev
```

## Operator Flow

1. Start Telegram Local Bot API Server in `--local` mode.
2. Move the bot session to the local server with the documented `logOut` flow.
3. Start the worker with `npm run worker:dev`.
4. Send `/ingest project:<name> tag:<tag>` with files or captions from an allowlisted Telegram user.
5. Use `/status` or `/status <job_id>` to inspect progress.
6. Use `/retry <job_id>` only for failed jobs.
7. Use `/cancel <job_id>` for active jobs that should stop.

Operational state is in SQLite at `SQLITE_DB_PATH`. This is sufficient for the later dashboard because jobs, files, source bundles, Telegram offsets, and append-only events are all queryable without scraping logs.

## Development Process

This repository uses the `vibe-doctor` harness. Durable context lives in:

- `docs/context/product.md`
- `docs/context/architecture.md`
- `docs/context/conventions.md`
- `docs/context/qa.md`
- `docs/plans/sprint-roadmap.md`

Implementation should proceed by Sprint from `docs/plans/sprint-roadmap.md`.

## Key Rules

- Telegram is the single capture, command, and notify channel.
- Telegram Local Bot API Server is the large-file path.
- Deterministic TypeScript owns file lifecycle, queue state, retry, permissions, and notifications.
- LLM agents only operate through a constrained wiki ingest adapter.
- `raw/**` in the Obsidian vault is immutable after finalization.
