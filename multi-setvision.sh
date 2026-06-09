#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Bulk-set vision API config ke SEMUA agents/NN/.env.
#
# Set primary + (optional) fallback provider sekaligus.
#
# Usage interaktif (recommended):
#   bash multi-setvision.sh
#
# Usage non-interaktif:
#   bash multi-setvision.sh PRIMARY_PROVIDER PRIMARY_KEY [FALLBACK_PROVIDER FALLBACK_KEY]
#   bash multi-setvision.sh groq gsk_xxx gemini AIzaxxx
#
# Provider valid: groq, groq-90b, gemini, openai, anthropic, none
# =====================================================
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$ROOT/agents" ]; then
  echo "ERROR: Folder agents/ belum ada."
  echo "Run dulu: bash multi-setup.sh COUNT"
  exit 1
fi

DIRS=$(ls -d "$ROOT"/agents/*/ 2>/dev/null | sort)
if [ -z "$DIRS" ]; then
  echo "ERROR: Tidak ada agent di agents/."
  exit 1
fi

COUNT=$(echo "$DIRS" | wc -l)

# --- Args atau prompt ---
PROVIDER="${1:-}"
KEY="${2:-}"
FB_PROVIDER="${3:-}"
FB_KEY="${4:-}"

if [ -z "$PROVIDER" ]; then
  echo "================================================================="
  echo "  Vision API Setup untuk $COUNT agent"
  echo "================================================================="
  echo "  Provider yang didukung:"
  echo "    groq      - llama-3.2-11b-vision (cepat, gratis 30 RPM) [recommended]"
  echo "    groq-90b  - llama-3.2-90b-vision (lebih akurat, gratis 15 RPM)"
  echo "    gemini    - gemini-1.5-flash (gratis 15 RPM)"
  echo "    openai    - gpt-4o-mini (\$0.0001/solve)"
  echo "    anthropic - claude-3-5-haiku (\$0.001/solve)"
  echo "    none      - skip captcha (random fallback)"
  echo
  printf "  Primary provider [groq]: "
  read -r PROVIDER
  PROVIDER="${PROVIDER:-groq}"

  if [ "$PROVIDER" != "none" ]; then
    printf "  Primary API key: "
    read -r KEY
  fi

  echo
  printf "  Fallback provider (Enter=skip): "
  read -r FB_PROVIDER

  if [ -n "$FB_PROVIDER" ] && [ "$FB_PROVIDER" != "none" ]; then
    printf "  Fallback API key: "
    read -r FB_KEY
  fi
fi

# --- Validasi ---
case "$PROVIDER" in
  groq|groq-90b|gemini|openai|anthropic|none) ;;
  *) echo "ERROR: provider tidak dikenal: '$PROVIDER'"; exit 1 ;;
esac

if [ "$PROVIDER" != "none" ] && [ -z "$KEY" ]; then
  echo "ERROR: API key kosong untuk provider $PROVIDER"
  exit 1
fi

if [ -n "$FB_PROVIDER" ] && [ "$FB_PROVIDER" != "none" ]; then
  case "$FB_PROVIDER" in
    groq|groq-90b|gemini|openai|anthropic) ;;
    *) echo "ERROR: fallback provider tidak dikenal: '$FB_PROVIDER'"; exit 1 ;;
  esac
  if [ -z "$FB_KEY" ]; then
    echo "ERROR: fallback API key kosong"
    exit 1
  fi
fi

# --- Apply ke semua .env ---
echo
echo "==> Update VISION_PROVIDER=$PROVIDER untuk $COUNT agent"
[ -n "$FB_PROVIDER" ] && [ "$FB_PROVIDER" != "none" ] && \
  echo "==> Update VISION_FALLBACK=$FB_PROVIDER"

set_env_var() {
  local file="$1"
  local key="$2"
  local val="$3"
  if grep -q "^${key}=" "$file"; then
    local tmp
    tmp=$(mktemp)
    awk -v k="$key" -v v="$val" 'BEGIN{FS="=";OFS="="}
      $1 == k { print k"="v; next }
      { print }' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

UPDATED=0
for D in $DIRS; do
  ENV_FILE="$D.env"
  [ -f "$ENV_FILE" ] || continue
  set_env_var "$ENV_FILE" "VISION_PROVIDER" "$PROVIDER"
  set_env_var "$ENV_FILE" "VISION_API_KEY" "$KEY"
  if [ -n "$FB_PROVIDER" ] && [ "$FB_PROVIDER" != "none" ]; then
    set_env_var "$ENV_FILE" "VISION_FALLBACK" "$FB_PROVIDER"
    set_env_var "$ENV_FILE" "VISION_FALLBACK_KEY" "$FB_KEY"
  else
    set_env_var "$ENV_FILE" "VISION_FALLBACK" ""
    set_env_var "$ENV_FILE" "VISION_FALLBACK_KEY" ""
  fi
  UPDATED=$((UPDATED+1))
done

echo
echo "================================================================="
echo "  $UPDATED agent ter-update."
echo
PRIMARY_PREVIEW=$(echo "$KEY" | cut -c1-8)
echo "  Primary  : $PROVIDER  key=${PRIMARY_PREVIEW}***"
if [ -n "$FB_PROVIDER" ] && [ "$FB_PROVIDER" != "none" ]; then
  FB_PREVIEW=$(echo "$FB_KEY" | cut -c1-8)
  echo "  Fallback : $FB_PROVIDER  key=${FB_PREVIEW}***"
fi
echo
echo "  Verifikasi:"
echo "    grep VISION_ agents/01/.env"
echo
echo "  Restart bot supaya config baru aktif:"
echo "    bash multi-stop.sh && bash multi-start.sh"
echo "================================================================="
