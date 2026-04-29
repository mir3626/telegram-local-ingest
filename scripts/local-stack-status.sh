#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

load_env_file() {
  local env_file="$1"
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    line="${line#export }"
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ "$value" =~ ^\"(.*)\"$ ]]; then
        value="${BASH_REMATCH[1]}"
      elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
      fi
      export "$key=$value"
    fi
  done < "$env_file"
}

if [[ -f .env ]]; then
  load_env_file ./.env
fi

resolve_path() {
  local value="$1"
  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$ROOT_DIR/$value"
  fi
}

pid_from_file() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] && sed -n '1p' "$pid_file" || true
}

pid_state() {
  local pid_file="$1"
  local pid
  pid="$(pid_from_file "$pid_file")"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    printf 'running pid=%s\n' "$pid"
    return 0
  fi
  if [[ -n "$pid" ]]; then
    printf 'stale pid=%s\n' "$pid"
    return 1
  fi
  printf 'stopped\n'
  return 1
}

timer_state() {
  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'unavailable: systemctl not found\n'
    return 1
  fi
  if ! systemctl --user list-timers >/dev/null 2>&1; then
    printf 'unavailable: systemd user session unavailable\n'
    return 1
  fi
  if systemctl --user is-active --quiet telegram-local-ingest-automation.timer; then
    printf 'active\n'
    return 0
  fi
  if systemctl --user list-unit-files telegram-local-ingest-automation.timer >/dev/null 2>&1; then
    printf 'installed but inactive\n'
    return 1
  fi
  printf 'missing\n'
  return 1
}

RUNTIME_DIR="$(resolve_path "${INGEST_RUNTIME_DIR:-./runtime}")"
PID_DIR="${INGEST_PID_DIR:-$RUNTIME_DIR/pids}"
BOT_API_PID="$PID_DIR/bot-api.pid"
WORKER_PID="$PID_DIR/worker.pid"
OPS_DASHBOARD_PID="${OPS_DASHBOARD_PID:-$PID_DIR/ops-dashboard.pid}"

if bot_state="$(pid_state "$BOT_API_PID")"; then
  bot_running=0
else
  bot_running=1
fi
if worker_state="$(pid_state "$WORKER_PID")"; then
  worker_running=0
else
  worker_running=1
fi
if dashboard_state="$(pid_state "$OPS_DASHBOARD_PID")"; then
  dashboard_running=0
else
  dashboard_running=1
fi
if automation_timer_state="$(timer_state)"; then
  automation_timer_running=0
else
  automation_timer_running=1
fi

echo "Local ingest stack status:"
echo "  Telegram Local Bot API Server: $bot_state"
echo "  telegram-local-ingest worker : $worker_state"
echo "  ops dashboard                : $dashboard_state"
echo "  automation dispatcher timer  : $automation_timer_state"

if [[ "$bot_running" -eq 0 && "$worker_running" -eq 0 && "$dashboard_running" -eq 0 && "$automation_timer_running" -eq 0 ]]; then
  exit 0
fi
if [[ "$bot_running" -eq 0 || "$worker_running" -eq 0 || "$dashboard_running" -eq 0 || "$automation_timer_running" -eq 0 ]]; then
  exit 2
fi
exit 1
