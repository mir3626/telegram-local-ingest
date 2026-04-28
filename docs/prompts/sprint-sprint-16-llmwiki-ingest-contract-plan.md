# Sprint 16 Planner Prompt - LLMwiki Ingest Contract

This is iter-2 sprint 16 for `telegram-local-ingest`.

## Goal

Provide a provider-neutral LLMwiki ingest contract that lets a local wiki command update `wiki/**` from finalized raw bundles while reading only `source.md`, `manifest.yaml`, and manifest-declared `wiki_inputs`.

## Required Context

- Read `docs/context/llmwiki.md`.
- Read `docs/context/architecture.md` LLMwiki/raw bundle sections.
- Read `packages/wiki-adapter/src/index.ts`.
- Read `packages/vault/src/index.ts` schema v2 `wiki_inputs` output.
- Read `test/wiki-adapter.test.ts` and raw immutability tests.

## Required Scope

- Define a repo-owned LLMwiki contract/schema for wiki pages, citations, `wiki/index.md`, and `wiki/log.md`.
- Make the local wiki adapter contract resolve only `source.md`, `manifest.yaml`, and declared `wiki_inputs` from finalized raw bundles.
- Require wiki edits to cite canonical input ids or source paths.
- Continue to reject runtime outputs, rendered translated files, overlay PDFs, and transcript DOCX downloads as source authority.
- Add smoke tests with a fake LLMwiki command proving raw immutability and expected wiki file updates.

## Non-Goals

- Do not implement reconcile/tombstones; that remains Sprint 13 carryover.
- Do not ingest existing personal vault data in tests.
- Do not require a specific provider such as Claude or Codex.
- Do not make rendered Telegram downloads part of wiki source authority.

## Acceptance Criteria

- LLMwiki can ingest one finalized bundle into `wiki/**` through a documented contract.
- Adapter inputs are token-efficient and limited to manifest-declared canonical inputs by default.
- Wiki output rules require citations to canonical input ids/source paths and updates to `wiki/index.md` plus `wiki/log.md`.
- Fake-command smoke tests prove raw immutability and expected wiki file updates.
- Provider-neutral command arguments remain usable by Claude, Codex, or a custom LLMwiki CLI.
