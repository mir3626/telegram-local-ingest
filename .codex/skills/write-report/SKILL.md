---
name: write-report
description: Codex-compatible wrapper for the shared vibe-doctor reporting workflow.
---

# write-report for Codex

This repository keeps provider-neutral skill runbooks under `.claude/skills`.

When this skill is invoked in Codex, open and follow:

`../../../.claude/skills/write-report/SKILL.md`

Codex notes:

- Treat Claude-specific UI references as references to the active agent session unless the source explicitly describes Claude-only behavior.
- Keep `.vibe/agent/handoff.md` and `.vibe/agent/session-log.md` current when the source skill requires context persistence.
