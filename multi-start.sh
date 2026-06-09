#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Multi-Agent Start
# Jalankan semua agent (di folder agents/*/) sebagai 1 tmux session.
# Tiap agent punya 1 window - bisa di-attach untuk lihat log live.
#
# Usage: bash multi-start.sh
# =====================================================
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
SESSION="sleepy-arena"

if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux belum terinstall."
  echo "Install dulu: pkg install tmux"
  exit 1
fi

if [ ! -d "$ROOT/agents" ]; then
  echo "ERROR: Folder agents/ belum ada."
  echo "Run dulu: bash multi-setup.sh BASE_NAME COUNT"
  exit 1
fi

DIRS=$(ls -d "$ROOT"/agents/*/ 2>/dev/null | sort)
if [ -z "$DIRS" ]; then
  echo "ERROR: Tidak ada agent di agents/."
  echo "Run dulu: bash multi-setup.sh BASE_NAME COUNT"
  exit 1
fi

COUNT=$(echo "$DIRS" | wc -l)
echo "==> Akan start $COUNT agent..."
echo

# Kill existing session if any
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Wake-lock biar HP tidak tidur
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "==> termux-wake-lock aktif"
fi

# Create tmux session, 1 window per agent. Stagger 1s antar window biar tidak rate-limit.
FIRST=true
INDEX=0
for D in $DIRS; do
  NAME=$(basename "$D")
  CMD="cd '$D' && exec node '$ROOT/src/index.js'"

  if [ "$FIRST" = "true" ]; then
    tmux new-session -d -s "$SESSION" -n "a$NAME" "$CMD"
    FIRST=false
  else
    sleep 1
    tmux new-window -t "$SESSION" -n "a$NAME" "$CMD"
  fi
  echo "  [start]   agents/$NAME"
  INDEX=$((INDEX+1))
done

echo
echo "================================================================="
echo "  Tmux session '$SESSION' started dengan $INDEX agent."
echo
echo "  Lihat semua agent: tmux attach -t $SESSION"
echo "  Detach (keluar tanpa stop): tekan  Ctrl+B  lalu  D"
echo "  Pindah ke window N: Ctrl+B  lalu  N  (angka)"
echo "  Pindah next/prev: Ctrl+B  lalu  N (next) atau P (prev)"
echo "  Stop semua: bash multi-stop.sh"
echo "================================================================="
