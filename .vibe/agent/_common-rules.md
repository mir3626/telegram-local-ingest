# Sprint 공용 규칙 (프롬프트 조각)

> **사용법**: Planner는 Sprint 프롬프트를 생성할 때 이 파일의 내용을 "Rules" 섹션 앞에
> 그대로 붙이거나, 프롬프트 상단에 `(공용 규칙은 `.vibe/agent/_common-rules.md` 준수)`
> 한 줄 포함 후 Sprint 고유 규칙만 추가한다. 중복을 피해 토큰 예산을 절약한다.

## 1. 샌드박스 우회 금지 (CRITICAL)

Generator가 샌드박스(예: Codex `workspace-write`) 안에서 실행 중이라는 이유로 **영구
설정 파일에 우회 코드를 남기는 것을 금지**한다. 샌드박스 전용 문제는 Generator가 해결할
책임이 없다. 발견 시 Orchestrator가 즉시 revert하며, Evaluator는 이를 자동 불합격 사유로
삼는다.

금지 예시:
- `next.config.ts`에 `experimental.webpackBuildWorker: false`, `workerThreads: true`
- `package.json` build 스크립트에 `--experimental-build-mode compile` (정적 생성 스킵)
- `tsconfig.json`에 `"skipLibCheck": true`를 샌드박스 회피용으로 추가
- webpack `externals`에 core 모듈 직접 등록

원칙: "샌드박스 안에서 통과 못 하는 빌드는 스킵하고 final report에 'sandbox-only
failure, escalate'라고 명시". 영구 파일을 건드리지 않는다.

## 2. 의존성 설치 금지

`npm install`, `pip install`, `cargo add` 등 **네트워크가 필요한 의존성 설치 명령을
Generator가 실행하지 않는다**. 필요한 패키지는 Sprint 프롬프트에 "이미 설치되어 있음"
또는 "Orchestrator가 사전 설치함"이라고 명시되어 있어야 한다. 없다면 Generator는 Final
report에 요구 패키지 목록을 남기고 코드 작성을 보류한다.

## 3. 수정 금지 목록 존중

각 Sprint 프롬프트의 "Do NOT modify" 목록을 엄격히 준수한다. 해당 파일을 수정해야만
체크리스트를 만족할 수 있다면, 코드 수정 대신 Final report에 "blocked by do-not-modify"
항목으로 보고한다.

## 4. 언어 / 품질 기준 (TypeScript 프로젝트 기본값)

- TypeScript `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` 전제.
- `any` 금지. 경계에서 `unknown` + 타입 가드.
- ESM 전용 — `require()` 금지.
- 주석/문서는 필요한 부분에만. 기존 코드에 장식용 주석 추가 금지.
- 테스트/에러 핸들링은 실제 필요한 범위에만 — 하이포세틱 시나리오 방어 금지.

## 5. 범위 준수

Sprint 체크리스트에 없는 "개선"/"리팩터"/"추가 기능"을 수행하지 않는다. 버그 발견 시
수정은 하되, 수정 범위를 체크리스트 관련 파일로 제한하고 Final report에 별도 항목으로
기록한다.

## 6. 최종 검증 출력

각 Sprint가 지정한 검증 명령을 전부 실행하고 exit code를 Final report에 표로 기록한다.
실행하지 않았거나 실패한 명령이 하나라도 있으면 "완료"라고 보고하지 않는다.

## 7. Sandbox × Orchestrator 계약 (구 sandbox-contract.md 흡수)

Generator는 보통 제한된 샌드박스(현재 기본: Codex `workspace-write`)에서 실행된다. 네트워크 차단 + 워크스페이스 외부 쓰기 금지 + 프로세스 수명 제한이 걸려 있다.

**역할 분담**:

| 단계 | Orchestrator (밖) | Generator (안) |
|---|---|---|
| Preflight | `git init`, 의존성 사전 설치, 환경변수 배치 | — |
| Planning | 체크리스트 생성, Sprint 프롬프트 조립 | — |
| Generation | 대기 | 코드 작성, 스모크 스크립트 추가, 자체 검증 |
| Light verify | 대기 | `tsc --noEmit`, smoke scripts |
| Heavy verify | `npm run build`, E2E, 네트워크 필요 검증 | — |
| Workaround revert | 샌드박스 우회용 영구 설정 발견 시 즉시 revert | — |
| Commit | Sprint 단위 커밋 | — |

**Generator Final report 필수 섹션** — "Sandbox-only failures". 샌드박스 제약 때문에 실행 못 한 명령/검증을 이 섹션에 기록하면 Orchestrator가 밖에서 대신 돌린다. §1(샌드박스 우회 금지)을 우회하기 위한 출구이기도 하다.

**Escalation** — Generator가 3회 이상 같은 샌드박스 에러로 실패하면 Orchestrator가 개입: (1) 밖에서 재현 → (2) 해결책 명시 후 재위임 또는 (3) 직접 수행 + Final report 기록.

## 8. 최소 테스트 요구

순수 함수(입력→출력) 로직이 있는 모듈은 **최소 1개의 스모크 테스트**를 포함한다.
테스트 파일은 `test/` 디렉터리에 `<module>.test.ts` 형식으로 생성한다.
UI/렌더링/DOM 의존 코드는 테스트 면제. 테스트를 작성하지 않은 모듈이 있다면
Final report의 Deviations에 이유와 함께 기록한다.

## 9. Final report 형식

Short markdown으로 아래 섹션을 순서대로 포함:

```markdown
## Files added
- path — 한 줄 설명

## Files modified
- path — 한 줄 설명

## Verification
| command | exit |
|---|---|
| npx tsc --noEmit | 0 |
| node scripts/xxx-smoke.mjs | 0 |

## Sandbox-only failures
- (sandbox 제약으로 실행 못 한 검증만 여기. 실제 실패는 Verification 표에 그대로 남김)

## Deviations
- (없으면 "none"; 있으면 이유와 함께 나열)
```

## 10. Sprint 프롬프트 작성자 경계 (Planner 책임)

Sprint 프롬프트 **본문은 Planner가 작성**한다. 즉 `docs/prompts/sprint-NN-*.md` 의 "생성할 파일 / 수정할 파일 / 타입 정의 / 함수 시그니처 / 동작 규약 / 테스트 요구사항 / 완료 체크리스트" 섹션은 매 Sprint 시작 시 소환된 Planner subagent의 fresh context 산출물이다.

Orchestrator가 허용되는 **메타 편집** 범위 (본문 재작성 X):
- scope expansion 헤더 prepend (예: `# SCOPE EXPANSION: aria-label 체크리스트 커버리지를 위해 ... 추가 허용` 한 블록)
- 의존성 선행 설치 공지 prepend (예: `# NOTE TO GENERATOR: 요구 devDeps는 Orchestrator가 사전 설치함`)
- 직전 Sprint 결과 2~3줄 요약 첨부 (새 Sprint 프롬프트 맨 앞)
- 포맷 보정 (마크다운 렌더링 깨짐 수정 등)

Orchestrator가 본문을 **직접 작성**하는 것은 다음 예외 상황에서만 허용되며, session-log에 `[decision]` 태그로 사유 기록:
- 🟢 Sprint 가 trivial (패턴 직접 계승 + 새 아키텍처 결정 없음 + 체크리스트 ≤3 항목) 이고 사용자가 "간소화" 명시. **반드시** `node scripts/vibe-planner-skip-log.mjs <sprintId> <reason>` 으로 session-log 에 `[decision][planner-skip]` 태그 기록 (수동 편집 금지). LOC 기준은 제거됨 (gameable).
- 🟡 Planner 소환이 2회 연속 실패(타임아웃 / 에러 반환) 후 사용자가 fallback 승인

어느 예외든 발동 시 **자동으로 Evaluator Should 트리거**로 간주한다 (작성자=평가자 우려 완화를 위해 Evaluator를 강제 소환). CLAUDE.md 트리거 매트릭스의 예외 조건과 충돌 시 이 규칙이 우선.

## 11. 역할 × Phase 상위 참조

본 파일은 Sprint **내부** 공용 규칙. Orchestrator / Planner / Generator / Evaluator의 **Phase 단위** 책임 분리 상세는 `docs/context/orchestration.md` 에 있다. 모순 발생 시 `orchestration.md` 가 우선한다.

## 12. Sprint 완료 단일 커밋 원칙 (v1.1.1+)

Sprint 마무리 시퀀스:

1. Generator report 수신
2. Orchestrator 샌드박스 밖 재검증 (tsc / test / build)
3. Orchestrator self-QA 통과 (체크리스트 대조)
4. `node scripts/vibe-sprint-complete.mjs <sprintId> passed` 실행 → state 파일 3종(`sprint-status.json` / `handoff.md` / `session-log.md`) 자동 갱신 (자동 커밋 X)
5. **단일 `git commit`**: Generator feature 파일 + state 3종을 한 번에 `git add` 후 commit
6. `git push origin <branch>`

### 규율

- **별도 `docs(sprint): close ...` 커밋 만들지 않는다.** main history 노이즈 감소 목적.
- 커밋 메시지 끝에 `LOC +A/-D (net N)` 한 줄 요약 권장 (`vibe-sprint-complete`이 이미 session-log에 기록해 둔 값 재사용).
- Revert·cherry-pick 시 Sprint 1건 = 1커밋 단위로 처리되어 깔끔.

### 예시 커밋 메시지

```
feat(game): whisper state machine + sprint-02 close

Sprint 2 Generator 산출 — WhisperHintState 전이 함수 (reveal/hide/apply),
승리 판정 checkVictory, 퍼즐 API 스텁 + 2개 샘플 퍼즐. rules.ts에
whisper 통합 + victory 체크. 테스트 +23 (총 72 pass).

LOC +350/-12 (net +338), 7 files.
```

### 예외 / 전환 기간

- **v1.1.1 이전** 히스토리의 `docs(sprint): close ...` 커밋은 그대로 보존 (rebase 금지).
- Sprint 내 **긴급 hotfix commit** 이 중간에 끼어야 하는 경우엔 단일 커밋 원칙 면제. session-log에 이유 기록.
- Generator가 BLOCKED 로 정지하고 scope expansion 으로 재위임한 경우, 각 재시도를 별도 커밋 남기지 않고 최종 성공 산출만 단일 commit에 포함.

## 13. Sandbox-bound Generator invariants

Generator (현 Codex / 향후 다른 provider 도 해당) 는 공급자·모델과 무관하게 다음 명령을 샌드박스 내에서 실행하지 않는다. 하네스가 보장하는 Generator 의 책임 ceiling 은 "파일 작성 + 정적 분석 + self-contained 단위 smoke" 까지다. 그 너머는 Orchestrator 가 샌드박스 밖에서 수행할 post-handoff 검증 영역이다.

### 13.1 Generator MUST NOT attempt

- **패키지 매니저 네트워크 설치**: `npm install`, `npm ci`, `pnpm install`, `yarn`, `pip install`, `pipx install`, `cargo add`, `cargo install`, `go get`, `apt-get install`, `brew install` 등. (§2 중복 강조 — provider-agnostic 재언급.)
- **Integration / E2E / property 테스트 러너**: `vitest run` (watch 모드 제외), `jest --runInBand`, `pytest` (단위 스모크 아닌 전체 디렉토리), `cargo test` (release 프로파일), `go test ./...`, `playwright test`, `cypress run`.
- **프로덕션 빌드**: `vite build`, `webpack --mode production`, `next build`, `cargo build --release`, `go build -ldflags` (배포용 최적화), `tsc -p tsconfig.build.json` (빌드 산출 생성 목적), `pyinstaller`, `docker build`.
- **브라우저 / 실제 런타임 smoke**: Playwright / Puppeteer headed 혹은 headless, Selenium, Electron headed, devtools 연결.
- **장기 실행 watch**: 위 러너의 `--watch` 형태 포함 (프로세스 미종료로 Sprint 지연).

### 13.2 Generator responsibility ceiling (MAY do)

- 정적 타입 체크: `tsc --noEmit`, `mypy <path>`, `ruff check`, `cargo check`, `go vet`, `pyright` (network-free 버전), `eslint . --quiet` (로컬 설정 범위).
- Self-contained 단위 smoke: `node --experimental-strip-types test/foo.test.ts` 형태, `pytest tests/unit/test_foo.py -k single`, `cargo test --lib <module>` (단일 모듈). 외부 네트워크 / DB / 브라우저 의존 0.
- 생성된 스모크 스크립트를 한 번 실행해 exit 0 확인.

### 13.3 Orchestrator post-handoff verifications

Generator report 를 받은 뒤 Orchestrator 가 샌드박스 밖에서 수행:

- 전체 테스트 (`npm test`, `pytest`, `cargo test` 등)
- 프로덕션 빌드 + bundle size 게이트 (M7 이후)
- 브라우저 smoke (M7 이후)
- E2E / integration (`playwright test`, `cypress run`)
- `npm install` 을 포함한 네트워크 설치
- 런타임 배포 smoke (dev 서버 기동 포함)

### 13.4 근거 (왜 이 분리인가)

- Generator 샌드박스 는 네트워크 차단 + 프로세스 시간 제한 + 워크스페이스 외부 쓰기 금지. 위 "MUST NOT" 명령은 거의 필연적으로 이 제약에 부딪혀 **Generator 가 우회 패치를 남기거나 (§1 위반) 혹은 반복 실패로 Sprint 를 지연** 시킨다.
- Orchestrator 는 하네스 host 환경에서 제약 없이 실행 가능하며, 실패 시 Sprint 를 BLOCKED 로 리턴하고 Planner/Evaluator 를 소환해 적절히 분기한다.
- 본 섹션은 §1 (샌드박스 우회 금지) / §2 (의존성 설치 금지) / §7 (Sandbox × Orchestrator 계약) 의 단편들을 **명령 레벨 whitelist/blacklist** 로 구체화한 것이다. 충돌 시 §1/§2/§7 원칙이 우선.

## § Stack-specific pattern shards (mandatory read)

Sprint Planner must parse the `VIBE:TEST-PATTERNS` and `VIBE:LINT-PATTERNS` marker blocks in `docs/context/conventions.md` before writing a Sprint prompt.
Every linked shard is mandatory context for the prompt sections that describe test strategy and quality gates.
If the marker blocks are absent, Planner may skip shard loading only for a brand-new project and must record `[decision][no-pattern-shards]` once in `session-log.md`.

## §14 Wiring Integration Checklist — dead weight / silent drift 방지

반복된 dogfood 리뷰에서 동일 패턴이 재발했다: **Codex 가 파일을 생성했지만 그 파일을 실제로 호출·참조하는 wiring 을 빠뜨려 dead code 가 되거나, 관련 문서·매니페스트·훅 중 일부만 업데이트되어 silent drift 발생**. 본 섹션은 이 패턴을 방지하기 위한 **모든 Sprint 의 필수 체크리스트**다.

### §14.1 신규 파일·스크립트·스킬 추가 시 — 모든 체크포인트 명시 처리

아래 목록 각 항목에 대해 Final report 의 **"## Wiring Integration"** 섹션에 `touched / n/a / skipped+reason` 중 하나로 상태 보고.

| # | 체크포인트 | 적용 조건 |
|---|---|---|
| W1 | `CLAUDE.md` §훅 강제 메커니즘 테이블 행 추가 | 신규 `scripts/vibe-*.mjs` 또는 `run-*.{sh,cmd}` 추가 시 |
| W2 | `CLAUDE.md` §관련 스킬 list + 한 줄 설명 추가 | 신규 슬래시 커맨드 / `.claude/skills/*` 추가 시 |
| W3 | `CLAUDE.md` §Sprint flow 번호 업데이트 | Sprint 사이클 절차 변경 시 |
| W4 | `.claude/settings.json` hook 등록 (SessionStart / Stop / PreToolUse / PostToolUse / Notification / PreCompact) | 이벤트 기반 스크립트 추가 시 |
| W5 | `.claude/settings.json` statusLine 등록 | 상태바 렌더 변경 시 |
| W6 | `.vibe/sync-manifest.json` `files.harness[]` 등록 | 신규 하네스 파일 (스크립트·스킬·lib·agent·schema 등) |
| W7 | `.vibe/sync-manifest.json` `files.hybrid{}.harnessKeys` 확장 | 기존 json-deep-merge 파일 (settings.json / package.json / config.json 등) 에 신규 top-level key 도입 시 |
| W8 | `README.md` 사용자 가시 섹션 추가 | npm script / 슬래시 커맨드 / 사용자 대면 기능 |
| W9 | `package.json` `scripts.vibe:*` 엔트리 추가 | `npm run` 호출 필요 시 |
| W10 | `docs/release/vX.Y.Z.md` 누적 기록 | 모든 기능 추가 / 변경 |
| W11 | `migrations/X.Y.Z.mjs` idempotent 마이그레이션 + `sync-manifest.migrations` 맵 등록 | schema / state file 구조 변경 시 |
| W12 | `test/*.test.ts` 회귀 방지 테스트 (신규 파일 당 최소 1개) | 테스트 가능한 로직 추가 시 |
| W13 | `docs/context/harness-gaps.md` 관련 gap status 갱신 (open → covered / partial → covered) | 기존 gap 을 해결하는 기능 추가 시 |
| W14 | `.gitignore` 런타임 artifact 등록 | PID / cache / 로그 파일 생성되는 스크립트 추가 시 |

### §14.2 파일·스크립트·스킬 삭제 또는 이름변경 시 — 참조 완전 제거

| # | 체크포인트 |
|---|---|
| D1 | 워크스페이스 전체 `rg <old-name>` 으로 grep → 발견된 모든 참조 업데이트 또는 제거 |
| D2 | `CLAUDE.md` / `README.md` / `.claude/settings.json` / `.claude/skills/*/SKILL.md` / `.vibe/sync-manifest.json` / `.vibe/agent/*.md` / `docs/context/*.md` 각각 개별 점검 |
| D3 | `.claude/agents/<name>.md` 삭제 시: `subagent_type: '<name>'` 사용처 모두 교체 (new name 또는 대체 호출 패턴) |
| D4 | `package.json` scripts / `.claude/settings.json` hooks 에서 참조 제거 |
| D5 | `migrations/X.Y.Z.mjs` 에 "file removed/relocated" 처리 로직 (downstream sync 시 orphan 방지) |
| D6 | `.gitignore` 에 있던 관련 경로 정리 (여전히 필요한지 확인) |

### §14.3 Dead weight 방지 원칙

1. **"미래 대비 placeholder / stub"** 금지. 실 호출처 없는 신규 파일은 본 Sprint 에서 생성하지 않는다. 필요 시 Sprint 분할.
2. 신규 파일 마다 Final report 에 `verified-callers: [<경로1>, <경로2>]` 명시 — grep 으로 확인된 실제 호출·import·hook 등록 지점.
3. "정의만 있고 호출 0" 파일이 리뷰에서 발견되면 dead weight 로 간주, 다음 Sprint 에서 제거 대상.

### §14.4 Final report 에 필수 포함

`## Wiring Integration` 섹션을 Final report 에 반드시 포함. 미포함 시 Orchestrator 가 Sprint 를 incomplete 로 간주하고 Codex 재위임.

```markdown
## Wiring Integration

| Checkpoint | Status | Evidence |
|---|---|---|
| W1 CLAUDE.md hook 테이블 | touched | CLAUDE.md:86 |
| W2 CLAUDE.md 관련 스킬 | n/a | 신규 슬래시 커맨드 없음 |
| W6 sync-manifest harness[] | touched | sync-manifest.json:103 |
| W12 test 회귀 방지 | touched | test/foo.test.ts |
| D1 rg <old-name> 결과 | touched | 4개 참조 교체 (CLAUDE.md / README.md / SKILL.md 2건) |
| ... | ... | ... |

verified-callers:
- scripts/vibe-foo.mjs → CLAUDE.md:86 훅 테이블 / .claude/settings.json:70 PostToolUse
```

### §14.5 근거

이전 하네스 업그레이드 (v1.2.0 → v1.3.1) 전체 회고에서 반복된 패턴:
- M9 `statusline.sh` 스크립트 생성 → settings.json statusLine 등록 **누락** → 사용자가 Claude Code 내장 indicator 만 보게 됨 (v1.3.1 뒤늦게 fix)
- M12 `/vibe-iterate` + `vibe-project-report.mjs` 생성 → CLAUDE.md 관련 스킬 / hook 테이블 **누락** → Orchestrator 가 자기 존재 모름 (v1.3.1 fix)
- M2 `run-claude.{sh,cmd}` "future provider" stub 생성 → 실 호출처 0 → dead weight (v1.3.1 삭제)
- M10 `harnessVersion` bump → git tag 자동 생성 **누락** → downstream `vibe:sync` 실패 (v1.3.1 retroactive tag)
- M1 `archiveSprintPrompts` regex 버그 → M1~M12 아카이빙 전량 실패, 20개 orphan 누적 (v1.3.1 fix)

본 §14 체크리스트는 위 5개 사례 모두 사전 차단한다. **Codex 출력물에 `## Wiring Integration` 섹션 없으면 Sprint 미완료.**

## §15 Scope discipline (unit test 생성 금지 default)

Planner prompt 가 명시적으로 unit test 파일 생성을 요구하지 **않는 한**, Generator 는
`test/**/*.test.ts`, `src/**/*.test.ts`, `__tests__/` 디렉터리 등 unit test 파일을
스스로 만들지 않는다. Test 가 필요하다고 판단되면 Final report `## Wiring Integration`
섹션의 W12 에 "propose: test file X — blocked by §15" 로 기록만 남기고 stop.

이 규칙은 프로토타입/MVP 가 명시적으로 smoke + type check 만으로 충분하다고 선언한
conventions.md 의 테스트 섹션을 Generator 레벨로 hoist 한 것이다. 해제는 Planner 가
"Tests to add: [...]" 섹션을 Sprint prompt 에 명시했을 때만.
