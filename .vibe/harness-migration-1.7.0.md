# Harness Migration v1.7.0

The harness runtime moved to `.vibe/harness/**`.
The following legacy root-level files were left in place because the migration could not prove they were unmodified synced harness files:

- src/commands/summarize-usage.ts: locally modified
- test/agent-adapter.test.ts: no sync hash
- test/artifact-core.test.ts: no sync hash
- test/automation-core.test.ts: no sync hash
- test/db.test.ts: no sync hash
- test/language-detector.test.ts: no sync hash
- test/live-smoke-readiness.test.ts: no sync hash
- test/operator.test.ts: no sync hash
- test/ops-dashboard.test.ts: no sync hash
- test/output-store.test.ts: no sync hash
- test/patterns-index.test.ts: no sync hash
- test/preflight-wrapper-generalized.test.ts: no sync hash
- test/preprocessors.test.ts: no sync hash
- test/rtzr.test.ts: no sync hash
- test/sensevoice.test.ts: no sync hash
- test/sync-glob.test.ts: no sync hash
- test/telegram-capture.test.ts: no sync hash
- test/telegram-importer.test.ts: no sync hash
- test/telegram-local-baseline.test.ts: no sync hash
- test/vault.test.ts: no sync hash
- test/vibe-sprint-complete.test.ts: no sync hash
- test/wiki-adapter.test.ts: no sync hash
- test/worker.test.ts: no sync hash

Review them manually. Product-owned `src/**`, `scripts/**`, and `test/**` files must not be deleted by the harness.
