# Session Log

Append-only notes that should survive context compaction.

## Entries

- 2026-04-22T00:00:00.000Z [decision] Project seeded from `vibe-doctor` for `telegram-local-ingest`.
- 2026-04-22T00:00:00.000Z [decision] Large file capture uses Telegram Local Bot API Server, not Dropbox.
- 2026-04-22T00:00:00.000Z [decision] Initial package manager is npm workspaces to keep the `vibe-doctor` harness stable.
- 2026-04-22T00:00:00.000Z [decision] LLM agents are constrained to wiki ingest adapter behavior; deterministic worker owns capture, queue, file lifecycle, retry, permissions, and notify.
- 2026-04-22T08:17:16.553Z [sprint-complete] sprint-0-phase0-seed and sprint-1-telegram-local-baseline completed together before initial commit. Next sprint: sprint-2-sqlite-job-model.
- 2026-04-22T08:26:27.473Z [sprint-complete] sprint-2-sqlite-job-model completed. Used Node 24 `node:sqlite` behind `packages/db`; warning is expected while module is experimental. Next sprint: sprint-3-telegram-capture.
- 2026-04-22T08:46:31.224Z [sprint-complete] sprint-3-telegram-capture completed. Added `packages/capture` and Telegram parser/client primitives. Next sprint: sprint-4-local-file-import.
- 2026-04-22T08:54:32.402Z [sprint-complete] sprint-4-local-file-import completed. Added `packages/importer` for controlled staging/archive import, SHA-256, duplicate detection, max size policy, and Telegram path safety. Next sprint: sprint-5-vault-bundle-writer.
- 2026-04-22T08:59:41.251Z [sprint-complete] sprint-5-vault-bundle-writer completed. Added `packages/vault` raw bundle writer with manifest/source/log files, artifact directories, and finalized overwrite guard. Next sprint: sprint-6-rtzr-stt.
