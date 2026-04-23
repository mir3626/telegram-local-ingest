# Agent Post-Processing

Local agent post-processing is disabled by default. Enable it only for a personal/operator workflow.

## Codex Command

Use the project wrapper so the worker can run from a job-scoped `.agent-work` directory without relying on relative paths:

```env
AGENT_POSTPROCESS_PROVIDER=codex
AGENT_POSTPROCESS_COMMAND={projectRoot}/scripts/run-codex-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}
AGENT_POSTPROCESS_TIMEOUT_MS=1800000
```

Optional Codex wrapper tuning:

```env
CODEX_MODEL=
CODEX_SANDBOX=workspace-write
CODEX_RETRY=3
```

`Selected model is at capacity` is a service-side capacity response for the chosen Codex model, not a local token-budget problem. Wait and retry, or set `CODEX_MODEL` to another model available to your account.

## Readiness

```bash
npm run smoke:agent:ready
```

This checks the Codex wrapper health and prints the command shape. It does not run a translation job.

## Live Smoke

```bash
npm run smoke:agent:live
```

This creates a temporary fixture under `runtime/agent-smoke/`, invokes Codex through `scripts/run-codex-postprocess.sh`, and verifies that at least one output file was written.

## Boundaries

- The worker decides queue, retry, file lifecycle, and Telegram notification state.
- The agent reads the finalized raw bundle and writes deliverables only under the output directory.
- The adapter snapshots `raw/**` before and after execution; raw mutation fails the job.
- Runtime outputs are TTL cache files, not source-of-truth vault content.
