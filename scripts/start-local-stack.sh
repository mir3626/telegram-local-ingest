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

if [[ ! -f .env ]]; then
  echo "Missing .env in $ROOT_DIR"
  exit 1
fi

load_env_file ./.env

resolve_path() {
  local value="$1"
  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$ROOT_DIR/$value"
  fi
}

is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

write_pid() {
  local pid_file="$1"
  local pid="$2"
  printf '%s\n' "$pid" > "$pid_file"
}

start_detached() {
  local log_file="$1"
  shift
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$@" >> "$log_file" 2>&1 &
  else
    nohup "$@" >> "$log_file" 2>&1 &
  fi
  printf '%s\n' "$!"
}

wait_until_alive() {
  local name="$1"
  local pid="$2"
  for _ in {1..20}; do
    if is_alive "$pid"; then
      return 0
    fi
    sleep 0.25
  done
  echo "$name failed to stay running: pid=$pid"
  return 1
}

pid_from_file() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] && sed -n '1p' "$pid_file" || true
}

start_bot_api() {
  local bot_pid
  bot_pid="$(pid_from_file "$BOT_API_PID")"
  if is_alive "$bot_pid"; then
    echo "Telegram Local Bot API Server already running: pid=$bot_pid"
    return
  fi
  rm -f "$BOT_API_PID"

  if command -v curl >/dev/null 2>&1 && curl -fsS "$TELEGRAM_BOT_API_BASE_URL/bot${TELEGRAM_BOT_TOKEN}/getMe" >/dev/null 2>&1; then
    local existing_pid
    existing_pid="$(pgrep -f "telegram-bot-api.*--http-port=${BOT_API_PORT}" | head -n 1 || true)"
    if [[ -n "$existing_pid" ]]; then
      write_pid "$BOT_API_PID" "$existing_pid"
      echo "Telegram Local Bot API Server already reachable; adopted pid=$existing_pid"
    else
      echo "Telegram Local Bot API Server already reachable; pid unknown"
    fi
    return
  fi

  if [[ ! -x "$BOT_API_BIN" ]]; then
    echo "Missing executable telegram-bot-api binary: $BOT_API_BIN"
    exit 1
  fi

  mkdir -p "$BOT_API_DIR" "$BOT_API_TEMP"
  echo "Starting Telegram Local Bot API Server..."
  local started_pid
  started_pid="$(start_detached "$BOT_API_LOG" "$BOT_API_BIN" \
    --api-id="$TELEGRAM_API_ID" \
    --api-hash="$TELEGRAM_API_HASH" \
    --local \
    --dir="$BOT_API_DIR" \
    --temp-dir="$BOT_API_TEMP" \
    --http-ip-address="$BOT_API_HOST" \
    --http-port="$BOT_API_PORT")"
  wait_until_alive "Telegram Local Bot API Server" "$started_pid"
  write_pid "$BOT_API_PID" "$started_pid"
  echo "Telegram Local Bot API Server started: pid=$(cat "$BOT_API_PID"), log=$BOT_API_LOG"
}

start_worker() {
  local worker_pid
  worker_pid="$(pid_from_file "$WORKER_PID")"
  if is_alive "$worker_pid"; then
    echo "telegram-local-ingest worker already running: pid=$worker_pid"
    return
  fi
  rm -f "$WORKER_PID"

  echo "Checking live smoke readiness..."
  if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    . "$HOME/.nvm/nvm.sh"
  fi
  npm run smoke:ready

  echo "Starting telegram-local-ingest worker..."
  local started_pid
  started_pid="$(start_detached "$WORKER_LOG" bash -lc "cd '$ROOT_DIR' && if [ -f \"\$HOME/.nvm/nvm.sh\" ]; then . \"\$HOME/.nvm/nvm.sh\"; fi; npm run worker:dev")"
  wait_until_alive "telegram-local-ingest worker" "$started_pid"
  write_pid "$WORKER_PID" "$started_pid"
  echo "telegram-local-ingest worker started: pid=$(cat "$WORKER_PID"), log=$WORKER_LOG"
}

start_ops_dashboard() {
  local dashboard_pid
  dashboard_pid="$(pid_from_file "$OPS_DASHBOARD_PID")"
  if is_alive "$dashboard_pid"; then
    echo "ops dashboard already running: pid=$dashboard_pid"
    return
  fi
  rm -f "$OPS_DASHBOARD_PID"

  local dashboard_host="${OPS_DASHBOARD_HOST:-127.0.0.1}"
  local dashboard_port="${OPS_DASHBOARD_PORT:-58991}"
  if command -v curl >/dev/null 2>&1 && curl -fsS "http://${dashboard_host}:${dashboard_port}/api/state" >/dev/null 2>&1; then
    local existing_pid
    existing_pid="$(pgrep -f "apps/ops-dashboard/src/index.ts" | head -n 1 || true)"
    if [[ -n "$existing_pid" ]]; then
      write_pid "$OPS_DASHBOARD_PID" "$existing_pid"
      echo "ops dashboard already reachable; adopted pid=$existing_pid"
    else
      echo "ops dashboard already reachable; pid unknown"
    fi
    return
  fi

  echo "Starting ops dashboard..."
  local started_pid
  started_pid="$(start_detached "$OPS_DASHBOARD_LOG" bash -lc "cd '$ROOT_DIR' && if [ -f \"\$HOME/.nvm/nvm.sh\" ]; then . \"\$HOME/.nvm/nvm.sh\"; fi; exec node --import tsx apps/ops-dashboard/src/index.ts")"
  wait_until_alive "ops dashboard" "$started_pid"
  write_pid "$OPS_DASHBOARD_PID" "$started_pid"
  echo "ops dashboard started: pid=$(cat "$OPS_DASHBOARD_PID"), url=http://${dashboard_host}:${dashboard_port}/, log=$OPS_DASHBOARD_LOG"
}

RUNTIME_DIR="$(resolve_path "${INGEST_RUNTIME_DIR:-./runtime}")"
LOG_DIR="${INGEST_LOG_DIR:-$RUNTIME_DIR/logs}"
PID_DIR="${INGEST_PID_DIR:-$RUNTIME_DIR/pids}"
mkdir -p "$LOG_DIR" "$PID_DIR"

BOT_API_BIN="${TELEGRAM_BOT_API_BIN:-$HOME/.local/bin/telegram-bot-api}"
BOT_API_DIR="${TELEGRAM_LOCAL_FILES_ROOT:-$HOME/telegram-bot-api-data}"
BOT_API_TEMP="${TELEGRAM_BOT_API_TEMP_DIR:-$HOME/telegram-bot-api-temp}"
BOT_API_HOST="${TELEGRAM_BOT_API_HOST:-127.0.0.1}"
BOT_API_PORT="${TELEGRAM_BOT_API_PORT:-8081}"
BOT_API_LOG="$LOG_DIR/bot-api.log"
WORKER_LOG="$LOG_DIR/worker.log"
OPS_DASHBOARD_LOG="${OPS_DASHBOARD_LOG:-$LOG_DIR/ops-dashboard.log}"
BOT_API_PID="$PID_DIR/bot-api.pid"
WORKER_PID="$PID_DIR/worker.pid"
OPS_DASHBOARD_PID="${OPS_DASHBOARD_PID:-$PID_DIR/ops-dashboard.pid}"

start_bot_api
sleep 2
start_worker
start_ops_dashboard

echo
echo "Local ingest stack is running."
echo "Logs:"
echo "  Bot API: $BOT_API_LOG"
echo "  Worker : $WORKER_LOG"
echo "  Ops UI : $OPS_DASHBOARD_LOG"
echo
echo "Dashboard: http://${OPS_DASHBOARD_HOST:-127.0.0.1}:${OPS_DASHBOARD_PORT:-58991}/"
