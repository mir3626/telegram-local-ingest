# Orchestrator Handoff

## Identity

- **repo**: `telegram-local-ingest`
- **path**: `C:\Users\Tony\Workspace\telegram-local-ingest`
- **current iteration**: `iter-1`
- **current sprint**: `sprint-2-sqlite-job-model`
- **harnessVersion**: `1.5.0`

## Status

The repository has been created from `vibe-doctor`. Sprint 0 and Sprint 1 are complete. The project context now targets a Telegram Local Bot API Server based local ingest worker, and the code has a baseline config loader, Telegram Bot API client, startup health check, and mocked tests.

## Durable Decisions

- Use Telegram as the single capture, command, and notify channel.
- Use Telegram Local Bot API Server for large files.
- Do not include Dropbox in V1.
- Use npm workspaces initially for harness compatibility.
- Use deterministic TypeScript code for queue, state, file import, retry, permissions, and notifications.
- Use RTZR STT for audio and voice files.
- Write immutable Obsidian raw bundles under `raw/<date>/<source_id>/`.
- Let the LLM wiki adapter update `wiki/**` only, never `raw/**`.

## Next Action

Start Sprint 2: SQLite job model and state machine.

```text
Implement migrations and durable state for jobs, job_files, job_events, telegram_offsets, and source_bundles.
```

## Links

- Product context: `docs/context/product.md`
- Architecture context: `docs/context/architecture.md`
- Roadmap: `docs/plans/sprint-roadmap.md`
