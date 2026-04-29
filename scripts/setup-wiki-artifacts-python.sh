#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${WIKI_ARTIFACT_PYTHON_VENV_DIR:-$ROOT_DIR/.venv-wiki-artifacts}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-wiki-artifacts-python.sh

Creates a local Python virtualenv for worker-owned wiki artifact renderers and
installs chart/report dependencies used by generated Python renderers.

Environment:
  WIKI_ARTIFACT_PYTHON_VENV_DIR  Override virtualenv path.
  PYTHON_BIN                     Python used to create the virtualenv.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip wheel setuptools
"$VENV_DIR/bin/python" -m pip install --upgrade matplotlib

echo "WIKI_ARTIFACT_PYTHON_BIN=$VENV_DIR/bin/python"
