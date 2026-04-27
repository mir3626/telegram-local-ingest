# LLMwiki Raw Policy

This project follows the LLMwiki pattern described by Andrej Karpathy: raw sources are immutable evidence, the wiki is an LLM-maintained Markdown layer, and schema/rules keep the LLM disciplined. In this repository, the raw layer is not the Telegram file alone and not the user-facing translated output. It is the finalized raw bundle: original bytes plus deterministic canonical text projections and a manifest that declares what the wiki agent may read.

## Layer Contract

- `raw/**/original/` stores the uploaded source bytes and is the source of truth for audit.
- `raw/**/extracted/` stores deterministic canonical text projections from original files: PDF text/OCR, DOCX block text, image OCR text, EML body text, and STT transcript Markdown.
- `manifest.yaml` is the machine-readable authority for the source package.
- `source.md` is the LLM-readable entrypoint and read-order guide.
- `wiki/**` is the LLM-maintained knowledge layer. It may cite raw bundle inputs but must not replace them.
- `runtime/outputs/**` is a TTL delivery cache for Telegram downloads and is never wiki source authority.

## Wiki Input Roles

Future raw bundle schema version 2 should expose `wiki_inputs`:

- `canonical_text`: primary LLM-readable source text derived deterministically from an original file.
- `translation_aid`: optional translated text that may help Korean wiki writing but is not primary authority.
- `evidence_original`: original binary/source evidence used only for audit or visual verification.
- `structure`: optional block/bounding-box structure used to relate canonical text back to original document regions.

Rendered convenience files such as `_translated.docx`, `_translated.pdf`, image overlay PDFs, and transcript DOCX downloads must not be listed as `canonical_text`.

## Type Policy

- Text files: use UTF-8 original text directly when safe; chunk when large.
- DOCX: use deterministic body/block text and block ids from `word/document.xml`.
- PDF: prefer text-layer extraction; use OCR text for scanned PDFs and mark OCR basis.
- Image: use OCR text plus bounding boxes; original image remains evidence.
- Audio/voice: use cleaned STT transcript Markdown as canonical text; user-facing transcript DOCX is output-only.
- EML: use headers plus preferred text body; attachments are separate sources.
- Translations: keep as `translation_aid` only when needed; citations still point to canonical text/original evidence.

## Token Policy

- LLMwiki reads `manifest.yaml`, `source.md`, and declared `canonical_text` inputs by default.
- It should not inspect binary/rendered documents unless a visual audit is explicitly needed.
- Large canonical text should be chunked with stable ids, hashes, and source-span metadata.
- The wiki agent should cite canonical input ids or source paths in wiki pages.
- Low-confidence OCR/STT content should be marked as derived or uncertain instead of becoming an unqualified fact.

## Operational Rule

Preprocessing that creates canonical wiki text must happen before raw bundle finalization or be copied into the finalized raw bundle before wiki ingest. Runtime-only preprocessing artifacts are not sufficient for LLMwiki because they are not durable source evidence.
