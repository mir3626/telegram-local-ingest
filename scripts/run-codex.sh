#!/usr/bin/env bash
#
# run-codex.sh — UTF-8-safe wrapper for `codex exec` on Korean Windows.
#
# WHY THIS EXISTS
# ---------------
# Korean Windows defaults to CP949 (chcp 949). When `codex exec` runs
# without UTF-8 forced, the Rust binary, its spawned subprocesses, and any
# .NET/Python tooling underneath fall back to system ANSI. The result: any
# non-ASCII string literal (Korean, Japanese, emoji, …) gets round-tripped
# through CP949 and unmappable bytes are silently replaced with `?`
# (e.g. `상점` round-trips into broken bytes like `?\x81\xec\xa0\x90`).
# This wrapper prevents that by
# forcing UTF-8 at every layer AND telling codex to propagate UTF-8 into
# every subshell it spawns via `shell_environment_policy`.
#
# It also handles transient model "at capacity" errors with backoff
# retries, and buffers stdin so retries work even when the prompt is
# piped in.
#
# USAGE
# -----
#   cat docs/prompts/task.md | ./scripts/run-codex.sh -
#   ./scripts/run-codex.sh "implement X per docs/prompts/task.md"
#
# ENV OVERRIDES
# -------------
#   CODEX_MODEL=gpt-5-codex        -> pass `-m <name>` to codex
#   CODEX_RETRY=3                  -> max retry attempts (default 3)
#   CODEX_SANDBOX=workspace-write  -> sandbox mode
#   CODEX_EXTRA_CONFIG="-c k=v"    -> extra `-c` overrides
#
# This wrapper is the ONLY supported Codex invocation path. Orchestrator
# sprint calls, `vibe:run-agent --provider codex`, and manual debugging
# all route through this script by piping a prompt file into
# `run-codex.sh -` (or passing the prompt as a positional arg).
# See docs/context/codex-execution.md for the full rationale.

set -euo pipefail

print_usage() {
  cat <<'EOF'
Usage:
  run-codex.sh --health|--version|--help
  cat prompt.md | run-codex.sh -
  run-codex.sh "prompt text"
EOF
}

run_health_check() {
  if ! command -v codex >/dev/null 2>&1; then
    echo "run-codex: codex CLI not found in PATH" >&2
    return 1
  fi

  local tmp_stdout tmp_stderr rc pid watchdog v stderr_tail

  tmp_stdout="$(mktemp "${TMPDIR:-/tmp}/run-codex-health.XXXXXX")"
  tmp_stderr="$(mktemp "${TMPDIR:-/tmp}/run-codex-health.XXXXXX")"
  rc=0

  if command -v timeout >/dev/null 2>&1; then
    set +e
    timeout 5 codex --version >"$tmp_stdout" 2>"$tmp_stderr"
    rc=$?
    set -e
  else
    codex --version >"$tmp_stdout" 2>"$tmp_stderr" &
    pid=$!
    (
      sleep 5
      kill -TERM "$pid" 2>/dev/null || true
    ) &
    watchdog=$!

    set +e
    wait "$pid" 2>/dev/null
    rc=$?
    set -e

    kill -TERM "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  fi

  if [[ $rc -eq 0 ]]; then
    v="$(
      awk '
        {
          for (i = 1; i <= NF; i++) {
            if ($i ~ /[0-9]+\.[0-9]+/) {
              print $i
              exit
            }
          }
        }
      ' "$tmp_stdout"
    )"
    if [[ -z "$v" ]]; then
      v="unknown"
    fi
    echo "codex-cli $v"
    rm -f "$tmp_stdout" "$tmp_stderr"
    return 0
  fi

  stderr_tail="$(tail -n 20 "$tmp_stderr" 2>/dev/null || true)"
  rm -f "$tmp_stdout" "$tmp_stderr"

  if printf '%s\n' "$stderr_tail" | grep -qiE '(not authenticated|login required|auth|OPENAI_API_KEY|unauthorized)'; then
    echo "run-codex: codex CLI present but authentication missing - run 'codex auth login' or set OPENAI_API_KEY" >&2
    return 2
  fi

  if [[ $rc -eq 124 || $rc -eq 143 ]]; then
    echo "run-codex: codex --version hung (>5s) - likely auth or config issue" >&2
    return 2
  fi

  echo "run-codex: codex --version failed (rc=$rc)" >&2
  if [[ -n "$stderr_tail" ]]; then
    printf '%s\n' "$stderr_tail" >&2
  fi
  return 3
}

retry_reason() {
  local rc stderr_file stderr_text

  rc="$1"
  stderr_file="$2"
  stderr_text="$(cat "$stderr_file" 2>/dev/null || true)"

  if printf '%s\n' "$stderr_text" | grep -qi 'at capacity'; then
    printf 'capacity'
    return 0
  fi

  if [[ $rc -eq 124 || $rc -eq 143 ]] || printf '%s\n' "$stderr_text" | grep -qi 'timeout'; then
    printf 'timeout'
    return 0
  fi

  printf 'exit=%s' "$rc"
}

retry_delay_for_attempt() {
  local attempt override

  attempt="$1"
  override="${CODEX_RETRY_DELAY:-}"

  if [[ -n "$override" && "$override" =~ ^[0-9]+$ ]]; then
    printf '%s' "$override"
    return 0
  fi

  printf '%s' "$((attempt * 30))"
}

token_suffix() {
  local tokens

  tokens="$(extract_token_count)"

  if [[ -n "$tokens" ]]; then
    printf ' tokens=%s' "$tokens"
  fi
}

extract_token_count() {
  local tokens

  tokens="$(
    tail -n 10 "$attempt_output" 2>/dev/null |
      tr -d '\r' |
      grep -Eio '(^|[^[:alnum:]_])tokens?[[:space:]:][^0-9]{0,19}[0-9]+' |
      tail -n 1 |
      grep -Eo '[0-9]+' || true
  )"

  if [[ -n "$tokens" ]]; then
    printf '%s' "$tokens"
  fi
}

resolve_sprint_id() {
  if [[ -n "${VIBE_SPRINT_ID:-}" ]]; then
    printf '%s' "$VIBE_SPRINT_ID"
    return 0
  fi

  local status_file sid
  status_file=".vibe/agent/sprint-status.json"
  if [[ ! -f "$status_file" ]]; then
    return 1
  fi

  sid="$(
    grep -Eo '"currentSprintId"[[:space:]]*:[[:space:]]*"[^"]*"' "$status_file" |
      sed -E 's/.*"currentSprintId"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' |
      head -n 1 || true
  )"
  if [[ -n "$sid" && "$sid" != "idle" ]]; then
    printf '%s' "$sid"
    return 0
  fi

  return 1
}

iso_from_epoch() {
  local ts
  ts="$1"

  date -u -d "@$ts" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ||
    date -u -r "$ts" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ||
    return 1
}

status_tick_after_success() {
  local script_dir sprint_id tokens iso args tick_output tick_rc

  tokens="$(extract_token_count)"
  if [[ -z "$tokens" ]]; then
    echo "[run-codex] status-tick: skipped reason=no-tokens" >&2
    return 0
  fi

  if ! sprint_id="$(resolve_sprint_id)"; then
    echo "[run-codex] status-tick: skipped reason=no-sprint" >&2
    return 0
  fi

  script_dir="$(cd "$(dirname "$0")" && pwd)"
  args=("$script_dir/vibe-status-tick.mjs" --add-tokens "$tokens" --sprint "$sprint_id")
  if iso="$(iso_from_epoch "$start_ts")"; then
    args+=(--elapsed-start "$iso")
  fi

  set +e
  tick_output="$(node "${args[@]}" 2>&1)"
  tick_rc=$?
  set -e

  if [[ $tick_rc -eq 0 ]]; then
    echo "[run-codex] status-tick: ticked tokens=$tokens sprint=$sprint_id" >&2
    return 0
  fi

  echo "[run-codex] status-tick: skipped reason=cli-failed rc=$tick_rc ${tick_output}" >&2
}

agent_session_start() {
  if [[ "${VIBE_SKIP_AGENT_SESSION_START:-}" == "1" ]]; then
    return 0
  fi

  local script_dir script_path
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  script_path="$script_dir/vibe-agent-session-start.mjs"

  if [[ ! -f "$script_path" ]] || ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  node "$script_path" >&2 || true
}

# ---------- 0. Subcommand dispatch ----------
# Must run BEFORE locale forcing / chcp / stdin buffering so --health returns fast.
if [[ $# -ge 1 ]]; then
  case "$1" in
    --health|--version)
      set +e
      run_health_check
      rc=$?
      set -e
      exit "$rc"
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
  esac
fi

agent_session_start

attempt_output="$(mktemp "${TMPDIR:-/tmp}/run-codex.XXXXXX")"
attempt_stderr="$(mktemp "${TMPDIR:-/tmp}/run-codex.XXXXXX")"
cleanup() {
  rm -f "$attempt_output" "$attempt_stderr"
}
trap cleanup EXIT

is_windows_host() {
  local uname_s os_name

  uname_s="$(uname -s 2>/dev/null || true)"
  os_name="${OS:-}"

  case "$uname_s" in
    MINGW*|MSYS*|CYGWIN*)
      return 0
      ;;
  esac

  [[ "$os_name" == "Windows_NT" ]]
}

windows_sandbox_limitation_header() {
  cat <<'EOF'
## Host OS sandbox limitation (auto-injected)

현 호스트는 Windows. Codex sandbox 는 Windows 에서 child process spawn 을 대부분 차단 (spawn EPERM). 다음 명령은 Codex self-verify 단계에서 시도 금지 — 실패 확정이며 wall-clock 만 소모한다:

- `npx tsc --noEmit`, `npm test`, `node --test`
- `node scripts/vibe-preflight.mjs`
- `node scripts/vibe-gen-schemas.mjs --check`
- `tsx` / `esbuild` 또는 기타 child process spawn 을 필요로 하는 명령

대신 **static inspection** (파일 read + 타입/패턴 분석) 만으로 Acceptance Criteria 판정. 실제 실행 검증은 Orchestrator 가 sandbox 밖에서 수행.

Final report `## Sandbox-only failures` 섹션에 위 명령 언급 불필요 — Windows 는 기본값.

---
EOF
}

trim_section_body() {
  awk '
    {
      lines[NR] = $0
      if ($0 !~ /^[[:space:]]*$/) {
        if (start == 0) {
          start = NR
        }
        last = NR
      }
    }
    END {
      if (start == 0) {
        exit
      }
      for (i = start; i <= last; i++) {
        print lines[i]
      }
    }
  '
}

emit_sandbox_only_summary() {
  local section normalized first_nonempty item_count preview

  section="$(
    awk '
      /^## Sandbox-only failures[[:space:]]*$/ { in_section = 1; next }
      in_section && /^##[[:space:]]/ { exit }
      in_section { print }
    ' "$attempt_output" | trim_section_body
  )"

  if [[ -z "$section" ]]; then
    return 0
  fi

  first_nonempty="$(
    printf '%s\n' "$section" | awk '
      NF {
        print
        exit
      }
    '
  )"
  normalized="$(printf '%s' "$first_nonempty" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

  if [[ "$normalized" == "- none" ]]; then
    return 0
  fi

  item_count="$(printf '%s\n' "$section" | grep -c '^[[:space:]]*-[[:space:]]' || true)"
  if [[ "$item_count" -lt 1 ]]; then
    return 0
  fi

  preview="$(printf '%s\n' "$section" | awk 'NR <= 20 { print }')"

  echo "──── run-codex.sh: Sandbox-only failures 감지 ────" >&2
  echo "(${item_count}개 항목. Orchestrator가 샌드박스 밖에서 재검증 필요.)" >&2
  printf '%s\n' "$preview" >&2
  echo "───────────────────────────────────────────────" >&2
}

# ---------- 1. Force UTF-8 in the parent shell ----------
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LANGUAGE=en_US.UTF-8
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
export DOTNET_SYSTEM_GLOBALIZATION_USENLS=false

# ---------- 2. Flip Windows console code page to UTF-8 ----------
if command -v chcp.com >/dev/null 2>&1; then
  chcp.com 65001 >/dev/null 2>&1 || true
fi

# ---------- 3. Build codex argv ----------
sandbox="${CODEX_SANDBOX:-workspace-write}"

codex_args=(
  exec
  -s "$sandbox"
  -c 'shell_environment_policy.inherit=all'
  -c 'shell_environment_policy.set.LC_ALL="en_US.UTF-8"'
  -c 'shell_environment_policy.set.LANG="en_US.UTF-8"'
  -c 'shell_environment_policy.set.LANGUAGE="en_US.UTF-8"'
  -c 'shell_environment_policy.set.PYTHONUTF8="1"'
  -c 'shell_environment_policy.set.PYTHONIOENCODING="utf-8"'
  -c 'shell_environment_policy.set.DOTNET_SYSTEM_GLOBALIZATION_USENLS="false"'
)

if [[ -n "${CODEX_MODEL:-}" ]]; then
  codex_args+=(-m "$CODEX_MODEL")
fi

if [[ -n "${CODEX_EXTRA_CONFIG:-}" ]]; then
  # shellcheck disable=SC2206
  extra=( $CODEX_EXTRA_CONFIG )
  codex_args+=( "${extra[@]}" )
fi

if [[ $# -eq 0 && -t 0 ]]; then
  print_usage >&2
  exit 1
fi

# ---------- 4. Buffer stdin so retries can replay it ----------
stdin_buf=""
if [[ ! -t 0 ]]; then
  stdin_buf=$(cat)
fi

# ---------- 4b. Inject common rules into prompt ----------
RULES_FILE=".vibe/agent/_common-rules.md"
if [[ -n "$stdin_buf" && -f "$RULES_FILE" ]]; then
  rules_content=$(cat "$RULES_FILE")
  if is_windows_host; then
    rules_content="$(printf '%s\n\n%s' "$(windows_sandbox_limitation_header)" "$rules_content")"
    echo "[run-codex] injected Windows sandbox limitation header" >&2
  fi
  stdin_buf="$(printf '%s\n\n---\n\n%s' "$rules_content" "$stdin_buf")"
  echo "[run-codex] injected common rules from $RULES_FILE" >&2
fi

# ---------- 5. Retry loop ----------
retries="${CODEX_RETRY:-3}"
attempt=0
start_ts="$(date +%s)"
model_label="${CODEX_MODEL:-default}"
while [[ $attempt -lt $retries ]]; do
  attempt=$((attempt + 1))
  : >"$attempt_output"
  : >"$attempt_stderr"
  echo "[run-codex] attempt $attempt/$retries starting (sandbox=$sandbox, model=$model_label)" >&2

  set +e
  if [[ -n "$stdin_buf" ]]; then
    printf '%s' "$stdin_buf" | codex "${codex_args[@]}" "$@" 2>"$attempt_stderr" | tee "$attempt_output"
  else
    codex "${codex_args[@]}" "$@" 2>"$attempt_stderr" | tee "$attempt_output"
  fi
  rc=$?
  set -e

  if [[ -s "$attempt_stderr" ]]; then
    cat "$attempt_stderr" >&2
  fi

  if [[ $rc -eq 0 ]]; then
    emit_sandbox_only_summary
    elapsed=$(( $(date +%s) - start_ts ))
    echo "[run-codex] total attempts=$attempt elapsed=${elapsed}s$(token_suffix)" >&2
    status_tick_after_success
    rm -f .vibe/agent/codex-unavailable.flag
    exit 0
  fi

  if [[ $attempt -ge $retries ]]; then
    emit_sandbox_only_summary
    elapsed=$(( $(date +%s) - start_ts ))
    echo "[run-codex] giving up after $attempt attempts elapsed=${elapsed}s last_exit=$rc" >&2
    case "$(tail -n 20 "$attempt_stderr" 2>/dev/null | grep -Eio "403|401|429|5[0-9][0-9]" | head -n 1 || true)" in
      403) reason_hint="403-forbidden" ;;
      401) reason_hint="401-unauthorized" ;;
      429) reason_hint="429-rate-limit" ;;
      5*) reason_hint="5xx-server-error" ;;
      *) reason_hint="unknown" ;;
    esac
    mkdir -p .vibe/agent
    printf '%s\nlast_exit=%s\nreason_hint=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$rc" "$reason_hint" > .vibe/agent/codex-unavailable.flag
    cat >&2 <<EOF
[run-codex] CODEX_UNAVAILABLE — 3 retries exhausted (last exit=$rc, $reason_hint).
                  Orchestrator 는 아래 중 하나 선택:
                  (1) 시간차 재시도 (quota 아닌 edge block 일 수 있음)
                  (2) 사용자 승인 하에 Orchestrator 직접 편집
                      → session-log 에 [decision][orchestrator-hotfix] 기록 필수
                  (3) \`.vibe/config.json.providers\` 에 fallback provider 추가 후 재시도
EOF
    exit $rc
  fi

  delay="$(retry_delay_for_attempt "$attempt")"
  echo "[run-codex] attempt $attempt/$retries retrying reason=$(retry_reason "$rc" "$attempt_stderr") delay=${delay}s" >&2
  if [[ "$delay" -gt 0 ]]; then
    sleep "$delay"
  fi
done
