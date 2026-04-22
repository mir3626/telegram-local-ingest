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

## Success Criteria

- Mobile and PC capture are both usable through Telegram share/send flows.
- Large files are handled through Telegram Local Bot API Server instead of Dropbox.
- Worker can restart without losing job state.
- Raw source bytes and derived artifacts are traceable through manifest metadata.
- Raw bundles are immutable once finalized.
- LLM agent access is constrained to wiki ingest, not capture, file import, queue state, or retry decisions.
- MVP can run on one local Windows machine with Node 24+, SQLite, ffmpeg, Telegram Local Bot API Server, and an Obsidian vault path.

## Non-Goals For V1

- Dropbox or cloud drive ingestion.
- Multi-user permission matrix beyond an explicit allowlist.
- Public web dashboard.
- Vector database.
- Full human review UI.
- n8n production gateway.
- General-purpose OpenClaw/Hermes automation as the front door.

## Key Product Decisions

- Telegram is the single command/capture/notify channel.
- Telegram Local Bot API Server replaces Dropbox for large files.
- Queue/state handling is deterministic TypeScript code, not LLM reasoning.
- Obsidian raw bundles are the source of truth for ingested source packages.
- RTZR STT output is copied into the raw bundle immediately because remote STT results are temporary.
- The initial package manager is npm workspaces to stay compatible with the `vibe-doctor` harness.
