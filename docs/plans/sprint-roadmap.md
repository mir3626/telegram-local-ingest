# Sprint Roadmap

<!-- BEGIN:VIBE:CURRENT-SPRINT -->
> **Current**: next-sprint-planning
> **Completed**: sprint-0-phase0-seed, sprint-1-telegram-local-baseline, sprint-2-sqlite-job-model, sprint-3-telegram-capture, sprint-4-local-file-import, sprint-5-vault-bundle-writer, sprint-6-rtzr-stt, sprint-7-wiki-ingest-adapter, sprint-8-status-retry-cancel, sprint-9-output-store-downloads, sprint-10-preprocessing-language-check, sprint-11-codex-agent-postprocess, sprint-12-utility-cleanup-polish, sprint-13-vault-reconcile-retention, sprint-14-wiki-raw-input-schema, sprint-15-prebundle-canonical-artifacts, sprint-16-llmwiki-ingest-contract, sprint-17-automation-registry-cli, sprint-18-automation-dispatch-scheduler, sprint-19-fx-koreaexim-daily-module, sprint-20-ops-dashboard-automation, sprint-22-derived-artifact-runner, sprint-23-generated-renderer-audit, sprint-24-artifact-dashboard-promote, sprint-24b-dashboard-sse-observability, sprint-24c-dashboard-ui-redesign, sprint-25-derived-action-library, sprint-26-fx-wiki-workflow-acceptance, sprint-27-chart-format-expansion, sprint-28-derived-presentation-documents, sprint-29-vault-trash-tombstone-ux, sprint-30-registered-renderer-qa-matrix, sprint-32-derived-artifact-content-qa
> **Pending**: sprint-21-bootstrap-packaging (deferred)
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
- **status**: completed. Added `packages/agent-adapter`, local command placeholder/stdin prompt execution, prompt hard-boundaries, output/work directory separation, raw snapshot protection, and disabled-by-default config via `AGENT_POSTPROCESS_PROVIDER`. The worker now runs the agent adapter when deterministic language detection marks translation as needed, registers generated files through `packages/output-store`, and sends a Korean completion message with `download:<output_id>` buttons for 24-hour downloads. Download button labels show the actual KST expiry deadline. DOCX/PDF/EML/HWP-family sources are delivered as worker-owned DOCX files; uploaded DOCX sources use preprocessed block ids plus agent-created `translations.json` so the worker can replace body paragraph text inside the original DOCX package before appending `[원문]`, while PDF/EML/HWP-family sources and DOCX fallback paths render from `translated.md`. Agent-created DOCX/HWP/HWPX/PDF/ZIP binaries are ignored. Non-document sources are delivered as mobile-friendly PDFs that combine preprocessed original text plus the translated/formatted result. Output filenames use the uploaded source stem plus `_translated`, and appended source text is labeled `[원문]` rather than appendix/`부록`. Added `{projectRoot}` command placeholders, `scripts/run-codex-postprocess.sh`, `scripts/run-claude-postprocess.sh`, `scripts/smoke-agent-postprocess.sh`, `npm run smoke:agent:ready`, `npm run smoke:agent:live`, and operations documentation for Codex and Claude command recipes.

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
- **status**: completed. First slice added hidden `output-discard:<output_id>` and `output-regenerate:<output_id>` callback interfaces. Discard deletes the runtime output file and marks the output deleted; regenerate currently records `output.regenerate_requested` without exposing a Telegram button or re-running the agent. Current polish also added OCR preprocessing for scanned PDF and image uploads through `pdftoppm` plus `tesseract`, while leaving the existing language preset scope unchanged. The worker now performs expired-output cleanup on startup and then on `WORKER_OUTPUT_CLEANUP_INTERVAL_MS`, and `/status` reports output downloadability, expiry, and discard state. Operator docs record the personal-OAuth-only boundary and API migration path for any future public/multi-user service. User-facing regenerate/discard controls are deliberately parked as low-priority follow-up work.

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
- **status**: completed for the product CLI maintenance path. Added SQLite `vault_tombstones`, `npm run tlgi -- vault reconcile [--json]`, and `npm run tlgi -- vault delete <id> [--apply] [--reason <text>] [--json]`. Reconcile reports SQLite/filesystem drift across raw bundles, wiki source pages, derived bundles/pages, and runtime outputs without mutating state. Managed delete dry-runs by default and only removes managed vault/runtime paths under explicit `--apply`, then marks outputs deleted, writes tombstones, and appends job events. Telegram buttons/status messaging for these maintenance actions remain a future operator UX layer.

## Sprint 17 — Automation Registry And CLI Foundation

- **id**: `sprint-17-automation-registry-cli`
- **goal**: Add a modular automation substrate so batch scripts can be added, removed, enabled, disabled, and run without growing `package.json`.
- **tasks**:
  - Add an `automations/<module_id>/manifest.json` convention with schema validation.
  - Add SQLite tables for automation modules, runs, and run events/log pointers.
  - Add a small `packages/automation-core` package for manifest discovery and one-shot module execution.
  - Add `apps/ops-cli` with stable subcommands: `automation list`, `automation run`, `automation enable`, `automation disable`, and `automation logs`.
  - Keep `package.json` limited to a single product CLI entrypoint.
- **acceptance criteria**:
  - Adding an automation folder does not require editing `package.json`.
  - Disabled modules cannot be run by dispatcher-style commands unless explicitly forced/manual.
  - Each run has durable stdout/stderr/result paths under `runtime/automation/runs/<run_id>/`.
  - CLI commands work in tests against a temp SQLite/runtime root.
- **status**: completed. Added `packages/automation-core`, `apps/ops-cli`, automation manifest discovery, SQLite automation module/run/event tables, durable run log/result files, and a single stable `npm run tlgi -- automation ...` entrypoint. Module-created `result.json` payloads are preserved inside the runner summary, disabled modules require `--force` for manual runs, and missing/deleted module folders remain visible as unavailable registry entries.

## Sprint 18 — Automation Dispatch Scheduler

- **id**: `sprint-18-automation-dispatch-scheduler`
- **goal**: Run due automations through a one-shot dispatcher suitable for `systemd` timers, without a 24-hour resident worker.
- **tasks**:
  - Extend automation manifests with schedule metadata and catch-up policy.
  - Add `automation dispatch` to run only enabled due modules.
  - Add schedule state and next-run calculations in SQLite.
  - Add a user-level `systemd` timer/service installer and uninstaller.
  - Add retry/backoff recording for failed scheduled runs.
- **acceptance criteria**:
  - One systemd timer can drive every enabled automation module.
  - If the PC was off, dispatcher can backfill according to manifest policy.
  - Scheduled runs are idempotency-keyed and do not duplicate the same date/window.
- **status**: completed. Added `automation dispatch`, schedule-window idempotency keys, SQLite `automation_schedule_state`, daily/interval due calculations with catch-up limits, retry-after metadata recording, and user-level systemd service/timer file installation through `automation timer install|status|uninstall`.

## Sprint 19 — FX Koreaexim Daily Module

- **id**: `sprint-19-fx-koreaexim-daily-module`
- **goal**: Add the first real automation module: daily Korea Eximbank exchange-rate capture into raw bundles and LLMwiki pages.
- **tasks**:
  - Add `automations/fx-koreaexim-daily` manifest and runner.
  - Read `FX_KOREAEXIM_AUTHKEY` plus target currency settings from env/config.
  - Fetch `exchangeJSON` with `data=AP01`, normalize target currencies, and preserve original JSON.
  - Write immutable raw bundles with canonical `rates.md`/`rates.csv` wiki inputs.
  - Invoke the existing wiki ingest adapter after bundle finalization.
- **acceptance criteria**:
  - Missing API key is reported as module readiness failure without exposing secrets.
  - Non-business-day/null responses are recorded as skipped, not failed data.
  - Re-running the same date is idempotent.
  - Wiki pages are token-efficient monthly/latest summaries, not raw JSON dumps.
- **status**: completed. Added `automations/fx-koreaexim-daily` with Korea Eximbank AP01 fetch/fixture support, currency filtering, deterministic `fx_koreaexim_<YYYYMMDD>` raw bundle output, original JSON evidence, canonical Markdown/CSV wiki inputs, optional wiki ingest adapter invocation, idempotent existing-bundle skip behavior, and fixture-backed regression coverage.

## Sprint 20 — Ops Dashboard Automation Controls

- **id**: `sprint-20-ops-dashboard-automation`
- **goal**: Add a product-owned local operations dashboard for automation modules, separate from the vibe-doctor harness dashboard.
- **tasks**:
  - Add `apps/ops-dashboard` served only on localhost.
  - Show module enabled state, readiness, next run, last run, and failures.
  - Add enable/disable and manual run controls with local admin guard.
  - Add run log and result viewers.
  - Link runs to raw bundles/wiki pages where available.
- **acceptance criteria**:
  - Dashboard does not depend on or edit harness `vibe-dashboard` files.
  - Secrets are never displayed; only present/missing status is shown.
  - UI actions call the same ops CLI/core boundaries used by tests.
- **status**: completed. Added `apps/ops-dashboard`, a product-owned localhost-only automation dashboard backed by the same automation-core and SQLite registry/run tables as `apps/ops-cli`. It shows module enabled/available/readiness state, next due time, last/recent runs, durable stdout/stderr/result viewers, raw bundle/wiki source links when recorded, and local enable/disable/manual-run/dispatch controls with optional `OPS_DASHBOARD_TOKEN` admin guard.

## Sprint 21 — Bootstrap Packaging

- **id**: `sprint-21-bootstrap-packaging`
- **goal**: Package the local ingest, wiki, automation, and dashboard stack into a repeatable one-shot Linux setup path.
- **tasks**:
  - Add a top-level bootstrap script that chains dependency setup, npm install/build, `.env` creation, DB migration, automation scan, and optional systemd timer install.
  - Add a release bundle layout for Linux hosts.
  - Add setup verification that checks Telegram, document/OCR tools, STT provider, wiki roots, automation registry, and timers.
  - Document reinstall/upgrade/uninstall paths.
- **acceptance criteria**:
  - A fresh Linux machine can install the local solution from one command plus env/secret input.
  - Bootstrap is idempotent and preserves existing `.env` values.
  - Packaging excludes runtime data, tokens, and machine-specific secrets.
  - LLMwiki lint findings are linked into the report without being treated as DB authority.
  - Retries never recreate missing raw evidence implicitly; they require restore, reimport, or delete-confirm.
- **status**: deferred. Keep future scripts/features modular and bootstrap-friendly, but do not implement the packaging sprint until the solution shape stabilizes further.

## Sprint 22 — Derived Artifact Runner

- **id**: `sprint-22-derived-artifact-runner`
- **goal**: Let wiki chat requests create new derived artifacts through a worker-owned execution pipeline instead of letting the LLM run arbitrary Bash.
- **tasks**:
  - Add a `tlgi.artifact.request.v1` request schema.
  - Add `packages/artifact-core` for registered/generated renderer execution.
  - Validate source paths against raw/wiki/derived allowlists and snapshot `raw/**` around execution.
  - Finalize outputs into `derived/<YYYY-MM-DD>/<artifact_id>/` with `manifest.yaml`, `source.md`, `provenance.json`, and `artifacts/*`.
  - Reuse Telegram attachment delivery for generated artifacts.
- **acceptance criteria**:
  - The LLM writes only a structured artifact request; the worker owns execution and file writes.
  - Derived artifacts are never written under `raw/**`.
  - The user prompt, request, sources, renderer, and artifact hashes are recorded in provenance.
- **status**: completed. Added `packages/artifact-core`, generated/registered renderer execution, source snapshots, derived package finalization, CLI `npm run tlgi -- artifact run`, and worker integration for `artifact-requests.json`.

## Sprint 23 — Generated Renderer Audit Log

- **id**: `sprint-23-generated-renderer-audit`
- **goal**: Make ad hoc generated renderer usage auditable and reviewable before promotion.
- **tasks**:
  - Add SQLite `artifact_renderer_runs` with request JSON, original user prompt, run paths, renderer mode/language, status, output bundle, and promote metadata.
  - Write generated renderer code under `runtime/wiki-artifacts/runs/<run_id>/generated/`.
  - Add CLI log/promote commands.
  - Ensure generated renderer runs cannot silently mutate raw source bundles.
- **acceptance criteria**:
  - Operators can inspect which user prompt caused a generated renderer.
  - Generated code and logs remain durable under runtime.
  - Promotion state is stored separately from generated run output.
- **status**: completed. SQLite schema version 7 records artifact renderer runs, `tlgi artifact logs` lists them, and `tlgi artifact promote` can promote a generated renderer into the registered renderer directory.

## Sprint 24 — Artifact Dashboard Promote

- **id**: `sprint-24-artifact-dashboard-promote`
- **goal**: Expose generated renderer review and promotion in the existing ops dashboard.
- **tasks**:
  - Add dashboard API endpoints for artifact run list/detail.
  - Show generated renderer source prompt, request JSON, generated code, stdout/stderr/result, derived bundle, and wiki page path.
  - Add `Promote to Registered Renderer` action guarded by the same local dashboard admin token path.
  - Register the existing FX one-year chart script as `fx.chart.1y`.
- **acceptance criteria**:
  - Dashboard visibly includes the user prompt that triggered generated renderer creation.
  - Promoting creates a registered renderer manifest and entry script under `WIKI_RENDERERS_DIR`.
  - Existing registered renderers can be reused from natural-language wiki chat requests.
- **status**: completed. The ops dashboard now shows a `2차 산출물 / Generated Renderer` section, detail view, prompt/code/log inspection, and promote action. The local `yoni-llm-wiki` vault now has `renderers/fx-chart-1y` registered as `fx.chart.1y`.

## Sprint 24b — Dashboard SSE Observability

- **id**: `sprint-24b-dashboard-sse-observability`
- **goal**: Upgrade the product-owned ops dashboard from manual refresh/static log reads to a real-time observability surface.
- **deliverables**:
  - Add a dashboard SSE endpoint for state and log events.
  - Add a cursor-based log tail API for safe log reads.
  - Stream only server-mapped log targets, never arbitrary user-provided paths.
  - Add a live log panel for worker, Telegram Bot API, dashboard, automation run, and artifact run logs.
  - Keep `OPS_DASHBOARD_TOKEN` compatible with EventSource through the existing local token query path.
- **acceptance criteria**:
  - Dashboard lists update from SSE state events without manual refresh.
  - Live logs can follow app logs and selected run stdout/stderr.
  - Log tailing survives append-only growth and cursor reset after truncation/rotation.
  - Tests cover tail API authorization and SSE state/log delivery.
- **status**: completed. Added `/events` Server-Sent Events, `/api/logs/tail`, live log target switching, pause/clear controls, run-log target injection from detail views, and focused dashboard tests.

## Sprint 24c — Dashboard UI Redesign

- **id**: `sprint-24c-dashboard-ui-redesign`
- **goal**: Rework the product ops dashboard into a single-page operations surface that stays readable as more monitored data is added.
- **deliverables**:
  - Use an image-generated UI mockup as the visual planning reference.
  - Replace the plain utility-dashboard look with a refined operations-console visual system: command bar, status metric ribbon, thin bordered surfaces, dark live log terminal, compact tables, and restrained status accents.
  - Add a compact top status strip for stack, automation, run, schedule, artifact, and log-target health.
  - Split the page into visible functional zones: automation modules, live logs, recent automation runs, generated renderer audits, and detail inspector.
  - Keep existing dashboard APIs, SSE behavior, token guard, and promote/manual-run actions intact.
  - Ensure desktop and mobile viewports avoid horizontal overflow.
- **acceptance criteria**:
  - The dashboard remains one page but is scannable by category.
  - Live log controls and detail inspection remain immediately accessible.
  - Browser smoke confirms the core sections render without console errors.
- **status**: completed. Rebuilt the dashboard HTML/CSS around a polished operations-console style with a command bar, summary metrics, grouped surfaces, compact tables, live log controls, and a detail inspector while preserving existing operations.

## Sprint 25 — Derived Action Library

- **id**: `sprint-25-derived-action-library`
- **goal**: Promote recurring wiki-data transformations into reusable registered renderers/scripts.
- **tasks**:
  - Add registered renderers for charts as PNG/SVG/PDF.
  - Add summary report renderers for Markdown/PDF/DOCX.
  - Add comparison table renderers for CSV/XLSX/Markdown table.
  - Add timeline renderers for Markdown/JSON.
  - Add vendor invoice summary renderers producing CSV plus `report.md`.
  - Add FX statistics renderers for period statistics, `chart.png`, `stats.csv`, and `summary.md`.
  - Add STT meeting action-item renderers.
  - Add multi-document glossary renderers.
  - Add topic-specific wiki index rebuild helpers.
- **acceptance criteria**:
  - High-value repeated actions run as registered renderers rather than ad hoc generated code.
  - Each renderer writes provenance-rich derived packages and declares supported artifact kinds.
  - Generated renderer promotion remains the path for discovering future reusable renderers.
- **status**: completed for the first reusable action batch. Sprint 25A added registered renderers in `llmwiki-runtime-kit`: `report.summary`, `table.compare`, `timeline.extract`, `invoice.vendor-summary`, `fx.stats.period`, `meeting.actions`, `glossary.extract`, `wiki.index.topic`, and `notebooklm.export-pack`. Remaining follow-up: broaden generic chart formats beyond current PNG-first FX statistics and improve semantic quality where deterministic extraction is too shallow.

## Sprint 26 — FX Wiki Workflow Acceptance

- **id**: `sprint-26-fx-wiki-workflow-acceptance`
- **goal**: Prove the FX LLMwiki source set can answer common natural-language derived-output requests through registered renderers, not ad hoc generated code.
- **tasks**:
  - Add a product-side smoke command that checks vault reconcile before and after FX workflow runs.
  - Exercise `fx.stats.period`, `table.compare`, and `notebooklm.export-pack` against the live FX wiki source set.
  - Verify each run records SQLite `artifact_renderer_runs` as `registered`, writes finalized `derived/**` packages, and ingests `wiki/derived/**` pages.
  - Align `ops-cli artifact run` derived-ingest fallback with the worker so local CLI and Telegram execution produce the same wiki side effects.
  - Strengthen wiki chat routing guidance so custom FX date-range chart requests use `fx.stats.period`.
- **acceptance criteria**:
  - `npm run smoke:fx-wiki` passes when Korea Eximbank FX source pages exist in the local vault.
  - The smoke leaves reconcile clean and produces inspectable derived artifacts/pages.
  - Natural-language custom FX period requests are guided to registered renderers before generated renderers.
- **status**: completed. Added `scripts/smoke-fx-wiki-workflow.mjs`, `npm run smoke:fx-wiki`, CLI derived-ingest fallback, and deployed runtime-kit chat guidance. Live smoke created registered FX statistics, comparison table, and NotebookLM export pack derived packages/pages, with `npm run tlgi -- vault reconcile --json` still clean.

## Sprint 27 — Chart Format Expansion

- **id**: `sprint-27-chart-format-expansion`
- **goal**: Extend the registered FX chart/statistics renderer beyond PNG-only output while keeping ordinary Telegram chart requests compact.
- **tasks**:
  - Add `chartFormats`/`formats` support to `fx.stats.period`.
  - Support `png`, `svg`, and `pdf` chart outputs with declared media types.
  - Keep the default chart output to PNG unless the user explicitly asks for more formats.
  - Update wiki chat routing guidance so agents can request SVG/PDF when needed.
  - Extend the FX wiki smoke to prove PNG/SVG/PDF artifacts are packaged and ingested.
- **acceptance criteria**:
  - Registered FX period requests can produce `chart.png`, `chart.svg`, and `chart.pdf`.
  - `npm run smoke:fx-wiki` verifies all three chart formats and leaves reconcile clean.
  - No generated renderer is needed for common FX chart export format requests.
- **status**: completed. `fx.stats.period` now accepts `parameters.chartFormats` or `parameters.formats`, defaults to PNG, and can emit PNG/SVG/PDF. The live vault was updated through runtime-kit allowlist deploy, and the product smoke now validates all three chart formats.

## Sprint 28 — Derived Presentation Documents

- **id**: `sprint-28-derived-presentation-documents`
- **goal**: Wrap every second-order artifact package in a human-readable document by default while preserving renderer-produced raw content artifacts for reuse.
- **tasks**:
  - Add a worker-owned presentation stage after registered/generated renderer execution.
  - Create a default DOCX presentation document that embeds readable summaries, tables, and images from generated content artifacts.
  - Use title-based delivery names shaped as `<artifact_id>_<agent-generated artifact title>.docx`.
  - Support optional PDF presentation output when the artifact request explicitly asks for PDF delivery.
  - Send presentation artifacts to Telegram first, while keeping raw charts/tables/DOCX/JSON/ZIPs in the derived package for audit and wiki ingest.
  - Update wiki chat guidance so agents do not generate presentation DOCX/PDF themselves.
- **acceptance criteria**:
  - Any derived package has at least one role `presentation` DOCX artifact.
  - Telegram wiki-chat artifact delivery sends the presentation document by default.
  - `npm run smoke:fx-wiki` verifies the presentation document alongside the FX chart/table/export content artifacts.
- **status**: completed. `packages/artifact-core` now creates DOCX presentation artifacts for derived packages, optionally converts them to PDF through LibreOffice, and names them with the agent-supplied artifact title suffix. The worker now delivers presentation artifacts first for wiki-chat artifact requests. Runtime-kit chat guidance tells agents to rely on the worker presentation layer and request PDF only through `parameters.presentationFormats`. Markdown report/table/timeline renderer outputs are normalized into DOCX artifacts during package finalization, and the presentation layer renders Markdown headings, lists, and pipe tables as Word structure instead of pasting Markdown source text.

## Sprint 29 — Vault Trash Tombstone UX

- **id**: `sprint-29-vault-trash-tombstone-ux`
- **goal**: Let users remove unwanted wiki data from active use through an Obsidian-friendly `_trash/**` layer while preserving deterministic SQLite tombstone synchronization.
- **tasks**:
  - Add a vault trash command family: `vault trash`, `vault trash-apply`, `vault trash-list`, and `vault restore`.
  - Treat manual moves into `_trash/wiki/**` as pending tombstone requests in `vault reconcile`.
  - Move connected raw/derived vault evidence into `_trash/raw/**` and `_trash/derived/**` on apply, while deleting runtime-only outputs.
  - Create `_trash/tombstones/<id>.md` pages and SQLite `vault_tombstones` rows for applied trash.
  - Exclude `_trash/**` from normal wiki chat/query and derived artifact source selection, while allowing explicit deleted/trash queries.
  - Add runtime-kit bootstrap/templates/rules for `_trash/**`.
- **acceptance criteria**:
  - A user can move a wiki source page into `_trash/wiki/sources/` and `vault trash-apply --apply` tombstones the linked raw bundle and runtime outputs.
  - `vault restore <tombstone_id> --apply` restores trash files and removes the SQLite tombstone.
  - Normal wiki chat rules exclude `_trash/**` unless the user explicitly asks for inactive/deleted data.
- **status**: completed. The product CLI now supports trash, trash-apply, trash-list, and restore. Reconcile reports untombstoned `_trash/**` entries as `trash_pending`. Runtime-kit bootstrap creates `_trash/`, rules mark it inactive, and the chat prompt excludes it by default.

## Sprint 30 — Registered Renderer QA Matrix

- **id**: `sprint-30-registered-renderer-qa-matrix`
- **goal**: Prove every registered renderer routes to the right data, rejects known wrong-source cases, and produces inspectable final artifacts from real local test documents.
- **tasks**:
  - Add a renderer QA matrix covering request shape, required source shape, expected outputs, and guard cases for every registered renderer.
  - Add a product smoke command that ingests local test documents from the configured vault's `to-be-removed/` directory.
  - Exercise registered renderers for FX charts/statistics, comparison tables, summary reports, timelines, invoice summaries, meeting action items, glossary extraction, topic indexes, and NotebookLM export packs.
  - Include guard cases for custom `fx.chart.1y`, missing-currency `fx.stats.period`, invoice false positives, and meeting false positives.
  - Copy generated final artifacts into `to-be-removed-result/<timestamp>/` for manual inspection.
- **acceptance criteria**:
  - `npm run smoke:wiki-renderers` imports the local test documents, runs all renderer success cases, runs guard cases, copies final artifacts, and leaves `vault reconcile --json` clean.
  - Runtime-kit documentation records the matrix so future registered renderers can add rows and smoke expectations before promotion.
  - Existing `smoke:fx-wiki`, typecheck, build, full tests, and checkpoint remain green.
- **status**: completed. Added `scripts/smoke-wiki-renderers.ts` and `npm run smoke:wiki-renderers`; it imports the real local files under `yoni-llm-wiki/to-be-removed`, creates raw bundles/wiki source pages, runs the full registered renderer matrix and guard cases, and copies derived artifacts plus metadata into `yoni-llm-wiki/to-be-removed-result/<timestamp>/`. Runtime-kit now documents the renderer QA matrix in `docs/renderer-qa-matrix.md`.

## Sprint 32 — Derived Artifact Content QA

- **id**: `sprint-32-derived-artifact-content-qa`
- **goal**: Catch derived artifact regressions that only become obvious after opening the generated files and comparing them with wiki source content.
- **tasks**:
  - Extend `npm run smoke:wiki-renderers` so it opens generated DOCX, CSV, XLSX, PDF, ZIP, and text artifacts instead of checking only file existence.
  - Compare selected business terms from provenance source pages against the generated user-facing artifacts.
  - Fail on zero-byte artifacts, leaked source-wrapper metadata, raw JSON/list dumps, truncated previews, generic table labels, and key invoice date/total/currency regressions.
  - Record renderer source pages in provenance for the one-year FX chart renderer so generated chart packages have an auditable source basis.
  - Repair wiki-input path handling so raw-bundle canonical artifacts are passed to the wiki ingest command as bundle-relative paths.
  - Tighten invoice extraction for date, currency, and total rows exposed by the stricter smoke.
- **acceptance criteria**:
  - `npm run smoke:wiki-renderers` imports the local test documents, regenerates all registered renderer outputs, opens the final files, compares them to wiki/provenance content, and leaves `vault reconcile --json` clean.
  - The copied result directory contains `qa-summary.md` with the artifact-level content QA notes for manual review.
  - Runtime-kit framework changes are deployed to the live `yoni-llm-wiki` vault with no allowlist drift.
- **status**: completed. The latest passing QA run copied outputs to `/home/tony/workspace/yoni-llm-wiki/to-be-removed-result/20260502_034834234`. It opened each presentation DOCX, compared source-backed terms for every registered renderer family, parsed invoice CSV cells for PacificBio and Rotterdam totals/dates/currencies, checked NotebookLM ZIP contents, and ran four guard cases. The smoke also caught and drove fixes for wiki-input relative path handling, FX chart provenance source recording, orphan derived cleanup planning, and invoice extraction edge cases.

## Iteration iter-2 — LLMwiki Foundation

This iteration turns the completed Telegram ingest utility into a Karpathy-style LLMwiki source pipeline. The core decision is that rendered user deliverables are not wiki raw. Wiki raw is the immutable raw bundle plus deterministic canonical text projections declared by `manifest.yaml` `wiki_inputs`.

### Sprint 14 — Wiki Raw Input Schema

- **id**: `sprint-14-wiki-raw-input-schema`
- **goal**: Define and implement the raw bundle contract that tells LLMwiki exactly which artifacts may be read.
- **tasks**:
  - Add `manifest.yaml` schema version 2 fields for `wiki_inputs`.
  - Classify entries as `canonical_text`, `translation_aid`, and `evidence_original`.
  - Update `source.md` so it is an LLM-readable read-order entrypoint, not a large rendered body dump.
  - Document that `runtime/outputs`, `_translated.*`, overlay PDFs, and transcript DOCX files are excluded from wiki source authority.
  - Add tests for manifest/source rendering and backwards-safe bundle layout.
- **acceptance criteria**:
  - A raw bundle declares canonical wiki inputs without requiring the LLM to inspect rendered DOCX/PDF deliverables.
  - Every wiki input links back to an original file or extracted deterministic artifact.
  - `source.md` gives the wiki agent a concise read order and authority policy.
- **status**: completed. Raw bundles now write `schema_version: 2`, `wiki_policy`, and manifest `wiki_inputs` records for canonical text, structure, translation aids, and evidence originals. `source.md` now gives LLMwiki a concise read order and authority policy, and tests cover direct vault writes plus STT transcript artifact classification.

### Sprint 15 — Pre-Bundle Canonical Artifacts

- **id**: `sprint-15-prebundle-canonical-artifacts`
- **goal**: Move deterministic text extraction into the raw bundle finalization path so wiki inputs are durable raw artifacts.
- **tasks**:
  - Run PDF/DOCX/EML/image/text canonical preprocessing before raw bundle finalization.
  - Copy canonical text artifacts and structure files into `raw/**/extracted/`.
  - Keep STT transcript Markdown as the canonical audio input while user-facing transcript DOCX remains runtime output only.
  - Record preprocessing skips and OCR confidence limits in manifest/log metadata.
  - Keep language detection and agent postprocess reading the same canonical artifact set after finalization.
- **acceptance criteria**:
  - DOCX/PDF/EML/image canonical text no longer exists only under runtime-only preprocess directories.
  - Retrying a job does not rewrite finalized raw evidence.
  - Translation/output rendering still works while wiki ingest sees only canonical text inputs.
- **status**: completed. Deterministic text, DOCX, PDF text/OCR, image OCR, and EML preprocessing now runs before raw bundle finalization and copies canonical artifacts plus structure metadata into finalized `raw/**/extracted/` files. STT transcript Markdown remains the canonical audio input and is copied from STT events into the same extracted layer. `preprocess.completed`, language detection, and agent post-processing now consume finalized raw paths, while retries reuse existing finalized bundles.

### Sprint 16 — LLMwiki Ingest Contract

- **id**: `sprint-16-llmwiki-ingest-contract`
- **goal**: Provide the LLMwiki adapter schema, prompts, and filesystem contract for maintaining `wiki/**`.
- **tasks**:
  - Define `_system/schemas/llmwiki.md` or equivalent repo-owned schema for index, log, source pages, entity/topic pages, and citations.
  - Add a local adapter wrapper that reads only `source.md`, `manifest.yaml`, and declared `wiki_inputs`.
  - Require wiki edits to cite canonical input ids/source paths and update `wiki/index.md` plus `wiki/log.md`.
  - Forbid wiki agents from treating runtime outputs or rendered translated files as source authority.
  - Add smoke tests with a fake LLMwiki command proving raw immutability and expected wiki file updates.
- **acceptance criteria**:
  - LLMwiki can ingest one finalized bundle into `wiki/**` with index/log/citations.
  - The adapter fails if it attempts to mutate `raw/**`.
  - Wiki output remains provider-neutral and can be driven by Claude, Codex, or a custom LLMwiki CLI.
- **status**: completed. The wiki adapter now loads schema v2 `manifest.yaml`, resolves manifest-declared `wiki_inputs`, passes a provider-neutral `telegram-local-ingest.llmwiki.v1` contract with source/manifest/wiki-input/citation/index/log arguments to the configured command, rejects rendered outputs as wiki source inputs, requires `wiki/index.md` and `wiki/log.md` outputs, and keeps raw bundle snapshot checks before and after command execution. `docs/schemas/llmwiki.md` defines page, citation, and output rules, and fake-command tests cover index/log writes plus raw immutability.

### Automation Continuation

The automation sprints were added to the active iteration after the LLMwiki ingest contract. Full sprint details live in their roadmap sections above; this compact continuation keeps the iteration-scoped preflight order aligned with the current work queue. Sprint 21 bootstrap packaging is intentionally deferred outside the active iteration queue.

- **id**: `sprint-17-automation-registry-cli`
- **status**: completed.
- **id**: `sprint-18-automation-dispatch-scheduler`
- **status**: completed.
- **id**: `sprint-19-fx-koreaexim-daily-module`
- **status**: completed.
- **id**: `sprint-20-ops-dashboard-automation`
- **status**: completed.
- **id**: `sprint-22-derived-artifact-runner`
- **status**: completed.
- **id**: `sprint-23-generated-renderer-audit`
- **status**: completed.
- **id**: `sprint-24-artifact-dashboard-promote`
- **status**: completed.
- **id**: `sprint-25-derived-action-library`
- **status**: completed.
- **id**: `sprint-26-fx-wiki-workflow-acceptance`
- **status**: completed.
- **id**: `sprint-27-chart-format-expansion`
- **status**: completed.
- **id**: `sprint-28-derived-presentation-documents`
- **status**: completed.
- **id**: `sprint-29-vault-trash-tombstone-ux`
- **status**: completed.

### Sprint 13 Carryover — Vault Reconcile And Retention

- **id**: `sprint-13-vault-reconcile-retention`
- **goal**: Make raw/wiki/output deletion safe after LLMwiki starts depending on durable source bundles.
- **tasks**:
  - Preserve the earlier Sprint 13 scope for SQLite tombstones, drift findings, `vault:reconcile`, and managed delete.
  - Extend reconcile to understand `wiki_inputs` and wiki citations once Sprint 14/16 define them.
  - Keep LLMwiki lint as a wiki graph health signal only; SQLite remains the authority for source bundle state.
- **acceptance criteria**:
  - Manual deletion of `raw/**` or `wiki/**` produces a deterministic drift report.
  - Missing source evidence is never silently recreated by retry or lint.
  - Reconcile can tell present, missing, intentionally deleted, and orphaned raw/wiki/output state apart.
- **status**: completed as the CLI/SQLite carryover slice. Future refinements should add dashboard/Telegram surfaces on top of the same `npm run tlgi -- vault ...` commands rather than bypassing tombstones.
