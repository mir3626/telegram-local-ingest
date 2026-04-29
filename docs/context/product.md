# Product Context

## One-Liner

`telegram-local-ingest` is a local-first ingest worker that receives raw data through Telegram, imports large files through Telegram Local Bot API Server, normalizes them into immutable Obsidian raw bundles, and triggers a controlled LLM wiki ingest flow with Telegram status notifications.

## Target Users

- Primary operator: a local PC/server owner who maintains an Obsidian-based LLM wiki.
- Capture user: the same person or an allowlisted user sending screenshots, documents, audio, text, and other source material from mobile or desktop Telegram.
- Future operator: a person who wants a single capture channel without trusting a general-purpose LLM agent with file lifecycle, permissions, retry logic, or notification state.

## Core Workflow

1. User sends text, screenshots, documents, audio, voice notes, archives, or other files to a Telegram bot.
2. User sends `/ingest` with optional project, tag, and instruction metadata.
3. Local worker polls Telegram Local Bot API Server, validates allowlist and command intent, and creates a durable SQLite job.
4. Worker imports the Telegram local file path into runtime staging, computes hash, deduplicates, and archives the immutable original.
5. Worker normalizes content by type. Audio and voice files go through STT and are persisted immediately as transcript artifacts, then exposed to Telegram as mobile-friendly DOCX transcript downloads when document rendering is available.
6. Worker writes an Obsidian raw bundle under `raw/<date>/<source_id>/`.
7. Worker calls a narrow wiki ingest adapter that can update wiki notes but cannot modify raw bundles.
8. Worker sends Telegram ACK, completion, failure, status, and retry notifications.

Plain text Telegram messages without uploaded files are treated as wiki chat requests, not ingest jobs, unless they are registered bot slash commands. The worker calls the configured `WIKI_CHAT_COMMAND`, passes the operator message plus vault roots, shows a pending Telegram message plus periodic typing action while the command runs, replaces the pending message with the final answer or error, rejects any raw-bundle mutation detected around the command, and splits long answers across multiple Telegram messages. Unknown slash text and compound natural-language requests go to the wiki chat agent rather than regex action routing.

## Post-Processing Utility Workflow

The next product layer adds a personal utility flow on top of the ingest pipeline. It remains local-first and operator-only:

1. User uploads a file to the allowlisted Telegram bot.
2. Worker imports the file, runs type-specific preprocessing, and writes immutable source evidence.
3. Worker runs a deterministic language/translation-needed check over extracted text, DOCX text, or transcripts.
4. If translation or formatting is needed, worker calls a local agent adapter. Codex and Claude Code can both be tested through the same adapter contract.
5. Agent output is written to an output-only workspace and, when appropriate, to the wiki boundary. `raw/**` remains immutable.
6. Worker sends a Telegram completion message with a download button. Downloadable outputs expire after 24 hours and are deleted from runtime storage.

The utility layer is intentionally designed for later extraction into a separate bot: preprocessing, language detection, agent execution, output status, and output retention are separate boundaries rather than worker-internal scripts.
`TRANSLATION_TARGET_LANGUAGE` defaults to `ko`; `TRANSLATION_DEFAULT_RELATION` defaults to `business` for later prompt tone and terminology handling.
Local agent post-processing is disabled by default through `AGENT_POSTPROCESS_PROVIDER=none`; enabling Codex, Claude, or a custom command requires an explicit `AGENT_POSTPROCESS_COMMAND`. When enabled, the worker runs the agent only for jobs whose deterministic language check says translation is needed, then stores a 24-hour runtime output and sends Telegram download buttons with the actual KST expiry deadline. DOCX is the editable document baseline: DOCX/PDF/EML/HWP-family sources are delivered as document files named `<source-stem>_translated.docx`, but agents are Markdown/JSON translation workers, not document renderers. STT-only audio outputs keep the raw `*.transcript.md` artifact for preprocessing and raw bundle traceability, but the user-facing Telegram download is rendered as `<source-stem>_transcript.docx` through `pandoc` when available, with Markdown retained only as a renderer fallback. For uploaded DOCX sources, preprocessing writes deterministic text block ids, the agent returns `translations.json`, and the worker preserves the original DOCX package by replacing body paragraph text in `word/document.xml`, validating the result, and appending the `[원문]` source section itself. If structured DOCX replacement is unavailable, PDF/EML/HWP-family sources and fallback DOCX processing are rendered through `pandoc` from `translated.md`. PDF source outputs append `[원문]` as original PDF page-image snapshots rendered by `pdftoppm`, so visual layout is preserved for review; EML/HWP-family sources still append extracted source text. EML uploads are parsed into mail headers plus the preferred text body and then follow the same translation-plus-original-section path as other document sources. Non-document sources are delivered as a mobile-friendly `<source-stem>_translated.pdf`; PNG/JPEG image sources use TSV OCR block coordinates plus `translations.json` so the worker can render translated text over the original image and append `[원문]` as the untouched source image page. Translation metadata, glossary, and translator-note sections remain worker-rendered support content; Markdown glossary tables are formatted as real tables in both DOCX and PDF output paths. PDF source uploads use `pdftotext` for text-layer extraction and fall back to `pdftoppm` plus `tesseract` OCR for scanned PDFs; image uploads use `tesseract` OCR before language detection and translation. The original text section must be labeled `[원문]`, not appendix/`부록`. The Codex recipe uses `{projectRoot}/scripts/run-codex-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}`; the Claude recipe uses `{projectRoot}/scripts/run-claude-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}`.

The worker now keeps Telegram polling/callback handling responsive while a bounded background pool processes jobs. Default concurrency is conservative: `WORKER_JOB_CONCURRENCY=2`, `WORKER_STT_CONCURRENCY=1`, and `WORKER_AGENT_CONCURRENCY=1`. This allows another upload or download click to be handled while a long post-processing job runs, without opening multiple personal OAuth agent sessions by default.

## Product Automation

Batch-style product automations are now treated as manifest-registered modules under `automations/*`, not as one npm script per task. The stable operator entrypoint is `npm run tlgi -- automation ...`. Sprint 17 establishes the registry, enable/disable state, manual run command, and durable logs under `runtime/automation/runs/<run_id>/`. Sprint 18 adds one-shot due-run dispatch, schedule state, retry-after metadata, and user-level `systemd` timer file installation. Sprint 19 adds `fx.koreaexim.daily`, a Korea Eximbank AP01 exchange-rate capture module that writes original JSON plus canonical Markdown/CSV raw-bundle inputs and optionally triggers LLMwiki ingest. Later sprints add a product-owned ops dashboard and one-shot bootstrap packaging.

Automation modules remain one-shot local tasks. They should produce raw bundles and invoke existing worker/wiki boundaries rather than writing arbitrary wiki state directly. Secrets stay in `.env`; module manifests only declare required env names so readiness can report missing configuration without exposing values.

Regenerate and discard output actions have hidden callback interfaces for future utility-bot UX. Discard is functional for runtime cache cleanup; regenerate currently records an intent event only. Expired-output cleanup runs on worker startup and then on a configured cadence, while `/status` shows whether outputs are downloadable, expired, or discarded. Exposing regenerate/discard controls as user-facing Telegram buttons is a low-priority follow-up goal after the upload, post-processing, and download path is stable.

Personal OAuth-backed Codex/Claude Code automation is an operator-only local workflow. A public, paid, or multi-user utility bot must migrate to official API credentials with isolated workspaces, per-user quota/accounting, and explicit retention controls before accepting untrusted users.

## Retention And Reconcile Policy

Raw bundles and wiki notes can become stale or valueless over time, but deletion must remain explicit because SQLite is the operational source of job state. The preferred deletion path is the managed delete CLI, `npm run tlgi -- vault delete <id>`, which starts from a job/source bundle/derived artifact identity, dry-runs by default, removes related raw/wiki/derived/runtime output files only with `--apply`, and records the deletion in SQLite as job events plus a durable tombstone instead of silently dropping history.

LLMwiki source policy is now explicit: wiki raw is the finalized raw bundle plus deterministic canonical text projections, not the rendered user deliverables. `_translated.docx`, `_translated.pdf`, image overlay PDFs, transcript DOCX downloads, and `runtime/outputs/**` are convenience outputs only. The wiki layer should read `source.md`, `manifest.yaml`, and manifest-declared canonical wiki inputs, with optional translation aids clearly marked as secondary.

Manual deletion from Obsidian, `raw/**`, or `wiki/**` is treated as drift, not as the canonical deletion workflow. `npm run tlgi -- vault reconcile [--json]` scans SQLite records plus automation run result metadata against the filesystem and reports missing raw bundle parts, missing wiki pages, active output files missing on disk, orphan raw/derived bundle folders, and orphan wiki source/derived pages. Tombstoned missing paths are reported as intentionally deleted state. The command does not recreate deleted raw bundles automatically.

LLMwiki lint is useful for wiki graph health, such as broken links, missing source references, or orphan wiki notes. It is not sufficient for SQLite synchronization. SQLite reconciliation must be owned by the worker/CLI because it must update `source_bundles`, `job_outputs`, and job events consistently.

## Adoption Review Follow-Ups

These product review items should stay visible as separate product work or validation, not as harness adoption scope:

- Verify PDF `pdftotext` readiness, setup, and operator documentation for PDF preprocessing.
- Verify OCR readiness, setup, and operator documentation for scanned PDF and image preprocessing.
- Verify PDF/DOCX output policy alignment across code, operations docs, and Telegram download labels.
- Verify DOCX XML sanitizing for extracted source text before it is inserted into generated Word XML.

## Success Criteria

- Mobile and PC capture are both usable through Telegram share/send flows.
- Large files are handled through Telegram Local Bot API Server instead of Dropbox.
- Worker can restart without losing job state.
- Raw source bytes and derived artifacts are traceable through manifest metadata.
- Raw bundles are immutable once finalized.
- LLM agent access is constrained to wiki ingest, not capture, file import, queue state, or retry decisions.
- Downloadable generated outputs are stored outside the vault, have explicit expiry metadata, and can be deleted without losing source evidence.
- Local agent automation is for personal/operator use only; future paid or multi-user service variants must use official API credentials instead of routing other users through a personal OAuth session.
- MVP can run on one local operator workstation with Node 24+, SQLite, ffmpeg, Telegram Local Bot API Server, and an Obsidian vault path. Linux dependency setup is scripted for document rendering, PDF extraction/OCR, image OCR, CJK PDF fonts, and optional SenseVoice CPU STT.

## Non-Goals For V1

- Dropbox or cloud drive ingestion.
- Multi-user permission matrix beyond an explicit allowlist.
- Public web dashboard.
- Vector database.
- Full human review UI.
- n8n production gateway.
- General-purpose OpenClaw/Hermes automation as the front door.
- Public or paid utility bot backed by personal Codex/Claude OAuth credentials.
- Pixel-perfect Office/PDF layout preservation in the first utility slice.

## Key Product Decisions

- Telegram is the single command/capture/notify channel.
- Telegram Local Bot API Server replaces Dropbox for large files.
- Queue/state handling is deterministic TypeScript code, not LLM reasoning.
- Obsidian raw bundles are the source of truth for ingested source packages.
- RTZR STT output is copied into the raw bundle immediately because remote STT results are temporary.
- The initial package manager is npm workspaces to stay compatible with the `vibe-doctor` harness.
- Generated user-download outputs are operational artifacts under `runtime/outputs`, not source-of-truth vault content.
- Product automations are module manifests plus one-shot runners, managed through the ops CLI instead of package script sprawl.
- Managed delete and deterministic reconcile are available through `npm run tlgi -- vault ...`; Telegram UX for those maintenance actions is a later operator convenience.
