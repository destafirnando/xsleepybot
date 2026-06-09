#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Multi-Agent Setup
# Bikin N folder agent (agents/01, agents/02, ...) dengan .env per agent.
#
# Usage:
#   bash multi-setup.sh BASE_NAME COUNT
# Contoh:
#   bash multi-setup.sh sleepy 10
#
# Hasil: 10 folder agent dengan AGENT_NAME=sleepy-01..sleepy-10
# =====================================================
set -e

BASE_NAME="${1:-sleepy}"
COUNT="${2:-10}"

if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 50 ]; then
  echo "ERROR: COUNT harus angka 1-50"
  echo "Usage: bash multi-setup.sh BASE_NAME COUNT"
  echo "Contoh: bash multi-setup.sh sleepy 10"
  exit 1
fi

if ! [[ "$BASE_NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "ERROR: BASE_NAME hanya huruf kecil, angka, dan dash."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/agents"

CREATED=0
SKIPPED=0
for i in $(seq 1 "$COUNT"); do
  PADDED=$(printf "%02d" "$i")
  AGENT_DIR="$ROOT/agents/$PADDED"

  if [ -d "$AGENT_DIR" ]; then
    echo "  [skip]    agents/$PADDED sudah ada"
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  mkdir -p "$AGENT_DIR/state" "$AGENT_DIR/logs"

  AGENT_NAME="$BASE_NAME-$PADDED"
  cat > "$AGENT_DIR/.env" <<EOF
# Auto-generated oleh multi-setup.sh
AGENTHANSA_API_KEY=
AGENT_NAME=$AGENT_NAME
AGENT_DESCRIPTION=Arena bot $AGENT_NAME (Termux multi)

# Game yang diikuti (comma-separated). Skip captcha kalau tidak punya vision API.
ENABLED_GAMES=coin_snipe,crash_pilot,maze

# Vision API untuk captcha (opsional). Set 'anthropic'/'openai'/'gemini' + API key.
VISION_PROVIDER=none
VISION_API_KEY=

# Polling intervals (detik)
IDLE_POLL_INTERVAL=120
ACTIVE_POLL_INTERVAL=10

API_BASE_URL=https://www.agenthansa.com
EOF

  echo "  [ok]      agents/$PADDED -> $AGENT_NAME"
  CREATED=$((CREATED+1))
done

echo
echo "================================================================="
echo "  Created: $CREATED  |  Skipped: $SKIPPED  |  Total: $COUNT"
echo "  Lokasi : $ROOT/agents/"
echo
echo "  Langkah selanjutnya:"
echo "    bash multi-start.sh        # start semua agent di tmux"
echo "    bash multi-status.sh       # cek status"
echo "    bash multi-stop.sh         # stop semua"
echo "================================================================="
