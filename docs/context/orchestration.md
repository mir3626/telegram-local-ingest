# Orchestration — 역할 × Phase 매트릭스 (single source of truth)

> 이 문서는 **Orchestrator / Planner / Generator / Evaluator의 책임을 Phase별로 분리**한다. 매 세션 시작 시 Orchestrator가 숙지해야 하며, 모순 발생 시 이 문서가 CLAUDE.md 트리거 매트릭스 위에 있다.

## 1. 핵심 원칙

### 1.1 왜 sub-agent인가

Sub-agent는 **specialization이 아니라 context checkpoint 메커니즘**이다. 무한 컨텍스트 윈도우가 있다면 Orchestrator 하나로 충분하다. 현실에서 context 압축·누적이 품질을 조용히 파괴하기 때문에, 독립된 fresh 윈도우로 체크포인트를 만드는 것이 sub-agent의 진짜 가치다.

### 1.2 Context 소유자 매칭

**가장 풍부한 맥락을 보유한 에이전트가 그 결정을 내려야 한다**:

- **Phase 0 인터뷰 직후의 product 맥락** → Orchestrator가 가장 풍부 → **Sprint 로드맵 분할은 Orchestrator**
- **매 Sprint 시작 시점의 fresh context** → Planner 신규 소환이 가장 격리 → **Sprint 기술 사양 + 프롬프트 초안은 Planner**
- **Sprint 내부 코딩 context** → Generator 소환이 격리 수단 + 역할 제약이자 상수 → **모든 소스코드는 Generator**
- **독립 검증 context** → Evaluator 신규 소환 (작성자 ≠ 평가자) → **합격/불합격 판정은 Evaluator (트리거 시)**

### 1.3 Orchestrator의 고유 책임

- Phase 생명주기 관리 (0 / 1 / 2 / 3 / 4 / Sprint 반복)
- 네이티브 인터뷰 진행 (사용자와 대화 또는 PO 대행)
- Sprint 로드맵 분할 (`docs/plans/sprint-roadmap.md`)
- Sprint 간 상태 유지 (sprint-status.json / handoff.md / session-log.md)
- Sub-agent 소환 판정 (트리거 매트릭스 평가)
- 샌드박스 밖 검증 (Codex 샌드박스가 차단하는 명령들)
- 문서(.md) 및 설정(.json/.yaml/.toml) 직접 편집
- 사용자 소통 (질문/승인/에스컬레이션)
- 최종 보고서 작성 (`docs/reports/`)

## 2. 역할 요약

| 역할 | 모델 / 도구 | 상주 여부 | 컨텍스트 특성 | 책임 |
|---|---|---|---|---|
| **Orchestrator** | Claude Opus (메인 대화) | 상주 | 세션 전체 누적 | Phase 생명주기, 인터뷰 진행, Sprint 로드맵, 상태 유지, sub-agent 소환, 사용자 소통 |
| **Planner** | Claude Opus (Agent 도구, model: "opus") | Sprint 내 | **매 Sprint fresh** | Sprint 기술 사양(타입·시그니처·파일 구조) + 프롬프트 초안 + 완료 체크리스트 |
| **Generator** | Codex CLI (`./scripts/run-codex.sh -`) | Sprint 내 | **매 호출 fresh** | 모든 소스코드 작성/수정 (.ts/.tsx/.py/.js/.mjs/.sh/.css 등) |
| **Evaluator** | Claude Opus (Agent 도구, model: "opus") | Sprint 내 (트리거 시) | **매 소환 fresh** | 체크리스트 기반 합격/불합격 + 사유 리포트 |

## 3. Phase × 역할 매트릭스

| Phase | Orchestrator | Planner | Generator | Evaluator |
|---|---|---|---|---|
| **Phase 1** 환경 점검 | ○ 실행 (`/vibe-init` Phase 1, `vibe-preflight`) | — | — | — |
| **Phase 2** provider 선택 | ○ 실행 (`/vibe-init` Phase 2) | — | — | — |
| **Phase 3** 네이티브 인터뷰 | ○ **PO 대행 포함 완주** (스킵 금지) | — | — | — |
| **Phase 3'** context shards 생성 (seed 변환) | ○ (product/architecture/conventions.md) | — | — | — |
| **Phase 4** git init + 요약 | ○ | — | — | — |
| **Phase 5** Sprint 로드맵 분할 | ○ **Must — Planner 위임 금지** | — | — | — |
| **Sprint N** 기술 사양 + 프롬프트 초안 | 위임만 (메타 편집 허용) | ○ **매 Sprint Must** | — | — |
| **Sprint N** 코드 구현 | 위임만 (메타 편집 금지) | — | ○ | — |
| **Sprint N** 검증 (tsc/test/build) | ○ self-QA | — | — | 트리거 시 ○ |
| **Sprint N** 마무리 (`vibe-sprint-complete`) | ○ | — | — | — |
| **Sprint 간** 상태 유지 (handoff/session-log/status.json) | ○ | — | — | — |

## 4. Phase 0 — 프로젝트 최초 1회 상세

### 4.1 흐름

```
Phase 1 환경 점검
  ↓
Phase 2 provider 선택 (fast-path: 사용자 "기본" → 즉시 확정)
  ↓
Phase 3 네이티브 인터뷰 (`scripts/vibe-interview.mjs`)
  ↓ (사용자 답변 / PO 대행)
  └─ 모호성 점수 ≤ 0.2 수렴까지 반복
  ↓
Phase 3' seed → product.md / architecture.md / conventions.md
  ↓
Phase 4 git init + 초기 커밋
  ↓
Phase 5 Orchestrator가 Sprint 로드맵 분할 → docs/plans/sprint-roadmap.md
  ↓
vibe-preflight --bootstrap → exit 0
```

### 4.2 PO 대행 모드 규율

사용자가 "자율 진행", "위임", "알아서" 등을 지시한 경우:

1. 네이티브 인터뷰를 **스킵하지 않는다** (인터뷰 flow 자체가 숨겨진 가정을 드러내는 강제 장치).
2. Orchestrator가 `scripts/vibe-interview.mjs`를 정상 호출.
3. 질문이 반환되면 Orchestrator가 PO 관점에서 답변 판단.
4. **Phase별 rationale 요약 1회** — 인터뷰 종료 직후 session-log에 다음 형식으로 append:
   ```
   - YYYY-MM-DDTHH:mm [decision][phase3-po-proxy] {Phase 3 종료 요약}.
     핵심 답변 N개 rationale: (1) ... (2) ... (3) ...
     최종 모호성 점수: 0.XX. 주요 미정 항목: ... (또는 "none").
   ```
5. product.md 끝에 `## Phase 3 답변 기록 (PO 대행)` 섹션으로 Q/A 전체 덤프.

**로그 폭증 방지**: 답변마다 개별 기록 X, Phase 종료 1회 요약 O. (dogfood 반복으로 수치 조정 예정.)

### 4.3 Sprint 로드맵 분할 규율

Orchestrator 단독 작성. 각 entry 필드:

```markdown
## Sprint N — {name}

- **id**: sprint-NN-{slug}
- **한 줄 목표**: ...
- **의존**: Sprint M 완료 후 (없으면 "없음")
- **예상 LOC**: ~N00 (코드) + ~N00 (테스트)
- **핵심 산출물**: 파일 목록 (Planner가 구체화)
- **완료 판정 거시 기준**: 이 Sprint가 끝나면 무엇이 동작해야 하는가
```

파일 경로는 `docs/plans/sprint-roadmap.md`. 매 Sprint 시작 시 Planner에게 해당 slot만 전달.

## 5. 매 Sprint 반복 상세

### 5.1 Planner 소환 입력 — 권장 템플릿

```
입력 파일:
- docs/context/product.md
- docs/context/architecture.md
- docs/context/conventions.md
- docs/plans/sprint-roadmap.md §(Sprint N 해당 slot)
- (이전 Sprint 결과 2~3줄 요약, 또는 handoff.md §3 완료 이력 발췌)

요구 산출:
1. 기술 사양 — 이 Sprint가 건드리는 타입/함수 시그니처/파일 목록
2. 완료 체크리스트 — 기계적 검증 가능한 항목만 (npx tsc --noEmit 통과 등)
3. Sprint 프롬프트 본문 — Generator에 바로 투입 가능한 자기완결 형식
   - 공용 규칙은 `.vibe/agent/_common-rules.md` 준수 선언
   - Files Generator may touch 목록 (체크리스트 항목 완전 커버리지 고려)
   - Do NOT modify 목록
   - Verification 명령
   - Sandbox-only failures 섹션 요구
4. 트리거 매트릭스 — 이 Sprint가 Evaluator Must/Should 대상인지 평가
```

### 5.2 Generator 위임 규율

- 단일 엔트리포인트: `cat docs/prompts/sprint-NN-*.md | ./scripts/run-codex.sh -`
- 추가 컨텍스트 prepend는 헤더 한두 줄로만 (scope expansion, deps 상태 안내 등)
- Agent 도구로 코드 위임 금지 (Claude가 실행됨)

### 5.3 Orchestrator self-QA

- 샌드박스 밖에서 `cmd //c "npm run typecheck && npm run test && npm run build"` 등 재검증
- Generator report의 "Sandbox-only failures" 섹션은 sandbox 탓인지 실제 실패인지 교차 확인
- 체크리스트 항목 × Generator 산출 × 재검증 결과를 매핑

### 5.5 Sprint 완료 단일 커밋 원칙 (v1.1.1+)

self-QA 통과 후 `vibe-sprint-complete` 실행 → 업데이트된 state 파일 3종을 Generator feature 파일과 **한 git commit에 묶는다**. 별도 `docs(sprint): close ...` 커밋 금지. 상세: `_common-rules.md` §12.

이유: main history 에서 실제 feature/fix/refactor 커밋과 state-only 메타 커밋이 뒤섞이면 변경 의미 추적이 어려워짐. 단일 커밋은 "Sprint X 작업 + 상태 스냅샷" 단위로 의미를 명확히 한다.

### 5.4 Evaluator 소환 (트리거 시)

- CLAUDE.md 트리거 매트릭스의 Must / Should 조건 평가
- 프로토타입 예외 적용 가능 여부 판단
- 소환 시 입력: 프롬프트 + 산출 diff + self-QA 결과
- 산출: 합격/불합격 + 사유 리포트 → 불합격 시 스펙/구현 문제 분류

## 6. Escalation 경로

```
Orchestrator self-QA 실패
  ↓
Evaluator 소환 (Tribunal)
  ↓
불합격 원인 분석
  ├─ 스펙 문제 → Planner 재소환 → 체크리스트 수정 → Sprint 재실행
  └─ 구현 문제 → Generator 재위임 (구체 수정 지시)
  ↓
2회 연속 불합격 → 사용자 에스컬레이션
  (스펙 축소 / 기술 스택 변경 / 수동 개입 중 선택)
  ↓
최종 결과 + 사유 → docs/reports/에 기록
```

## 7. 안티 패턴 — 피해야 할 조합

| 잘못된 방식 | 왜 잘못인가 | 대신 |
|---|---|---|
| 전체 Sprint 로드맵을 Planner가 생성 | Planner는 fresh context로 인터뷰 맥락 없음. 로드맵 품질 ↓ | Orchestrator가 인터뷰 직후 작성 |
| Sprint 2~N 프롬프트를 Orchestrator가 직접 작성 | 누적 context 오염으로 Sprint 간 일관성 ↓. 이전 Sprint 구현 세부 무의식 침투 | 매 Sprint 앞에 Planner 재소환 |
| "자율 진행" → 네이티브 인터뷰 스킵 | 숨겨진 가정 발견 장치 우회. 재현성 ↓ | PO 대행으로 인터뷰 완주 |
| Sprint 프롬프트 본문을 Orchestrator가 작성 | 재현성 훼손 + 역할 경계 흐림 | Planner가 본문 작성, Orchestrator는 메타 편집만 |
| Codex 샌드박스 실패를 본 실패로 오인 | sandbox-only vs real failure 혼동 → 불필요한 재위임 | Orchestrator 샌드박스 밖 재검증으로 분리 |
| Evaluator Must 트리거인데 프로토타입 예외 적용 | 품질 게이트 무력화 | Must는 예외 없이 소환 |

## 8. 안전장치 — 이 문서의 참조 경로

이 문서가 누락되지 않도록 여러 레이어에 링크가 박혀 있다:

- **`CLAUDE.md`** §"필요할 때만 읽을 문서" (Orchestrator 필수 숙지 명시)
- **`CLAUDE.md`** §trigger-matrix 말미 (상세 포인터)
- **`.vibe/sync-manifest.json`** — harness 리스트에 `docs/context/orchestration.md` 등록 → `vibe:sync`로 downstream 프로젝트에 자동 배포
- **`.vibe/agent/re-incarnation.md`** Boot sequence에서 참조 (향후 업데이트 시 포함)
- **`.vibe/agent/README.md`** 파일 목록 언급
- **`scripts/vibe-preflight.mjs`** — 파일 존재 체크 (향후 code 확장 예정)

업데이트 시: 이 문서와 CLAUDE.md의 매트릭스가 서로 모순되지 않도록 동시 수정한다. 모순 발견 시 `docs/context/orchestration.md`가 우선.
