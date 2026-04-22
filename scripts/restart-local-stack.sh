#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/stop-local-stack.sh"
sleep 1
"$ROOT_DIR/scripts/start-local-stack.sh"
