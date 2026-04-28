# Sprint 14 Planner Prompt — Wiki Raw Input Schema

This is iter-2 sprint 14 for `telegram-local-ingest`.

## Goal

Define and implement the raw bundle schema contract that tells LLMwiki exactly which artifacts may be read. The durable product decision is:

> Wiki raw is the finalized raw bundle plus deterministic canonical text projections. Rendered user deliverables are not wiki source authority.

## Required Context

- Read `docs/context/llmwiki.md`.
- Read `docs/context/conventions.md` raw bundle rules.
- Read `packages/vault/src/index.ts`.
- Read tests around raw bundle manifest/source rendering.

## Required Scope

- Add manifest schema version 2 support for `wiki_inputs`.
- Define input roles: `canonical_text`, `translation_aid`, `evidence_original`, and `structure`.
- Update `source.md` rendering to act as a concise LLM read-order entrypoint.
- Ensure rendered deliverables are excluded from wiki authority: `_translated.*`, image overlay PDFs, transcript DOCX files, and `runtime/outputs/**`.
- Add tests that assert manifest/source output includes the new policy and remains backwards-safe for existing raw bundle layout.

## Non-Goals

- Do not move preprocessing before raw finalization in this sprint; that belongs to Sprint 15.
- Do not implement a real LLMwiki CLI ingest in this sprint; that belongs to Sprint 16.
- Do not implement retention/reconcile tombstones in this sprint; that remains Sprint 13 carryover.
- Do not change Telegram output behavior.

## Acceptance Criteria

- A raw bundle declares canonical wiki inputs without requiring the LLM to inspect rendered DOCX/PDF deliverables.
- Every wiki input links back to an original file or deterministic extracted artifact.
- `source.md` gives the wiki agent a concise read order and authority policy.
- Tests cover the manifest/source schema contract.
