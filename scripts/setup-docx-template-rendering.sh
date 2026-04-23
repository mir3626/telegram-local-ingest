#!/usr/bin/env bash
set -euo pipefail

if command -v pandoc >/dev/null 2>&1 && { command -v soffice >/dev/null 2>&1 || command -v libreoffice >/dev/null 2>&1; }; then
  echo "DOCX template rendering tools are already installed."
  exit 0
fi

echo "Installing DOCX template rendering tools: pandoc, libreoffice-writer, poppler-utils"
sudo apt-get update
sudo apt-get install -y pandoc libreoffice-writer poppler-utils

echo "Installed:"
pandoc --version | head -1
if command -v soffice >/dev/null 2>&1; then
  soffice --version
else
  libreoffice --version
fi
