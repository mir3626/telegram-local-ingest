# Orchestrator Handoff

## Identity

- **repo**: `telegram-local-ingest`
- **path**: `C:\Users\Tony\Workspace\telegram-local-ingest`
- **current iteration**: `iter-1`
- **current sprint**: `sprint-8-status-retry-cancel`
- **harnessVersion**: `1.5.0`

## Status

The repository has been created from `vibe-doctor`. Sprint 0 through Sprint 7 are complete. The project context now targets a Telegram Local Bot API Server based local ingest worker, and the code has config loading, Telegram Bot API baseline, startup health checks, SQLite-backed operational state, Telegram capture-to-job creation, controlled Telegram file import into runtime staging/archive, immutable Obsidian raw bundle writing, RTZR STT client/helpers, and a protected wiki ingest adapter boundary.

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
- Use `packages/rtzr` as the RTZR STT boundary for auth, submit/poll, transcript artifacts, and ffmpeg conversion helpers.
- Use `packages/wiki-adapter` as the LLM/wiki command boundary, guarded by a write lock and raw snapshot checks.
- Use RTZR STT for audio and voice files.
- Write immutable Obsidian raw bundles under `raw/<date>/<source_id>/`.
- Let the LLM wiki adapter update `wiki/**` only, never `raw/**`.

## Next Action

Start Sprint 8: Status, retry, cancel, and operator polish.

```text
Implement Telegram-facing /status, /retry, /cancel handling, completion/failure messages, daily failed jobs report skeleton, and MVP operator startup docs.
```

## Links

- Product context: `docs/context/product.md`
- Architecture context: `docs/context/architecture.md`
- Roadmap: `docs/plans/sprint-roadmap.md`
