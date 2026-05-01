# Codex 실행 가이드 (Korean Windows 안전판)

> **요약**: Korean Windows + Codex 조합은 비-ASCII string literal을 조용히
> 깨뜨릴 수 있다. 이 문서는 원인, 영구 해결책, 모든 Generator prompt가
> 따라야 할 규약(BLOCKED 패턴, Encoding integrity gate)을 정의한다.
> 이 가이드는 `vibe-doctor` 베이스와 이를 파생한 모든 프로젝트에 적용된다.

---

## 1. 증상

- 한국어(또는 비-ASCII) string literal이 `?�점`, `?�전 출발` 같은
  mojibake로 변한다.
- `file <name>.cs` 결과가 `UTF-8 Unicode text`가 아니라
  `Non-ISO extended-ASCII text`로 분류된다.
- Codex가 만진 파일에서 NEL (U+0085) 라인 종결자가 새로 등장한다.
- 씬/UI 빌드 후 라벨이 깨진 채 실행된다.

## 2. 근본 원인 (확정)

1. **Korean Windows 콘솔 코드 페이지가 CP949 (chcp 949)**.
2. **Codex와 그 자식 프로세스(git/cat/grep/dotnet 등)는 실행 시점의
   locale을 그대로 상속**한다. `LANG`/`LC_ALL`/`PYTHONUTF8`이 비어있으면
   모두 system ANSI(=CP949)를 따른다.
3. UTF-8로 저장된 한국어 string이 어딘가에서 CP949로 디코딩되었다가 다시
   UTF-8로 인코딩되면, **CP949에 매핑되지 않는 첫 바이트**가 `?`(0x3F)로
   치환된다. 예: "상점"(`EC 83 81 EC A0 90`) → `3F 81 EC A0 90`.
4. `.cs` 파일이 **UTF-8 BOM 없이** 저장되어 있으면 인코딩 추론 실패 여지가
   커진다.

이것은 Codex 버그가 아니라 **환경 설정 누락**이다.

## 3. 영구 해결책

### 3.1 방어층 1 — `.editorconfig`

`[*.cs]` 섹션에 `charset = utf-8-bom` + `end_of_line = crlf`를 강제한다.
vibe-doctor 베이스의 `.editorconfig`가 이미 이 값을 가지며, 파생
프로젝트도 동일 값을 유지해야 한다.

### 3.2 방어층 2 — 환경 변수 강제 (`.vibe/harness/scripts/run-codex.sh`)

Codex 호출은 **모두** 이 wrapper를 경유한다. Orchestrator의 Sprint 호출,
`vibe:run-agent` CLI, 수동 디버깅 모두 동일하게 프롬프트 파일을 stdin으로 파이프 주입하거나 positional arg로 전달한다:

```bash
# 표준 호출 패턴 — stdin 파이프 주입 (권장, 긴 프롬프트)
cat docs/prompts/task.md | ./.vibe/harness/scripts/run-codex.sh -

# 인라인 패턴 — 짧은 프롬프트, vibe:run-agent 기본 경로
./.vibe/harness/scripts/run-codex.sh "{prompt}"
```

`.vibe/config.json` 의 codex provider 항목은 이 wrapper를 default로
가리키므로, `vibe:run-agent --provider codex` 호출도 자동으로
wrapper를 경유한다.

Windows에서 `vibe:run-agent`가 이 POSIX wrapper를 실행할 때는 bare `bash`를
사용하지 않고 Git Bash 실행 파일을 직접 탐색한다. `where bash` 결과가
`WindowsApps\bash.exe`이면 WSL launcher이므로 Windows Codex wrapper 실행에
사용하지 않는다. WSL에서 Codex를 실행하려면 Linux용 `node`와 `codex`를 WSL
내부에 별도로 설치한다. Windows npm shim(`/mnt/c/.../npm/codex`)은 WSL Codex
실행 경로로 지원하지 않는다.

wrapper가 자동 설정하는 항목:

| 항목 | 값 | 이유 |
|---|---|---|
| `LANG`, `LC_ALL`, `LANGUAGE` | `en_US.UTF-8` | libc 기반 도구 UTF-8 강제 |
| `PYTHONUTF8`, `PYTHONIOENCODING` | `1`, `utf-8` | Python 자식 UTF-8 |
| `DOTNET_SYSTEM_GLOBALIZATION_USENLS` | `false` | .NET이 ICU 사용, NLS 회피 |
| `chcp.com 65001` | best-effort | Windows 콘솔 코드 페이지 UTF-8 |
| `shell_environment_policy.inherit=all` + `set.*` | `-c` 옵션 | **codex가 자식으로도 UTF-8 전파** |
| `CODEX_RETRY` (기본 3) | exponential backoff | 일시 오류 자동 회복 |

### 3.3 방어층 3 — `~/.codex/config.toml` 권장

```toml
model = "gpt-5-codex"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[agents]
job_max_runtime_seconds = 3600

[shell_environment_policy]
inherit = "all"
[shell_environment_policy.set]
LC_ALL = "en_US.UTF-8"
LANG = "en_US.UTF-8"
PYTHONUTF8 = "1"
DOTNET_SYSTEM_GLOBALIZATION_USENLS = "false"
```

모델을 고정하지 않으면 provider-side default가 throttling될 때
"Selected model is at capacity"로 실패할 수 있다.

## 4. Generator 프롬프트 규약 (BLOCKED 패턴)

막히면 spec 외 파일을 건드리는 패턴을 방지하기 위해 **모든 Generator
prompt**에 다음을 명시한다.

```markdown
# BLOCKED 처리 규칙 (반드시 준수)
- spec의 "Files Generator may touch" 외부 파일 수정 절대 금지.
- spec 범위 내에서 fix가 불가능하다고 판단되면:
  1. STOP — 더 이상 코드 변경 시도하지 않는다.
  2. completion report에 다음 형식으로 BLOCKED 항목 기재:
     ```
     ## BLOCKED
     - Item: <ID>
     - Reason: <왜 spec 범위 내에서 불가능한지>
     - Required scope expansion: <어떤 파일/접근이 필요한지>
     ```
  3. 정상 종료 (exit 0). Orchestrator가 spec을 수정해서 재투입한다.
- "어떻게든 동작하게 만든다" 사고 금지. 데이터 단 fix가 spec이면 데이터를
  고치고, runtime hardcoded bypass로 우회하지 않는다.
```

## 5. Evaluator 강화 (Encoding integrity gate — 필수)

Grep gate + 문법 체크만으로는 한국어 손상을 놓친다. 모든 spec의 acceptance
gate에 다음을 **필수 추가**:

```markdown
- [ ] **Encoding integrity (REQUIRED)**:
  - `file <touched files>`가 모두 `UTF-8 Unicode text`로 분류
  - `LC_ALL=C grep -lE '"[?][^"]*"' <touched files>` 결과 빈 줄
  - `git diff`의 비-ASCII string literal 변화가 의도된 것만 (mojibake 0건)
  - 변경된 .cs 파일에 BOM (`xxd | head -1`이 `efbbbf...`로 시작)
```

## 6. 복구 절차 (이미 깨진 파일이 있을 때)

```bash
# 1) 손상 파일 식별
LC_ALL=C grep -lE '"[?][^"]*[\xc0-\xff]' path/to/**/*.cs

# 2) git에서 가장 가까운 정상 버전으로 복구
git checkout HEAD -- <file>

# 3) wrapper 통해 의도한 변경만 좁게 재투입
./.vibe/harness/scripts/run-codex.sh - < <narrow-prompt>.md

# 4) 검증
file <file>                           # "UTF-8 Unicode text"
LC_ALL=C grep -nE '"[?][^"]*"' <file>  # 빈 결과
```

## 7. 파생 프로젝트 체크리스트

vibe-doctor를 베이스로 새 프로젝트를 만들 때:

- [ ] `.editorconfig`의 `[*.cs]` (및 필요시 `[*.{ts,tsx}]`) 섹션 유지
- [ ] `.vibe/harness/scripts/run-codex.sh` 복사 및 실행 권한 확인
- [ ] Generator prompt 템플릿에 §4 BLOCKED 규칙 포함
- [ ] Evaluator acceptance gate에 §5 encoding integrity 포함
- [ ] Sprint는 sequential 진행 (Planner → Generator → Evaluator). 병렬 Sprint 실행은 현재 지원 범위 밖.
- [ ] `~/.codex/config.toml`에 모델 핀 + `shell_environment_policy` 설정

## 8. 변경 이력

- 2026-04-08: 최초 작성. `dungeon-of-abyss` Sprint A/C 사후 분석 결과를
  vibe-doctor 베이스로 역전파.
- 2026-04-09: Sprint F1 — `.vibe/config.json` 의 codex provider 항목이
  `./.vibe/harness/scripts/run-codex.sh` 를 default로 가리키도록 canonicalization.
  aspirational 병렬 러너 레퍼런스 제거 (Sprint E2에서 기반 코드/문서
  purge 완료).

## Codex 403 Forbidden troubleshooting

- 증상: `backend-api/codex/responses` 403 Forbidden 이 연속 반환된다. dogfood10 iter-1 hotfix 시점에 관측됐다.
- 감지 메커니즘: `run-codex.sh` 가 3회 retry 소진 후 `.vibe/agent/codex-unavailable.flag` 를 touch 하고 stderr 에 `CODEX_UNAVAILABLE` 블록을 출력한다.
- flag 내용: ISO8601 timestamp, `last_exit=<code>`, `reason_hint=<hint>` 를 기록한다. hint 는 `403-forbidden`, `401-unauthorized`, `429-rate-limit`, `5xx-server-error`, `unknown` 중 하나다.
- Orchestrator 대응: (1) 시간차 재시도 — dogfood10 에서는 edge block 인 경우 수십 분 후 복구가 관찰됐다. (2) 사용자 승인 하에 Orchestrator 직접 편집 — session-log 에 `[decision][orchestrator-hotfix]` 기록 필수. (3) `.vibe/config.json.providers` 에 fallback provider 추가 후 재시도.
- 자동 복구: 다음 성공 호출 시 `.vibe/harness/scripts/run-codex.sh` 가 flag 파일을 `rm -f` 로 제거한다. 이 flag 는 "현재 Codex 가 계속 unreachable 한가" 의 snapshot 이다.
- 알려진 root causes: rate-limit, CF edge block, 계정 fingerprint 중 하나일 수 있으나 명확한 판별 방법은 없다. dogfood10 에서는 사용자 토큰이 98% 여유였음에도 403 이 반환됐다.
## Provider-neutral lifecycle

Codex does not expose the same `SessionStart` and `PreCompact` hooks as Claude Code. The harness therefore routes Codex through generic lifecycle scripts where possible:

- `.vibe/harness/scripts/run-codex.sh` calls `node .vibe/harness/scripts/vibe-agent-session-start.mjs` before non-health Codex runs.
- `.vibe/harness/scripts/run-codex.sh` and `.vibe/harness/scripts/run-codex.cmd` append dashboard attention events when a Codex wrapper run completes or fails. This is a wrapper-level completion signal, not a native Codex permission hook.
- `npm run vibe:run-agent -- --provider codex ...` also calls the same session-start entrypoint before executing the provider command.
- Sprint Generator invocations are short-lived and normally do not need context-threshold checkpoint automation; they hand state back through the completion report and Orchestrator-owned sprint scripts.
- Codex used as the main Orchestrator runs in Orchestrator maintenance mode, not Sprint Generator mode. It is the risky path because it can accumulate decisions outside the `run-codex.sh` wrapper. Use the `maintain-context` skill at work boundaries: after meaningful decisions, reviews, releases, tags, pushes, syncs, or before final handoff.
- The portable checkpoint sequence is: update `.vibe/agent/handoff.md`, append a concise `.vibe/agent/session-log.md` entry, then run `npm run vibe:checkpoint` or `node .vibe/harness/scripts/vibe-checkpoint.mjs`.

This is not a true Codex `PreCompact` hook and it cannot fire at a real 80% context threshold. It is the portable fallback that works for Codex and other CLI providers without Claude-specific hook support.
