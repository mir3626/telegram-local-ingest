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
apps/ops-cli                # product operator CLI
packages/core               # job model, config, state machine
packages/telegram           # Telegram Bot API client and update parser
packages/capture            # Telegram update capture and /ingest job creation
packages/importer           # local file import, archive, hashes, duplicate detection
packages/operator           # /status, /retry, /cancel, notify/report message builders
packages/rtzr               # RTZR STT client
packages/vault              # Obsidian raw bundle writer
packages/wiki-adapter       # protected wiki ingest command boundary
packages/automation-core    # manifest-based one-shot automation modules
automations                 # product automation module registry
docs/context                # project context for AI coding sessions
docs/plans/sprint-roadmap.md
.vibe, .claude, scripts     # vibe-doctor development harness
```

## Requirements

- Node.js 24+
- npm 11+
- Linux host with `apt-get` for the bundled setup script
- Telegram bot token from BotFather
- Telegram `api_id` and `api_hash` from `my.telegram.org`
- Telegram Local Bot API Server from `tdlib/telegram-bot-api`
- SQLite
- ffmpeg for audio preprocessing
- pandoc for DOCX rendering
- poppler-utils for PDF text/page extraction
- tesseract OCR with English, Korean, Simplified Chinese, and Japanese language packs
- Noto CJK fonts for Korean/Chinese/Japanese PDF rendering
- RTZR API credentials
- Obsidian vault path

## Setup

```bash
npm install
cp .env.example .env
npm run setup:linux
```

Fill `.env` with local values. Keep `.env` out of git.

Generated Python artifact renderers, such as ad hoc wiki-data charts, use `WIKI_ARTIFACT_PYTHON_BIN`. `npm run setup:linux` creates `./.venv-wiki-artifacts` with `matplotlib` and fills this env value; `npm run setup:wiki-artifacts` can refresh only that renderer virtualenv.

For optional local CPU SenseVoice STT, run the heavier model setup separately:

```bash
npm run setup:linux:sensevoice
```

See [Telegram Local Bot API Server Setup](docs/operations/telegram-local-bot-api-server.md) before starting the worker.

Run the current scaffold:

```bash
npm run typecheck
npm test
npm run build
npm run worker:dev
```

## Operator Flow

1. Start Telegram Local Bot API Server in `--local` mode.
2. Move the bot session to the local server with the documented `logOut` flow.
3. Start the worker with `npm run worker:dev`.
4. Send `/start` to confirm the Telegram user id and allowlist status.
5. Send `/ingest project:<name> tag:<tag>` with files or captions from an allowlisted Telegram user.
6. Use `/status` or `/status <job_id>` to inspect progress.
7. Use `/retry <job_id>` only for failed jobs.
8. Use `/cancel <job_id>` for active jobs that should stop.

Operational state is in SQLite at `SQLITE_DB_PATH`. This is sufficient for the dashboard because jobs, files, source bundles, Telegram offsets, append-only events, and structured error diagnostics are all queryable without scraping logs.

## Automation Modules

Batch and scheduled jobs are registered under `automations/*` instead of being added one-by-one to `package.json`.

```bash
npm run tlgi -- automation list
npm run tlgi -- automation enable <module-id>
npm run tlgi -- automation run <module-id> --force
npm run tlgi -- automation logs <module-id>
npm run tlgi -- automation dispatch --dry-run
npm run tlgi -- automation timer install --interval-minutes 15
npm run ops:dashboard
```

Run logs are stored under `runtime/automation/runs/<run_id>/`. Scheduled jobs use a single dispatcher/timer rather than a resident process per automation; `timer install` writes user-level systemd unit files and prints the `systemctl --user` activation command. `scripts/start-local-stack.sh` installs/enables that timer, then runs one immediate dispatch by default so missed due windows are caught when the local solution starts. Set `AUTOMATION_DISPATCH_ON_START=0` to skip that startup catch-up dispatch.

`npm run ops:dashboard` starts a product-owned localhost dashboard, separate from the `vibe-doctor` harness dashboard. It shows module readiness without secret values, enable/disable controls, manual run/dispatch actions, live logs, structured diagnostics, generated artifact runs, and result viewers. `npm run ops:start` also starts this dashboard with the Telegram Local Bot API Server and worker. By default it binds to `127.0.0.1`; set `OPS_DASHBOARD_TOKEN` to require a local admin token for write actions only.

The first bundled module is `fx.koreaexim.daily`. Set `FX_KOREAEXIM_AUTHKEY`, optionally tune `FX_CURRENCIES`, then enable it:

```bash
npm run tlgi -- automation enable fx.koreaexim.daily
npm run tlgi -- automation dispatch --dry-run
```

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
