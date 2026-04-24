#!/usr/bin/env bash
set -euo pipefail

missing_packages=()
if ! command -v pandoc >/dev/null 2>&1; then
  missing_packages+=("pandoc")
fi
if ! command -v pdftotext >/dev/null 2>&1; then
  missing_packages+=("poppler-utils")
fi

if [[ ${#missing_packages[@]} -eq 0 ]]; then
  echo "Document processing tools are already installed."
  exit 0
fi

echo "Installing document processing tools: ${missing_packages[*]}"
sudo apt-get update
sudo apt-get install -y "${missing_packages[@]}"

echo "Installed:"
if command -v pandoc >/dev/null 2>&1; then
  pandoc --version | head -1
fi
if command -v pdftotext >/dev/null 2>&1; then
  pdftotext -v 2>&1 | head -1
fi
