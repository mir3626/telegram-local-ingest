# Provider runners

각 provider는 `.vibe/config.json`에서 프로젝트 기본값을 정의하고,
`.vibe/config.local.json`으로 로컬 override할 수 있다.
`config.local.json`이 없으면 `config.json`의 기본값으로 작동한다.

## 기본 Provider 구성

> 아래는 기본값 예시이다. 실제 역할 배정은 `/vibe-init` 또는 `.vibe/config.json` → `sprintRoles`에서 사용자가 자유롭게 설정한다.

| Provider | 호출 방법 | 비고 |
|----------|-----------|------|
| `claude-opus` | Agent 도구 (model: opus) | Claude 계열 — Planner/Evaluator 후보 (트리거 해당 시에만 소환) |
| `claude-sonnet` | Agent 도구 (model: sonnet) | Claude 계열 |
| `codex` | `Bash("... \| ./.vibe/harness/scripts/run-codex.sh -")` | **Codex CLI** (run-codex.sh wrapper 경유 — UTF-8 safety + 자동 재시도). 인증: OAuth (`codex auth login`, 기본) 또는 API 키 (`OPENAI_API_KEY`). 상세: `docs/context/codex-execution.md` |
| `gemini` | Bash 도구 (`gemini "{prompt}"`) | CLI 직접 실행 |

> **⚠️ Provider 호출 규칙**:
> - **Claude 계열** provider → Claude Code의 **Agent 도구** 사용 (model 파라미터 지정)
> - **Codex** → **`Bash("... | ./.vibe/harness/scripts/run-codex.sh -")` 로 wrapper 경유 CLI 호출**. Agent 도구는 Claude만 지원하므로 Codex에 사용 금지. raw `codex exec` 직접 호출은 Korean Windows 환경에서 mojibake 위험이 있으므로 금지.
> - **기타 비-Claude 계열** provider → **Bash 도구**로 CLI/API 명령 실행
>
> `codex:rescue` 플러그인은 잠정 보류 (Windows 환경에서 불안정·속도 저하 이슈).

Windows 네이티브 환경에서 `vibe:run-agent`가 `./.vibe/harness/scripts/run-codex.sh`를 실행할 때는
Git Bash를 직접 탐색한다. bare `bash`가 WSL launcher(`WindowsApps\bash.exe`)로
잡히는 환경에서도 provider 실행이 WSL로 새지 않게 하기 위함이다. WSL에서 Codex를
사용하려면 WSL 내부에 Linux용 `node`와 `codex`를 설치하고, Windows npm shim을
재사용하지 않는다.

## 템플릿형 인자 치환

이 베이스는 특정 CLI 버전에 강하게 결합되지 않도록 **템플릿형 인자 치환**을 사용한다.

치환 가능한 변수:
- `{prompt}`
- `{promptFile}`
- `{cwd}`
- `{role}`
- `{taskId}`

### Codex 플러그인 (잠정 보류)

OpenAI 공식 Codex 플러그인 (`openai/codex-plugin-cc`)은 Windows 환경에서 불안정·속도 저하 이슈로 **잠정 보류** 상태다.
Generator 호출은 반드시 **Codex CLI** (`Bash("codex exec ...")`)를 사용한다.

**보류된 스킬/에이전트** (참고용):
- `codex:rescue` (스킬) — 잠정 보류
- `codex:codex-rescue` (에이전트) — 잠정 보류
- `codex:setup` (스킬) — Codex CLI 준비 상태 확인 (사용 가능)
- `codex:gpt-5-4-prompting` (내부) — Codex/GPT-5.4 프롬프트 가이드 (사용 가능)
## Troubleshooting

## Provider-neutral lifecycle hooks

Claude Code has native hooks, but Codex and other CLI providers usually do not. The harness uses the following portable fallback:

- `node .vibe/harness/scripts/vibe-agent-session-start.mjs` is the canonical session-start command. It runs session-start logging, `vibe-version-check`, and `vibe-model-registry-check`.
- Claude `SessionStart` calls that script through `.claude/settings.json`.
- Codex calls it from `.vibe/harness/scripts/run-codex.sh` before non-health runs.
- `npm run vibe:run-agent` calls it before any provider command when the script exists in the target workspace.

Context compaction remains provider-specific. Providers without a native `PreCompact` hook must follow `_common-rules.md` Section 16: update `handoff.md` and `session-log.md`, then run `node .vibe/harness/scripts/vibe-checkpoint.mjs`.

### ouroboros 설치 실패 (`Could not find a version that satisfies the requirement ouroboros-ai`)

**증상**: `pip install ouroboros-ai` 또는 `pip install ouroboros` 실행 시 패키지를 찾지 못한다는 에러.

**원인 1 — 잘못된 패키지명**: PyPI 패키지명은 **`ouroboros-ai`** 이다. 하이픈 없는 `ouroboros`는 다른 패키지이므로 혼동하지 말 것.

**원인 2 — Python 버전**: ouroboros-ai는 **Python 3.12 이상**을 요구한다. 3.11 이하에서는 호환 버전이 없다는 에러가 발생한다.

**해결 순서**:

```bash
# 1. Python 버전 확인 (3.12+ 필수)
python --version

# 2. 3.12 미만이면 업그레이드 (Windows는 python.org 공식 인스톨러, macOS는 brew install python@3.12)

# 3. 설치 (권장: pipx 격리 환경)
pipx install "ouroboros-ai[all]"

# 또는 pip
pip install --user "ouroboros-ai[all]"

# 또는 업스트림 원클릭 스크립트 (macOS/Linux)
curl -fsSL https://raw.githubusercontent.com/Q00/ouroboros/main/scripts/install.sh | bash

# 4. 초기 설정
ouroboros setup

# 5. 설치 확인
python -m ouroboros --version
```

**extras 옵션** (필요에 따라 선택):
- `[claude]` — Claude Code 연동
- `[litellm]` — LiteLLM 멀티 프로바이더
- `[mcp]` — MCP 서버/클라이언트
- `[tui]` — Textual 터미널 UI
- `[all]` — 전체 번들 (기본 권장)

---

### ouroboros MCP 서버 연결 실패 (Windows PID 파일 문제)

**증상**: `claude mcp list`에서 ouroboros가 `✗ Failed to connect`로 표시되거나, `ouroboros_interview` 호출 시 MCP 서버가 응답하지 않음.

**원인**: ouroboros가 시작 시 `~/.ouroboros/mcp-server.pid`의 이전 프로세스 ID를 확인하는데, Windows에서 `os.kill(old_pid, 0)` 호출이 `SystemError`를 발생시켜 서버가 크래시함.

**해결 순서**:

```bash
# 1. stale PID 파일 삭제
rm ~/.ouroboros/mcp-server.pid

# 2. MCP 서버 재등록
claude mcp remove ouroboros --scope project
claude mcp add --scope project ouroboros -- python -m ouroboros mcp serve --llm-backend claude_code

# 3. 재연결 확인
claude mcp list
# ouroboros: ... - ✓ Connected 가 나오면 성공

# 4. 연결이 안 되면 Claude Code 대화 내에서 /mcp 실행
```

**주의**: `claude mcp add` 시 `--` 뒤의 인자가 줄바꿈으로 잘리지 않도록 한 줄로 입력할 것.

---

### Codex 에이전트 프로필 (레거시 CLI)

`.codex/agents/`에 정의된 에이전트 (병렬 실행 등 CLI 직접 호출 시 사용):
- `coder` — 코드 작성, workspace-write 샌드박스
- `explorer` — 코드 탐색/조사, read-only 샌드박스
- `developer_instructions` 에 정규식/역슬래시가 들어가면 TOML `""" ... """` 대신 literal multiline string(`''' ... '''`)을 사용한다.
