#!/data/data/com.termux/files/usr/bin/bash
# =====================================================
# Multi-Agent Status
# Tampilkan status tmux session + tail log per agent.
# =====================================================
ROOT="$(cd "$(dirname "$0")" && pwd)"
SESSION="sleepy-arena"

echo "=== Tmux session ==="
if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux list-windows -t "$SESSION" 2>/dev/null
else
  echo "Session '$SESSION' tidak jalan."
fi

echo
echo "=== Process node bot ==="
N=$(ps aux 2>/dev/null | grep "node.*xsleepybot/src/index.js" | grep -v grep | wc -l)
echo "Aktif: $N agent"

echo
echo "=== Tail log per agent (3 baris terakhir) ==="
if [ -d "$ROOT/agents" ]; then
  for D in "$ROOT"/agents/*/; do
    [ -d "$D" ] || continue
    NAME=$(basename "$D")
    LOG=$(ls -t "$D/logs"/*.log 2>/dev/null | head -1)
    echo "--- agents/$NAME ---"
    if [ -n "$LOG" ]; then
      tail -3 "$LOG" 2>/dev/null | sed 's/^/  /'
    else
      echo "  (belum ada log)"
    fi
    echo
  done
else
  echo "(folder agents/ belum dibuat)"
fi

echo "=== Tips ==="
echo "Lihat live log per agent:"
echo "  tail -f agents/01/logs/\$(date +%Y-%m-%d).log"
echo
echo "Attach ke tmux session (lihat semua agent):"
echo "  tmux attach -t $SESSION"
