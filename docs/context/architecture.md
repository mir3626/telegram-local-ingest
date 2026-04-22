# Architecture Context

## System Shape

```text
Telegram clients
  -> Telegram Bot
  -> Telegram Local Bot API Server (--local)
  -> apps/worker local polling process
  -> SQLite queue
  -> runtime/staging + runtime/archive
  -> processors: document/image/text/audio
  -> RTZR STT for audio/voice
  -> Obsidian vault raw bundle writer
  -> wiki ingest adapter
  -> Telegram notifications
```

## Repository Layers

1. **Harness layer**
   - `CLAUDE.md`, `AGENTS.md`, `.claude/*`, `.vibe/*`, `scripts/vibe-*`, `src/commands/*`, `src/lib/*`, `test/*`
   - Kept from `vibe-doctor` to run Phase 0, Sprint planning, QA gates, reporting, and sync.

2. **Application layer**
   - `apps/worker`
   - Long-running local process for Telegram polling, job dispatch, startup checks, and notification.

3. **Domain packages**
   - `packages/core`: job model, state machine, config, hashes, queue contracts.
   - `packages/db`: SQLite schema, migrations, repositories, dashboard-friendly queries.
   - `packages/telegram`: Bot API client, update parser, Local Bot API file import semantics.
   - `packages/rtzr`: RTZR auth, submit, polling, result persistence.
   - `packages/vault`: Obsidian raw bundle layout, manifest writer, source markdown writer, write lock helpers.

## Runtime Directories

```text
runtime/
  ingest.db
  staging/
  archive/
    originals/
  temp/
  logs/
  wiki.lock
```

`runtime/` is operational state and must not be treated as Obsidian content.

## Obsidian Vault Layout

```text
<vault>/
  raw/
    2026-04-22/
      tg_<message_id>_<hash>/
        manifest.yaml
        source.md
        original/
        normalized/
        extracted/
        log.md
  wiki/
  _system/
    schemas/
    prompts/
    reports/
```

Raw bundles are append-only/finalized artifacts. The wiki ingest adapter may read `raw/**/source.md` and modify `wiki/**`, but must not rewrite `raw/**`.

## Telegram Local Bot API Server Contract

- The worker uses `TELEGRAM_BOT_API_BASE_URL`, normally `http://127.0.0.1:8081`.
- The local server must run with `--local`.
- `getFile` may return an absolute local `file_path`; the worker must accept both absolute paths and ordinary Bot API relative paths.
- Large files are copied or hard-linked from the local Bot API storage into runtime staging before processing.
- The bot should be moved to the local server with the official `logOut` flow before relying on local-only file behavior.

## Job State Model

```text
RECEIVED
  -> QUEUED
  -> IMPORTING
  -> NORMALIZING
  -> BUNDLE_WRITING
  -> INGESTING
  -> NOTIFYING
  -> COMPLETED

Any active state
  -> FAILED
  -> RETRY_REQUESTED
  -> QUEUED

Any active state
  -> CANCELLED
```

SQLite tables planned for Sprint 2:

- `jobs`
- `job_files`
- `job_events`
- `telegram_offsets`
- `source_bundles`

Sprint 2 uses Node 24's built-in `node:sqlite` module to avoid Windows native npm install friction. The module currently emits an experimental warning in Node 24.14.1, so all SQL access is isolated under `packages/db` and can be swapped later if needed.

## Security Boundaries

- Telegram user allowlist is mandatory.
- Bot token, Telegram API credentials, RTZR credentials, and wiki command secrets live only in `.env`.
- Raw file contents are untrusted. Prompt injection inside uploaded documents must be treated as data, not instructions.
- LLM wiki adapter receives a prepared source package and explicit allowed write root.
- File imports must reject path traversal and must verify resolved paths.
- Commands such as `/retry` and `/cancel` operate only on jobs belonging to the allowlisted chat/user context.

## External Dependencies

- Node.js 24+
- Telegram Local Bot API Server from `tdlib/telegram-bot-api`
- Telegram `api_id` and `api_hash`
- BotFather bot token
- SQLite
- ffmpeg
- RTZR STT API credentials
- Obsidian vault directory
