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
  -> optional agent post-processing + runtime outputs
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
   - `packages/capture`: Telegram polling/capture orchestration, allowlist enforcement, command-to-job creation.
   - `packages/db`: SQLite schema, migrations, repositories, dashboard-friendly queries.
   - `packages/importer`: Telegram Local Bot API file import into controlled runtime staging/archive with hashing and duplicate detection.
   - `packages/operator`: Telegram `/status`, `/retry`, `/cancel`, completion/failure notifications, and daily report message builders.
   - `packages/telegram`: Bot API client, update parser, Local Bot API file import semantics.
   - `packages/rtzr`: RTZR auth, submit, polling, result persistence.
   - `packages/vault`: Obsidian raw bundle layout, manifest writer, source markdown writer, write lock helpers.
   - `packages/wiki-adapter`: Protected CLI adapter boundary for LLM/wiki updates.
   - `packages/output-store`: Runtime-only downloadable output registration, expiry, and cleanup.
   - `packages/preprocessors`: Deterministic text/transcript collection boundary before agent execution.
   - `packages/language-detector`: Script-based primary-language and translation-needed check.
   - Planned `packages/agent-adapter`: Codex-first local agent execution boundary, with Claude Code as a future provider.

## Runtime Directories

```text
runtime/
  ingest.db
  staging/
  archive/
    originals/
  temp/
  outputs/
    <job_id>/
      <output_id>/
  logs/
  wiki.lock
```

`runtime/` is operational state and must not be treated as Obsidian content.
`runtime/outputs/` is a TTL-controlled delivery cache. Files under it can be deleted after expiry because raw bundles and wiki artifacts remain the durable sources of truth.

## Worker Dispatch

`apps/worker` runs the integrated local loop:

1. Poll Telegram updates and advance durable offsets.
2. Route `/status`, `/retry`, and `/cancel` through `packages/operator`.
3. Route file uploads, with or without `/ingest`, through `packages/capture`.
4. Process queued jobs through file import, raw bundle writing, optional wiki adapter execution, Telegram notification, and terminal state transition.

The post-processing utility layer extends this loop after source artifacts exist:

1. Preprocess by file type and collect text/structured artifacts.
2. Run a deterministic language check to decide whether translation is needed.
3. Call the configured agent adapter in a job-scoped workspace.
4. Register downloadable files in `job_outputs` and `runtime/outputs`.
5. Notify Telegram with a download button whose callback resolves the output only if it is still active.
6. Periodically delete expired output files and mark them deleted in SQLite.

Sprint 10 currently records `preprocess.completed` and `language.detected` job events during the `INGESTING` phase. The worker reads imported text-like originals and bundled `*.transcript.md` files, strips transcript Markdown boilerplate before language scoring, and stores only artifact metadata plus language signals in SQLite rather than duplicating source text in the database.

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
- `job_outputs`

Sprint 2 uses Node 24's built-in `node:sqlite` module to avoid Windows native npm install friction. The module currently emits an experimental warning in Node 24.14.1, so all SQL access is isolated under `packages/db` and can be swapped later if needed.

Sprint 3 adds Telegram capture primitives: `getUpdates` polling payloads, update parsing, command parsing, allowlist checks, durable offset advancement, and `/ingest` job creation through `packages/capture`.

Sprint 4 adds controlled file import through `packages/importer`: each Telegram file is resolved through `getFile`, validated against `TELEGRAM_LOCAL_FILES_ROOT` when configured, copied into `runtime/staging`, archived under `runtime/archive/originals`, hashed with SHA-256, and marked as duplicate when identical bytes were already imported. After a job reaches `COMPLETED`, the worker deletes the Local Bot API Server source file returned by `getFile`; the retained copies are runtime archive/staging and the immutable raw bundle.

Sprint 5 adds immutable raw bundle writing through `packages/vault`: bundle paths are deterministic under `raw/<date>/<source_id>/`, originals and derived artifacts are copied into `original/`, `normalized/`, and `extracted/`, and `manifest.yaml`, `source.md`, `log.md`, and `.finalized` are written as the Obsidian-facing source package.

Sprint 6 adds RTZR batch STT primitives through `packages/rtzr`: OAuth token retrieval, multipart file submission, polling with rate-limit backoff, failed-result handling, transcript artifact writing, supported audio format checks, and ffmpeg conversion helpers for unsupported Telegram audio containers.

Sprint 7 adds the wiki ingest adapter boundary through `packages/wiki-adapter`: deterministic command arguments, a filesystem write lock, stdout/stderr capture, raw bundle snapshot checks before/after adapter execution, and validation that `rawRoot` and `wikiRoot` do not overlap.

Sprint 8 adds Telegram operator commands through `packages/operator`: `/status` summary/detail responses, failed-job retry back to `QUEUED`, active-job cancellation, concise completion/failure messages, and a daily failed-job report text builder.

Post-MVP utility work adds `job_outputs` and `packages/output-store`. Output records point to generated files under `runtime/outputs`, include an expiry timestamp, and are resolved by Telegram download callbacks. This keeps the future utility-bot delivery behavior separate from wiki/raw bundle semantics.

## Security Boundaries

- Telegram user allowlist is mandatory.
- Bot token, Telegram API credentials, RTZR credentials, and wiki command secrets live only in `.env`.
- Raw file contents are untrusted. Prompt injection inside uploaded documents must be treated as data, not instructions.
- LLM wiki adapter receives a prepared source package and explicit allowed write root.
- File imports must reject path traversal and must verify resolved paths.
- If `TELEGRAM_LOCAL_FILES_ROOT` is configured, both relative and absolute Telegram `file_path` values must resolve inside that root.
- Commands such as `/retry` and `/cancel` operate only on jobs belonging to the allowlisted chat/user context.
- Raw bundles remain self-contained copies. Do not place symlinks from `raw/**` to Telegram Local Bot API Server storage: those targets include bot-token-derived paths, may disappear after cleanup, and make raw bundles non-portable. If linking is needed, prefer Obsidian-relative links to files copied inside the finalized raw bundle.
- Local agent adapters may read prepared input copies and write only to job-scoped output directories. They must not receive bot tokens, OAuth credential files, `.env`, `runtime/ingest.db`, or arbitrary workspace access.
- Generated download callbacks must validate Telegram allowlist and job chat/user ownership before sending files.
- Personal Codex/Claude OAuth automation is allowed only for the operator's own local workflow; public, paid, or multi-user service flows must switch to official API credentials and product-grade tenant isolation.

## External Dependencies

- Node.js 24+
- Telegram Local Bot API Server from `tdlib/telegram-bot-api`
- Telegram `api_id` and `api_hash`
- BotFather bot token
- SQLite
- ffmpeg
- RTZR STT API credentials
- Obsidian vault directory
