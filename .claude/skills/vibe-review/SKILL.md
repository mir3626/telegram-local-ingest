---
name: vibe-review
description: Template/harness review for vibe-doctor process health
---

`/vibe-review` is a **vibe-doctor template/harness review**, not a normal product code review.

Use it to review the orchestration harness, template rules, sync behavior, agent contracts, and process health. If the user asks for "code review" in a downstream product repo without naming `/vibe-review`, review project-owned product code directly and do not run this workflow unless they explicitly ask for template/harness/process review.

## Protocol

1. Load reproducible helper inputs:

```bash
node .vibe/harness/scripts/vibe-review-inputs.mjs --install
```

The `--install` flag runs `npm install` first when local `tsx`/`zod` dependencies are missing, then prints the reproducible review input JSON. Omit `--install` only when dependencies are already installed. This helper is allowed to run in a partial or uninitialized downstream checkout when the explicit review target is an init/bootstrap/harness process failure.

2. Also read:
   - `.vibe/agent/handoff.md`
   - recent `.vibe/agent/session-log.md` entries, default `50` or `.vibe/config.json.review.recentEntries`
   - `git log --oneline`, default latest `20` commits, or since the latest `review-*.md`
   - open `.vibe/agent/sprint-status.json.pendingRisks`
   - `.vibe/agent/project-decisions.jsonl`
   - `docs/context/harness-gaps.md`
   - `.vibe/archive/rules-deleted-*.md` and `.vibe/audit/iter-*/rules-deleted.md`

3. Write the report to:
   - `docs/reports/review-<sprintCount>-<YYYY-MM-DD>.md`
   - `<sprintCount>` is `sprint-status.json.sprints.filter(s => s.status === 'passed').length`

## Rubric

Primary metric: dogfood friction incident count per sprint plus delivered product feature count.

- Blocker: sprint friction incidents >= 3 or product delivery blocked
- Friction: sprint friction incidents 1-2, or repeated Orchestrator detours
- Polish: friction 0 but UX/docs improvement needed
- Structural: future maintenance risk or architectural drift

Use uncovered rules and open harness gaps as secondary signals. If `openHarnessGapCount > 0`, include at least one finding connected to the ledger state.

## Findings Format

Each finding is a Markdown heading followed by this YAML block and short evidence bullets:

```yaml
- id: review-<slug>
  severity: blocker|friction|polish|structural
  priority: P0|P1|P2|P3
  proposal: one or two sentence summary
  estimated_loc: number
  proposed_sprint: next M-number or "backlog"
```

## Automatic Checks

- Platform detection for `detectOptInGaps()` is explicit-only:
  - Prefer `platform` passed by the interview/init seed.
  - Otherwise read `<!-- BEGIN:PROJECT:review-signals -->` or `<!-- BEGIN:HARNESS:review-signals -->` marker blocks in `docs/context/product.md`.
  - Otherwise read explicit `Platform:` / `Platforms:` lines only.
  - Do not infer frontend status from arbitrary product prose.
- Call `detectOptInGaps()` first and seed M7 opt-in findings before subjective review.
- If `pendingRestorations.length > 0`, auto-seed one Friction finding per entry:
  - `id: review-pending-restoration-<ruleSlug>`
  - `proposal: '<title>' restoration decision needed (tier=<tier>, reason=<reason>, source=<file>)`
  - `estimated_loc: 0`
  - `proposed_sprint: 'backlog'`
- If `.vibe/config.json.bundle.enabled === false` and explicit platform/review-signals indicate frontend web/browser, seed a Friction finding for missing bundle-size gate.
- If `.vibe/config.json.browserSmoke.enabled === false` and the same platform condition holds, seed a Friction finding for missing browser smoke gate.
- If recent session-log entries contain `[decision][phase3-utility-opt-in]`, skip those two utility opt-in findings.
- Count `status=open` entries in `docs/context/harness-gaps.md`; if nonzero, include at least one finding tied to ledger evidence.
- If `wiringDriftFindings.length > 0`, auto-seed one Blocker finding per entry:
  - `id: review-wiring-drift-<artifact basename>`
  - `proposal: '<artifactPath>' was created but is missing runtime reference or sync manifest wiring.`
  - `estimated_loc: 20`
  - `proposed_sprint: 'backlog'`

### Adapter-Health Blind Spot

If the project has `app/api/*/route.ts` or equivalent data fetcher paths (`productFetcherPaths` non-empty), and e2e or Playwright smoke tests exist, but those smoke tests do not assert each route response or item contract, seed one Blocker finding.

Detection: for each `productFetcherPaths` basename, require at least one string occurrence in the e2e smoke files. If absent, treat that adapter as unprobed.

Avoid false positives when the adapter is explicitly mock-only or when explicit platform/review-signals are not frontend web/browser.

## Report Shape

1. `## Inputs loaded`
2. `## Findings (severity desc)`
3. `## Suggested next-sprint scope`
4. `## Links`

If there are no findings, write `none` under `## Findings` and include one or two residual-risk lines.
