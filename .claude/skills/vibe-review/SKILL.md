---
name: vibe-review
description: 주기적 프로세스 리뷰 드래프트 생성
---

이 스킬은 Orchestrator가 주기적 프로세스 리뷰를 재현 가능하게 작성할 때 사용한다.
리뷰를 시작할 때 아래 입력을 먼저 로드하고, 같은 입력 집합을 기준으로 findings를 만든다.

## Protocol

1. 먼저 helper를 호출해 기본 입력을 수집한다.

```bash
node --import tsx -e "import { collectReviewInputs, detectOptInGaps } from './src/lib/review.ts'; const inputs = await collectReviewInputs(); const config = (await import('./.vibe/config.json', { with: { type: 'json' } })).default; const issues = detectOptInGaps(config, { productText: inputs.productText, sessionLogRecent: inputs.recentSessionEntries }); console.log(JSON.stringify({ inputs, issues }, null, 2));"
```

2. 자동 로드 입력:
   - `.vibe/agent/handoff.md` 전체
   - `.vibe/agent/session-log.md` 최근 N entries
     - 기본값 `50`
     - `.vibe/config.json.review.recentEntries` 있으면 그 값 사용
   - `git log --oneline`
     - 기본값 최근 `20` commits
     - 최신 `review-*.md` 가 있으면 그 리뷰 이후 범위를 우선 사용
   - `.vibe/agent/sprint-status.json` 의 `pendingRisks` 중 `open` 상태만
   - `.vibe/agent/project-decisions.jsonl` 전체
   - `docs/context/harness-gaps.md` 전체
   - `.vibe/archive/rules-deleted-*.md` + `.vibe/audit/iter-*/rules-deleted.md` pending 복원 결정 목록

3. 출력 파일 경로:
   - `docs/reports/review-<sprintCount>-<YYYY-MM-DD>.md`
   - `<sprintCount>` 는 `sprint-status.json.sprints.filter(s => s.status === 'passed').length`

## Rubric

Primary metric = **dogfood friction incident count per sprint** + **delivered product feature count**.

- 🔴 Blocker — sprint 당 friction incident ≥ 3 발생 또는 product delivery 차단
- 🟡 Friction — sprint 당 friction incident 1~2, 사용자/Orchestrator 우회 반복
- 🟢 Polish — friction 0 이지만 UX/문서 개선 여지
- 🔵 Structural — friction 잠재 + 장기 유지보수 축 영향

`uncovered rule` 수와 open harness gap 수는 secondary signal 로만 사용한다. 단,
`openHarnessGapCount > 0` 이면 기존처럼 최소 1개 finding 에 ledger 상태를 근거로 연결한다.

## Findings Format

각 finding 은 Markdown 표가 아니라 아래 YAML 블록 + 설명 bullet 로 작성한다.

```yaml
- id: review-<slug>
  severity: blocker|friction|polish|structural
  priority: P0|P1|P2|P3
  proposal: 1~2문장 요약
  estimated_loc: number
  proposed_sprint: 다음 M번호 또는 "backlog"
```

설명 bullet 에는 왜 이 이슈가 지금 relevant 한지 근거만 짧게 적는다.

## Automatic Checks

- `detectOptInGaps()` 를 호출해 M7 opt-in 누락을 먼저 시드한다.
- `pendingRestorations.length > 0` 이면 각 entry 당 `🟡 Friction` finding 을 자동 seed 한다.
  - `id: review-pending-restoration-<ruleSlug>`
  - `proposal: '<title>' 복원 여부 결정 필요 (tier=<tier>, reason=<reason>, source=<file>)`
  - `estimated_loc: 0`
  - `proposed_sprint: 'backlog'`
- `.vibe/config.json.bundle.enabled === false` 이고 `product.md` 또는 interview seed 의 platform 이 `web|mobile|browser` 를 포함하면:
  - 🟡 Friction entry
  - `proposal: "frontend 프로젝트인데 bundle-size gate 가 opt-in 되지 않음"`
- `.vibe/config.json.browserSmoke.enabled === false` 이고 같은 platform 조건이면:
  - 🟡 Friction entry
  - `proposal: "frontend 프로젝트인데 browser smoke gate 가 opt-in 되지 않음"`
- 최근 session-log entries 안에 `[decision][phase3-utility-opt-in]` 가 있으면 위 두 entry 는 skip 한다.
- `docs/context/harness-gaps.md` 의 `status=open` 개수를 집계해 findings 에 반영한다.
  - open gap 이 0이 아니면 최소 1개 finding 에 ledger 상태를 근거로 연결한다.
- `wiringDriftFindings.length > 0` 이면 각 entry 당 `🔴 Blocker` finding 을 auto-seed 한다.
  - `id: review-wiring-drift-<artifact basename>`
  - `proposal: '<artifactPath>' 가 생성됐지만 runtime reference 또는 sync manifest wiring 이 누락됨`
  - `estimated_loc: 20`
  - `proposed_sprint: 'backlog'`

### Adapter-health blind-spot (🔴 Blocker)

프로젝트에 `app/api/*/route.ts` 또는 동등한 데이터 fetcher 경로 (`productFetcherPaths`
non-empty) 가 존재하고 `e2e/` / `playwright.config.*` 기반 smoke 가 있음에도, smoke
파일이 **각 route 의 응답 (items 배열 / status code) 을 개별 assertion 하지 않으면**
🔴 Blocker finding 1건을 auto-seed 한다.

- 판정 로직: `productFetcherPaths` 의 각 경로 basename (예: `geeknews`, `dcinside`) 을
  e2e smoke 파일 내용에서 **string 으로 1회 이상 등장** 하는지 grep. 매칭 없으면 해당
  adapter 는 "probe 되지 않음" 으로 간주.
- Finding 문구: "adapter <name> 이 소리 없이 0 items 반환해도 smoke 가 통과하는 상태는
  production broken feature 를 의미함 — probe-based assertion 또는 contract test 필요."
- 완화 (false-positive 회피): adapter 가 **의도적으로 mock-only** 이거나 platform 이
  web 이 아니면 (`productText` platform grep) seed 하지 않는다.

## Report Shape

출력 문서는 아래 섹션을 순서대로 포함한다.

1. `## Inputs loaded`
   - 어떤 파일과 commit 범위를 읽었는지 기록
2. `## Findings (severity desc)`
   - severity 순서: blocker -> friction -> structural -> polish
3. `## Suggested next-sprint scope`
   - 다음 Sprint 후보 scope 를 2~5개 bullet 로 압축
4. `## Links`
   - 참조한 handoff, session-log, latest review, harness-gaps 경로

## Notes

- review 는 사람이 읽는 문서지만 입력 재현성 우선이다. 감상 대신 evidence 를 적는다.
- finding 이 없더라도 `## Findings` 에 `none` 을 쓰지 말고 residual risk 를 1~2줄 적는다.
- helper 가 반환한 입력 밖의 자료를 추가로 읽었다면 `## Inputs loaded` 에 명시한다.
