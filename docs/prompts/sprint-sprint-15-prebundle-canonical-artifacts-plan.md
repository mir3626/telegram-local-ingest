# Sprint 15 Planner Prompt — Pre-Bundle Canonical Artifacts

This is iter-2 sprint 15 for `telegram-local-ingest`.

## Goal

Move deterministic canonical text extraction into the raw bundle finalization path so LLMwiki inputs are durable raw artifacts, not runtime-only preprocessing leftovers.

## Required Context

- Read `docs/context/llmwiki.md`.
- Read `docs/context/conventions.md` raw bundle rules.
- Read `packages/vault/src/index.ts`.
- Read `packages/preprocessors/src/index.ts`.
- Read the worker flow around `BUNDLE_WRITING`, `INGESTING`, and `preprocess.completed`.
- Read Sprint 14 tests in `test/vault.test.ts` and related worker bundle tests.

## Required Scope

- Ensure deterministic PDF/DOCX/EML/image/text canonical artifacts are available under finalized `raw/**/extracted/` before LLMwiki ingest.
- Keep STT transcript Markdown as the canonical audio input; user-facing transcript DOCX remains runtime-output only.
- Preserve `runtime/outputs/**`, `_translated.*`, image overlay PDFs, and transcript DOCX files as excluded deliverables.
- Record preprocessing skip reasons, OCR/STT basis, truncation, and structure artifact links in raw bundle metadata where practical.
- Keep language detection and agent postprocess using the same canonical artifact set after finalization.
- Preserve raw immutability: retries must reuse finalized bundles instead of rewriting source evidence.

## Non-Goals

- Do not implement the real LLMwiki CLI ingest; that belongs to Sprint 16.
- Do not implement reconcile/tombstones; that remains Sprint 13 carryover.
- Do not change Telegram output rendering or download UX unless required to keep existing behavior working.
- Do not treat rendered translated outputs as wiki authority.

## Acceptance Criteria

- DOCX/PDF/EML/image canonical text no longer exists only under runtime-only preprocess directories.
- New raw bundles expose the durable canonical artifacts through schema v2 `wiki_inputs`.
- Translation/output rendering still works and reads the same canonical text content.
- Existing finalized bundles are not rewritten on retry.
- Tests cover at least one text/document path and one structured or OCR/STT-derived path.
