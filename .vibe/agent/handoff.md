# Orchestrator Handoff

## Identity

- **repo**: `telegram-local-ingest`
- **path**: `C:\Users\Tony\Workspace\telegram-local-ingest`
- **current iteration**: `iter-1`
- **current sprint**: `sprint-6-rtzr-stt`
- **harnessVersion**: `1.5.0`

## Status

The repository has been created from `vibe-doctor`. Sprint 0 through Sprint 5 are complete. The project context now targets a Telegram Local Bot API Server based local ingest worker, and the code has config loading, Telegram Bot API baseline, startup health checks, SQLite-backed operational state, Telegram capture-to-job creation, controlled Telegram file import into runtime staging/archive, and immutable Obsidian raw bundle writing.

## Durable Decisions

- Use Telegram as the single capture, command, and notify channel.
- Use Telegram Local Bot API Server for large files.
- Do not include Dropbox in V1.
- Use npm workspaces initially for harness compatibility.
- Use deterministic TypeScript code for queue, state, file import, retry, permissions, and notifications.
- Use `packages/db` as the SQL boundary; app code should call repository functions rather than writing SQL inline.
- Use `packages/capture` as the Telegram update-to-job orchestration boundary.
- Use `packages/importer` as the Telegram file import boundary; never process files in-place from Bot API storage.
- Use `packages/vault` as the immutable raw bundle writing boundary.
- Use RTZR STT for audio and voice files.
- Write immutable Obsidian raw bundles under `raw/<date>/<source_id>/`.
- Let the LLM wiki adapter update `wiki/**` only, never `raw/**`.

## Next Action

Start Sprint 6: RTZR STT audio processor.

```text
Add ffmpeg checks and RTZR auth/submit/poll handling so Telegram audio and voice files produce persisted transcript artifacts.
```

## Links

- Product context: `docs/context/product.md`
- Architecture context: `docs/context/architecture.md`
- Roadmap: `docs/plans/sprint-roadmap.md`
