#!/usr/bin/env bash
set -euo pipefail

missing_packages=()
if ! command -v pandoc >/dev/null 2>&1; then
  missing_packages+=("pandoc")
fi
if ! command -v pdftotext >/dev/null 2>&1; then
  missing_packages+=("poppler-utils")
fi
if ! command -v pdftoppm >/dev/null 2>&1; then
  missing_packages+=("poppler-utils")
fi
if ! command -v tesseract >/dev/null 2>&1; then
  missing_packages+=("tesseract-ocr")
fi
if ! command -v fc-match >/dev/null 2>&1; then
  missing_packages+=("fontconfig")
fi
if [[ ! -f "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc" && ! -f "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc" ]]; then
  missing_packages+=("fonts-noto-cjk")
fi
if command -v tesseract >/dev/null 2>&1; then
  available_langs="$(tesseract --list-langs 2>/dev/null || true)"
  grep -qx "eng" <<<"$available_langs" || missing_packages+=("tesseract-ocr-eng")
  grep -qx "kor" <<<"$available_langs" || missing_packages+=("tesseract-ocr-kor")
  grep -qx "chi_sim" <<<"$available_langs" || missing_packages+=("tesseract-ocr-chi-sim")
  grep -qx "jpn" <<<"$available_langs" || missing_packages+=("tesseract-ocr-jpn")
else
  missing_packages+=("tesseract-ocr-eng" "tesseract-ocr-kor" "tesseract-ocr-chi-sim" "tesseract-ocr-jpn")
fi

if [[ ${#missing_packages[@]} -eq 0 ]]; then
  echo "Document, OCR, and CJK font tools are already installed."
  exit 0
fi

mapfile -t missing_packages < <(printf '%s\n' "${missing_packages[@]}" | sort -u)
echo "Installing document, OCR, and CJK font tools: ${missing_packages[*]}"
sudo apt-get update
sudo apt-get install -y "${missing_packages[@]}"

echo "Installed:"
if command -v pandoc >/dev/null 2>&1; then
  pandoc --version | head -1
fi
if command -v pdftotext >/dev/null 2>&1; then
  pdftotext -v 2>&1 | head -1
fi
if command -v pdftoppm >/dev/null 2>&1; then
  pdftoppm -v 2>&1 | head -1
fi
if command -v tesseract >/dev/null 2>&1; then
  tesseract --version | head -1
  tesseract --list-langs 2>/dev/null | sed 's/^/  /'
fi
if command -v fc-match >/dev/null 2>&1; then
  fc-match 'Noto Sans CJK KR' | sed 's/^/  /'
fi
