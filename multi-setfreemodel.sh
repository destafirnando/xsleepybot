#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Set FREEMODEL_API_KEY (freemodel.dev) ke SEMUA agents/NN/.env
# Freemodel = PRIORITAS UTAMA solver captcha (GPT-5.5 vision).
#
# Usage interaktif:
#   bash multi-setfreemodel.sh
# Usage non-interaktif:
#   bash multi-setfreemodel.sh <FREEMODEL_API_KEY>
# =====================================================
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$ROOT/agents" ]; then
  echo "ERROR: Folder agents/ belum ada. Run: bash multi-setup.sh COUNT"
  exit 1
fi

DIRS=$(ls -d "$ROOT"/agents/*/ 2>/dev/null | sort)
if [ -z "$DIRS" ]; then
  echo "ERROR: Tidak ada agent di agents/."
  exit 1
fi

COUNT=$(echo "$DIRS" | wc -l)

KEY="${1:-}"
if [ -z "$KEY" ]; then
  echo "================================================================="
  echo "  Set FREEMODEL_API_KEY (freemodel.dev) untuk $COUNT agent"
  echo "  Freemodel = PRIORITAS UTAMA solver captcha (GPT-5.5)"
  echo "================================================================="
  printf "  Paste FREEMODEL_API_KEY: "
  read -r KEY
fi

if [ -z "$KEY" ]; then
  echo "ERROR: API key kosong."
  exit 1
fi

set_env_var() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}=" "$file"; then
    local tmp
    tmp=$(mktemp)
    awk -v k="$key" -v v="$val" 'BEGIN{FS="=";OFS="="} $1==k{print k"="v; next} {print}' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

UPDATED=0
for D in $DIRS; do
  ENV_FILE="$D.env"
  [ -f "$ENV_FILE" ] || continue
  set_env_var "$ENV_FILE" "FREEMODEL_API_KEY" "$KEY"
  UPDATED=$((UPDATED+1))
done

PREVIEW=$(echo "$KEY" | cut -c1-8)
echo
echo "================================================================="
echo "  $UPDATED agent ter-update dengan FREEMODEL_API_KEY=${PREVIEW}***"
echo
echo "  Verifikasi: grep FREEMODEL agents/01/.env"
echo "  Restart:    bash multi-stop.sh && bash multi-start.sh"
echo "================================================================="
