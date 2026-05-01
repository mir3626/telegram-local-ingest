---
name: vibe-sync
description: Sync vibe-doctor harness/template updates while preserving project-owned code and rules.
---

`/vibe-sync` updates harness-owned files from upstream according to `.vibe/sync-manifest.json`. It must preserve project-owned source, product context, local provider settings, and `PROJECT:*` marker blocks.

## When To Run

- Session start or statusline reports that a harness update is available.
- The user explicitly asks for `/vibe-sync` or `npm run vibe:sync`.
- Preflight reports a harness version mismatch.

## Flow

1. Run `npm run vibe:sync -- --dry-run` and inspect the plan.
2. Explain any `conflict` rows to the user unless they already authorized forceful sync.
3. Run `npm run vibe:sync`.
4. Let post-sync verification run:
   - harness-only typecheck via `.vibe/harness/tsconfig.harness.json`
   - bootstrap preflight via `.vibe/harness/scripts/vibe-preflight.mjs --bootstrap`
5. If sync fails, use `.vibe/sync-backup/<timestamp>/` for recovery context.

## Options

| Flag | Purpose |
|---|---|
| `--dry-run` | Print the plan only. |
| `--force` | Replace all conflicted harness files with upstream versions. |
| `--from <path>` | Use a local upstream checkout instead of cloning. |
| `--ref <tag>` | Override the upstream git ref for this run. |
| `--no-backup` | Skip backup creation. |
| `--no-verify` | Skip post-sync typecheck/preflight. |
| `--json` | Print the plan as JSON. |

## Legacy Bootstrap

For old projects that cannot run the normal sync path yet, run the standalone bootstrap once from the project root. It understands current glob-based manifests and copies `.vibe/harness/**` before normal `/vibe-sync` is available.

Local clone:

```bash
git clone --depth 1 https://github.com/mir3626/vibe-doctor /tmp/vibe-doctor
node /tmp/vibe-doctor/.vibe/harness/scripts/vibe-sync-bootstrap.mjs
```

Compatibility raw URL, kept for legacy docs:

```bash
curl -sL https://raw.githubusercontent.com/mir3626/vibe-doctor/main/scripts/vibe-sync-bootstrap.mjs | node --input-type=module -
```

The root `scripts/vibe-sync-bootstrap.mjs` file is only a compatibility bridge. The canonical harness runtime lives under `.vibe/harness/**`.

## Upstream Ref Contract

- exact `vX.Y.Z` or `X.Y.Z`: hard pin
- caret `^vX.Y.Z` or `^X.Y.Z`: floating compatible range
- branch names such as `main`: use as-is
- missing `upstream.ref`: use cached latest when newer than installed, then current `harnessVersion`, then `main`

Default templates use caret refs so plain `/vibe-sync` advances to the latest compatible harness version. Use exact refs only when an intentional pin is needed.

## Boundaries

- Root `src/**`, `scripts/**`, `test/**`, `app/**`, `components/**`, and `lib/**` are project-owned after v1.7.0.
- Harness runtime, tests, migrations, and configs live under `.vibe/harness/**`.
- Root Markdown files stay hybrid through marker blocks.
- `package.json` sync owns `scripts.vibe:*` and `engines`; product scripts such as `test`, `build`, `typecheck`, and `test:ui` are project-owned.
