# Sprint Roadmap

<!-- BEGIN:VIBE:CURRENT-SPRINT -->
> **Current**: sprint-4-local-file-import
> **Completed**: sprint-0-phase0-seed, sprint-1-telegram-local-baseline, sprint-2-sqlite-job-model, sprint-3-telegram-capture
> **Pending**: sprint-4-local-file-import, sprint-5-vault-bundle-writer, sprint-6-rtzr-stt, sprint-7-wiki-ingest-adapter, sprint-8-status-retry-cancel
<!-- END:VIBE:CURRENT-SPRINT -->

## Background

This roadmap implements the Telegram-first local ingest pipeline discussed in the imported planning transcript. Dropbox is intentionally excluded from V1. Large file handling is based on Telegram Local Bot API Server running in `--local` mode.

```text
Telegram mobile/desktop
  -> Telegram Local Bot API Server
  -> local TypeScript worker
  -> SQLite queue
  -> file import + normalization
  -> RTZR STT for audio
  -> Obsidian raw bundle
  -> wiki ingest adapter
  -> Telegram notify
```

## Sprint 0 — Phase 0 Seed And Repository Skeleton

- **id**: `sprint-0-phase0-seed`
- **goal**: Convert the `vibe-doctor` template into the `telegram-local-ingest` downstream project and define the first implementation boundaries.
- **deliverables**:
  - Root package metadata updated.
  - npm workspace skeleton under `apps/worker` and `packages/*`.
  - Context shards updated for product, architecture, conventions, and QA.
  - `.env.example` includes Telegram Local Bot API Server, RTZR, runtime, and vault settings.
  - Roadmap excludes Dropbox and centers Telegram Local Bot API Server.
- **acceptance criteria**:
  - `npm install` completes.
  - `npm run typecheck` passes.
  - `npm test` passes.
  - `npm run build` passes.
- **status**: completed in the initial setup pass.

## Sprint 1 — Telegram Local Bot API Baseline

- **id**: `sprint-1-telegram-local-baseline`
- **goal**: Add configuration and startup checks for Telegram Local Bot API Server.
- **tasks**:
  - Implement typed config loader in `packages/core`.
  - Implement Telegram Bot API client base in `packages/telegram`.
  - Add `getMe`, `getWebhookInfo`, `deleteWebhook`, `logOut` documentation guard, and health check helpers.
  - Model local-mode `getFile` behavior where `file_path` can be absolute.
  - Add mocked tests for local and relative file path cases.
- **acceptance criteria**:
  - Worker fails fast on missing token/base URL.
  - Telegram package can call mocked local server endpoints.
  - Docs explain local server prerequisites.
- **status**: completed in the initial setup pass.

## Sprint 2 — SQLite Job Model And State Machine

- **id**: `sprint-2-sqlite-job-model`
- **goal**: Build durable job, file, and event persistence.
- **tasks**:
  - Choose SQLite dependency after evaluating Windows install friction.
  - Create migrations for `jobs`, `job_files`, `job_events`, `telegram_offsets`, and `source_bundles`.
  - Implement state transition rules.
  - Implement append-only event log.
  - Add focused tests for transitions and retry eligibility.
- **acceptance criteria**:
  - Restart-safe job state is persisted.
  - Invalid transitions are rejected.
  - Events can reconstruct job history.
- **status**: completed. Uses `node:sqlite` behind `packages/db`, with tests for persistence, transitions, retry eligibility, offsets, source bundles, files, and events.

## Sprint 3 — Telegram Capture And Command Parser

- **id**: `sprint-3-telegram-capture`
- **goal**: Receive Telegram updates and create ingest jobs from files/text plus `/ingest` commands.
- **tasks**:
  - Implement `getUpdates` long polling with durable offset.
  - Parse text, photo, document, audio, voice, video, and caption fields.
  - Implement `/ingest`, `/status`, `/retry`, and `/cancel` parser skeleton.
  - Add allowlisted user IDs.
  - Batch recent uploads before `/ingest`.
  - Send ACK messages.
- **acceptance criteria**:
  - Duplicate updates are not reprocessed after restart.
  - Unauthorized users are ignored or rejected with a safe message.
  - `/ingest project:foo tag:bar` creates a queued job.
- **status**: completed. Added Telegram update parsing, command parsing, allowlist enforcement, durable offset polling, and `/ingest` job creation through `packages/capture`.

## Sprint 4 — Local File Import And Archive

- **id**: `sprint-4-local-file-import`
- **goal**: Import Telegram Local Bot API files into controlled runtime storage.
- **tasks**:
  - Implement `getFile` and local path resolver.
  - Copy or link files from local Bot API storage into `runtime/staging`.
  - Compute SHA-256 and detect duplicates.
  - Archive originals under `runtime/archive/originals`.
  - Enforce max file size policy even though local server can download without size limit.
  - Add path traversal and absolute path safety tests.
- **acceptance criteria**:
  - Worker never processes files in-place from Bot API storage.
  - Same file uploaded twice is detected as duplicate.
  - Unsafe paths are rejected.

## Sprint 5 — Obsidian Raw Bundle Writer

- **id**: `sprint-5-vault-bundle-writer`
- **goal**: Write immutable source bundles into the Obsidian vault.
- **tasks**:
  - Implement bundle path builder: `raw/<date>/<source_id>/`.
  - Generate `manifest.yaml`, `source.md`, and `log.md`.
  - Copy original, normalized, and extracted artifacts into the right subdirectories.
  - Add finalized marker or manifest field to prevent rewrite.
  - Add tests for layout and immutability.
- **acceptance criteria**:
  - Bundle output is deterministic and readable in Obsidian.
  - `source.md` is suitable as the LLM ingest entrypoint.
  - Existing finalized bundles are not overwritten.

## Sprint 6 — RTZR STT Audio Processor

- **id**: `sprint-6-rtzr-stt`
- **goal**: Convert Telegram audio/voice into transcript artifacts through RTZR.
- **tasks**:
  - Add ffmpeg startup check.
  - Convert unsupported Telegram voice/audio formats into RTZR-supported input when needed.
  - Implement RTZR auth, submit, polling, timeout, and backoff.
  - Save `rtzr.json` and `transcript.md` under `extracted/`.
  - Add mocked tests for success, failure, and 429 behavior.
- **acceptance criteria**:
  - Audio jobs produce transcript markdown.
  - RTZR result is persisted locally immediately.
  - External API failures leave retryable job state.

## Sprint 7 — Wiki Ingest Adapter

- **id**: `sprint-7-wiki-ingest-adapter`
- **goal**: Call a narrow wiki ingest command that reads finalized raw bundles and updates wiki notes only.
- **tasks**:
  - Define adapter command contract.
  - Implement write lock.
  - Pass bundle path, allowed wiki root, project, tags, and instructions.
  - Capture stdout/stderr into job events.
  - Prevent adapter from modifying `raw/**`.
- **acceptance criteria**:
  - Adapter can be replaced by Codex, Claude Code, OpenClaw, Hermes, or a custom CLI without changing capture flow.
  - Failed adapter calls are retryable.
  - Raw immutability is enforced before and after adapter execution.

## Sprint 8 — Status, Retry, Cancel, And Operator Polish

- **id**: `sprint-8-status-retry-cancel`
- **goal**: Complete the MVP operator loop.
- **tasks**:
  - Implement `/status` summary and per-job detail.
  - Implement `/retry <job_id>`.
  - Implement `/cancel <job_id>`.
  - Add clear Telegram completion/failure messages.
  - Add daily failed jobs report skeleton.
  - Add README operator guide for local server and worker startup.
- **acceptance criteria**:
  - User can see job progress from Telegram.
  - Retry does not duplicate immutable artifacts.
  - Operator can run the MVP from a documented local setup.

## Deferred

- Dropbox.
- n8n gateway.
- Public web dashboard.
- Multi-user permission matrix.
- Vector DB.
- Human review UI.
- Telegram webhook deployment.
