# Orchestrator Handoff

## Identity

- **repo**: `telegram-local-ingest`
- **path**: `C:\Users\Tony\Workspace\telegram-local-ingest`
- **current iteration**: `iter-1`
- **current sprint**: `sprint-3-telegram-capture`
- **harnessVersion**: `1.5.0`

## Status

The repository has been created from `vibe-doctor`. Sprint 0, Sprint 1, and Sprint 2 are complete. The project context now targets a Telegram Local Bot API Server based local ingest worker, and the code has config loading, Telegram Bot API baseline, startup health checks, and SQLite-backed operational state.

## Durable Decisions

- Use Telegram as the single capture, command, and notify channel.
- Use Telegram Local Bot API Server for large files.
- Do not include Dropbox in V1.
- Use npm workspaces initially for harness compatibility.
- Use deterministic TypeScript code for queue, state, file import, retry, permissions, and notifications.
- Use `packages/db` as the SQL boundary; app code should call repository functions rather than writing SQL inline.
- Use RTZR STT for audio and voice files.
- Write immutable Obsidian raw bundles under `raw/<date>/<source_id>/`.
- Let the LLM wiki adapter update `wiki/**` only, never `raw/**`.

## Next Action

Start Sprint 3: Telegram capture and command parser.

```text
Implement getUpdates polling with durable offset, update parsing, allowlist checks, /ingest command parsing, and job creation through packages/db.
```

## Links

- Product context: `docs/context/product.md`
- Architecture context: `docs/context/architecture.md`
- Roadmap: `docs/plans/sprint-roadmap.md`
