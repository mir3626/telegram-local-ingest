# Sprint 13 Planner Prompt - Vault Reconcile And Retention

This is iter-2 carryover sprint 13 for `telegram-local-ingest`.

## Goal

Make raw/wiki/output deletion safe by separating managed delete, manual filesystem drift detection, LLMwiki graph lint, and SQLite-owned source bundle/output state.

## Required Context

- Read `docs/context/llmwiki.md`.
- Read `docs/context/architecture.md` deletion/reconcile sections.
- Read `docs/plans/sprint-roadmap.md` Sprint 13 and Iteration 2 sections.
- Read `packages/db/src/index.ts` source bundle and job output repositories.
- Read `packages/vault/src/index.ts` finalized raw bundle layout.
- Read `packages/output-store/src/index.ts`.

## Required Scope

- Add a deterministic `vault:reconcile` dry-run command that compares SQLite `source_bundles`, `job_outputs`, raw bundle files, finalized markers, and wiki references against the filesystem.
- Detect missing finalized bundles, orphan raw folders, missing manifests/source files, missing output files, and wiki references to absent raw bundle paths or canonical input ids.
- Treat configured LLMwiki lint as a wiki graph health signal only; it may report broken links/orphans but must not mutate SQLite.
- Add explicit apply/tombstone behavior only when the operator requests it; do not recreate deleted raw bundles automatically.
- Record reconcile findings and tombstone decisions in SQLite/job events where practical.

## Non-Goals

- Do not build a GUI for retention.
- Do not let LLMwiki or an agent directly mutate SQLite.
- Do not delete raw bundles silently during dry-run.
- Do not re-ingest or reconstruct raw evidence after manual deletion.

## Acceptance Criteria

- Dry-run reconcile reports DB-to-filesystem and filesystem-to-DB drift without modifying state.
- Apply mode, if included, is explicit and records tombstone/deletion events instead of silently dropping history.
- Runtime output cleanup remains separate from raw bundle deletion.
- Wiki lint findings are linked into the report but are not treated as database authority.
- Tests cover at least missing raw bundle, orphan raw folder, missing output file, and wiki citation drift cases.
