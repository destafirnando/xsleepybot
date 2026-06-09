#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Installer untuk Termux - jalankan SEKALI saat pertama setup:
#   bash install.sh
# =====================================================
set -e

echo "==> Update pkg index..."
pkg update -y && pkg upgrade -y

echo "==> Install Node.js + tools..."
pkg install -y nodejs-lts git termux-api

echo "==> Install dependencies dari package.json..."
npm install

echo "==> Setup .env..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "=========================================================="
  echo "  File .env sudah dibuat. Edit dulu pakai:"
  echo "    nano .env"
  echo ""
  echo "  Isi minimal: AGENT_NAME (kalau belum punya API key)"
  echo "=========================================================="
else
  echo "  .env sudah ada, skip."
fi

echo ""
echo "==> SELESAI! Jalankan bot dengan:"
echo "    bash start.sh"
