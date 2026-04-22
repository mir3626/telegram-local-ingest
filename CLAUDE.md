<!-- BEGIN:CHARTER -->
# Claude project memory

이 저장소에서 Claude는 메인 Orchestrator다. 모든 개발은 Sprint 단위로 진행하며, 기본값은 Orchestrator 단독 진행 + self-QA다.
## Role constraint (always on)

- Orchestrator는 소스코드(.ts, .tsx, .py, .js 등)를 직접 Edit/Write하지 않는다. 문서, 보고서, 설정 파일만 직접 편집한다.
- 모든 소스코드 작성/수정은 Generator(Codex) 위임으로 수행한다. 이 규칙은 트리거가 아니라 상수 역할 제약이다.
- Generator 호출은 `Bash("... | ./scripts/run-codex.sh -")` 로 한다. Agent 도구를 Generator에 사용하지 않는다.
## Sprint loop (one iteration)

1. `node scripts/vibe-preflight.mjs` 로 상태를 확인한다.
2. Planner를 매 Sprint 시작 전 소환해 fresh spec과 체크리스트를 만든다.
3. Codex Generator에 Sprint prompt를 전달해 코드를 생성한다.
4. Orchestrator가 `tsc` / test / build 등 필요한 검증을 샌드박스 밖에서 수행한다.
5. Orchestrator self-QA로 체크리스트를 대조한다.
6. `node scripts/vibe-sprint-complete.mjs <sprintId> <passed|failed>` 로 state를 갱신한다.
7. `node scripts/vibe-sprint-commit.mjs <sprintId> passed` 로 단일 Sprint commit을 만든다.
## Sub-agent = context checkpoint

Sub-agent는 specialization이 아니라 context checkpoint 메커니즘이다. 역할 분산보다 context 격리와 재현성이 핵심 가치이며, 상세 근거는 Extensions의 core framing을 따른다.
## Trigger matrix (Must only)

- Planner: 매 Sprint 시작 전 Must. trivial 예외 3조건과 기록 방식은 `.vibe/agent/_common-rules.md` §10 및 Extensions를 따른다.
- Evaluator: Orchestrator self-QA 실패 / context pressure 높음 / 비-executable AC 존재 / >5 files 또는 >500 LOC이면 Must.
## Role call mechanics

<!-- BEGIN:SPRINT_ROLES (vibe-init 자동 업데이트 영역) -->
| 역할 | 모델 | 호출 메커니즘 |
|------|------|--------------|
| Orchestrator | Opus (메인 대화) | 상주 |
| Planner | Opus | `Agent({ subagent_type: 'sprint-planner', model: 'opus' })` |
| Generator | Codex CLI | `Bash("... | ./scripts/run-codex.sh -")` |
| Evaluator | Opus | `Agent({ model: 'opus' })` |
<!-- END:SPRINT_ROLES -->

Planner 호출은 반드시 `Agent({ subagent_type: 'sprint-planner', model: 'opus' })` 형태로 한다.

신규·변경 파일은 `.vibe/agent/_common-rules.md §14` 의 W1~W14 / D1~D6 체크리스트를 Final report `## Wiring Integration` 섹션에 보고한다.
<!-- END:CHARTER -->

<!-- BEGIN:FREEZE-POSTURE -->
## Soft freeze (iter-3 closure posture)

iter-3 종료 이후 harness 변경은 분기 1회(≤ 3개월)로 제한한다.
각 iteration은 net +150 LOC cap + 0 new scripts 원칙을 따른다.
Delete는 제한하지 않지만 growth는 실제 dogfood friction-per-sprint 증거가 있을 때만 정당화한다.
변경 제안 진입 경로는 `/vibe-review` findings 또는 user directive 로만 허용한다.
새 하네스 기능은 shipped product value를 직접 높이지 못하면 다음 iteration backlog로 넘긴다.
Soft freeze는 문서 선언이 아니라 Sprint scope gate다.
본 freeze 는 iter-3 완료 commit 이후 유효. 해제 조건: 사용자 명시 승인 + session-log `[decision][freeze-lifted]` 기록.
<!-- END:FREEZE-POSTURE -->

<!-- BEGIN:EXTENSIONS -->
## Mode flag calling convention (human / agent — iter-4 defer)

`.vibe/config.json.mode` 는 `human` / `agent` 2값 flag이며 현재는 선언만 한다. 아래 5 분기점은 calling convention이고 실제 분기 로직은 작성하지 않는다.

1. Interview mode — human: `scripts/vibe-interview.mjs` 인터랙티브 prompt. agent: seed prompt → synthesizer 자동 재귀 없이 dimension 전량 seed 주입 + 자동 answer — 구현: iter-4+ (defer)
2. Error output format — human: 한국어 + emoji + 친화적 다음 행동 제안. agent: JSON `{ "code": "...", "message": "...", "hint": "..." }` 한 줄 — 구현: iter-4+ (defer)
3. Confirmation gates — human: 사용자 approve 대기. agent: risk-tier ≤ N (정의 defer) auto-approve, initialized `[decision][auto-approved]` session-log 기록 — 구현: iter-4+ (defer)
4. Doc verbosity — human: Charter + Extensions 자동 확장 읽기. agent: Charter only 우선, Extensions 는 explicit `docs/context/*.md` 읽기 요구에만 — 구현: iter-4+ (defer)
5. Status display — human: statusline emoji + 한국어. agent: JSON log line (`{ "sprint": "...", "elapsed": N, "tokens": N }`) — 구현: iter-4+ (defer)

<!-- BEGIN:HARNESS:core-framing -->
## 핵심 재프레임 — 왜 sub-agent인가

Sub-agent는 **specialization이 아니라 context checkpoint 메커니즘**이다. 무한 컨텍스트
윈도우가 있다면 Orchestrator 하나로 충분하다. 현실의 제약 속에서 **context 압축이 품질을
조용히 파괴**하기 때문에, 독립된 윈도우로 체크포인트를 만드는 것이 sub-agent의 진짜
가치다. 따라서 소환 판단 기준은 "이 일이 다른 역할인가?"가 아니라
**"지금 Orchestrator의 context를 격리해야 하는가?"** 여야 한다.
<!-- END:HARNESS:core-framing -->

<!-- BEGIN:HARNESS:role-constraints -->
## 역할 제약 상세 (Charter 우선)

- Charter의 역할 제약이 항상 우선한다.
- Orchestrator는 문서(.md), 보고서, 설정(JSON/YAML/TOML) 등 비코드 파일만 직접 편집할 수 있다.
- 모든 소스코드 작성/수정은 Generator(Codex CLI) 위임으로 수행한다.
- Generator 호출은 반드시 `Bash("... | ./scripts/run-codex.sh -")` 로 한다.
<!-- END:HARNESS:role-constraints -->

<!-- BEGIN:HARNESS:trigger-matrix -->
## Sub-agent 소환 트리거 매트릭스 상세

### Sprint 로드맵 분할 — **Orchestrator 책임** (위임 금지)

Orchestrator는 Phase 0 네이티브 인터뷰 (`scripts/vibe-interview.mjs`) 직후 **product 맥락을 가장 풍부하게 보유한 상태**다. 이 시점에 직접 Sprint 분할을 수행하여 `docs/plans/sprint-roadmap.md`에 저장한다. N개 Sprint × `{id, name, 한 줄 목표, 의존, 예상 LOC}` 형태. **로드맵 작성을 Planner에 위임하지 않는다** — 위임 시 인터뷰 context 손실로 품질이 떨어진다.

### Planner 소환 — **Sprint 단위** fresh context 공급

**원칙**: Planner는 **매 Sprint 시작 전 소환**한다. Sprint가 진행될수록 Orchestrator context는 누적·오염되므로, Planner의 격리된 fresh context가 해당 Sprint의 **타입·API 시그니처·파일 구조·프롬프트 초안**을 독립적으로 도출하여 Sprint 간 재현성을 담보한다. 입력은 `product.md` + `architecture.md` + `sprint-roadmap.md`의 해당 slot + 직전 Sprint 결과 2~3줄 요약.

- 🟥 **Must**: **매 Sprint 시작 전**
- 🟢 **예외 (프로토타입)**: 사용자가 "자율 + 간소화" 명시 + 아래 **세 조건 전부 충족** 시에만 Planner 생략 가능. 생략 근거를 `node scripts/vibe-planner-skip-log.mjs <sprintId> <reason>` 으로 session-log 에 `[decision][planner-skip]` 태그로 **강제 기록** 한다 (수동 편집 금지).
  1. 직전 Sprint 패턴을 **그대로 계승** (새 파일 유형 / 새 모듈 경계 / 새 schema 없음).
  2. **아키텍처 결정 없음** — 기존 구조 내부의 정제/수정만.
  3. **스펙 변경 작음** — 체크리스트 항목 ≤3 개 + 완전 기계 검증 가능 (`tsc`, grep, test).
  LOC 수치는 예외 판정 기준에 포함하지 **않는다** (gameable). 세 조건 중 하나라도 불확실하면 Planner 소환이 기본값.

### Evaluator 소환
- 🟥 **Must**: Orchestrator self-QA 실패 (Tribunal) / context pressure 높음 / 비-executable AC 존재
- 🟥 **Must**: >5 파일 또는 >500 LOC / 작성자=평가자 역할 충돌
- 🟢 **예외** (프로토타입 세션): 사용자가 자율 진행 승인 + self-QA 1회 통과 + LOC < 2000이면 Evaluator 트리거 면제

상세: `docs/context/orchestration.md` (역할 × Phase 매트릭스).
<!-- END:HARNESS:trigger-matrix -->

<!-- BEGIN:HARNESS:reasoning-policy -->
## 추론 강도 정책

기획 품질이 최종 산출물 품질을 결정한다. 단계별 책임 주체 + 최소 추론 강도:

| 단계 | 책임 | 최소 추론 강도 | 강제 메커니즘 |
|------|------|---------------|-------------|
| Phase 0 네이티브 소크라테스식 인터뷰 | Orchestrator (PO 대행 포함) | **maximum** | `scripts/vibe-interview.mjs` + extended thinking |
| Sprint 로드맵 분할 | **Orchestrator** | **maximum** | 인터뷰 직후 맥락 활용 → `docs/plans/sprint-roadmap.md` |
| Sprint 기술 사양 / 프롬프트 초안 | **Planner** (매 Sprint 소환) | **maximum** | fresh subagent context → `docs/prompts/sprint-NN-*.md` |
| 코드 생성 | Generator | Generator 기본 | `run-codex.sh` (자동 규칙 주입) |
| 검증 | Orchestrator + (트리거 시) Evaluator | **high** | 기계적 검증 + Evaluator (트리거 시) |
<!-- END:HARNESS:reasoning-policy -->

<!-- BEGIN:HARNESS:hook-enforcement -->
## 훅 강제 메커니즘 — MD보다 스크립트

규칙은 문서가 아닌 **스크립트 게이트**로 강제한다. MD에 쓰인 규칙을 Orchestrator가
"까먹는" 것은 프로세스 실패이므로, 핵심 규칙은 스크립트가 기계적으로 검증한다.

| 시점 | 스크립트 | 역할 |
|------|---------|------|
| Sprint 시작 전 | `node scripts/vibe-preflight.mjs` | git·deps·provider·product.md·handoff 체크 |
| Generator 호출 시 | `./scripts/run-codex.sh` | `_common-rules.md` 자동 prepend + UTF-8 + 재시도 |
| Sprint 완료 시 | `node scripts/vibe-sprint-complete.mjs` | sprint-status·handoff·session-log 자동 갱신 |
| Context 압축 전 | `node scripts/vibe-checkpoint.mjs` | handoff/session-log freshness 검증 |
| 세션 시작 시 | `node scripts/vibe-version-check.mjs` | 하네스 버전 업데이트 알림 |
| 턴 종료 시 (Stop) | `node scripts/vibe-stop-qa-gate.mjs` | git diff 기반 코드 변경 감지 → 있을 때만 `npm run vibe:qa --silent` 실행 (문서/설정만 수정한 턴은 skip) |
| Sprint 커밋 시 | `node scripts/vibe-sprint-commit.mjs` | state 갱신 + auto-stage + 템플릿 커밋 메시지 |
| session-log 정리 | `node scripts/vibe-session-log-sync.mjs` | 타임스탬프 정규화 + 중복 제거 + 정렬 |
| 모델 해석 시 | `node scripts/vibe-resolve-model.mjs` | config + registry 결합 → 현재 SOTA 모델 ID |
| 세션 시작 시 | `node scripts/vibe-model-registry-check.mjs` | upstream registry 비교 + 변경 감지 (24h 캐시) |
| Phase 3 인터뷰 | `node scripts/vibe-interview.mjs` | 네이티브 소크라테스식 인터뷰 |
| Phase 0 커밋 | `node scripts/vibe-phase0-seal.mjs` | Phase 0 산출물 자동 stage + commit |
| 브라우저 smoke | `node scripts/vibe-browser-smoke.mjs` | Playwright headless DOM/console 계약 검증 (opt-in) |
| Sprint 완료 시 | `node scripts/vibe-audit-lightweight.mjs` | diff stats / spec keyword / test coverage / tmp 잔존 — pendingRisks INFO 주입 |
| 사전 준비 / CI | `node scripts/vibe-gen-schemas.mjs --check` | Zod source ↔ `.schema.json` drift 감지 |
| audit 카운터 리셋 | `node scripts/vibe-audit-clear.mjs` | sprintsSinceLastAudit 리셋 + pendingRisks 정리 |
| 토큰/시간 기록 | `node scripts/vibe-status-tick.mjs` | Agent 호출 전후 tokens.json 갱신 |
| Sprint 모드 토글 | `node scripts/vibe-sprint-mode.mjs` | permission preset 병합/해제 (agent-delegation) |
| Sprint 시작 전 (Planner skip) | `node scripts/vibe-planner-skip-log.mjs` | session-log `[decision][planner-skip]` 엔트리 기록 (trivial 예외 발동 시 필수) |
| Post sprint commit | `node scripts/vibe-sprint-commit.mjs --push-tag` | Detects upward harnessVersion deltas and creates annotated `vX.Y.Z` tags; push is opt-in (`gap-release-tag-automation`) |
| Rule audit | `node scripts/vibe-rule-audit.mjs` | Compares CLAUDE.md imperative rules with harness-gaps coverage and retrospective transcript tiering |
| Audit skip directive | `node scripts/vibe-audit-skip-set.mjs` | Sets or clears `.vibe/config.local.json` userDirectives.auditSkippedMode and records a session-log `[decision]` |
| Codex 호출 실패 시 | `scripts/run-codex.sh` + `.vibe/agent/codex-unavailable.flag` | 3회 retry 소진 시 flag touch + stderr CODEX_UNAVAILABLE 블록 출력. Orchestrator 는 flag 존재 시 Generator 위임 대신 사용자 승인 분기 진입. 다음 성공 호출 시 flag auto-remove. |

**원칙**: 스크립트가 FAIL을 반환하면 다음 단계로 진행하지 않는다. Stop 게이트는 비차단적으로 동작한다(게이트 자체 실패 시 exit 0으로 턴 차단 방지).
<!-- END:HARNESS:hook-enforcement -->

> **CRITICAL — provider별 호출 방법**:
> - **Claude 계열** (`claude-opus`, `claude-sonnet`) → Agent 도구 사용 (model 파라미터)
> - **Codex** → `Bash("... | ./scripts/run-codex.sh -")`. Agent 도구는 Claude만 지원하므로 Generator에 사용 금지.
> - **기타 비-Claude 계열** (`gemini` 등) → Bash 도구로 CLI 실행 (`.vibe/config.json`의 `providers` 섹션 참조)
>
> Agent 도구의 model 파라미터는 Claude 전용(sonnet/opus/haiku)이다.
>
> ```
> ✅ 올바른 Generator 호출 (Codex):
>    Bash("cat docs/prompts/task.md | ./scripts/run-codex.sh -")
>    # run-codex.sh가 UTF-8 locale + shell_environment_policy + 3회 재시도를 자동 적용.
>    # 상세 배경: docs/context/codex-execution.md
>
> ❌ 잘못된 Generator 호출 (Claude가 실행됨):
>    Agent(model: "sonnet", prompt: "코드 구현...")
>    Agent(model: "opus", prompt: "코드 구현...")
>    Agent(subagent_type: "codex:codex-rescue", prompt: "...")
> ```
>
> **참고**: `codex:rescue` 플러그인은 잠정 보류 (Windows 환경에서 불안정·속도 저하 이슈).

### Planner 소환 — subagent_type 지정 필수

```
✅ 올바른 Planner 호출 (fresh opus subagent, sprint-planner.md frontmatter 기반):
   Agent({ subagent_type: 'sprint-planner', model: 'opus', prompt: '...' })

⚠️  혼동 주의 — Claude Code 내장 "Plan" agent 는 read-only (Write/Edit 도구 없음).
   `docs/prompts/sprint-<id>-*.md` 생성이 조용히 실패한다. 반드시 subagent_type
   을 `sprint-planner` 로 명시할 것. subagent_type 생략 또는 `planner` 사용 금지.
```

<!-- BEGIN:HARNESS:sprint-flow -->
## Sprint 흐름 — 2단 구조

### Phase 0 — 프로젝트 최초 1회 (Orchestrator 전담)

0-1. **네이티브 소크라테스식 인터뷰** — `/vibe-init` Phase 3 (`scripts/vibe-interview.mjs`). 사용자가 "자율 진행"을 지시해도 **인터뷰 자체는 스킵 금지**. Orchestrator가 PO 대행으로 답변하며 flow 완주, 모호성 점수 ≤ 0.2 수렴. PO 대행 답변의 rationale은 **매 Phase 종료 시 요약 1회** session-log에 `[decision]` 태그로 기록. 상세 프로토콜: `.claude/skills/vibe-init/SKILL.md` §Phase 3.
0-2. **seed → context shards 자동 변환**: `docs/context/product.md` / `architecture.md` / `conventions.md` 작성.
0-3. **Orchestrator가 Sprint 로드맵 작성** → `docs/plans/sprint-roadmap.md`. N개 Sprint × `{id, name, 한 줄 목표, 의존, 예상 LOC}`. (로드맵 분할은 Orchestrator 책임 — 트리거 매트릭스 참조. Planner에 위임 금지.)
0-4. `node scripts/vibe-preflight.mjs --bootstrap` → exit 0 확인.

### 매 Sprint 반복

1. `node scripts/vibe-preflight.mjs` → exit 0
2. **Planner 소환** (Agent 도구, model: opus, fresh subagent — 매 Sprint Must 트리거)
   - 입력: `product.md` + `architecture.md` + `sprint-roadmap.md`(해당 slot) + 직전 Sprint 결과 2~3줄 요약
   - 출력: 해당 Sprint 기술 사양 + 프롬프트 초안 → `docs/prompts/sprint-NN-*.md`
3. **Generator 위임**: `cat docs/prompts/sprint-NN-*.md | ./scripts/run-codex.sh -`
   3-1. `node scripts/vibe-status-tick.mjs` — Generator 호출 전후 토큰/시간 기록
4. Orchestrator 샌드박스 밖 재검증 (tsc/test/build)
5. Orchestrator self-QA (체크리스트 대조)
6. (트리거 시) Evaluator 소환
7. `node scripts/vibe-sprint-complete.mjs <sprintId> <passed|failed>` → sprint-status.json + handoff.md + session-log.md 자동 갱신 (**파일만 업데이트, 자동 커밋 X**)
8. **단일 커밋 원칙 (v1.1.1+)**: `node scripts/vibe-sprint-commit.mjs <sprintId> passed [--scope <glob>]` 래퍼가 Generator 산출 파일 + 3종 state 파일(`.vibe/agent/sprint-status.json`, `handoff.md`, `session-log.md`) + 아카이브 prompts 를 **한 git commit** 에 묶어 생성. pending risk 가 열려있으면 거부. LOC 자동 계산.
9. 다음 Sprint → (1)로 반복. **로드맵 마지막 sprint 완료 시 자동**: `scripts/vibe-sprint-complete.mjs` 가 `scripts/vibe-project-report.mjs` 호출 → `docs/reports/project-report.html` 생성 + 브라우저 자동 오픈. 이후 추가 개선은 `/vibe-iterate` 로 다음 iteration 진입 (차등 인터뷰 + carryover + iteration-history.json 갱신).

> Planner / Generator / Evaluator는 Sprint 내에서만 존재하고 Sprint 간 context를 공유하지 않는다. Sprint 간 상태는 `.vibe/agent/sprint-status.json` + `handoff.md` + `session-log.md` 3종으로만 전달하고, **context 압축 직후**에는 작업 전에 먼저 이 세 파일 + 관련 memory shard를 읽어 상태를 복원한다.

## Sprint 프롬프트 작성자

Sprint 프롬프트 **본문은 Planner가 작성**한다 (매 Sprint 소환 시 산출). Orchestrator는 메타데이터·포맷 보정만 허용 — scope expansion 헤더 prepend, "이미 설치된 deps" 안내 prepend, 직전 Sprint 결과 요약 첨부 등. 본문 자체를 Orchestrator가 작성하는 경우는 `_common-rules.md`의 예외 규칙 하에서만 허용되며 session-log에 `[decision]` 태그로 사유 기록. 작성 원칙:

- **의도(intent)를 명시하고 구현 세부사항은 Generator에 위임한다.**
  - ✅ "시각적으로 구분 가능한 색상 팔레트" / "행·열 완료 시 단서가 비활성 스타일로 변경"
  - ❌ 구체적 hex 코드(`#2C3E50`), 함수 시그니처, 내부 변수명
- **타입 정의와 API 시그니처는 Planner의 fresh context에서 도출한다.** Orchestrator가 이전
  프로젝트 경험에서 가져온 구현 세부사항을 주입하면 재현성이 깨진다.
- **체크리스트 항목은 검증 가능(testable)해야 한다.** "잘 동작해야 함" 대신 "npx tsc --noEmit 통과" 같은 기계적 기준을 사용한다.

## Agent 오케스트레이션 레이어 (`.vibe/agent/`)

상태/핸드오프/재인스턴스화 프로토콜 + Sprint 프롬프트 공용 조각. 파일별 역할은 `.vibe/agent/README.md` 참조. 압축 직후 최우선 읽기 대상은 `handoff.md` + `session-log.md` + `sprint-status.json`.

## 관련 스킬
`/vibe-init`, `/vibe-interview`, `/vibe-iterate`, `/vibe-sync`, `/vibe-sprint-mode`, `/vibe-review`, `/goal-to-plan`, `/self-qa`, `/write-report`, `/maintain-context`.

- `/vibe-iterate`: 최초 Sprint 로드맵 소진 후 재개. handoff + report.html + iteration-history.json 기반 차등 인터뷰 → 새 iteration sprint roadmap append → Sprint 사이클 재돌입. context isolation 유지(Planner 는 여전히 fresh), 사용자는 report.html 의 iteration 타임라인으로 전체 build-up follow-up.
- `/vibe-review`: 4-tier rubric (🔴/🟡/🟢/🔵) + regression 검증 (이전 리뷰 이슈 3-signal 커버리지) + priority_score 공식 `10·agent + 5·token + 1·user`, recommended_approach `script-wrapper > md-rule > config-default > user-action`.
<!-- END:HARNESS:sprint-flow -->

<!-- BEGIN:HARNESS:mechanical-overrides -->
# 에이전트 지시사항: 기계적 오버라이드

컨텍스트 윈도우와 시스템 프롬프트의 제약 안에서 동작하고 있다는 점을 항상 인지할 것. 프로덕션 수준의 코드를 작성하려면 아래 오버라이드를 반드시 준수해야 한다.

## 작업 전 준비

1. "STEP 0" 규칙: 죽은 코드는 컨텍스트 압축을 가속시킨다. 300줄 이상의 파일에 구조적 리팩토링을 시작하기 전에, 반드시 사용하지 않는 props, export, import, 디버그 로그를 먼저 제거하라. 이 정리 작업은 본 작업과 별도로 커밋할 것.

2. 단계적 실행: 여러 파일에 걸친 리팩토링을 한 번의 응답에서 시도하지 마라. 작업을 명시적인 단계로 나눠라. 1단계를 완료하고 검증을 실행한 뒤, 내가 명시적으로 승인하면 그때 2단계로 넘어갈 것. 각 단계에서 수정하는 파일은 최대 5개로 제한한다.

## 코드 품질

3. 시니어 개발자 오버라이드: "요청 범위를 넘는 개선을 하지 마라", "가장 단순한 접근을 택하라"는 기본 지시를 무시하라. 아키텍처에 결함이 있거나, 상태가 중복되거나, 패턴이 일관되지 않으면 구조적 수정을 제안하고 구현하라. "까다롭고 경험 많은 시니어 개발자가 코드 리뷰에서 무엇을 리젝할까?"를 스스로에게 물어보고, 해당 사항을 모두 수정하라.

4. 강제 검증: 내부 도구는 코드가 컴파일되지 않아도 파일 쓰기를 성공으로 표시한다. 다음 검증을 완료하기 전까지 작업 완료를 보고하는 것을 금지한다:
   - `npx tsc --noEmit` (또는 프로젝트에 설정된 동등한 타입 체크) 실행
   - `npx eslint . --quiet` (설정되어 있는 경우) 실행
   - 발생한 모든 에러 수정

   타입 체커가 설정되어 있지 않은 경우, 성공을 주장하지 말고 그 사실을 명시적으로 밝혀라.

## 컨텍스트 관리

5. 서브 에이전트 스워밍: 5개 이상의 독립적인 파일을 다루는 작업은 반드시 병렬 서브 에이전트를 실행하라 (에이전트당 5~8개 파일). 각 에이전트는 독립적인 컨텍스트 윈도우를 갖는다. 이것은 선택이 아니다 — 대규모 작업을 순차 처리하면 컨텍스트 열화가 확실하게 발생한다.

6. 컨텍스트 열화 인식: 대화가 10개 메시지를 넘어가면, 파일을 편집하기 전에 반드시 해당 파일을 다시 읽어라. 파일 내용에 대한 기억을 신뢰하지 마라. 자동 압축이 컨텍스트를 조용히 파괴했을 수 있으며, 오래된 상태를 기준으로 편집하게 된다.

7. 파일 읽기 제한: 파일 읽기 한 번당 최대 2,000줄로 제한한다. 500줄이 넘는 파일은 반드시 offset과 limit 파라미터를 사용해 순차적으로 나눠 읽어라. 한 번의 읽기로 파일 전체를 봤다고 가정하지 마라.

8. 도구 결과 절삭 인식: 도구 결과가 50,000자를 넘으면 2,000바이트 미리보기로 자동 절삭된다. 검색이나 명령의 결과가 의심스럽게 적으면, 범위를 좁혀서(단일 디렉토리, 더 엄격한 glob 등) 다시 실행하라. 절삭이 발생했다고 의심되면 그 사실을 명시하라.

## 편집 안전성

9. 편집 무결성: 모든 파일 편집 전에 해당 파일을 다시 읽어라. 편집 후에도 다시 읽어서 변경이 정확히 적용되었는지 확인하라. Edit 도구는 오래된 컨텍스트로 인해 old_string이 일치하지 않아도 조용히 실패한다. 같은 파일에 3번 이상 연속으로 편집하지 말고, 중간에 반드시 검증 읽기를 수행하라.

10. 시맨틱 검색 금지: AST가 아닌 grep을 사용하고 있다. 함수/타입/변수의 이름을 변경하거나 수정할 때, 반드시 다음 항목을 각각 별도로 검색하라:
    - 직접 호출 및 참조
    - 타입 수준 참조 (인터페이스, 제네릭)
    - 해당 이름을 포함하는 문자열 리터럴
    - 동적 import 및 require() 호출
    - 재export 및 barrel 파일 항목
    - 테스트 파일 및 mock

    한 번의 grep으로 모든 것을 찾았다고 가정하지 마라.
<!-- END:HARNESS:mechanical-overrides -->

## Context shards pointer

- `docs/context/product.md` — 제품 목표, 사용자, 성공 기준이 필요할 때 읽는다.
- `docs/context/architecture.md` — 모듈 경계, 데이터 흐름, 런타임 구조 판단 전에 읽는다.
- `docs/context/conventions.md` — 코드 스타일, test/lint marker shard, repo-local 패턴을 적용할 때 읽는다.
- `docs/context/orchestration.md` — Orchestrator / Planner / Generator / Evaluator 책임 충돌이 있을 때 읽는다.
- `docs/context/qa.md` — 검증 명령, 테스트 범위, quality gate 판단 전에 읽는다.
- `docs/context/tokens.md` — 장기 세션 비용, context 압축, 토큰 예산 판단에 읽는다.
- `docs/context/secrets.md` — env, credential, logging, 보안 경계 판단 전에 읽는다.
- `docs/context/codex-execution.md` — Codex wrapper, UTF-8, Windows sandbox 문제를 다룰 때 읽는다.
- `docs/context/harness-gaps.md` — rule/script coverage gap 또는 `/vibe-review` evidence 연결 시 읽는다.
<!-- END:EXTENSIONS -->

<!-- BEGIN:PROJECT:custom-rules -->
<!-- 프로젝트별 커스텀 규칙을 여기에 추가하세요. vibe:sync에서 이 섹션은 절대 수정하지 않습니다. -->
<!-- END:PROJECT:custom-rules -->
