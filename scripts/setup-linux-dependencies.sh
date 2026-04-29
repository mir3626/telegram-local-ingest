#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_SENSEVOICE=0
WITH_ARTIFACT_PYTHON=1
SKIP_APT=0
UPDATE_ENV=1

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-linux-dependencies.sh [options]

Installs Linux dependencies used by telegram-local-ingest:
  - ffmpeg for audio preprocessing
  - pandoc for DOCX rendering
  - poppler-utils for PDF text/page extraction
  - tesseract OCR with English, Korean, Simplified Chinese, and Japanese packs
  - Noto CJK fonts for Korean/Chinese/Japanese PDF rendering
  - Python venv/pip build prerequisites for optional local SenseVoice STT
  - Python virtualenv with matplotlib for wiki artifact chart renderers

Options:
  --with-sensevoice  Also run scripts/setup-sensevoice-cpu.sh after system setup.
  --skip-artifact-python
                      Skip the wiki artifact Python virtualenv setup.
  --skip-apt         Skip apt-get package installation and only update .env/check tools.
  --no-env           Do not create or update .env safe defaults.
  -h, --help         Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-sensevoice)
      WITH_SENSEVOICE=1
      shift
      ;;
    --skip-artifact-python)
      WITH_ARTIFACT_PYTHON=0
      shift
      ;;
    --skip-apt)
      SKIP_APT=1
      shift
      ;;
    --no-env)
      UPDATE_ENV=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

apt_packages=(
  ca-certificates
  curl
  git
  fontconfig
  ffmpeg
  sqlite3
  python3
  python3-venv
  python3-pip
  build-essential
  pandoc
  poppler-utils
  tesseract-ocr
  tesseract-ocr-eng
  tesseract-ocr-kor
  tesseract-ocr-chi-sim
  tesseract-ocr-jpn
  fonts-noto-cjk
)

install_apt_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "This setup script currently supports Debian/Ubuntu apt-based Linux only." >&2
    echo "Install these packages manually, or rerun with --skip-apt after installing them." >&2
    printf '  %s\n' "${apt_packages[@]}" >&2
    exit 1
  fi
  local sudo_cmd=()
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      echo "sudo is required when running this script as a non-root user." >&2
      exit 1
    fi
    sudo_cmd=(sudo)
  fi

  local missing=()
  local package
  for package in "${apt_packages[@]}"; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed"; then
      missing+=("$package")
    fi
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "Linux system packages are already installed."
    return
  fi

  echo "Installing Linux system packages:"
  printf '  %s\n' "${missing[@]}"
  "${sudo_cmd[@]}" apt-get update
  "${sudo_cmd[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
}

command_path() {
  command -v "$1" 2>/dev/null || true
}

find_noto_cjk_font() {
  local candidates=(
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"
    "/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf"
    "/usr/share/fonts/truetype/noto/NotoSansCJKkr-Regular.otf"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  if command -v fc-match >/dev/null 2>&1; then
    local matched
    matched="$(fc-match -f '%{file}\n' 'Noto Sans CJK KR' 2>/dev/null | head -n 1 || true)"
    if [[ -n "$matched" && -f "$matched" ]]; then
      printf '%s\n' "$matched"
    fi
  fi
}

escape_sed_replacement() {
  sed -e 's/[\/&]/\\&/g' <<<"$1"
}

set_env_default() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  if [[ -z "$value" ]]; then
    return
  fi

  if grep -qE "^${key}=" "$env_file"; then
    local current
    current="$(grep -m 1 -E "^${key}=" "$env_file" | cut -d= -f2-)"
    if [[ -n "$current" ]]; then
      echo "Keeping existing $key=$current"
      return
    fi

    local escaped
    escaped="$(escape_sed_replacement "$value")"
    sed -i "0,/^${key}=.*/s//${key}=${escaped}/" "$env_file"
    echo "Set $key=$value"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$env_file"
    echo "Added $key=$value"
  fi
}

update_env_defaults() {
  local env_file="$ROOT_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    if [[ -f "$ROOT_DIR/.env.example" ]]; then
      cp "$ROOT_DIR/.env.example" "$env_file"
      echo "Created .env from .env.example"
    else
      touch "$env_file"
      echo "Created empty .env"
    fi
  fi

  set_env_default "$env_file" "FFMPEG_PATH" "$(command_path ffmpeg)"
  set_env_default "$env_file" "PANDOC_BIN" "$(command_path pandoc)"
  set_env_default "$env_file" "PDFTOTEXT_BIN" "$(command_path pdftotext)"
  set_env_default "$env_file" "PDFTOPPM_BIN" "$(command_path pdftoppm)"
  set_env_default "$env_file" "TESSERACT_BIN" "$(command_path tesseract)"
  set_env_default "$env_file" "PDF_FONT_PATH" "$(find_noto_cjk_font)"
  if [[ -x "$ROOT_DIR/.venv-wiki-artifacts/bin/python" ]]; then
    set_env_default "$env_file" "WIKI_ARTIFACT_PYTHON_BIN" "$ROOT_DIR/.venv-wiki-artifacts/bin/python"
  fi
}

print_versions() {
  echo
  echo "Detected tool versions:"
  if command -v node >/dev/null 2>&1; then
    node -v | sed 's/^/  node: /'
  else
    echo "  node: not found (install Node.js 24+ before running the worker)"
  fi
  if command -v npm >/dev/null 2>&1; then
    npm -v | sed 's/^/  npm: /'
  else
    echo "  npm: not found"
  fi
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -version 2>/dev/null | head -n 1 | sed 's/^/  /'
  else
    echo "  ffmpeg: not found"
  fi
  if command -v pandoc >/dev/null 2>&1; then
    pandoc --version | head -n 1 | sed 's/^/  /'
  else
    echo "  pandoc: not found"
  fi
  if command -v pdftotext >/dev/null 2>&1; then
    pdftotext -v 2>&1 | head -n 1 | sed 's/^/  /'
  else
    echo "  pdftotext: not found"
  fi
  if command -v pdftoppm >/dev/null 2>&1; then
    pdftoppm -v 2>&1 | head -n 1 | sed 's/^/  /'
  else
    echo "  pdftoppm: not found"
  fi
  if command -v tesseract >/dev/null 2>&1; then
    tesseract --version | head -n 1 | sed 's/^/  /'
    echo "  tesseract languages:"
    tesseract --list-langs 2>/dev/null | sed 's/^/    /'
  else
    echo "  tesseract: not found"
  fi
  if command -v fc-match >/dev/null 2>&1; then
    fc-match 'Noto Sans CJK KR' | sed 's/^/  font: /'
  else
    echo "  fontconfig: not found"
  fi
  local artifact_python="${WIKI_ARTIFACT_PYTHON_BIN:-$ROOT_DIR/.venv-wiki-artifacts/bin/python}"
  if [[ -x "$artifact_python" ]]; then
    "$artifact_python" --version 2>&1 | sed 's/^/  artifact python: /'
    "$artifact_python" -c "import matplotlib; print('matplotlib ok')" 2>&1 | sed 's/^/  artifact python: /'
  else
    echo "  artifact python: not found"
  fi
}

if [[ "$SKIP_APT" -eq 0 ]]; then
  install_apt_packages
else
  echo "Skipping apt package installation."
fi

if [[ "$WITH_ARTIFACT_PYTHON" -eq 1 ]]; then
  bash "$ROOT_DIR/scripts/setup-wiki-artifacts-python.sh"
else
  echo
  echo "Wiki artifact Python setup was skipped."
fi

if [[ "$UPDATE_ENV" -eq 1 ]]; then
  update_env_defaults
else
  echo "Skipping .env updates."
fi

if [[ "$WITH_SENSEVOICE" -eq 1 ]]; then
  bash "$ROOT_DIR/scripts/setup-sensevoice-cpu.sh"
else
  echo
  echo "SenseVoice local CPU setup was skipped."
  echo "Run npm run setup:linux:sensevoice later if you want local CPU STT."
fi

print_versions

echo
echo "Linux dependency setup complete."
echo "Next steps:"
echo "  1. Fill .env with Telegram, RTZR, vault, and agent command values."
echo "  2. Run npm install."
echo "  3. Run npm run smoke:ready."
