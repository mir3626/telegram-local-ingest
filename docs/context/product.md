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
5. Worker normalizes content by type. Audio and voice files go through RTZR STT and are persisted immediately as transcript artifacts.
6. Worker writes an Obsidian raw bundle under `raw/<date>/<source_id>/`.
7. Worker calls a narrow wiki ingest adapter that can update wiki notes but cannot modify raw bundles.
8. Worker sends Telegram ACK, completion, failure, status, and retry notifications.

## Post-Processing Utility Workflow

The next product layer adds a personal utility flow on top of the ingest pipeline. It remains local-first and operator-only:

1. User uploads a file to the allowlisted Telegram bot.
2. Worker imports the file, runs type-specific preprocessing, and writes immutable source evidence.
3. Worker runs a deterministic language/translation-needed check over extracted text, DOCX text, or transcripts.
4. If translation or formatting is needed, worker calls a local agent adapter. Codex is the first provider; Claude Code can be added through the same adapter later.
5. Agent output is written to an output-only workspace and, when appropriate, to the wiki boundary. `raw/**` remains immutable.
6. Worker sends a Telegram completion message with a download button. Downloadable outputs expire after 24 hours and are deleted from runtime storage.

The utility layer is intentionally designed for later extraction into a separate bot: preprocessing, language detection, agent execution, and output retention are separate boundaries rather than worker-internal scripts.
`TRANSLATION_TARGET_LANGUAGE` defaults to `ko`; `TRANSLATION_DEFAULT_RELATION` defaults to `business` for later prompt tone and terminology handling.
Local agent post-processing is disabled by default through `AGENT_POSTPROCESS_PROVIDER=none`; enabling Codex or a custom command requires an explicit `AGENT_POSTPROCESS_COMMAND`. When enabled, the worker runs the agent only for jobs whose deterministic language check says translation is needed, then stores a 24-hour runtime output and sends Telegram download buttons with the actual KST expiry deadline. DOCX is the editable document baseline: DOCX/PDF/HWP-family sources are delivered as document files named `<source-stem>_translated.<ext>`, preferring agent-created DOCX/HWP/HWPX outputs and falling back to worker-rendered DOCX through `pandoc`. The current local skill inventory has DOCX editing support but no HWP/HWPX editing skill, so HWP/HWPX fallback remains DOCX unless an agent explicitly creates a valid native HWP/HWPX output. Non-document sources are delivered as a mobile-friendly `<source-stem>_translated.pdf` that combines the preprocessed original text and the translated/formatted result. PDF source uploads require `pdftotext` for text extraction before language detection. The original text section must be labeled `[원문]`, not appendix/`부록`. The Codex recipe uses `{projectRoot}/scripts/run-codex-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}`.

The worker now keeps Telegram polling/callback handling responsive while a bounded background pool processes jobs. Default concurrency is conservative: `WORKER_JOB_CONCURRENCY=2`, `WORKER_STT_CONCURRENCY=1`, and `WORKER_AGENT_CONCURRENCY=1`. This allows another upload or download click to be handled while a long post-processing job runs, without opening multiple personal OAuth agent sessions by default.

Regenerate and discard output actions have hidden callback interfaces for future utility-bot UX. Discard is functional for runtime cache cleanup; regenerate currently records an intent event only. Exposing these controls as user-facing Telegram buttons is a low-priority follow-up goal after the upload, post-processing, and download path is stable.

## Adoption Review Follow-Ups

These product review items should stay visible as separate product work or validation, not as harness adoption scope:

- Verify PDF `pdftotext` readiness, setup, and operator documentation for PDF preprocessing.
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
- MVP can run on one local Windows machine with Node 24+, SQLite, ffmpeg, Telegram Local Bot API Server, and an Obsidian vault path.

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
