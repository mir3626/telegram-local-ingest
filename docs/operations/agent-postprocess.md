# Agent Post-Processing

Local agent post-processing is disabled by default. Enable it only for a personal/operator workflow.

## Provider Commands

Use the project wrapper so the worker can run from a job-scoped `.agent-work` directory without relying on relative paths:

```env
AGENT_POSTPROCESS_PROVIDER=codex
AGENT_POSTPROCESS_COMMAND='{projectRoot}/scripts/run-codex-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}'
AGENT_POSTPROCESS_TIMEOUT_MS=1800000
```

To test the same post-processing contract with Claude Code instead of Codex:

```env
AGENT_POSTPROCESS_PROVIDER=claude
AGENT_POSTPROCESS_COMMAND='{projectRoot}/scripts/run-claude-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}'
AGENT_POSTPROCESS_TIMEOUT_MS=1800000
```

The worker can poll Telegram while post-processing runs in the background. Keep personal OAuth CLI agent concurrency conservative:

```env
WORKER_JOB_CONCURRENCY=2
WORKER_STT_CONCURRENCY=1
WORKER_AGENT_CONCURRENCY=1
WORKER_JOB_CLAIM_TTL_MS=7200000
WORKER_OUTPUT_CLEANUP_INTERVAL_MS=600000
```

`WORKER_JOB_CONCURRENCY` controls total simultaneous jobs. `WORKER_AGENT_CONCURRENCY` limits Codex/Claude-style local agent executions and should stay `1` unless the local CLI and account are known to handle parallel sessions cleanly. `WORKER_OUTPUT_CLEANUP_INTERVAL_MS` controls the repeat cleanup cadence after the startup cleanup pass.

Optional Codex wrapper tuning:

```env
CODEX_MODEL=
CODEX_SANDBOX=workspace-write
CODEX_RETRY=3
```

`Selected model is at capacity` is a service-side capacity response for the chosen Codex model, not a local token-budget problem. Wait and retry, or set `CODEX_MODEL` to another model available to your account.

Optional Claude wrapper tuning:

```env
CLAUDE_BIN=claude
CLAUDE_MODEL=sonnet
CLAUDE_PERMISSION_MODE=acceptEdits
CLAUDE_ALLOWED_TOOLS=Read,Write,Edit,MultiEdit,Glob,Grep
CLAUDE_MAX_BUDGET_USD=
```

The Claude wrapper runs `claude --print` from the job-scoped agent workspace, adds only the agent workspace, raw bundle, and output directory as allowed directories, and relies on the same adapter raw snapshot guard as Codex. Set `CLAUDE_PERMISSION_MODE=bypassPermissions` only for an intentionally isolated local smoke test.

## Readiness

```bash
npm run smoke:agent:ready
npm run smoke:agent:ready:claude
```

This checks the selected wrapper health and prints the command shape. It does not run a translation job.

## Live Smoke

```bash
npm run smoke:agent:live
npm run smoke:agent:live:claude
```

This creates a temporary fixture under `runtime/agent-smoke/`, invokes the selected wrapper, and verifies that at least one output file was written.

## Telegram Downloads

The Telegram completion message lists the real expiry timestamp in KST, and the download button includes the same deadline in compact form. Runtime download files are valid for 24 hours.

The worker runs expired-output cleanup when it starts and then repeats it on `WORKER_OUTPUT_CLEANUP_INTERVAL_MS` (default 10 minutes). `/status` and `/status <job_id>` include output state so the operator can see whether files are still downloadable, expired, or explicitly discarded.

For DOCX/PDF/EML/HWP-family uploads, the editable delivery baseline is DOCX. If the agent creates DOCX/HWP/HWPX output, that document is sent directly with the uploaded source stem plus `_translated` as the download filename. If the agent returns Markdown, the worker uses `pandoc` to create `<source-stem>_translated.docx`; DOCX sources use `--reference-doc <source.docx>` so more source styling can carry over, and PDF/EML/HWP/HWPX sources fall back to DOCX. EML uploads are parsed into mail headers plus the preferred text body before language detection and agent translation. Current local skill inventory includes `doc`/`docx` but no HWP/HWPX editing skill, so HWP/HWPX should be treated as native only when an agent explicitly produces a valid HWP/HWPX file. When the original text is included after the translation, it must be labeled `[원문]`, not appendix/`부록`.

For non-document uploads, the worker converts the agent's translated Markdown/text result plus the preprocessed original text into one mobile-friendly `<source-stem>_translated.pdf`. For Korean/CJK PDF rendering, WSL normally auto-detects the Windows Malgun Gothic font at `/mnt/c/Windows/Fonts/malgun.ttf`. Set `PDF_FONT_PATH` when running on a host with a different font location. PDF source uploads use `pdftotext` from poppler-utils when a text layer exists, and fall back to `pdftoppm` plus `tesseract` OCR for scanned PDFs. Image uploads use `tesseract` OCR before language detection and translation.

Optional tool overrides:

```env
PANDOC_BIN=/usr/bin/pandoc
PDFTOTEXT_BIN=/usr/bin/pdftotext
PDFTOPPM_BIN=/usr/bin/pdftoppm
TESSERACT_BIN=/usr/bin/tesseract
OCR_LANGUAGES=kor+eng+chi_sim+jpn
OCR_PSM=3
PDF_OCR_MAX_PAGES=10
PDF_OCR_DPI=200
```

Install/update document and OCR tools with:

```bash
npm run setup:docx-rendering
```

## Boundaries

- The worker decides queue, retry, file lifecycle, and Telegram notification state.
- The agent reads the finalized raw bundle and writes deliverables only under the output directory.
- The adapter snapshots `raw/**` before and after execution; raw mutation fails the job.
- Runtime outputs are TTL cache files, not source-of-truth vault content.
- The current Codex/Claude Code operating mode is personal-OAuth-only and operator-owned. Do not expose it as a public or paid multi-user service path.
- A public, paid, or multi-user utility bot must move agent execution to official API credentials, per-user quota/accounting, isolated workspaces, and explicit data retention controls before accepting untrusted users.
