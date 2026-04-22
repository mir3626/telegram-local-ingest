# Orchestrator Handoff

## Identity

- **repo**: `telegram-local-ingest`
- **path**: `C:\Users\Tony\Workspace\telegram-local-ingest`
- **current iteration**: `iter-1`
- **current sprint**: `completed`
- **harnessVersion**: `1.5.0`

## Status

The repository has been created from `vibe-doctor`. Sprint 0 through Sprint 8 are complete. The project context now targets a Telegram Local Bot API Server based local ingest worker, and the code has config loading, Telegram Bot API baseline, startup health checks, SQLite-backed operational state, Telegram capture-to-job creation, controlled Telegram file import into runtime staging/archive, immutable Obsidian raw bundle writing, RTZR STT client/helpers, a protected wiki ingest adapter boundary, and Telegram operator command primitives.

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
- Use `packages/operator` for Telegram status/retry/cancel and notification/report text.
- Use RTZR STT for audio and voice files.
- Write immutable Obsidian raw bundles under `raw/<date>/<source_id>/`.
- Let the LLM wiki adapter update `wiki/**` only, never `raw/**`.

## Next Action

MVP roadmap is complete. Next practical step is integration wiring in `apps/worker` against a live local Telegram Bot API Server and a real Obsidian vault.

```text
Run a live smoke: local Telegram server -> /ingest file -> SQLite job -> import -> raw bundle -> optional RTZR/wiki adapter -> Telegram status.
```

## Links

- Product context: `docs/context/product.md`
- Architecture context: `docs/context/architecture.md`
- Roadmap: `docs/plans/sprint-roadmap.md`
