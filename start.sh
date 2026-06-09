#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Run bot dengan termux-wake-lock supaya tidak tidur.
# Jalankan: bash start.sh
# Stop:     Ctrl+C (wake-lock akan dilepas otomatis)
# =====================================================
set -e

# Cegah HP tidur saat bot jalan
if command -v termux-wake-lock >/dev/null 2>&1; then
  echo "==> Mengaktifkan termux-wake-lock..."
  termux-wake-lock
  trap 'echo "==> Melepas wake-lock..."; termux-wake-unlock || true' EXIT
fi

echo "==> Bot start. Tekan Ctrl+C untuk stop."
exec node src/index.js
