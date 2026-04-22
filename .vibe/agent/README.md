# `.vibe/agent/` — Agent orchestration layer

이 서브트리는 두 축을 담는다: (1) **sub-agent(Planner/Generator/Evaluator)가 context
checkpoint로서 소환될 때** 공유할 프롬프트 조각·샌드박스 계약, (2) **Orchestrator 본인이
재인스턴스화**될 수 있도록 무손실 상태를 박제하는 핸드오프·스키마·프로토콜. 사람 사용자가
읽는 docs가 아니라 **에이전트가 파싱/include/주입해서 쓰는 머신 친화 자산**이다.

## 왜 분리되어 있는가

`docs/context/*`와 `docs/orchestration/*`는 설계 의도와 규칙을 사람이 읽기 위한
문서인 반면(특히 `docs/context/orchestration.md`가 역할×Phase 매트릭스의 single source
of truth), `.vibe/agent/*`는 다음 세 가지 문제를 해결한다:

1. **Sprint 프롬프트 보일러플레이트 중복** — 6개 Sprint가 같은 "Rules / Verification /
   Final report" 섹션을 복붙. 공용 조각을 `_common-rules.md`로 추출하고 Planner가
   Sprint 프롬프트 생성 시 참조 링크 또는 inline include로 재사용.

2. **샌드박스 × Orchestrator 경계 모호성** — Codex `workspace-write` sandbox는 네트워크/
   파일 접근이 제한돼 `npm install` 같은 사전 작업을 Generator가 수행할 수 없다.
   역할 분담은 `_common-rules.md` §7에 흡수.

3. **Sprint 간 + 세션 간 상태 유실** — Sprint N이 만든 스모크 스크립트가 Sprint N+1에서
   "still pass"해야 한다. 동시에 context 압축/세션 종료 후 새 Orchestrator가 무손실 복구해야
   한다. 두 요구를 `sprint-status.json`(verificationCommands + handoff 필드) + `handoff.md`
   narrative가 함께 감당한다.

## 파일

| 파일 | 용도 |
|---|---|
| `_common-rules.md` | Sprint 프롬프트 공용 rules + 샌드박스 계약 + Final report 형식 일체. Planner가 Sprint 프롬프트 조립 시 참조. |
| `sprint-status.schema.json` | Sprint 누적 상태 + handoff 필드 JSON Schema. 런타임 인스턴스는 `.vibe/agent/sprint-status.json`. |
| `handoff.md` | Orchestrator의 무손실 상태 박제 (현재 스냅샷). 컨텍스트 압축 복구 시 최우선 읽기 대상. |
| `session-log.md` | Append-only 증분 저널. handoff가 놓치는 mid-session 결정/실패/발견을 보존. |
| `re-incarnation.md` | fresh Orchestrator 부팅 프로토콜 (읽기 순서, 체크포인트 규정, tripwire). |
| `../../scripts/vibe-preflight.mjs` | 새 Sprint 시작 전 기계적 체크(git/deps/provider/status/handoff staleness). |
| `../../scripts/vibe-agent-session-start.mjs` | Provider-neutral session start entrypoint. Claude/Codex/other CLI providers use it for session-start logging, harness version check, and model registry check. |
| `../../scripts/vibe-checkpoint.mjs` | PreCompact hook이 호출. handoff/session-log가 stale하면 압축을 block. |

## 버전

`schemaVersion: 0.1` — 실험적. 한 번 더 dogfood한 뒤 안정화 여부 결정.
