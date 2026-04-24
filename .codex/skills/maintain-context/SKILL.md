---
name: maintain-context
description: Codex-compatible wrapper for the shared vibe-doctor context maintenance and Orchestrator checkpoint workflow.
---

# maintain-context for Codex

This repository keeps provider-neutral skill runbooks under `.claude/skills`.

When this skill is invoked in Codex, open and follow:

`../../../.claude/skills/maintain-context/SKILL.md`

Codex notes:

- Use this for Codex main Orchestrator sessions that need a manual checkpoint; Sprint Generator invocations normally hand state back through their completion report.
- Invoking this skill means the session is in Codex Orchestrator maintenance mode, not Sprint Generator mode.
- Treat Claude-specific UI references as references to the active agent session unless the source explicitly describes Claude-only behavior.
- Keep `.vibe/agent/handoff.md` and `.vibe/agent/session-log.md` current when the source skill requires context persistence.
