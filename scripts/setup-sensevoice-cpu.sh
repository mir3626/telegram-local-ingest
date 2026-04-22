#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${SENSEVOICE_VENV_DIR:-$ROOT_DIR/.venv-sensevoice}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SENSEVOICE_MODEL="${SENSEVOICE_MODEL:-iic/SenseVoiceSmall}"
SENSEVOICE_VAD_MODEL="${SENSEVOICE_VAD_MODEL:-fsmn-vad}"
SENSEVOICE_DEVICE="${SENSEVOICE_DEVICE:-cpu}"
SENSEVOICE_MAX_SINGLE_SEGMENT_TIME_MS="${SENSEVOICE_MAX_SINGLE_SEGMENT_TIME_MS:-30000}"
SENSEVOICE_PREWARM="${SENSEVOICE_PREWARM:-1}"

echo "Creating SenseVoice CPU virtualenv: $VENV_DIR"
"$PYTHON_BIN" -m venv "$VENV_DIR"

# shellcheck source=/dev/null
. "$VENV_DIR/bin/activate"

python -m pip install --upgrade pip wheel setuptools
python -m pip install --upgrade funasr modelscope torch torchaudio

if [[ "$SENSEVOICE_PREWARM" != "0" ]]; then
  echo
  echo "Prewarming SenseVoice model cache..."
  echo "  model: $SENSEVOICE_MODEL"
  echo "  vad:   $SENSEVOICE_VAD_MODEL"
  echo "  device:$SENSEVOICE_DEVICE"
  python "$ROOT_DIR/scripts/sensevoice-prewarm.py" \
    --model "$SENSEVOICE_MODEL" \
    --vad-model "$SENSEVOICE_VAD_MODEL" \
    --device "$SENSEVOICE_DEVICE" \
    --max-single-segment-time-ms "$SENSEVOICE_MAX_SINGLE_SEGMENT_TIME_MS"
fi

echo
echo "SenseVoice CPU environment is ready."
echo "Set this in .env to use it:"
echo "STT_PROVIDER=sensevoice"
echo "SENSEVOICE_PYTHON=$VENV_DIR/bin/python"
echo
echo "To skip model prewarm on a future setup run:"
echo "SENSEVOICE_PREWARM=0 bash scripts/setup-sensevoice-cpu.sh"
