# Session Log

Append-only notes that should survive context compaction.

## Entries

- 2026-04-22T00:00:00.000Z [decision] Project seeded from `vibe-doctor` for `telegram-local-ingest`.
- 2026-04-22T00:00:00.000Z [decision] Large file capture uses Telegram Local Bot API Server, not Dropbox.
- 2026-04-22T00:00:00.000Z [decision] Initial package manager is npm workspaces to keep the `vibe-doctor` harness stable.
- 2026-04-22T00:00:00.000Z [decision] LLM agents are constrained to wiki ingest adapter behavior; deterministic worker owns capture, queue, file lifecycle, retry, permissions, and notify.
- 2026-04-22T08:17:16.553Z [sprint-complete] sprint-0-phase0-seed and sprint-1-telegram-local-baseline completed together before initial commit. Next sprint: sprint-2-sqlite-job-model.
