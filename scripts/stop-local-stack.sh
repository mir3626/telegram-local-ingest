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

stop_pid_file() {
  local name="$1"
  local pid_file="$2"
  if [[ ! -f "$pid_file" ]]; then
    echo "$name not managed by pid file: $pid_file"
    return
  fi

  local pid
  pid="$(sed -n '1p' "$pid_file")"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "$name pid is not running: ${pid:-empty}"
    rm -f "$pid_file"
    return
  fi

  echo "Stopping $name: pid=$pid"
  kill "$pid" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$pid_file"
      echo "$name stopped"
      return
    fi
    sleep 0.25
  done

  echo "$name did not stop gracefully; sending SIGKILL"
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$pid_file"
}

RUNTIME_DIR="$(resolve_path "${INGEST_RUNTIME_DIR:-./runtime}")"
PID_DIR="${INGEST_PID_DIR:-$RUNTIME_DIR/pids}"

stop_pid_file "telegram-local-ingest worker" "$PID_DIR/worker.pid"
stop_pid_file "Telegram Local Bot API Server" "$PID_DIR/bot-api.pid"
