#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
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

RUNTIME_DIR="$(resolve_path "${INGEST_RUNTIME_DIR:-./runtime}")"
PID_DIR="${INGEST_PID_DIR:-$RUNTIME_DIR/pids}"
BOT_API_PID="$PID_DIR/bot-api.pid"
WORKER_PID="$PID_DIR/worker.pid"

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

echo "Local ingest stack status:"
echo "  Telegram Local Bot API Server: $bot_state"
echo "  telegram-local-ingest worker : $worker_state"

if [[ "$bot_running" -eq 0 && "$worker_running" -eq 0 ]]; then
  exit 0
fi
if [[ "$bot_running" -eq 0 || "$worker_running" -eq 0 ]]; then
  exit 2
fi
exit 1
