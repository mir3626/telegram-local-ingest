# Sprint Roadmap

<!-- BEGIN:VIBE:CURRENT-SPRINT -->
> **Current**: sprint-12-utility-cleanup-polish
> **Completed**: sprint-0-phase0-seed, sprint-1-telegram-local-baseline, sprint-2-sqlite-job-model, sprint-3-telegram-capture, sprint-4-local-file-import, sprint-5-vault-bundle-writer, sprint-6-rtzr-stt, sprint-7-wiki-ingest-adapter, sprint-8-status-retry-cancel, sprint-9-output-store-downloads, sprint-10-preprocessing-language-check, sprint-11-codex-agent-postprocess
> **Pending**: sprint-13-vault-reconcile-retention
<!-- END:VIBE:CURRENT-SPRINT -->

## Background

This roadmap implements the Telegram-first local ingest pipeline discussed in the imported planning transcript. Dropbox is intentionally excluded from V1. Large file handling is based on Telegram Local Bot API Server running in `--local` mode.

```text
Telegram mobile/desktop
  -> Telegram Local Bot API Server
  -> local TypeScript worker
  -> SQLite queue
  -> SQLite job claims + bounded worker pool
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
- **status**: completed. Added `packages/importer` to copy Telegram Local Bot API files into `runtime/staging` and `runtime/archive/originals`, compute SHA-256, detect duplicate bytes through SQLite metadata, enforce max file size, and reject unsafe relative/absolute paths.

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
- **status**: completed. Added `packages/vault` raw bundle writer with deterministic `raw/<date>/<source_id>/` paths, `manifest.yaml`, `source.md`, `log.md`, original/normalized/extracted artifact directories, and `.finalized` overwrite protection.

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
- **status**: completed. Added `packages/rtzr` with OAuth token handling, batch STT submit/poll APIs, 429 polling backoff, failed-result errors, transcript artifact writing, supported format checks, and ffmpeg availability/conversion helpers.

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
- **status**: completed. Added `packages/wiki-adapter` with a CLI command contract, argument builder, write lock, stdout/stderr capture, raw bundle snapshot protection, and raw/wiki root overlap checks.

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
- **status**: completed. Added `packages/operator` for `/status`, `/retry`, `/cancel`, concise completion/failure messages, daily failed job report text, and README operator startup guidance.

## Deferred

- Dropbox.
- n8n gateway.
- Public web dashboard.
- Multi-user permission matrix.
- Vector DB.
- Human review UI.
- Telegram webhook deployment.

## Sprint 9 — Output Store And Telegram Downloads

- **id**: `sprint-9-output-store-downloads`
- **goal**: Add a runtime-only output delivery cache for generated artifacts and expose active outputs through Telegram download callbacks.
- **tasks**:
  - Add `job_outputs` SQLite table and repository functions.
  - Add `packages/output-store` to copy generated files into `runtime/outputs/<job_id>/<output_id>/`.
  - Add 24-hour expiry metadata and cleanup helpers.
  - Add `sendDocument` support to `packages/telegram`.
  - Add worker callback routing for `download:<output_id>` with allowlist and job ownership validation.
- **acceptance criteria**:
  - Generated output files are tracked independently from raw bundles.
  - Expired/deleted outputs are not sent to Telegram.
  - Cleanup can delete expired output files without touching raw/wiki content.
- **status**: completed. Added `job_outputs`, `packages/output-store`, `sendDocument` support, worker `download:<output_id>` callback handling with chat/user ownership validation, and expired-output cleanup that only touches `runtime/outputs`.

## Sprint 10 — Preprocessing And Translation Need Check

- **id**: `sprint-10-preprocessing-language-check`
- **goal**: Introduce deterministic preprocessing and language-check boundaries before agent execution.
- **tasks**:
  - Add `packages/preprocessors` interface for audio, image, document, spreadsheet, and generic text artifacts.
  - Reuse RTZR/SenseVoice transcript artifacts for audio.
  - Add a simple `packages/language-detector` script for primary language, confidence, and translation-needed decisions.
  - Record preprocessing and language-check events on jobs.
- **acceptance criteria**:
  - Worker can decide whether translation is needed without asking an LLM.
  - Unsupported file types are preserved and logged without blocking the source bundle.
- **status**: completed. Added `packages/preprocessors`, `packages/language-detector`, `TRANSLATION_TARGET_LANGUAGE`, and worker `preprocess.completed`/`language.detected` events during `INGESTING`. Current preprocessing reads text-like imported originals, parses EML messages into mail headers plus preferred text body, extracts DOCX text into runtime-only artifacts, and reads bundled transcript Markdown, preserving unsupported files without blocking the job.

## Sprint 11 — Codex Agent Post-Processing

- **id**: `sprint-11-codex-agent-postprocess`
- **goal**: Run local Codex non-interactive agent tasks for personal translation and document formatting.
- **tasks**:
  - Add `packages/agent-adapter` provider interface.
  - Implement Codex provider first using a job-scoped workspace and output-only write target.
  - Create preset prompts for natural Korean translation, terminology consistency, tone, and Markdown formatting.
  - Register generated outputs through `packages/output-store`.
  - Notify Telegram when automatic translation/formatting is complete.
- **acceptance criteria**:
  - Agent input is a prepared data package, not arbitrary workspace access.
  - Agent writes only output artifacts; `raw/**` remains immutable.
  - Claude Code can be tested behind the same interface.
- **status**: completed. Added `packages/agent-adapter`, local command placeholder/stdin prompt execution, prompt hard-boundaries, output/work directory separation, raw snapshot protection, and disabled-by-default config via `AGENT_POSTPROCESS_PROVIDER`. The worker now runs the agent adapter when deterministic language detection marks translation as needed, registers generated files through `packages/output-store`, and sends a Korean completion message with `download:<output_id>` buttons for 24-hour downloads. Download button labels show the actual KST expiry deadline. DOCX/PDF/EML/HWP-family sources are delivered as document files, preferring agent-generated DOCX/HWP/HWPX outputs and falling back to worker-rendered DOCX through `pandoc`; non-document sources are delivered as mobile-friendly PDFs that combine preprocessed original text plus the translated/formatted result. Output filenames use the uploaded source stem plus `_translated`, and appended source text is labeled `[원문]` rather than appendix/`부록`. Added `{projectRoot}` command placeholders, `scripts/run-codex-postprocess.sh`, `scripts/run-claude-postprocess.sh`, `scripts/smoke-agent-postprocess.sh`, `npm run smoke:agent:ready`, `npm run smoke:agent:live`, and operations documentation for Codex and Claude command recipes.

## Sprint 12 — Utility Cleanup And Bot Separation Prep

- **id**: `sprint-12-utility-cleanup-polish`
- **goal**: Prepare the post-processing flow for later extraction into a standalone utility bot.
- **tasks**:
  - Add hidden/skeleton interfaces for regenerate and discard output actions.
  - Add scheduled cleanup cadence to the worker loop.
  - Add operator-facing output status messages.
  - Document the personal-OAuth-only operating boundary and API migration path for future paid service use.
  - Later, expose regenerate/discard controls in Telegram only after the primary upload, post-processing, and download flow is stable. This is a low-priority follow-up.
- **acceptance criteria**:
  - Utility concerns are isolated from wiki/raw capture concerns.
  - Expired output cleanup is repeatable after worker restart.
  - Public/multi-user service constraints are documented.
- **status**: in progress, implementation-complete except live validation. First slice added hidden `output-discard:<output_id>` and `output-regenerate:<output_id>` callback interfaces. Discard deletes the runtime output file and marks the output deleted; regenerate currently records `output.regenerate_requested` without exposing a Telegram button or re-running the agent. Current polish also added OCR preprocessing for scanned PDF and image uploads through `pdftoppm` plus `tesseract`, while leaving the existing language preset scope unchanged. The worker now performs expired-output cleanup on startup and then on `WORKER_OUTPUT_CLEANUP_INTERVAL_MS`, and `/status` reports output downloadability, expiry, and discard state. Operator docs record the personal-OAuth-only boundary and API migration path for any future public/multi-user service. User-facing regenerate/discard controls are deliberately parked as low-priority follow-up work.

## Sprint 13 — Vault Reconcile And Retention

- **id**: `sprint-13-vault-reconcile-retention`
- **goal**: Make raw/wiki/output deletion safe by separating managed delete, manual drift detection, LLMwiki graph lint, and SQLite tombstone state.
- **tasks**:
  - Add SQLite retention metadata for source bundle tombstones and drift status, plus a job event trail for managed/manual deletion outcomes.
  - Add a deterministic `vault:reconcile` dry-run command that compares `source_bundles`, `job_outputs`, raw bundle files, and wiki references against the filesystem.
  - Integrate configured LLMwiki lint as a wiki graph check only; it may report broken links/orphans but must not directly mutate SQLite.
  - Add an explicit apply mode for reconcile findings that can mark missing/deleted bundles and outputs without recreating raw evidence.
  - Define a managed delete command path for future Telegram/CLI UX that removes related runtime outputs, delegates wiki cleanup, and tombstones SQLite state.
  - Update `/status`, retry, and download behavior so missing/deleted source bundles or outputs produce clear operator messages.
- **acceptance criteria**:
  - Manual deletion of `raw/**` or `wiki/**` produces a deterministic drift report instead of silent desync.
  - Dry-run reconcile performs no writes; apply mode requires an explicit operator flag.
  - SQLite can distinguish present, missing, intentionally deleted, and orphaned source/output state.
  - LLMwiki lint findings are linked into the report without being treated as DB authority.
  - Retries never recreate missing raw evidence implicitly; they require restore, reimport, or delete-confirm.
- **status**: planned after Sprint 12 live validation.
