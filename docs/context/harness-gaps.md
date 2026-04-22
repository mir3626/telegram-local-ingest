# Harness Gaps

## Purpose

이 ledger 는 dogfood 와 실제 Sprint 운영 중 드러난 하네스 사각지대를 추적한다.
각 항목은 symptom, 현재 script/hook 커버리지, 그리고 남은 상태를 한 곳에서 본다.
목표는 규칙을 문서에만 남기지 않고 가능한 한 script/hook 으로 강제하는 것이다.

## Entries

| id | symptom | covered_by | status | script-gate | migration-deadline |
|---|---|---|---|---|---|
| gap-mcp-frozen-pid | legacy MCP stale PID 로 Phase 3 인터뷰 기동 실패 (Windows) | `scripts/vibe-interview.mjs` native fallback (M5) | covered | covered | — |
| gap-windows-cli-path | Windows 에서 `./scripts/run-codex.sh` 가 provider health check 에서 cmd.exe fallback 으로 실패 | `.claude/skills/vibe-init/SKILL.md` Step 2-3 OS 감지 + `run-codex.cmd` (M2) | covered | covered | — |
| gap-loc-accounting | 커밋 범위 기반 LOC 집계 누락 -> sprint 크기 왜곡 | `vibe-sprint-complete.mjs` `actualLoc` 기록 + lastSprintScope (M1/M3) | covered | covered | — |
| gap-cmd-wrapper-health | Codex wrapper 가 retry·버전·health subcommand 없어 진단 어려움 | `run-codex.sh --health` / `--version` (M2) | covered | covered | — |
| gap-session-log-ordering | session-log 엔트리 타임스탬프 역순·중복·race 로 손상 | `vibe-session-log-sync.mjs` (M3) | covered | covered | — |
| gap-audit-cadence | 프로세스 건강성 리뷰 주기 누락 -> 사각지대 누적 | `sprintsSinceLastAudit` + `vibe-audit-clear.mjs` + `/vibe-review` (M8) | covered | covered | — |
| gap-review-reproducibility | 리뷰가 사람 주관 기반 -> 입력 재현 불가 | `/vibe-review` SKILL.md + `test/vibe-review-inputs.test.ts` exist (M8) | covered | covered | — |
| gap-phase0-commit-forget | Phase 0 산출물 커밋 누락으로 첫 Sprint 가 dirty tree 위에서 시작 | `vibe-phase0-seal.mjs` (M7) | covered | covered | — |
| gap-opt-in-visibility | bundle/browserSmoke opt-in 미인지로 frontend 프로젝트가 검증 없이 진행 | `/vibe-review` detectOptInGaps + test coverage (M8) | covered | covered | — |
| gap-rule-only-in-md | 규칙이 MD 에만 존재 -> Orchestrator 가 잊음 | `scripts/vibe-rule-audit.mjs` rule scanner (M-harness-gates) + retrospective transcript scan via `--scan-transcripts` (iter-3 N1) → tier-based delete; O2 evaluates `two-tier-audit-convention` restoration and defers final decision to O3 | under-review | covered | O3 |
| gap-zod-single-source | state JSON schema drift between runtime validators and `.schema.json` files | `src/lib/schemas/*.ts` + `scripts/vibe-gen-schemas.mjs` (M-audit) | covered | covered | — |
| gap-statusline-visibility | Agent 위임 중 Orchestrator 상태 불투명 | `.claude/statusline.{sh,ps1}` + `vibe-status-tick.mjs` + tests (M9) | covered | covered | — |
| gap-permission-noise | Agent 위임 시 권한 프롬프트 반복 | `vibe-sprint-mode.mjs` + settings-presets + tests (M9) | covered | covered | — |
| gap-integration-smoke | end-to-end meta smoke 부재 | `test/integration/meta-smoke.test.ts` (M10, this Sprint) | covered | covered | — |
| gap-external-interview-dependency-purge | v1.2.0 에서 외부 인터뷰 엔진 참조가 docs/scripts에 잔존 (optional enhancement 수준으로 보존) | Sprint M11 (v1.2.1) | covered | covered | — |
| gap-release-tag-automation | `harnessVersion` bump 시 git tag (예: `v1.3.0`) 자동 생성·push 단계가 없어 downstream `vibe:sync` 가 `resolveUpstreamRef` 에서 존재하지 않는 tag 를 clone 시도 → sync 실패. v1.2.0/v1.2.1/v1.3.0 tag 가 retroactive 로만 푸시됨 | `vibe-sprint-commit.mjs` harness-tag hook (M-harness-gates) | covered | covered | — |
| gap-statusline-wiring | M9 에서 `.claude/statusline.{sh,ps1}` 스크립트는 만들었지만 `.claude/settings.json` 에 Claude Code 가 해당 스크립트를 호출하도록 `statusLine` 설정 항목을 추가 안 함. 사용자가 내장 activity indicator 만 보게 되어 custom statusline 이 dead code 상태 | `.claude/settings.json` 에 `statusLine: {type:"command", command:"bash .claude/statusline.sh"}` 추가 + `sync-manifest.json` 의 harnessKeys 에 `statusLine` 등록 (retroactive 수정, v1.3.1 예정). 향후 M9-style 신규 Claude Code integration feature 는 **스크립트 생성 + settings.json 등록 + manifest harnessKeys 업데이트** 3단 절차를 Planner 체크리스트에 강제할 것 | covered | covered | — |
| gap-archive-prompts-regex | `archiveSprintPrompts()` 의 필터가 `entry.startsWith(${sprintId}-)` 로 suffix `-` 를 강제하여 `sprint-M5-native-interview.md` 같은 실제 파일명을 매치 못함. M1~M12 아카이빙 전량 실패 → `docs/prompts/` 에 20개 orphan 누적 | Sprint M13 에서 필터를 `base === sprintId \|\| base.startsWith(${sprintId}-)` 로 교체. 20개 orphan 은 Orchestrator 가 `git mv` 로 retroactive 이동. | covered | covered | — |
| gap-v1.3-wiring | v1.3.0 핵심 기능 `/vibe-iterate` 및 `scripts/vibe-project-report.mjs` 가 CLAUDE.md 에 전혀 등장하지 않아 Orchestrator 가 자기 존재를 인지 못함. M12 sprint 의 Planner/Codex 가 SKILL.md 만 만들고 CLAUDE.md wiring 을 빠뜨림 | Sprint M13 에서 CLAUDE.md Sprint flow 절차 9 에 project-report 자동 호출 + /vibe-iterate 진입 문구 명기, "관련 스킬" 목록에 /vibe-iterate 추가 + 한 줄 설명. 향후 **"artifact created but not wired"** 탐지를 /vibe-review rubric 의 명시적 체크 항목으로 추가 필요 (open sub-gap) | covered | covered | — |
| gap-dead-stub-files | `scripts/run-claude.{sh,cmd}` 가 exit 2 "not wired" stub 상태로 manifest + README 에만 언급. 실 호출처 0. YAGNI violation | Sprint M13 에서 삭제 + manifest/README 참조 제거. 미래 provider 편입 시 재생성. | covered | covered | — |
| gap-review-catch-wiring-drift | /vibe-review 가 "artifact created but not wired" 패턴을 구조적으로 감지 안 함. statusline/run-claude/vibe-iterate/project-report 같은 사례가 review cadence 로 잡히지 않았음 | `.claude/skills/vibe-review/SKILL.md` rubric 에 "wiring-drift" 체크 추가 필요: 각 scripts/`*.mjs` 가 package.json · CLAUDE.md · settings.json · skill 중 최소 1곳에서 참조되는지 자동 스캔. 아직 미구현 | open | pending | +3 sprints |
| gap-harness-bloat-self-expansion | 하네스 rule 이 실제 incident signal 없이 preventive 목적만으로 누적되어 agent context 를 조용히 압박 | `scripts/vibe-rule-audit.mjs --scan-transcripts` + iter-3 rules-deleted ledger (iter-3 N1) | partial | partial | +3 sprints |
| gap-generator-test-scope-creep | Generator 가 Planner prompt 비지정 상태에서 test/*.test.ts 를 자발 생성. dogfood10 M2/M3 에서 3회 발생. | _common-rules.md §15 (sprint-M2-generator-scope-discipline). 재발 시 run-codex.sh post-process diff grep 으로 enforcement 승격. | closed | covered | — |
| gap-external-adapter-blind-spot | e2e smoke 가 개별 data-fetcher route 응답을 probe 하지 않아 adapter 가 0 items 반환해도 통과. dogfood10 iter-1 배포 후 사용자 발견. | `/vibe-review` rubric adapter-health blind-spot + `collectReviewInputs.productFetcherPaths` (sprint-M3-review-adapter-blind-spot) | closed | covered | +1 sprint (iter-7) |

Update protocol:
1. 새 gap 발견 시 id `gap-<slug>` 로 표 끝에 append 한다.
2. 해결 Sprint 에서 `covered_by` 와 `status` 를 갱신한다.
3. `/vibe-review` 는 이 ledger 를 읽고 `open` 개수를 findings 근거에 반영한다.

4. `script-gate` is `covered` only when a `scripts/vibe-*.mjs` or hook exit code (documented in CLAUDE.md § hook enforcement table) enforces the rule. Mere mention in an MD file counts as `pending`.
5. `migration-deadline` is free-form but MUST be either `—` or reference a concrete target (Sprint id, version, or `+N sprints`). `/vibe-review` flags overdue deadlines.

## Process

새 gap 은 현상 중심으로 적고, 특정 사람의 실수로 서술하지 않는다.
`covered` 는 실사용 중인 script/hook 과 테스트가 둘 다 있는 경우에만 쓴다.
`partial` 과 `open` 은 다음 Sprint scope 후보를 만들 때 우선 확인한다.
