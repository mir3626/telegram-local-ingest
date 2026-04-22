---
name: vibe-iterate
description: Start the next project iteration after the initial Sprint roadmap is complete.
---

# vibe-iterate

Use this skill after the first Sprint roadmap is complete and the user wants to
continue the project into another iteration. The goal is to inherit prior
context through durable files while keeping each Planner call fresh-context.

## Purpose

`/vibe-iterate` creates the next iteration from the latest handoff,
`project-report.html`, and `iteration-history.json`. It carries forward open
work, accepted decisions, and new user goals without replaying old context into
Planner.

## Phase 0 - Load State

The Orchestrator reads:

- `docs/reports/project-report.html` (latest report)
- `.vibe/agent/handoff.md`
- `.vibe/agent/session-log.md`
- `docs/plans/project-milestones.md`
- `.vibe/agent/iteration-history.json`
- the previous iteration section in `docs/plans/sprint-roadmap.md`

This state is Orchestrator input only; do not inject the full history into
Planner prompts.

## Phase 1 - Differential Interview

Run:

```bash
node scripts/vibe-interview.mjs --mode iterate --carryover <prior-iter-id> --output .vibe/interview-log/iter-<N>.json
```

Build the carryover seed from previous unresolved items, confirmed decisions,
and new user requests. Inject that seed into the synthesizer prompt so the
interview deepens the prior plan without contradicting it. If `--mode iterate`
runs without a carryover seed, start the iteration with empty carryover; this is
equivalent to a fresh restart.

## Phase 2 - Append Sprint Roadmap

The Orchestrator creates a new roadmap section from unfinished prior Sprints and
new iteration goals. Append the section to `docs/plans/sprint-roadmap.md`:

```md
## Iteration iter-<N>
```

Never overwrite existing roadmap content. Prior iteration sections are the
project record.

## Phase 3 - Update Iteration History

Append a record to `.vibe/agent/iteration-history.json` and set
`currentIteration` to the new id. Include `id`, `label`, `goal`, `startedAt`,
`plannedSprints[]`, carryover summary, and open risks or deferred items.

## Phase 4 - Run Sprints Normally

Each Sprint follows the existing process: Planner prompt, Codex implementation,
verification, and standard Sprint completion.

Planner must not receive `.vibe/agent/iteration-history.json`. The Orchestrator
may prepend only a short prior-sprint header such as:

```md
This is iter-<N> sprint-NN.
```

## Phase 5 - Refresh Project Report

After every Sprint in the iteration is complete, run:

```bash
node scripts/vibe-project-report.mjs
```

The regenerated `docs/reports/project-report.html` should render the cumulative
iteration timeline and milestone progress. Open the report in the browser.

## User Follow-Up

Point the user to the report's Iteration timeline and milestone progress. Keep
`.vibe/agent/handoff.md` focused on the current iteration only; prior iteration
state belongs in `.vibe/agent/iteration-history.json`.

## Context Isolation Guarantee

Planner remains fresh-context per Sprint. Iteration state crosses boundaries
only through `.vibe/agent/iteration-history.json`,
`docs/reports/project-report.html`, `docs/plans/sprint-roadmap.md`, and short
Orchestrator-authored prior-sprint summaries.
