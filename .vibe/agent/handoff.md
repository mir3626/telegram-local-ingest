# Orchestrator Handoff

## Identity

- **repo**: `telegram-local-ingest`
- **path**: `/home/tony/workspace/telegram-local-ingest`
- **current iteration**: `iter-1`
- **current sprint**: `completed`
- **harnessVersion**: `1.5.2`

## Status

The repository has been created from `vibe-doctor`. Sprint 0 through Sprint 8 are complete. The project context now targets a Telegram Local Bot API Server based local ingest worker, and the code has config loading, Telegram Bot API baseline, startup health checks, SQLite-backed operational state, Telegram capture-to-job creation, controlled Telegram file import into runtime staging/archive, immutable Obsidian raw bundle writing, RTZR STT client/helpers, a protected wiki ingest adapter boundary, Telegram operator command primitives, and an integrated worker dispatch loop.

The harness has been synced from the local WSL-visible `vibe-doctor` template at `/mnt/c/Users/Tony/Workspace/vibe-doctor` from `1.5.0` to `1.5.2`. The Telegram-specific `.env.example` was preserved after sync because the upstream harness template is provider-only. A live smoke readiness checker now exists at `apps/worker/src/readiness.ts` and can be run with `npm run smoke:ready`.

Live smoke has passed against the local Telegram Bot API Server and temporary vault. `TonyYoniBot` accepted an `/ingest project:smoke tag:live first smoke test` file message, created SQLite job `tg_5985744318_2`, imported the Local Bot API file into runtime archive/staging, wrote immutable raw bundle `raw/2026-04-22/tg_5985744318_2/`, skipped RTZR/wiki because credentials/adapter are not configured, and completed with Telegram notification.

Upload-only behavior is now supported: an authorized file upload creates an ingest job even without `/ingest` text. Plain captions are preserved as instructions; `/ingest` captions still provide optional `project:`/`tag:` metadata. After a job reaches `COMPLETED`, the worker deletes the corresponding Telegram Local Bot API Server source file from `TELEGRAM_LOCAL_FILES_ROOT` so `documents/file_*` does not duplicate the archived/runtime/raw copies. A Windows launcher exists as `Start Telegram Local Ingest.cmd` and has also been copied to `C:\Users\Tony\Desktop\Start Telegram Local Ingest.cmd`; it starts the local Bot API server and worker in separate WSL console windows using the project `.env`.

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

MVP roadmap is complete and `apps/worker` now wires the main flow together. Next practical step is to run one real upload-only smoke from the desktop launcher, then decide whether to add richer worker logs, RTZR credentials, or wiki adapter wiring.

```text
Run a live smoke: local Telegram server -> /ingest file -> SQLite job -> import -> raw bundle -> optional RTZR/wiki adapter -> Telegram status.
```

## Continuation Prompt

Use this when resuming in a fresh session:

```text
Continue from /home/tony/workspace/telegram-local-ingest. Read .vibe/agent/handoff.md and .vibe/agent/session-log.md first. Harness is synced to `v1.5.2` from local `/mnt/c/Users/Tony/Workspace/vibe-doctor`. The MVP roadmap is complete, `npm run smoke:ready` exists, live smoke passed, upload-only file ingest is implemented, completed jobs delete their Telegram Local Bot API Server source files, and `Start Telegram Local Ingest.cmd` exists in the repo plus the Windows desktop. Do not add Dropbox. Use Telegram Local Bot API Server for large files. Next step: run one real upload-only smoke from the launcher, then consider richer worker logs, RTZR credentials, or wiki adapter wiring.
```

## Latest Verification

- `npm run typecheck`: passed after harness sync and readiness checker
- `npm run build`: passed after harness sync and readiness checker
- App-focused tests passed: `47` passed, including `test/live-smoke-readiness.test.ts`
- `npm test`: harness-only failures remain in `test/run-codex-wrapper.test.ts` under WSL locale/wrapper behavior; application tests pass
- `npm run smoke:ready`: passed after `.env` was configured
- Live smoke passed: job `tg_5985744318_2` completed and raw bundle was written under `/home/tony/obsidian-ingest-smoke-vault/raw/2026-04-22/tg_5985744318_2/`
- Latest app-focused verification after upload-only/source-cleanup/launcher changes: `npm run typecheck`, `npm run build`, and 50 focused app tests passed

## WSL Move Notes

- Active workspace moved to `/home/tony/workspace/telegram-local-ingest`.
- The old Windows workspace copy at `C:\workspace\telegram-local-ingest` is no longer present.
- The temporary local `origin` remote pointing to `/mnt/c/workspace/telegram-local-ingest` was removed; the WSL repo is self-contained.
- WSL Node installed with `nvm`: Node `v24.15.0`, npm `11.12.1`.
- WSL app verification passed: `npm run typecheck`, `npm run build`, and app-focused tests (`44` passed).
- Full `npm test` in WSL currently has harness-only failures in `test/run-codex-wrapper.test.ts` related to the Codex wrapper/locale environment; application tests pass.

## Links

- Product context: `docs/context/product.md`
- Architecture context: `docs/context/architecture.md`
- Roadmap: `docs/plans/sprint-roadmap.md`
