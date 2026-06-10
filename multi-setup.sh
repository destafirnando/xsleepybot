#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Multi-Agent Setup
# Bikin N folder agent (agents/01, agents/02, ...) dengan .env kosong.
# Kamu wajib isi API key tiap .env (manual atau pakai multi-setkeys.sh).
#
# Usage:
#   bash multi-setup.sh COUNT
# Contoh:
#   bash multi-setup.sh 10        # bikin 10 folder
# =====================================================
set -e

COUNT="${1:-10}"

if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 50 ]; then
  echo "ERROR: COUNT harus angka 1-50"
  echo "Usage: bash multi-setup.sh COUNT"
  echo "Contoh: bash multi-setup.sh 10"
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

  cat > "$AGENT_DIR/.env" <<EOF
# Auto-generated oleh multi-setup.sh
# WAJIB: isi AGENTHANSA_API_KEY kamu di bawah ini.
AGENTHANSA_API_KEY=

# Game yang diikuti (comma-separated). Skip captcha kalau tidak punya vision API.
ENABLED_GAMES=coin_snipe,crash_pilot,maze

# Vision API untuk captcha (opsional). Set 'anthropic'/'openai'/'gemini' + API key.
VISION_PROVIDER=none
VISION_API_KEY=

# FREEMODEL.DEV - PRIORITAS UTAMA solver captcha (GPT-5.5). Diisi via multi-setfreemodel.sh
FREEMODEL_API_KEY=

# Fallback provider (dipakai kalau primary wrong, attempt-2). Contoh: gemini.
VISION_FALLBACK=
VISION_FALLBACK_KEY=

# Maze mode: survive (default) | push | aggressive | safe
# Default 'survive' = target dist 11 (score 110+) untuk lewat median R1
MAZE_MODE=survive

# Polling intervals (detik)
IDLE_POLL_INTERVAL=120
ACTIVE_POLL_INTERVAL=10

API_BASE_URL=https://www.agenthansa.com
EOF

  echo "  [ok]      agents/$PADDED (.env kosong, isi API key dulu)"
  CREATED=$((CREATED+1))
done

echo
echo "================================================================="
echo "  Created: $CREATED  |  Skipped: $SKIPPED  |  Total: $COUNT"
echo "  Lokasi : $ROOT/agents/"
echo
echo "  LANGKAH BERIKUTNYA - isi API key:"
echo
echo "  CARA A (cepat) - bulk-fill dari file teks:"
echo "    1. Bikin file keys.txt, isi 1 API key per baris:"
echo "       nano keys.txt"
echo "    2. Run:  bash multi-setkeys.sh keys.txt"
echo
echo "  CARA B (manual per agent):"
echo "    nano agents/01/.env"
echo "    nano agents/02/.env"
echo "    ... dst"
echo
echo "  Setelah API key terisi:"
echo "    bash multi-start.sh        # start semua agent di tmux"
echo "================================================================="
