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
   - `packages/agent-adapter`: Local command adapter for Codex or Claude Code translation/formatting execution.
   - `packages/automation-core`: Manifest discovery, readiness checks, and one-shot automation module execution.
   - `apps/ops-cli`: Product-owned operator CLI for automation registry, enable/disable, manual runs, and logs.

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
  automation/
    runs/
  wiki.lock
```

`runtime/` is operational state and must not be treated as Obsidian content.
`runtime/outputs/` is a TTL-controlled delivery cache. Files under it can be deleted after expiry because raw bundles and wiki artifacts remain the durable sources of truth.

## Worker Dispatch

`apps/worker` runs a responsive local loop:

1. Poll Telegram updates and advance durable offsets.
2. Route `/status`, `/retry`, and `/cancel` through `packages/operator`.
3. Route file uploads, with or without `/ingest`, through `packages/capture`.
4. Claim runnable jobs through SQLite `job_claims`.
5. Process claimed jobs in a bounded background pool through file import, raw bundle writing, optional wiki adapter execution, Telegram notification, and terminal state transition.

Polling and callback handling are separated from long job execution. This keeps uploads, status, retry, STT preset selection, and download buttons responsive while Codex/RTZR/SenseVoice work is still running. `WORKER_JOB_CONCURRENCY` controls total simultaneous jobs, while `WORKER_STT_CONCURRENCY` and `WORKER_AGENT_CONCURRENCY` bound the expensive STT and local OAuth agent sections. The default keeps agent concurrency at `1` because personal Codex/Claude CLI sessions are more fragile under parallel load.

The post-processing utility layer extends this loop after source artifacts exist:

1. Preprocess by file type and collect text/structured artifacts.
2. Run a deterministic language check to decide whether translation is needed.
3. Call the configured agent adapter in a job-scoped workspace.
4. Register downloadable files in `job_outputs` and `runtime/outputs`.
5. Notify Telegram with a download button whose callback resolves the output only if it is still active.
6. Periodically delete expired output files and mark them deleted in SQLite.

Preprocessing records `preprocess.completed` and `language.detected` job events for deterministic text boundaries. For new bundles, text-like originals, DOCX body blocks, EML headers/body text, PDF text/OCR output, and image OCR output are extracted during `BUNDLE_WRITING`, copied into finalized `raw/**/extracted/`, and then reused by language detection and agent post-processing through raw-bundle paths. STT transcript Markdown is produced before bundle finalization, copied into `raw/**/extracted/`, and consumed as cleaned transcript text after stripping Markdown boilerplate. The worker stores artifact metadata plus language signals in SQLite rather than duplicating source text in the database. Image OCR stores line-level block coordinates beside the extracted text when Tesseract TSV data is available.

Sprint 11 adds `packages/agent-adapter` and worker integration. The adapter builds a job-scoped prompt, writes it into a separate `.agent-work` directory, runs a configured local command with `{projectRoot}`, `{promptFile}`, `{outputDir}`, `{bundlePath}`, and `{jobId}` placeholders or stdin prompt delivery, snapshots `raw/**` before/after execution, and rejects any raw mutation. During `INGESTING`, the worker runs the adapter only when deterministic language detection says translation is needed, registers generated download artifacts through `packages/output-store`, and includes active download buttons in the Telegram completion notification. Agents are restricted to `translated.md` plus `translations.json` when a structured DOCX/image block structure is provided; they must not create DOCX/PDF/HWP/HWPX/ZIP/binary deliverables. DOCX is the editable document baseline for DOCX/PDF/EML/HWP-family sources. For DOCX sources, preprocessing extracts deterministic paragraph block ids, the agent returns translated text by block id, and the worker clones the original DOCX package, replaces body paragraph text in `word/document.xml`, appends `[원문]` itself, validates the package, and ignores any agent-created document binary. If the structured DOCX path is unavailable or invalid, the worker falls back to `pandoc` rendering from `translated.md`; PDF/EML/HWP-family sources also use that Markdown-to-DOCX path. PDF source `[원문]` sections embed `pdftoppm` page-image snapshots of the original PDF instead of extracted text so the visual source layout remains reviewable. PNG/JPEG image sources with OCR block translations use direct PDF rendering: the first source page reuses the original image with translated text boxes overlaid on OCR coordinates, and `[원문]` embeds the untouched original image page. Other non-document sources use direct text PDF rendering for mobile-friendly downloads. Worker-owned renderers preserve translation metadata/glossary sections across these paths: Markdown pipe tables become styled Word tables in DOCX outputs and drawn tables in PDF outputs. PDF source preprocessing depends on `pdftotext` from poppler-utils for text-layer PDFs and `pdftoppm` plus `tesseract` for scanned PDFs; EML preprocessing depends on the built-in MIME parser and prefers `text/plain` over HTML alternatives; image source preprocessing depends on `tesseract`. Output filenames use the uploaded source stem plus `_translated`. The source text section is labeled `[원문]` instead of appendix/`부록`. `scripts/run-codex-postprocess.sh` and `scripts/run-claude-postprocess.sh` are operator-ready local agent command wrappers; `scripts/smoke-agent-postprocess.sh` provides readiness and explicit live smoke entrypoints for both providers.

Sprint 12 starts output lifecycle separation. Hidden callback interfaces exist for `output-discard:<output_id>` and `output-regenerate:<output_id>` but are not exposed in Telegram keyboards. Discard deletes the runtime output file and marks the output deleted in SQLite. Regenerate records `output.regenerate_requested` as an interface-only event until automatic regeneration is implemented. The worker runs expired-output cleanup on startup and then on `WORKER_OUTPUT_CLEANUP_INTERVAL_MS`, and `/status` reports whether recorded outputs are downloadable, expired, or discarded. User-facing Telegram controls for regenerate/discard are intentionally deferred as a low-priority follow-up.

Iteration 2 adds the LLMwiki raw policy. Wiki raw means the finalized raw bundle plus deterministic canonical text projections, not the rendered user deliverables. Raw bundle schema version 2 writes `wiki_inputs` entries classified as `canonical_text`, `translation_aid`, `evidence_original`, or `structure`. LLMwiki agents should read `source.md`, `manifest.yaml`, and declared canonical inputs by default; they must not treat `_translated.*`, image overlay PDFs, transcript DOCX files, or `runtime/outputs/**` as source authority. DOCX/PDF/EML/image/text canonical preprocessing now feeds finalized `raw/**/extracted/` artifacts before wiki ingest; retries reuse finalized bundles instead of rewriting source evidence.

## Automation Runtime

Product automations are registered by folder manifests under `automations/*` and operated through `npm run tlgi -- automation ...`. `package.json` should expose the stable CLI entrypoint, not one command per batch. Sprint 17 stores module snapshots and run history in SQLite tables `automation_modules`, `automation_runs`, and `automation_events`; run files live under `runtime/automation/runs/<run_id>/stdout.log`, `stderr.log`, and `result.json`. Sprint 18 adds `automation_schedule_state` for last due key, next due time, consecutive failure count, and retry-after metadata.

Automation modules are one-shot processes. Scheduling is a single host timer that invokes `automation dispatch`; the dispatcher decides which enabled modules are due and exits. This keeps daily or periodic jobs like exchange-rate ingestion from requiring a 24-hour resident worker. The dispatcher uses schedule-window idempotency keys to avoid duplicate daily/interval runs, and `automation timer install` writes user-level systemd service/timer files without activating them implicitly. Modules that create knowledge inputs should write immutable raw bundles and call the existing wiki ingest adapter instead of bypassing raw/wiki boundaries.

`fx.koreaexim.daily` is implemented as a manifest module under `automations/fx-koreaexim-daily`. It uses the same vault raw-bundle writer and wiki ingest adapter packages as Telegram jobs, but its source identity is deterministic (`fx_koreaexim_<YYYYMMDD>`) rather than Telegram-derived. API JSON is evidence; Markdown and CSV extracted artifacts are canonical wiki inputs.

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

The wiki ingest adapter reads the bundle contract: `source.md`, `manifest.yaml`, and manifest-declared `wiki_inputs`. It passes contract version `telegram-local-ingest.llmwiki.v1`, source/manifest paths, JSON-encoded wiki input records, citation requirements, and required `wiki/index.md` plus `wiki/log.md` paths to the configured provider-neutral command. Original binaries remain available for audit through `evidence_original`, but the token-efficient default input is canonical text.

Plain Telegram text messages that are not registered operator commands and contain no files run through `WIKI_CHAT_COMMAND` instead of creating a job. The worker passes `--message`, `--wiki-root`, `--raw-root`, `--job-id`, `--chat-id`, `--user-id`, and the shared wiki lock path to the command. Registered slash commands such as `/start`, `/status`, `/retry`, `/cancel`, and file-backed `/ingest` stay deterministic at the worker layer; ordinary text and unknown slash text go to the read-only wiki chat agent. The worker snapshots `raw/**` before and after execution and rejects the chat result if raw files changed. While the command is running, the bot sends periodic `typing` chat actions and a pending message; the final success or error replaces that pending message, and additional chunks are sent only when the answer is too long for one Telegram message.

Deletion is a separate lifecycle concern from mutation. While present, finalized raw bundles remain immutable. If a source package is no longer valuable, the preferred path is a managed delete command that resolves the job/source bundle from SQLite, removes or tombstones related runtime outputs, delegates wiki note cleanup to the configured LLMwiki/wiki tool, and records a deletion event in SQLite. Manual filesystem deletion is supported only as drift to be detected by a deterministic reconcile command.

The reconcile boundary is worker/CLI-owned, not LLM-owned. It should compare `source_bundles.bundle_path`, `manifest_path`, `source_markdown_path`, `.finalized`, `job_outputs.file_path`, and vault raw/wiki references against the filesystem. LLMwiki lint can validate wiki graph consistency, but it must not be the authority that mutates SQLite state. SQLite tombstones and drift records need a repository migration in a later sprint.

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

Vault reconcile work should extend the DB boundary with tombstone/drift metadata for `source_bundles` and possibly a dedicated reconcile findings table. Missing finalized bundles should make retry/status paths explain that the source package is missing or deleted rather than attempting to rebuild raw evidence implicitly.

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
- pandoc
- poppler-utils (`pdftotext`, `pdftoppm`)
- tesseract OCR with `eng`, `kor`, `chi_sim`, and `jpn` language data
- Noto CJK fonts for Korean/Chinese/Japanese PDF rendering
- RTZR STT API credentials
- Optional local SenseVoice CPU STT Python environment
- Obsidian vault directory
