---
name: maintain-context
description: Update durable context shards and run checkpoint validation when project rules, architecture, workflows, or long-running Orchestrator state changes.
---

# maintain-context

Use this skill when durable project context must survive a provider restart, chat compaction, or a handoff to another agent/session.

## When To Run

- After a meaningful Orchestrator decision, design review, release, tag, push, or sync.
- Before ending a long Orchestrator session after non-trivial work.
- Before starting a risky multi-file change if recent discussion contains state that is not yet in files.
- When a provider has no native compaction hook and the user asks to preserve or checkpoint context.
- When behavior, architecture, conventions, or workflow rules change.

Generator agents normally do not need this workflow. Sprint state is handed back through their completion report and the Orchestrator-owned sprint scripts.

## Workflow

1. Update only the relevant shard docs for behavior, architecture, conventions, QA, or workflow changes. Remove stale or duplicate guidance.
2. Update `.vibe/agent/handoff.md` with the current branch/version, completed work, open risks, and exact restart steps.
3. Append one concise entry to `.vibe/agent/session-log.md` with an ISO timestamp and a useful tag such as `[decision]`, `[harness-review]`, or `[checkpoint]`.
4. If sprint status changed, update `.vibe/agent/sprint-status.json` through the appropriate harness script rather than manual JSON edits.
5. Run `npm run vibe:checkpoint` when available. If the package script is absent, run `node scripts/vibe-checkpoint.mjs`.
6. If checkpoint fails, fix the stale/missing state files and rerun it. Do not report context as preserved until the check passes.
7. Mention the context files and checkpoint result in the final report.

## Codex Orchestrator Note

Codex does not provide Claude Code's native `PreCompact` or context-threshold hooks. For Codex used as the main Orchestrator, this skill is the portable replacement: checkpoint at work boundaries, not token-percentage events. The goal is not to imitate an automatic 80% hook; it is to ensure a new session can resume by reading `handoff.md`, `session-log.md`, and `sprint-status.json`.
