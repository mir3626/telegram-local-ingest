---
name: vibe-init
description: Codex-compatible wrapper for the shared vibe-doctor project initialization workflow.
---

# vibe-init for Codex

This repository keeps provider-neutral skill runbooks under `.claude/skills`.

When this skill is invoked in Codex, open and follow:

`../../../.claude/skills/vibe-init/SKILL.md`

Codex notes:

- Treat Claude-specific UI references as references to the active agent session unless the source explicitly describes Claude-only behavior.
- When the source skill tells the agent to run `npm run vibe:init`, run `npm run vibe:init -- --from-agent-skill`.
- Keep `.vibe/agent/handoff.md` and `.vibe/agent/session-log.md` current when the source skill requires context persistence.
