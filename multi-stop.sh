#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Multi-Agent Stop
# Stop tmux session + kill semua process node bot.
# =====================================================
SESSION="sleepy-arena"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
  echo "==> Tmux session '$SESSION' killed"
else
  echo "==> Session '$SESSION' tidak jalan"
fi

# Safety: kill semua node yang menjalankan src/index.js bot ini
pkill -f "node.*xsleepybot/src/index.js" 2>/dev/null && \
  echo "==> Process node leftover dimatikan" || \
  echo "==> Tidak ada process node leftover"

# Lepas wake-lock
if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock
  echo "==> wake-lock dilepas"
fi

echo
echo "Semua agent dihentikan."
