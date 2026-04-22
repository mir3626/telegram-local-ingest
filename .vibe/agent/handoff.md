# Orchestrator Handoff

## Identity

- **repo**: `telegram-local-ingest`
- **path**: `/home/tony/workspace/telegram-local-ingest`
- **current iteration**: `iter-1`
- **current sprint**: `completed`
- **harnessVersion**: `1.5.3`

## Status

The repository has been created from `vibe-doctor`. Sprint 0 through Sprint 8 are complete. The project context now targets a Telegram Local Bot API Server based local ingest worker, and the code has config loading, Telegram Bot API baseline, startup health checks, SQLite-backed operational state, Telegram capture-to-job creation, controlled Telegram file import into runtime staging/archive, immutable Obsidian raw bundle writing, RTZR STT client/helpers, a protected wiki ingest adapter boundary, Telegram operator command primitives, and an integrated worker dispatch loop.

The harness has been synced from the local WSL-visible `vibe-doctor` template at `/mnt/c/Users/Tony/Workspace/vibe-doctor` from `1.5.0` to `1.5.3`. The Telegram-specific `.env.example` and project `.gitignore` runtime entry were preserved after sync because the upstream harness template is provider-only. A live smoke readiness checker now exists at `apps/worker/src/readiness.ts` and can be run with `npm run smoke:ready`.

Live smoke has passed against the local Telegram Bot API Server and temporary vault. `TonyYoniBot` accepted an `/ingest project:smoke tag:live first smoke test` file message, created SQLite job `tg_5985744318_2`, imported the Local Bot API file into runtime archive/staging, wrote immutable raw bundle `raw/2026-04-22/tg_5985744318_2/`, skipped RTZR/wiki because credentials/adapter are not configured, and completed with Telegram notification.

Upload-only behavior is now supported: an authorized file upload creates an ingest job even without `/ingest` text. Plain captions are preserved as instructions; `/ingest` captions still provide optional `project:`/`tag:` metadata. After a job reaches `COMPLETED`, the worker deletes the corresponding Telegram Local Bot API Server source file from `TELEGRAM_LOCAL_FILES_ROOT` so `documents/file_*` does not duplicate the archived/runtime/raw copies. A Windows launcher exists as `Start Telegram Local Ingest.cmd` and has also been copied to `C:\Users\Tony\Desktop\Start Telegram Local Ingest.cmd`; it starts the local Bot API server and worker in separate WSL console windows using the project `.env`.

Operational hardening started: `scripts/start-local-stack.sh`, `scripts/stop-local-stack.sh`, and `scripts/restart-local-stack.sh` now manage the local Bot API server and worker with pid files and logs under `runtime/pids` and `runtime/logs`. The desktop launcher now calls `scripts/start-local-stack.sh` instead of embedding long server commands. Worker logs now include update receipt, queued job, bundle path, cleanup result, and completion lines. Upload UX now includes uploaded filenames in queued/completed Telegram messages.

Bot responses are now Korean-first and include suitable emoji in operator/status, queued/completed/failure, and RTZR preset flows. Audio/voice uploads are held in `RECEIVED` until the operator selects an RTZR context preset with inline buttons: meeting, call, or voice memo. The selected preset is stored as a `rtzr.preset_selected` job event with the RTZR optional config and the translation default relation, then the job transitions to `QUEUED`. Raw bundle manifests now include `processing_context.rtzr_preset` and `processing_context.translation.default_relation` so later STT/translation/wiki processing can reuse the captured context. `TRANSLATION_DEFAULT_RELATION` defaults to `business` and is exposed in `.env.example` for easy future admin/env management.

RTZR STT is now wired into the worker. When `RTZR_CLIENT_ID` and `RTZR_CLIENT_SECRET` are configured, audio/voice files are normalized if needed with ffmpeg, submitted to RTZR using the selected preset config, and written as `*.rtzr.json` plus `*.transcript.md` artifacts under raw bundle `extracted/`. The artifact paths are recorded in `rtzr.transcribed` job events before bundle writing, so `BUNDLE_WRITING` can reconstruct extracted artifacts after a restart. If RTZR credentials are not configured, audio jobs still complete with `rtzr.skipped` and preserve the raw original bundle.

The Windows desktop launcher now behaves as a start/stop toggle. It calls `scripts/local-stack-status.sh` first; if both managed processes are already running, it asks whether to stop them and runs `scripts/stop-local-stack.sh` on `Y`. If only one managed process is running, it asks whether to stop the partial stack; otherwise it continues with `scripts/start-local-stack.sh`. The desktop copy at `C:\Users\Tony\Desktop\Start Telegram Local Ingest.cmd` was updated.

Symlink review for raw originals: do not symlink `raw/**` to Telegram Local Bot API Server storage. Those paths contain bot-token-derived directories, are intentionally deleted after completion, and make raw bundles non-portable. Keep raw bundle originals as copied, self-contained files; if links are needed later, use Obsidian-relative links to files already inside the finalized raw bundle.

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

MVP roadmap is complete and `apps/worker` now wires the main flow together. Next practical step is to run one real audio/voice smoke from the desktop launcher/background stack, choose an RTZR preset button in Telegram, and inspect the resulting raw bundle `extracted/*.transcript.md` plus `manifest.yaml`. After that, proceed to translation context/admin controls or wiki adapter wiring.

```text
Run a live smoke: local Telegram server -> /ingest file -> SQLite job -> import -> raw bundle -> optional RTZR/wiki adapter -> Telegram status.
```

## Continuation Prompt

Use this when resuming in a fresh session:

```text
Continue from /home/tony/workspace/telegram-local-ingest. Read .vibe/agent/handoff.md and .vibe/agent/session-log.md first. Harness is synced to `v1.5.3` from local `/mnt/c/Users/Tony/Workspace/vibe-doctor`, including the WSL-safe Codex wrapper fix. The MVP roadmap is complete, `npm run smoke:ready` exists, live smoke passed, upload-only file ingest is implemented, completed jobs delete their Telegram Local Bot API Server source files, and the Windows desktop launcher now starts/stops the pid/log-managed local stack. Bot responses are Korean-first. Audio/voice uploads ask for an RTZR preset button before queueing; the selected RTZR config plus translation default relation are stored in job events and raw bundle manifests. RTZR STT is wired into the worker when credentials are set and writes `*.rtzr.json`/`*.transcript.md` extracted artifacts into raw bundles. Do not add Dropbox. Use Telegram Local Bot API Server for large files. Next step: run one real audio preset smoke from the launcher/background stack, then proceed to translation context/admin controls or wiki adapter wiring.
```

## Latest Verification

- `npm run typecheck`: passed after harness sync and readiness checker
- `npm run build`: passed after harness sync and readiness checker
- App-focused tests passed: `47` passed, including `test/live-smoke-readiness.test.ts`
- `npm test`: passed after v1.5.3 harness sync (`311` passed, `0` failed); `test/run-codex-wrapper.test.ts` now passes under WSL
- `npm run smoke:ready`: passed after `.env` was configured
- Live smoke passed: job `tg_5985744318_2` completed and raw bundle was written under `/home/tony/obsidian-ingest-smoke-vault/raw/2026-04-22/tg_5985744318_2/`
- Latest app-focused verification after upload-only/source-cleanup/launcher changes: `npm run typecheck`, `npm run build`, and 50 focused app tests passed
- Latest app-focused verification after ops scripts/logging/UX changes: shell script syntax check, `npm run typecheck`, `npm run build`, and 50 focused app tests passed
- Latest verification after Korean bot responses and RTZR preset capture: `npm run typecheck` passed, `npm run build` passed, and focused app tests passed (`28` passed for Telegram capture/operator/worker/vault/config/live smoke readiness). Full `npm test` still has harness-only WSL failures in `test/run-codex-wrapper.test.ts`; application tests pass (`307` passed, `3` harness failures).
- Latest verification after RTZR STT worker wiring: `npm run typecheck` passed, `npm run build` passed, and focused app tests passed (`53` passed across DB/Telegram/importer/vault/RTZR/wiki/operator/worker/readiness). Full `npm test` still has only the known WSL `test/run-codex-wrapper.test.ts` failures (`308` passed, `3` failed).
- Latest verification after v1.5.3 harness sync: `npm test` passed in WSL (`311` passed, `0` failed), including `test/run-codex-wrapper.test.ts`. `.gitignore` and Telegram-specific `.env.example` were restored after sync to preserve project-local runtime/env content.

## WSL Move Notes

- Active workspace moved to `/home/tony/workspace/telegram-local-ingest`.
- The old Windows workspace copy at `C:\workspace\telegram-local-ingest` is no longer present.
- The temporary local `origin` remote pointing to `/mnt/c/workspace/telegram-local-ingest` was removed; the WSL repo is self-contained.
- WSL Node installed with `nvm`: Node `v24.15.0`, npm `11.12.1`.
- WSL app verification passed: `npm run typecheck`, `npm run build`, and app-focused tests (`44` passed).
- Full `npm test` in WSL now passes after syncing local `vibe-doctor` v1.5.3.

## Links

- Product context: `docs/context/product.md`
- Architecture context: `docs/context/architecture.md`
- Roadmap: `docs/plans/sprint-roadmap.md`
