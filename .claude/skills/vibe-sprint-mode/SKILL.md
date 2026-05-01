---
name: vibe-sprint-mode
description: Toggle agent-delegation permission presets for autonomous Sprint execution.
---

# /vibe-sprint-mode

Usage: `/vibe-sprint-mode on|off|status [--tier core|extended]`

## Tiers

| Tier | Preset file | 포괄 범위 | 추천 시점 |
|------|-------------|-----------|-----------|
| `core` (default) | `.vibe/settings-presets/agent-delegation.json` | 기본 sprint 실행 필수 (npm / git / node scripts / run-codex / push/commit) | 단일 Sprint 자율, 혹은 매번 확인 싫지만 새 확장 권한은 여전히 프롬프트 받고 싶을 때 |
| `extended` | `.vibe/settings-presets/agent-delegation-extended.json` | core + `Agent(sprint-planner/Explore/qa-guardian/...)`, git checkout/branch/rev-parse/tag/fetch, file ops(mkdir/cp/mv/cat/head/tail/find/grep/xargs), Write/Edit on docs·CLAUDE.md·README.md·.vibe/agent state files·config·package.json, WebFetch (raw.githubusercontent / api.github / registry.npmjs) | **Phase 단위 완전 위임** — 사용자 interruption 0 목표일 때 |

두 tier 모두 아래 **critical 항목은 allow 에 포함하지 않음** (사용자 매번 확인):

- `git push --force`, `git reset --hard`, `git branch -D`
- 모든 `rm` / `rm -rf`
- `npm publish`
- `gh pr create|merge|close`, `gh release create`
- `Write` / `Edit` on `src/**`, `scripts/**`, `test/**` (Orchestrator 역할 제약 — Codex 위임)
- `Write` / `Edit` on `.env*`, `secrets/**`, `config/credentials.json` (기본 deny 로 이중 방어)

## Agent-delegation 진입 UX (매 Phase 시작 전)

사용자가 agent 위임 / autonomous Phase 실행을 지시할 때 Orchestrator 는 **반드시** 아래 3-옵션을 먼저 제시하고 선택받는다:

```text
Agent 위임 모드로 진행합니다. sprint-mode 옵션을 선택해주세요:

  a) extended  — 모든 확장 preset 적용 (Agent 호출 + 파일ops + docs 편집 등 일체 skip)
                  → Phase 끝까지 interruption 없이 자율 실행 목표. 권장.

  b) core      — 기존 v1 preset 만 적용 (npm / git push / run-codex / node scripts 등)
                  → 확장 권한 (Agent 호출, docs Write/Edit 등) 은 매번 확인.

  c) off       — sprint-mode 비활성. 모든 권한 요청을 사용자가 직접 확인.
```

선택 즉시 Orchestrator 는 해당 옵션에 맞는 명령을 실행:

- **a)** `node .vibe/harness/scripts/vibe-sprint-mode.mjs on --tier extended`
- **b)** `node .vibe/harness/scripts/vibe-sprint-mode.mjs on --tier core`
- **c)** `node .vibe/harness/scripts/vibe-sprint-mode.mjs off` (이미 off 이면 skip)

선택 결과를 session-log 에 `[decision][sprint-mode-tier]` 태그로 한 줄 기록하고, Phase 종료 시 `off` 로 되돌릴지 여부도 함께 사용자에게 확인.

## Underlying command

```bash
node .vibe/harness/scripts/vibe-sprint-mode.mjs on [--tier core|extended]
node .vibe/harness/scripts/vibe-sprint-mode.mjs off
node .vibe/harness/scripts/vibe-sprint-mode.mjs status
```

- `on` (tier 생략) → `core` default. 기존 호환.
- `on --tier extended` → extended preset merge. core preset 이 이미 켜져 있어도 상관 없이 superset 으로 덮어씀.
- `off` → 두 preset 의 rule 을 모두 제거. 사용자 커스텀 규칙은 보존.
- `status` → 현재 활성 tier + rule 수 표시.

## What it does

- **on**: 지정한 tier 의 preset 을 `.claude/settings.local.json` 의 `permissions.allow` 에 dedupe merge.
- **off**: 양 tier preset 의 rule 을 모두 allow 에서 제거. 사용자 커스텀 rule 은 유지.
- **status**: tier 별 active rule 수 + 활성 tier 표시.

## Security

- 모든 rule 은 scope-bound (npm/npx/node/git/file-ops + 명시된 sub-agent 만).
- `npm install` 은 의도적으로 포함 — 미신뢰 패키지의 postinstall 스크립트는 `--ignore-scripts` 로 대응.
- extended tier 도 shell 광역 접근은 제공하지 않음 (명시 패턴만).
- 오직 `.claude/settings.local.json` 만 수정. 프로젝트 공유 `.claude/settings.json` 은 절대 건드리지 않음.
- Critical 작업(push --force, reset --hard, rm, npm publish, gh pr 계열, src/ 편집, .env) 은 양 tier 모두 gated 상태 유지.
