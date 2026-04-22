---
name: vibe-init
description: 프로젝트 초기 세팅을 대화형으로 진행합니다. 환경 점검, provider 인증, 프로젝트 맞춤 설정까지 자동으로 안내합니다.
---

이 스킬은 프로젝트 초기 세팅을 Claude Code 대화형으로 진행합니다.
총 4단계(Phase 1~4)로 구성되며, 각 Phase를 순서대로 진행합니다.

> **용어 정리**: CLAUDE.md 의 "Phase 0 — 프로젝트 최초 1회" 는 이 Phase 1~4 전체를
> 묶는 umbrella term 입니다. 개별 sub-step 은 "Phase N Step N-M" 로 표기합니다
> (예: Sprint 로드맵 작성 = Phase 3 Step 3-5). "Phase 0" 을 개별 task 이름으로
> 사용하지 마십시오 (naming 혼란 방지).

---

## Phase 1 — 환경 점검 (doctor)

### Step 1-0: 세션 진행 모드 확인 (CRITICAL — 환경 점검 전에 선행)

이번 세션에서 프로젝트를 **사람이 주도**할지 **에이전트가 주도**할지를 먼저 확인합니다.
이후 모든 Phase 의 interactivity / fast-path / PO-proxy 기본값이 이 선택에 연동됩니다.

질문:

```
이번 세션에서 이 프로젝트를 어떤 방식으로 진행할까요?

  1. human (기본) — 사람이 각 단계 질문에 직접 답하고 승인합니다.
  2. agent — 에이전트가 초기 prompt 를 분석하여 모든 단계를 자동으로 진행합니다.
```

선택 결과는 `.vibe/config.json` 의 `mode` 필드에 기록합니다 (값: `"human"` 또는 `"agent"`).
답을 얻지 못하면 기본값 `"human"` 으로 진행합니다.

- `mode=human`: Phase 2 Fast-path 은 사용자가 "기본" 등으로 답했을 때만 활성. Phase 3 는 사용자 상호작용 기본. Step 1-1 로 진행.
- `mode=agent`: **아래 Step 1-0-agent 분기 로 이동** — 본 `/vibe-init` 세션은 agent delegation prompt 를 터미널에 출력한 뒤 즉시 종료. 사용자가 출력된 prompt 를 새 Claude Code 세션에 copy-paste 하면 그 새 세션의 agent 가 Phase 2~4 를 자율 진행한다.

---

### Step 1-0-agent: mode=agent 선택 시 분기 (CRITICAL)

Step 1-0 에서 사용자가 `agent` 를 선택하면 다음을 순차 수행:

1. **ONE_LINER 질문**:

   ```
   무엇을 만들고 싶은지 한 줄로 정의해주세요.
   (예: "커맨드라인 가계부 도구 — 태그별 월간 요약 + 일일 지출 cap 경고")
   ```

   사용자 답변을 `<ONE_LINER>` 변수로 저장.

2. **template 로드 + placeholder 치환**:

   `.claude/templates/agent-delegation-prompt.md` 를 Read. 파일 내부의 "이 아래부터가 실제 agent 에게 전달되는 prompt 본문이다" 이후 섹션부터 파일 끝까지가 prompt 본문이다. 본문 안의 `<ONE_LINER>` 를 사용자 답변으로 정확히 1 회 치환.

3. **완성 prompt 를 터미널에 출력**:

   치환 완료된 prompt 본문을 아래 형식으로 사용자에게 표시한다:

   ````
   ─────────────────────────────────────────────────────────────
   Agent Delegation Prompt (복사해서 새 Claude Code 세션에 주입)
   ─────────────────────────────────────────────────────────────

   ```md
   <치환된 prompt 본문 전체>
   ```

   ─────────────────────────────────────────────────────────────
   ```

4. **안내 + 세션 종료**:

   ```
   위 prompt 를 copy-paste 하여 새 Claude Code 세션에 전달하세요.
   그 세션의 agent 가 /vibe-init Phase 2~4 + Sprint 로드맵 + Sprint 실행 + closure
   를 자율적으로 진행합니다.

   본 /vibe-init 세션은 여기서 종료합니다.
   ```

   `.vibe/config.json.mode` 를 `"agent"` 로 기록한 뒤 본 `/vibe-init` skill 흐름은 **즉시 중단**. Phase 1-1 이하로 진행하지 않는다. (환경 점검 / provider 설정 등은 새 세션의 agent 가 담당.)

5. **왜 새 세션으로 넘기는가**:
   - 현재 세션은 사용자가 mode 선택을 위해 열었을 뿐, agent delegation 의 "첫 prompt" 가 아니다. Prompt 를 first-class instruction 으로 받는 건 "fresh agent session 의 initial user turn" 이어야 CLAUDE.md Charter 가 권고가 아닌 명령으로 해석된다.
   - 기존 대화 맥락 (사용자와의 이전 turn) 이 새 세션에는 없어야 agent 가 prompt 만으로 Charter 를 재해석한다. Context 오염 방지.

---

### Step 1-1: 환경 점검 실행

`npm run vibe:init`을 실행하여 기본 파일(`.env`, `.vibe/config.local.json`)을 생성한 뒤,
아래 환경 점검을 직접 수행합니다:

1. **필수 도구 확인** — `node` (>=24, Active LTS), `npm`, `git`, `bash` (Windows는 Git Bash)
   - 하나라도 없으면 설치 방법을 안내하고 중단합니다.

2. **AI Agent CLI 확인** — `claude`, `codex` CLI 등 존재 여부를 확인합니다.
   - Codex는 **CLI** (`codex exec`)로 직접 호출합니다. 플러그인(`codex:rescue`)은 Windows 불안정·속도 저하로 보류.

3. **Native interview 확인** — 별도 설치는 필요 없습니다. `scripts/vibe-interview.mjs`는 Node 24+만으로 동작합니다.

   결과를 사용자에게 보여줍니다. 예:
     ```
     환경 점검 결과:
       node (v22.x)      ✓
       npm                ✓
       git                ✓
       claude CLI         ✓
       codex CLI          ✗ (미설치)
     ```
   - 이 결과는 Phase 2에서 provider 선택/인증 안내에 사용됩니다.

---

## Phase 2 — Sprint 역할별 Provider 배정 및 인증

사용자에게 Sprint의 3가지 역할에 대해 **각각** 어떤 AI를 사용할지 물어봅니다.

### Step 2-1: 역할별 Provider 선택

> **Fast-path (기본값 일괄 수용)**: 사용자가 "기본", "default", "엔터", "그대로" 등으로
> 답하거나, 이미 `.vibe/config.local.json`이 존재하고 `sprintRoles`가 채워져 있으면
> 세 역할을 모두 기본값(`claude-opus` / `codex` / `claude-opus`)으로 즉시 확정하고
> Step 2-2의 인증 확인으로 바로 넘어갑니다. 역할별 개별 질문을 반복하지 않습니다.
> dogfood/재실행 케이스에서 Phase 2가 불필요하게 질문을 반복하는 것을 방지합니다.

아래와 같이 질문합니다:

```
Sprint 역할별 AI를 설정합니다. 각 역할에 어떤 AI를 사용할지 선택해주세요.
기본값은 괄호 안에 표시됩니다. 그대로 쓰려면 엔터만 누르면 됩니다.
(전체 기본값을 한 번에 수용하려면 "기본" 이라고 답하면 됩니다.)

1. Planner (스펙 정의 — "무엇을" 만들지 정의) [기본: claude-opus]
   선택지: claude-opus / codex / 기타

2. Generator (코드 구현 — 체크리스트 기반 구현) [기본: codex (CLI)]
   선택지: codex / claude-opus / 기타

3. Evaluator (판정 — 합격/불합격 판정) [기본: claude-opus]
   선택지: claude-opus / codex / 기타

"기타"를 선택하면 커스텀 AI agent를 연결할 수 있습니다.
```

사용자가 **"기타"**를 선택한 경우, 추가 질문:

```
커스텀 AI agent 설정:
  - provider 이름은 뭔가요? (예: deepseek, grok, gemini, aider)
  - CLI 명령어는 뭔가요? (예: deepseek, grok)
  - 프롬프트를 전달하는 인자 형식은 어떻게 되나요?
    예시) deepseek --prompt "{prompt}"
    예시) grok chat "{prompt}"
    모르면 비워두세요. 나중에 .vibe/config.local.json에서 직접 수정할 수 있습니다.
```

### Step 2-2: 선택된 Provider 인증 확인

각 선택된 provider에 대해 CLI가 설치되어 있는지 Phase 1 결과를 참조하여 확인합니다.

**CLI가 미설치인 경우**, 해당 provider의 설치 및 인증 방법을 step-by-step으로 안내합니다:

| Provider | 설치 안내 | 인증 안내 |
|----------|-----------|-----------|
| codex | `npm install -g @openai/codex` 으로 Codex CLI 설치. `codex --version`으로 설치 확인 | 아래 인증 방식 선택 안내 참조 |
| claude-opus | Claude Code 사용 중이므로 이미 인증됨 | - |
| 기타 (custom) | 사용자가 알려준 설치 방법 또는 "해당 AI의 공식 문서를 참고하세요" | 사용자에게 인증 방법 확인 |

**Codex CLI 인증 방식 선택** (codex가 선택된 경우):

Codex CLI 설치 후, 사용자에게 인증 방식을 선택하도록 안내합니다:

```
Codex CLI 인증 방식을 선택해주세요:

  1. OAuth 로그인 (기본, 권장)
     → `codex auth login` 실행 후 브라우저에서 OpenAI 계정 로그인
     → API 키 관리 없이 간편하게 사용 가능

  2. API 키 직접 설정
     → OPENAI_API_KEY 환경변수에 API 키를 설정
     → .env 파일에 추가하거나, 터미널에서 직접 설정
```

사용자가 **1 (OAuth)**를 선택한 경우:
- `! codex auth login` 실행을 안내합니다 (사용자가 직접 실행)
- 브라우저 로그인 완료 후 `codex auth status`로 인증 상태를 확인합니다

사용자가 **2 (API 키)**를 선택한 경우:
- `.env` 파일에 `OPENAI_API_KEY=sk-...` 추가를 안내합니다
- 또는 `! export OPENAI_API_KEY=sk-...` 로 현재 세션에서 직접 설정하도록 안내합니다

---

안내 후 사용자에게 확인합니다:
```
설치/인증을 지금 진행하시겠어요?
  - "예" → 사용자가 터미널에서 직접 명령 실행하도록 안내 (! 명령어 prefix 안내)
  - "나중에" → 건너뛰고 다음 단계로 진행
  - "건너뛰기" → 해당 provider를 일단 설정만 해두고 나중에 연결
```

### Step 2-3: 설정 파일 업데이트

선택 결과를 바탕으로 아래 파일들을 업데이트합니다:

#### `CLAUDE.md` (CRITICAL — 반드시 수행)

`<!-- BEGIN:SPRINT_ROLES -->` ~ `<!-- END:SPRINT_ROLES -->` 영역의 역할 테이블을 선택된 provider 이름으로 교체합니다.
또한 CRITICAL 블록 내 `Generator sub-agent(현재 설정: **{이전 값}**)` 부분을 선택된 generator provider로 업데이트합니다.

이 업데이트는 context 압축 후에도 올바른 모델이 참조되도록 보장하기 위해 필수입니다.

예시 (generator를 deepseek로 선택한 경우):
```markdown
<!-- BEGIN:SPRINT_ROLES (vibe-init 자동 업데이트 영역) -->
| 역할 | Provider | 상주 여부 | 책임 |
|------|----------|-----------|------|
| **Orchestrator** | **claude-opus** (메인 대화) | 상주 | Sprint 생명주기 관리, 사용자 소통, context 전달, 보고서 |
| **Planner** | **claude-opus** (sub-agent) | Sprint 내 | "무엇을(WHAT)" 정의 + 완료 체크리스트 작성 |
| **Generator** | **deepseek** (sub-agent) | Sprint 내 | 체크리스트 기반 코드 구현 (HOW는 Generator 재량) |
| **Evaluator** | **claude-opus** (sub-agent) | Sprint 내 | 체크리스트 기준 합격/불합격 판정 |
<!-- END:SPRINT_ROLES -->
```

CRITICAL 블록도 업데이트:
```markdown
> 모든 코드 구현은 반드시 Generator sub-agent(현재 설정: **deepseek**)를 생성하여 위임한다.
```

#### `.vibe/config.local.json`

선택한 Sprint 역할 구성을 반영합니다. 커스텀 provider는 `providers` 맵에 추가합니다.

##### OS 감지 + platform-native 경로 자동 기입 (CRITICAL — Windows 지원)

`config.local.json`을 작성하기 전 Orchestrator가 OS와 설치된 CLI 경로를 탐색하여
`providers.*.command` 를 플랫폼 적합한 형식으로 기입합니다. 이 단계를 건너뛰면 Windows
Git Bash 환경에서 `node` 의 기본 쉘이 cmd.exe로 fallback되어 `./scripts/run-codex.sh`
같은 POSIX 경로가 `vibe-preflight` 의 provider health check에서 실패합니다 (dogfood5
재현 사례).

**탐색 절차**:

1. Node / bash 로 OS 감지:
   - Windows: `node -e "console.log(process.platform)"` → `win32`
2. `codex` CLI 절대 경로 탐색:
   - Windows: `cmd //c "where codex"` → 첫 번째 `.cmd` 라인 추출 (예: `C:\Users\{user}\AppData\Roaming\npm\codex.cmd`)
   - POSIX: `which codex` → 그대로 사용
3. `claude` CLI 절대 경로 탐색 (동일 방식)
4. 탐색 결과를 `.vibe/config.local.json` 의 `providers.*.command` 로 기입:

   **Windows 결과 예시**:
   ```json
   "providers": {
     "claude-opus": {
       "command": "C:\\Users\\{user}\\.local\\bin\\claude.exe",
       "args": ["-p", "{prompt}"],
       "env": {}
     },
     "codex": {
       "command": "C:\\Users\\{user}\\AppData\\Roaming\\npm\\codex.cmd",
       "args": ["exec", "--json", "{prompt}"],
       "env": {}
     }
   }
   ```

   **POSIX (macOS/Linux) 결과 예시**:
   ```json
   "providers": {
     "claude-opus": {
       "command": "claude",
       "args": ["-p", "{prompt}"],
       "env": {}
     },
     "codex": {
       "command": "./scripts/run-codex.sh",
       "args": ["{prompt}"],
       "env": {}
     }
   }
   ```

5. 탐색 실패 시: 해당 CLI가 미설치 상태로 간주하고 Phase 2의 "CLI 미설치" 흐름으로 분기.
   config.local.json에는 기본 POSIX 경로(`./scripts/run-codex.sh` 등)를 임시로 두고,
   사용자에게 "Windows 환경이면 codex 설치 후 `where codex` 결과를 config.local.json
   에 반영해주세요" 1줄 경고 출력.

> Generator 호출 자체는 Orchestrator가 항상 `run-codex.sh` 를 통해 UTF-8 wrapping을 받도록 하지만, `vibe-preflight` 의 `provider.* --version` health check는 config.local.json의 `command` 를 cmd.exe/sh 를 통해 직접 실행하므로 플랫폼 적합한 경로가 필수입니다.

##### 커스텀 generator provider 예시

예시 (generator를 deepseek로 선택한 경우):
```json
{
  "orchestrator": "claude-opus",
  "sprintRoles": {
    "planner": "claude-opus",
    "generator": "deepseek",
    "evaluator": "claude-opus"
  },
  "sprint": {
    "unit": "feature",
    "subAgentPerRole": true,
    "freshContextPerSprint": true
  },
  "providers": {
    "claude-opus": {
      "command": "claude",
      "args": ["-p", "{prompt}"],
      "env": {}
    },
    "codex": {
      "command": "./scripts/run-codex.sh",
      "args": ["{prompt}"],
      "env": {}
    },
    "deepseek": {
      "command": "deepseek",
      "args": ["--prompt", "{prompt}"],
      "env": {}
    }
  }
}
```

#### `AGENTS.md`

Generator로 선택된 provider에 맞게 파일 내용을 수정합니다.
- 기본 codex가 아닌 경우, 파일 상단의 provider 이름을 변경합니다.
- 예: generator가 deepseek인 경우:
  ```markdown
  # DeepSeek project memory

  너의 기본 역할은 Sprint의 **Generator (코드 구현)** 다.
  ...
  ```

#### `CLAUDE.md` 의 `<!-- BEGIN:SPRINT_ROLES -->` 영역

선택된 역할 배정을 이 영역의 표에 반영합니다. 이 표가 Sprint 역할의 single source of truth입니다.

#### `docs/orchestration/providers.md`

커스텀 provider가 추가된 경우, 해당 provider 섹션을 문서에 추가합니다.

---

## Phase 3 — 프로젝트 맞춤 설정 (native socratic interview: vibe-interview)

Phase 3 인터뷰는 `scripts/vibe-interview.mjs`만 사용합니다.
상세 실행 규약은 `.claude/skills/vibe-interview/SKILL.md`를 authoritative runbook으로 따릅니다.

> **CRITICAL — Phase 3는 스킵 금지**: 사용자가 "자율 진행 / 위임 / 알아서 해"라고 말해도 Phase 3 인터뷰 자체는 반드시 완주합니다. 사용자가 직접 답하지 않으면 Orchestrator가 PO-proxy로 답변하고 rationale을 남깁니다.

### Step 3-0: 도메인 추론 시작

사용자의 프로젝트 한 줄 설명을 입력으로 받아 인터뷰 세션을 시작합니다. 이 단계는 도메인 추론, probing 질문, context shard seed 생성을 준비합니다.

실행 순서:

1. 사용자에게 프로젝트 한 줄 설명을 요청합니다.
2. `node scripts/vibe-interview.mjs --init --prompt "<one-liner>" [--lang ko|en] [--max-rounds 30] [--output .vibe/interview-log/<session-id>.json]`
3. stdout의 `{ phase: "domain-inference", inferencePrompt }`를 Orchestrator가 읽습니다.
4. 적절한 domain string을 판단해 기록합니다.
5. 이후 호출은 `.claude/skills/vibe-interview/SKILL.md`의 invocation protocol을 따릅니다.

### Step 3-1: native socratic interview 진행

- `vibe-interview`는 10개 핵심 dimension을 backbone으로 삼고, 다음 질문은 Orchestrator LLM이 생성합니다.
- 각 라운드는 누락 coverage와 모호도가 높은 dimension을 중심으로 1-3개의 질문을 만듭니다.
- 사용자가 "모름 / 미정 / 추천해줘"라고 답하면 해당 sub-field를 deferred로 기록하고, 다음 우선순위 dimension으로 넘어갑니다.
- 종료 조건은 다음 중 하나입니다.
  - ambiguity <= 0.2
  - roundNumber > maxRounds
  - 전체 required dimension coverage >= 0.5 이고 ambiguity <= 0.3

#### PO-proxy 모드

사용자가 자율 진행을 요청하거나 답변을 제공하지 않으면 Orchestrator가 PO 관점에서 답합니다.

- PO-proxy 답변도 일반 답변과 동일하게 `--continue`와 `--record` pipe로 기록합니다.
- Phase 종료 직후 `session-log.md`에 `[decision][phase3-po-proxy]` 항목을 한 번만 남깁니다.
- 답변마다 로그를 쓰지 말고, 최종 요약과 핵심 rationale만 기록합니다.

### Step 3-2: interview seed를 context shards로 변환

인터뷰 결과의 `seedForProductMd`와 dimension coverage를 기준으로 context shards를 작성합니다.
각 shard 작성 전에 기존 파일 내용을 읽고 사용자 작성 내용을 보존합니다.

> **원칙 — Write after Read**: `docs/context/*.md` 3개 파일이 placeholder인지 확인한 뒤 작성하고, 사용자 내용은 덮어쓰지 않습니다.

| seed field | 작성 위치 / 의미 |
|---|---|
| `dimensions.goal` | `product.md` one-liner / success criteria |
| `dimensions.target_user` | `product.md` target users |
| `dimensions.platform` | `product.md` platform |
| `dimensions.data_model` | `architecture.md` data model |
| `dimensions.primary_interaction` | `product.md` user flow |
| `dimensions.success_metric` | `product.md` acceptance criteria |
| `dimensions.non_goals` | `product.md` non-goals |
| `dimensions.constraints` | `product.md` core assumptions + `conventions.md` security rules |
| `dimensions.tech_stack` | `architecture.md` tech stack |
| `dimensions.domain_specifics` | `product.md` domain notes + `conventions.md` extra rules |

작성 완료 후 Orchestrator는 `seedForProductMd`를 `docs/context/product.md`의 `## Phase 3 답변 기록 (native interview)` 섹션에 append합니다.

기존 세션의 legacy interview 디렉터리가 남아 있어도 vibe-doctor는 사용하지 않습니다. 사용자가 직접 제거할 수 있습니다.

### Step 3-3: conventions.md test and lint shard links

After Step 3-2 writes the interview seed, inspect the interview log for `tech_stack.normalized_slugs[]`.
Use `.claude/skills/test-patterns/_index.md` to map each slug to a test shard path, then derive lint shards from the language prefix:

- `ts-*` -> `typescript-debt.md`
- `py-*` -> `python-debt.md`
- `rust-*` -> `rust-debt.md`
- `go-*` -> `go-debt.md`
- always include `universal-debt.md`
- include `canvas-dom-isolation.md` or `shell-bats.md` only when their test slugs are present

Rewrite only the marker blocks below in `docs/context/conventions.md`. If a marker is missing, append the full section. Re-running must be idempotent and must preserve user-authored content outside the markers.

```md
## 테스트 전략
<!-- BEGIN:VIBE:TEST-PATTERNS -->
- TypeScript unit/integration: [.claude/skills/test-patterns/typescript-vitest.md](../../.claude/skills/test-patterns/typescript-vitest.md)
<!-- END:VIBE:TEST-PATTERNS -->

## Lint 규칙
<!-- BEGIN:VIBE:LINT-PATTERNS -->
- TypeScript debt grep: [.claude/skills/lint-patterns/typescript-debt.md](../../.claude/skills/lint-patterns/typescript-debt.md)
- Universal TODO/FIXME: [.claude/skills/lint-patterns/universal-debt.md](../../.claude/skills/lint-patterns/universal-debt.md)
<!-- END:VIBE:LINT-PATTERNS -->
```

### Step 3-4: web/frontend utility opt-in

After Step 3-3, inspect `inferred_domain`, `dimensions.platform`, and `tech_stack.normalized_slugs[]` to decide whether the project is a web/frontend candidate.

Treat the project as a web/frontend candidate when either condition matches:

- `normalized_slugs[]` includes a `ts-` stack slug related to web, browser, or mobile work such as `ts-react`, `ts-vue`, `ts-svelte`, `ts-vite`, or `ts-next`
- `platform` contains `web`, `mobile`, or `browser`

Decision flow:

- PO-proxy mode: infer `bundle.enabled` and `browserSmoke.enabled` from the detected platform/domain signals without asking the user
- Manual mode: ask exactly these questions

```
1) 번들 크기 제약이 있나요? (예: 모바일 웹, 첫 페인트 budget) [y/N]
2) 브라우저 UI 가 있어 smoke 검증을 활성화할까요? [y/N]
```

Apply the result by patching `.vibe/config.json`:

```json
"bundle": {
  "enabled": false,
  "dir": "dist",
  "limitGzipKB": 80,
  "excludeExt": [".map"]
},
"browserSmoke": {
  "enabled": false,
  "configPath": ".vibe/smoke.config.js"
}
```

If the product build output uses a custom path such as `app/dist`, set `.vibe/config.json` `bundle.path` and `browserSmoke.dist` to that path (default: `dist`).

Always append one session log entry with the rationale:

```md
- 2026-04-16T00:00:00.000Z [decision][phase3-utility-opt-in] bundle=true browserSmoke=false rationale=...
```

If `browserSmoke.enabled` becomes `true`, create `.vibe/smoke.config.js` only when it does not already exist. Use this skeleton:

```js
export default {
  url: 'http://localhost:5173',
  viewport: { width: 375, height: 812 },
  expectDom: ['#stage'],
  expectConsoleFree: true,
  canvasAssertions: []
};
```

Also create a root `README.md` from `.claude/skills/vibe-init/templates/readme-skeleton.md` when the file does not already exist. Replace:

- `{{project_name}}` with the first heading from `docs/context/product.md`
- `{{one_liner}}` with the interview seed one-liner
- `{{status}}` with `WIP (Phase 0 complete)`

If `README.md` already exists, skip it and print:

```text
[vibe-init] README.md exists, skipping skeleton write
```

### Step 3-5: Sprint 로드맵 작성 (Orchestrator 전담)

Step 3-4 의 context shard 작성 직후, Orchestrator 가 **product 맥락을 가장 풍부하게
보유한 상태** 에서 Sprint 로드맵을 직접 작성합니다. **이 단계는 Planner 에 위임하지
않습니다** (CLAUDE.md §Sub-agent 소환 트리거 매트릭스 > "Sprint 로드맵 분할" 참조).
위임 시 인터뷰 context 손실로 품질이 저하됩니다.

절차:

1. 입력: `docs/context/product.md` + `docs/context/architecture.md` + 인터뷰 seed
2. 산출: `docs/plans/sprint-roadmap.md` 에 Iteration 1 섹션 append
3. 각 Sprint 항목은 `{id, name, 한 줄 목표, 의존, 예상 LOC}` 형태
4. N 은 프로젝트 규모에 따라 3~10 개 권장. 너무 많은 Sprint 는 재평가 필요.

포맷 예시:

```md
# Iteration 1 — <project-slug> (v0.1.0)

## Sprint M1 — <one-line-goal>
- id: sprint-M1-<slug>
- 목표: <한 줄>
- 의존: 없음 (첫 slot)
- 예상 LOC: ~<N>
```

작성 완료 후 `session-log.md` 에 `[decision][sprint-roadmap-drafted]` 한 줄 기록을
남깁니다. 이 산출물은 Phase 4 Step 4-0a 의 seal commit 에 포함됩니다.

---

## Phase 4 — 설정 요약 및 완료

### Step 4-0: Git 초기화 (CRITICAL — Codex/에이전트 위임 전제 조건)

Sprint Generator가 **Codex CLI**(또는 trust-based sandbox를 쓰는 다른 provider)인 경우,
프로젝트 루트에 `.git`이 존재하지 않으면 Codex가 `Not inside a trusted directory` 에러로
**첫 Sprint부터 즉시 실패**합니다. 따라서 여기서 git 초기화를 강제합니다.

절차:
1. `git rev-parse --is-inside-work-tree`로 기존 git 저장소 여부 확인
2. 없으면 다음을 **자동 실행** (사용자 추가 승인 불필요 — 이건 템플릿 규약):
   ```bash
   git init
   git add -A
   git -c commit.gpgsign=false commit -m "chore: initial vibe-doctor scaffold"
   ```
3. 실행 실패 시(이름/이메일 미설정 등) 실패 원인을 표시하고 사용자에게 1회 수동 실행을 요청합니다.

이 단계는 Phase 2에서 Codex/기타 샌드박스형 provider를 선택한 경우에만 필수지만,
선택과 무관하게 git 저장소가 있으면 이후 작업(커밋, 리뷰, 복구)이 모두 수월해지므로
**언제나 실행**하는 것을 기본값으로 삼습니다.

### Step 4-0a: Phase 0 seal commit

Immediately after Step 4-0 finishes, run:

```bash
node scripts/vibe-phase0-seal.mjs
```

Expected outcomes:

- exit `0` with `[phase0-seal] committed: ...` after staging the Phase 0 artifacts and creating the seal commit
- exit `0` with `[phase0-seal] already sealed (no changes)` when nothing changed
- exit `0` with `[phase0-seal] no candidate files present` when the Phase 0 files are absent

If the command exits non-zero, print the reason, tell the user to run it manually once, and continue Phase 4 without blocking.

### Step 4-0b: Agent delegation 권한 프리셋 (opt-in)

Orchestrator asks:

> Sprint 자율 실행 시 권한 프롬프트를 줄이는 agent-delegation 프리셋을 적용하시겠습니까?
> (npm install/build/test/git 등 scope 제한된 명령만 자동 허용)
> [Y/n]

- User answers Y (or PO-proxy auto-yes): run `node scripts/vibe-sprint-mode.mjs on`.
- User answers N: skip. Print "프리셋 미적용. 나중에 `/vibe-sprint-mode on`으로 활성화할 수 있습니다."
- If the script exits non-zero, print warning and continue.

### Step 4-1: 설정 요약 출력

모든 단계가 끝나면 아래를 출력합니다:

```
초기 세팅이 완료되었습니다!

  환경:
    node {버전}  ✓
    npm          ✓
    git          ✓

  Sprint 역할 설정:
    Orchestrator : claude-opus (기본)
    Planner      : {선택된 planner}  {✓ 인증됨 / ⚠ 미연결}
    Generator    : {선택된 generator}  {✓ 인증됨 / ⚠ 미연결}
    Evaluator    : {선택된 evaluator}  {✓ 인증됨 / ⚠ 미연결}

  작성/수정된 파일:
    - CLAUDE.md                        (Sprint 역할 테이블 + CRITICAL 블록)
    - .vibe/config.local.json          (Sprint 역할 + provider 설정)
    - docs/context/product.md          (프로젝트 목표)
    - docs/context/architecture.md     (기술 스택)
    - docs/context/conventions.md      (코드 규칙)
    - AGENTS.md                        (Generator 규칙)

이제 목표를 말씀해주시면 Sprint 단위로 작업을 시작할 수 있습니다.
예) "Goal: 로그인 페이지를 만들어줘"
```

---

## 중요 규칙

- 질문은 **친절하고 쉬운 말**로 합니다. 코딩을 모르는 사용자를 대상으로 합니다.
- 각 Phase/Step을 순서대로 진행하며, 답변을 받은 후 파일을 작성하고 다음으로 넘어갑니다.
- 사용자가 "모름", "잘 모름", "패스", "기본" 등으로 답하면 기본값을 사용합니다.
- 빈 답변도 허용합니다. 빈 값은 기본값으로 채웁니다.
- `npm run vibe:init` 실행이 실패하면 원인을 파악하여 해결 후 재시도합니다.
- provider 인증 시, 사용자가 직접 터미널 명령을 실행해야 하는 경우 `! 명령어` 형식을 안내합니다.
- 커스텀 provider의 CLI 인자 형식을 모르는 경우, 기본 템플릿(`["--prompt", "{prompt}"]`)을 사용하고 나중에 `.vibe/config.local.json`에서 수정 가능하다고 안내합니다.
- AGENTS.md는 파일명은 유지하되, 내용만 선택된 Generator provider에 맞게 수정합니다.
