#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Bulk-fill API keys ke agents/NN/.env dari file teks.
#
# Format file (1 key per baris, baris kosong/komentar # diabaikan):
#   tabb_aaaaaaaaaaaaaaa
#   tabb_bbbbbbbbbbbbbbb
#   # ini komentar, di-skip
#   tabb_ccccccccccccccc
#
# Key di baris 1 -> agents/01/.env
# Key di baris 2 -> agents/02/.env
# dst.
#
# Usage:
#   bash multi-setkeys.sh keys.txt
#   bash multi-setkeys.sh                 # baca dari stdin (Ctrl+D untuk akhiri)
#   echo "tabb_xxx" | bash multi-setkeys.sh
# =====================================================
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
FILE="${1:-}"

if [ ! -d "$ROOT/agents" ]; then
  echo "ERROR: Folder agents/ belum ada."
  echo "Run dulu: bash multi-setup.sh COUNT"
  exit 1
fi

if [ -n "$FILE" ] && [ ! -f "$FILE" ]; then
  echo "ERROR: File '$FILE' tidak ada."
  exit 1
fi

if [ -z "$FILE" ]; then
  echo "==> Baca API key dari stdin (1 per baris). Tekan Ctrl+D saat selesai."
  FILE="/dev/stdin"
fi

INDEX=1
ASSIGNED=0

while IFS= read -r LINE || [ -n "$LINE" ]; do
  KEY=$(echo "$LINE" | tr -d '[:space:]')

  case "$KEY" in
    ''|\#*) continue ;;
  esac

  PADDED=$(printf "%02d" "$INDEX")
  AGENT_DIR="$ROOT/agents/$PADDED"

  if [ ! -d "$AGENT_DIR" ]; then
    echo "  [stop]    agents/$PADDED tidak ada (max $((INDEX-1)) agent), berhenti"
    break
  fi

  if [ ! -f "$AGENT_DIR/.env" ]; then
    echo "  [skip]    agents/$PADDED/.env tidak ada"
    INDEX=$((INDEX+1))
    continue
  fi

  if grep -q "^AGENTHANSA_API_KEY=" "$AGENT_DIR/.env"; then
    TMPFILE=$(mktemp)
    awk -v k="$KEY" '/^AGENTHANSA_API_KEY=/{print "AGENTHANSA_API_KEY=" k; next} {print}' \
      "$AGENT_DIR/.env" > "$TMPFILE"
    mv "$TMPFILE" "$AGENT_DIR/.env"
  else
    echo "AGENTHANSA_API_KEY=$KEY" >> "$AGENT_DIR/.env"
  fi

  PREVIEW=$(echo "$KEY" | cut -c1-9)
  echo "  [ok]      agents/$PADDED <- ${PREVIEW}***"
  ASSIGNED=$((ASSIGNED+1))
  INDEX=$((INDEX+1))
done < "$FILE"

echo
echo "================================================================="
echo "  $ASSIGNED keys assigned ke agents."
echo
echo "  Verifikasi (tampilkan key tersamarkan):"
echo "    grep API_KEY agents/*/.env | sed 's/=tabb_.*/=tabb_*****/'"
echo
echo "  Start semua agent:"
echo "    bash multi-start.sh"
echo "================================================================="
