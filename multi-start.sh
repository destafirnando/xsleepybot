#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Multi-Agent Start
# Tampilkan menu pilih mode (1-5), propagate ke semua agent,
# lalu start semua di tmux session.
#
# Usage:
#   bash multi-start.sh           # interactive menu
#   bash multi-start.sh 1         # langsung mode 1 (auto)
#   bash multi-start.sh 2         # langsung mode 2 (coin_snipe)
#   ...
# =====================================================
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
SESSION="sleepy-arena"

# --- Sanity checks ---
if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux belum terinstall."
  echo "Install dulu: pkg install tmux"
  exit 1
fi

if [ ! -d "$ROOT/agents" ]; then
  echo "ERROR: Folder agents/ belum ada."
  echo "Run dulu: bash multi-setup.sh COUNT"
  exit 1
fi

DIRS=$(ls -d "$ROOT"/agents/*/ 2>/dev/null | sort)
if [ -z "$DIRS" ]; then
  echo "ERROR: Tidak ada agent di agents/."
  echo "Run dulu: bash multi-setup.sh COUNT"
  exit 1
fi

COUNT=$(echo "$DIRS" | wc -l)

# --- Menu ---
MODE="${1:-}"

if [ -z "$MODE" ]; then
  echo "================================================================="
  echo "  PILIH MODE untuk SEMUA $COUNT agent"
  echo "================================================================="
  echo "  [1] Auto - join semua tournament (semua 4 game)"
  echo "  [2] Hanya main coin_snipe   (skip game lain)"
  echo "  [3] Hanya main crash_pilot  (skip game lain)"
  echo "  [4] Hanya main captcha      (butuh vision API)"
  echo "  [5] Hanya main maze         (skip game lain)"
  echo "================================================================="
  printf "  Pilihan (1-5): "
  read -r MODE
fi

case "$MODE" in
  1) GAMES="coin_snipe,crash_pilot,captcha,maze"; LABEL="Auto (semua game)" ;;
  2) GAMES="coin_snipe";  LABEL="coin_snipe only" ;;
  3) GAMES="crash_pilot"; LABEL="crash_pilot only" ;;
  4) GAMES="captcha";     LABEL="captcha only" ;;
  5) GAMES="maze";        LABEL="maze only" ;;
  *)
    echo "ERROR: Pilihan tidak valid: '$MODE' (harus 1-5)"
    exit 1
    ;;
esac

echo
echo "==> Mode terpilih: [$MODE] $LABEL"
echo "==> Set ENABLED_GAMES=$GAMES untuk $COUNT agent"

# --- Update ENABLED_GAMES di tiap .env ---
for D in $DIRS; do
  ENV_FILE="$D.env"
  if [ ! -f "$ENV_FILE" ]; then
    echo "  [warn]  $D - .env tidak ada, skip"
    continue
  fi

  if grep -q "^ENABLED_GAMES=" "$ENV_FILE"; then
    TMPFILE=$(mktemp)
    awk -v g="$GAMES" '/^ENABLED_GAMES=/{print "ENABLED_GAMES=" g; next} {print}' \
      "$ENV_FILE" > "$TMPFILE"
    mv "$TMPFILE" "$ENV_FILE"
  else
    echo "ENABLED_GAMES=$GAMES" >> "$ENV_FILE"
  fi
done
echo "==> ENABLED_GAMES updated"
echo

# --- Kill existing session if any ---
tmux kill-session -t "$SESSION" 2>/dev/null || true

# --- Wake-lock biar HP tidak tidur ---
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "==> termux-wake-lock aktif"
fi

# --- Start tmux session, 1 window per agent ---
echo "==> Starting $COUNT agent..."
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
echo "  Mode: [$MODE] $LABEL"
echo
echo "  Lihat semua agent: tmux attach -t $SESSION"
echo "  Detach (keluar tanpa stop): tekan  Ctrl+B  lalu  D"
echo "  Pindah ke window N: Ctrl+B  lalu  N  (angka)"
echo "  Pindah next/prev: Ctrl+B  lalu  N (next) atau P (prev)"
echo "  Stop semua: bash multi-stop.sh"
echo "  Cek status: bash multi-status.sh"
echo "================================================================="
