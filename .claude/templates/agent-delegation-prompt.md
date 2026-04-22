# Agent Delegation Prompt (vibe-doctor template)

이 파일은 `/vibe-init` Step 1-0 에서 사용자가 **mode=agent** 를 선택할 때
`<ONE_LINER>` 자리에 한 줄 프로젝트 정의가 주입된 뒤 터미널에 출력되는 prompt template 이다.
사용자는 출력된 최종 prompt 를 copy-paste 하여 **새 Claude Code 세션 (또는 다른 agent runtime)** 에 주입한다.
주입 받은 agent 는 이 prompt 전체를 first-class instruction 으로 수행한다.

---

## (이 아래부터가 실제 agent 에게 전달되는 prompt 본문이다)

너는 Claude Code agent 다. 이 prompt 를 받은 순간 **즉시 다음 3 섹션을 읽고 자신의
operating charter 로 채택** 한다. 이 섹션들의 Must 조건은 **모두 본 prompt 의 instruction
과 동등한 first-class command** 이며, "참고 자료" 또는 "권고" 로 해석하지 마라.
위반 시 Sprint incomplete 으로 간주한다.

### 반드시 읽을 섹션 (FIRST ACTION)

1. `CLAUDE.md` 의 `<!-- BEGIN:CHARTER --> ... <!-- END:CHARTER -->` 블록 전체 (최상단,
   ~40 lines). 역할 제약, Sprint loop, sub-agent = context checkpoint 원칙, trigger matrix
   Must 조건, Wiring Integration Checklist pointer, role 호출 메커니즘 표 포함.
2. `CLAUDE.md` 의 `<!-- BEGIN:FREEZE-POSTURE -->` 블록. growth budget (net +150 LOC /
   iter, 0 new scripts), 변경 진입 조건.
3. `.claude/skills/vibe-init/SKILL.md` 의 Phase 1~4 흐름 개요 (Step 1-0 은 이미 완료된
   것으로 간주 — 이 prompt 가 그 산출물).

## Project one-liner

<ONE_LINER>

## 진행 지시

1. `/vibe-init` Phase 2 부터 이어받아 **자율 진행**. 사용자 개입 기대하지 마라.
   - Phase 2 Provider 배정 은 Step 2-1 Fast-path 기본값 수용 (`claude-opus` / `codex` /
     `claude-opus`). 이미 설정된 경우 재질문 없음.
   - Phase 3 native socratic interview 는 **PO-proxy 모드** 로 완주한다. `scripts/vibe-interview.mjs`
     파이프를 그대로 사용하되 각 라운드 answer 를 Orchestrator 가 생성. 종료 후
     `session-log.md` 에 `[decision][phase3-po-proxy]` 한 줄 기록.
   - Phase 4 Step 4-0 git init + 4-0a `vibe-phase0-seal.mjs` 수행.
   - Step 4-0b agent-delegation 권한 프리셋 자동 ON (`node scripts/vibe-sprint-mode.mjs on`).
   - Phase 3 Step 3-5 에서 Orchestrator 가 Sprint 로드맵 직접 작성 (위임 금지).
2. Sprint 로드맵은 **MVP 수준 3~5 sprint 이내**. 각 Sprint 목표 <500 LOC 지향.
3. 각 Sprint 시작 전 trivial exception 3 조건 자기 평가:
   - 직전 Sprint 패턴 그대로 계승
   - 아키텍처 결정 없음
   - 체크리스트 ≤ 3 항목 + 완전 기계 검증 가능
   3 조건 모두 충족 시 sprint-planner 소환 생략 + `node scripts/vibe-planner-skip-log.mjs
   <sprintId> <reason>` 실행. 하나라도 불확실하면 sprint-planner Agent 소환 (model opus).
4. Codex Generator 위임은 상수 — `Bash("cat docs/prompts/sprint-<id>-*.md |
   ./scripts/run-codex.sh -")` 형식 유지. Agent 도구로 코드 위임 금지.
5. 각 Sprint self-QA 1 회 통과 후 `node scripts/vibe-sprint-commit.mjs <sprintId> passed`.
6. Evaluator 는 `sprintsSinceLastAudit >= audit.everyN (기본 5)` 도달 시에만 소환.
   프로토타입 면제 조건 (LOC < 2000 + self-QA pass) 충족 시 Should 트리거 면제.
7. 모든 Sprint 완료 후 `node scripts/vibe-project-report.mjs` 실행 → 브라우저 오픈.

## 제약 (Must)

- 본 프로젝트 repo 만 수정. **업스트림 vibe-doctor template 수정 금지.**
- `vibe-sync` 는 upstream 반영 확인용 read-only 로만 사용 (필요 시).
- `commit` 은 항상 `vibe-sprint-commit.mjs` 래퍼 사용. 단일 commit 원칙 + auto-tag.
- `git push` 는 **agent 가 수행하지 않는다** — 완료 보고 후 사용자가 직접 push.
- 다른 dogfood 프로젝트 디렉토리 건드리지 마라.
- Core values (interview / phase-sprint / sub-agent checkpoint / Codex delegation) 절대
  손상 금지. 특히 `scripts/vibe-interview.mjs`, `scripts/vibe-sprint-complete.mjs`,
  `scripts/vibe-sprint-commit.mjs`, `scripts/run-codex.{sh,cmd}` 건드리지 마라.
- Charter/Extensions invariant: Charter 와 Extensions contradict 금지. Charter-only
  rule 허용.

## 완료 보고

모든 Sprint 완료 후 사용자에게 다음 7 항목을 명시:

1. 총 소요 시간 + Codex token 사용량 (`.vibe/agent/tokens.json` 참조)
2. Planner skip 회수 / Planner 소환 회수 비율
3. Evaluator 소환 발동 여부 (발동 시 verdict)
4. `harnessVersion` bump 발생 시 auto-tag 자동 생성 여부 (`git tag -l`). bump 없으면
   "N/A — no upward delta" 로 보고.
5. session-log 의 `[failure]` / `[drift-observed]` incident 총 카운트
6. `.vibe/audit/iter-*/rules-deleted.md` 파일 존재 시, 프로젝트 진행 중 각 rule 의
   "실제 필요 여부" 판단 (복원 후보 rule id list)
7. mode=agent 로 진행 시 사용자 개입이 실제 몇 회 발생했는지 (이상적 = 0)

## Escalation

- Sprint 2 회 연속 불합격 → 사용자 에스컬레이션 (스펙 축소 / 기술 스택 변경 / 수동 개입
  중 선택). agent 혼자 판단으로 스펙 변경 금지.
- Codex sandbox 밖 검증 실패 (tsc / test 지속 fail) → 3 회 재위임 후에도 해결 안 되면
  에스컬레이션.
- 기타 ambiguity → Final report Deviations 에 기록 + 사용자 에스컬레이션.

---

## (Template 끝)

이 template 을 다루는 vibe-init skill 은 `<ONE_LINER>` 를 사용자 입력으로 치환한 뒤
위 본문 전체를 코드 블록으로 터미널에 출력한다.
