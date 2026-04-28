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
  local pgid
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$pgid" ]]; then
    kill -- "-$pgid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
  else
    kill "$pid" >/dev/null 2>&1 || true
  fi
  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$pid_file"
      echo "$name stopped"
      return
    fi
    sleep 0.25
  done

  echo "$name did not stop gracefully; sending SIGKILL"
  if [[ -n "$pgid" ]]; then
    kill -9 -- "-$pgid" >/dev/null 2>&1 || kill -9 "$pid" >/dev/null 2>&1 || true
  else
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
}

RUNTIME_DIR="$(resolve_path "${INGEST_RUNTIME_DIR:-./runtime}")"
PID_DIR="${INGEST_PID_DIR:-$RUNTIME_DIR/pids}"

stop_pid_file "ops dashboard" "$PID_DIR/ops-dashboard.pid"
stop_pid_file "telegram-local-ingest worker" "$PID_DIR/worker.pid"
stop_pid_file "Telegram Local Bot API Server" "$PID_DIR/bot-api.pid"
