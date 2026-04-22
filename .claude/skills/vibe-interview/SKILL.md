---
name: vibe-interview
description: Native socratic interview runbook for `/vibe-init` Phase 3. The Orchestrator hosts the LLM internally and pipes structured prompts through `scripts/vibe-interview.mjs`.
---

## When To Invoke

Use this skill in `/vibe-init` Phase 3. It replaces the previous Ouroboros interview flow.

## Invocation Protocol

1. Ask the user for a one-liner prompt.
2. `node scripts/vibe-interview.mjs --init --prompt "<one-liner>" [--lang ko|en] [--max-rounds 30] [--output .vibe/interview-log/<session-id>.json]`
   Script stdout: `{ phase: "domain-inference", inferencePrompt: "<string>" }`.
3. Orchestrator internally evaluates `inferencePrompt` against its own LLM context. Produce `inferred_domain` as a 1-2 sentence string.
4. `node scripts/vibe-interview.mjs --set-domain --domain "<inferred_domain>"`
   Script stdout: `{ phase: "round", roundNumber: 1, dimension: { ... }, synthesizerPrompt: "<string>", priorCoverage: { ... } }`.
5. Orchestrator evaluates `synthesizerPrompt` internally and obtains 1-3 probing questions in the interview language.
6. Orchestrator asks the user, or answers on the user's behalf in PO-proxy mode. Collect the answer text verbatim.
7. `node scripts/vibe-interview.mjs --continue --answer "<text>"`
   Script stdout: `{ phase: "parse", answerParserPrompt: "<string>", pendingDimensionId: "<id>" }`.
8. Orchestrator evaluates `answerParserPrompt` internally and returns structured JSON attribution.
9. `node scripts/vibe-interview.mjs --record --attribution '<json>'`
   Script stdout returns either another `{ phase: "round", ... }` or `{ phase: "done", summary: { ambiguity_final, dimensions, answers, rationale }, seedForProductMd: "<markdown>" }`.
10. Repeat until `phase === "done"`.

## Operating Notes

- The Orchestrator is the LLM host. There is no external model call, MCP server, or sidecar service in this flow.
- Keep the synthesizer output JSON and parser output JSON in the Orchestrator context. The engine depends on the structured handoff, and the final transcript rationale should reference the same question set.
- If the synthesizer output fails JSON parsing, retry once with an extra postscript that says the output MUST be parseable JSON and MUST not contain code fences.

## PO-Proxy Mode

- When the user delegates or says "알아서", the Orchestrator may answer on the user's behalf under the normal Phase 0-1 PO-proxy rules.
- Answers still flow through the exact same `--continue` and `--record` pipe.
- Capture the rationale once at the end in `session-log.md` under `[decision][phase3-po-proxy]`.

## "I don't know" / "미정" Handling

- Pass the answer text exactly as spoken or inferred.
- The parser prompt maps uncertainty to `deferred` sub-fields.
- The engine does not stop on deferred answers. It keeps probing adjacent dimensions until termination criteria are met.

## Termination

- Hard terminate when `ambiguity <= 0.2`.
- Hard terminate when `roundNumber > maxRounds`.
- Soft terminate when all required dimensions have coverage `>= 0.5` and `ambiguity <= 0.3`.

## Output Artifacts

- `.vibe/interview-log/<session-id>.json`
  Full transcript, attribution history, final coverage, ambiguity trace, and termination metadata.
- `seedForProductMd`
  Append this markdown as `## Phase 3 답변 기록 (native interview)` in `docs/context/product.md` after the interview completes.
