---
name: vibe-review
description: Codex-compatible wrapper for the shared vibe-doctor template/harness review workflow.
---

# vibe-review for Codex

`vibe-review` is a template/harness review. For ordinary downstream product code review, use Codex's normal code-review stance unless the user explicitly asks for `/vibe-review` or a harness/template/process review.

This repository keeps provider-neutral skill runbooks under `.claude/skills`.

When this skill is invoked in Codex, open and follow:

`../../../.claude/skills/vibe-review/SKILL.md`

Codex notes:

- Treat Claude-specific UI references as references to the active agent session unless the source explicitly describes Claude-only behavior.
- The initialization boundary still blocks product work, but `/vibe-review` may run read-only in a partial or uninitialized checkout when the explicit target is an init/bootstrap/harness process failure.
- Keep `.vibe/agent/handoff.md` and `.vibe/agent/session-log.md` current when the source skill requires context persistence.
