#!/usr/bin/env bash
set -euo pipefail

if command -v pandoc >/dev/null 2>&1; then
  echo "DOCX document rendering tool is already installed."
  exit 0
fi

echo "Installing DOCX document rendering tool: pandoc"
sudo apt-get update
sudo apt-get install -y pandoc

echo "Installed:"
pandoc --version | head -1
