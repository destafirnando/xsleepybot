#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Run single agent dengan termux-wake-lock supaya tidak tidur.
# Tampilkan menu mode game di awal.
#
# Usage:
#   bash start.sh           # interactive menu
#   bash start.sh 1         # langsung mode 1 (auto)
#   bash start.sh 2         # langsung mode 2 (coin_snipe)
#   ...
# Stop: Ctrl+C (wake-lock akan dilepas otomatis)
# =====================================================
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env tidak ada. Copy dari template:"
  echo "  cp .env.example .env"
  echo "  nano .env  (isi AGENTHANSA_API_KEY)"
  exit 1
fi

# --- Menu mode ---
MODE="${1:-}"

if [ -z "$MODE" ]; then
  echo "================================================================="
  echo "  PILIH MODE"
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

# --- Update ENABLED_GAMES di .env ---
if grep -q "^ENABLED_GAMES=" "$ENV_FILE"; then
  TMPFILE=$(mktemp)
  awk -v g="$GAMES" '/^ENABLED_GAMES=/{print "ENABLED_GAMES=" g; next} {print}' \
    "$ENV_FILE" > "$TMPFILE"
  mv "$TMPFILE" "$ENV_FILE"
else
  echo "ENABLED_GAMES=$GAMES" >> "$ENV_FILE"
fi

# --- Sub-menu: MAZE_MODE (kalau maze ikut bermain) ---
case ",$GAMES," in
  *,maze,*)
    MAZE_MODE_ARG="${2:-}"
    if [ -z "$MAZE_MODE_ARG" ]; then
      echo
      echo "================================================================="
      echo "  MAZE MODE - pilih strategi maze (game ikut bermain)"
      echo "================================================================="
      echo "  [s] SAFE - target dist 10 (score 100+), survival ~95%  [DEFAULT]"
      echo "  [p] PUSH - target dist 14 (score 140+), survival ~70%"
      echo "================================================================="
      printf "  Pilihan (s/p, Enter=safe): "
      read -r MAZE_MODE_ARG
    fi
    case "$MAZE_MODE_ARG" in
      p|P|push|PUSH) MAZE_MODE="push" ;;
      *) MAZE_MODE="safe" ;;
    esac

    echo "==> MAZE_MODE=$MAZE_MODE"
    if grep -q "^MAZE_MODE=" "$ENV_FILE"; then
      TMPFILE=$(mktemp)
      awk -v m="$MAZE_MODE" '/^MAZE_MODE=/{print "MAZE_MODE=" m; next} {print}' \
        "$ENV_FILE" > "$TMPFILE"
      mv "$TMPFILE" "$ENV_FILE"
    else
      echo "MAZE_MODE=$MAZE_MODE" >> "$ENV_FILE"
    fi
    ;;
esac

# --- Wake-lock ---
if command -v termux-wake-lock >/dev/null 2>&1; then
  echo "==> Mengaktifkan termux-wake-lock..."
  termux-wake-lock
  trap 'echo "==> Melepas wake-lock..."; termux-wake-unlock || true' EXIT
fi

echo "==> Bot start. Tekan Ctrl+C untuk stop."
echo
exec node "$ROOT/src/index.js"
