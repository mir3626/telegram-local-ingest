---
name: vibe-init
description: Codex-compatible wrapper for the shared vibe-doctor project initialization workflow.
---

# vibe-init for Codex

This repository keeps provider-neutral skill runbooks under `.claude/skills`.

When this skill is invoked in Codex, open and follow:

`../../../.claude/skills/vibe-init/SKILL.md`

Codex notes:

- If `docs/context/product.md` or `.vibe/agent/sprint-status.json` is missing, empty, malformed, or still describes the `vibe-doctor` template, treat this skill as the only allowed workflow before any product or harness maintenance work.
- Treat Claude-specific UI references as references to the active agent session unless the source explicitly describes Claude-only behavior.
- Perform Step 1-0 before any bootstrap command. Ask whether this session is `human` or `agent` driven.
- If the user chooses `human`, run `npm run vibe:init -- --from-agent-skill --mode=human` when the source skill reaches Phase 1-1.
- If the user chooses `agent`, ask for the one-line project definition, run `npm run vibe:init -- --from-agent-skill --mode=agent --runtime=codex --one-liner "<ONE_LINER>"`, print the generated delegation prompt, and stop. Do not run Phase 1-1 bootstrap first.
- Keep `.vibe/agent/handoff.md` and `.vibe/agent/session-log.md` current when the source skill requires context persistence.
