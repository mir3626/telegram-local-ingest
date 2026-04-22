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

RUNTIME_DIR="$(resolve_path "${INGEST_RUNTIME_DIR:-./runtime}")"
LOG_DIR="${INGEST_LOG_DIR:-$RUNTIME_DIR/logs}"
LOG_FILE="$LOG_DIR/worker.log"

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

echo "Following telegram-local-ingest worker log:"
echo "  $LOG_FILE"
echo
tail -n "${INGEST_LOG_TAIL_LINES:-160}" -f "$LOG_FILE"
