# LLMwiki Ingest Contract Schema

Contract version: `telegram-local-ingest.llmwiki.v1`

## Inputs

The ingest adapter may read only these source files by default:

- `source.md`
- `manifest.yaml`
- `wiki_inputs[]` entries from `manifest.yaml` where `role: "canonical_text"` and `read_by_default: true`

Other manifest-declared inputs may be read only for the role-specific purpose:

- `structure`: block ids, OCR boxes, or provider JSON used to map text back to source regions.
- `translation_aid`: secondary translation help; never primary source authority.
- `evidence_original`: original or normalized source bytes for audit/visual verification.

The adapter must reject runtime outputs and rendered deliverables as source authority, including `runtime/outputs/**`, `*_translated.*`, `*.transcript.docx`, and `*_transcript.docx`.

## Wiki Writes

The ingest command may write only under the configured `wikiRoot`.

Required files:

- `wiki/index.md`: navigable index of ingested bundles, topics, and source ids.
- `wiki/log.md`: append-only ingest log with job id, bundle path, canonical input ids used, and generated/updated wiki pages.

Recommended page types:

- `wiki/sources/<bundle-id>.md`: source package summary with canonical input citations.
- `wiki/topics/<topic>.md`: topic notes synthesized from one or more canonical inputs.
- `wiki/entities/<entity>.md`: people, organizations, products, locations, or projects.

## Citation Rule

Every factual claim introduced or updated by an ingest command must cite at least one canonical input id or source path from `manifest.yaml`.

Use one of these citation forms:

- `Source: <canonical_input_id>`
- `Source path: <raw-bundle-relative-path>`
- Inline Markdown footnote whose body contains a canonical input id or source path.

If OCR/STT confidence is uncertain, mark the fact as OCR/STT-derived or uncertain instead of promoting it as an unqualified fact.

## Output Rule

The wiki layer is a derived knowledge layer. It must not modify `raw/**`, must not copy rendered Telegram download outputs into wiki as source evidence, and must not treat translated/runtime files as primary authority.
