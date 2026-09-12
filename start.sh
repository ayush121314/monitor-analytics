#!/usr/bin/env bash
set -uo pipefail

SKILL_DIR="$HOME/.claude/skills/feature-audit"
DATA_DIR="$(node -e "const c=require('$SKILL_DIR/config.json');console.log(c.dataDir.replace('~','$HOME'))" 2>/dev/null || echo "$HOME/Desktop/IMP/feature-audits")"
LOG="$DATA_DIR/server.log"
mkdir -p "$DATA_DIR"

find_port() {
  for p in $(seq 8999 9059); do
    if curl -s -m 1 "http://localhost:$p/api/summary" | grep -q '"repos"'; then echo "$p"; return 0; fi
  done
  return 1
}

PORT="$(find_port || true)"

if [ -z "${PORT:-}" ]; then
  echo "starting the feature-audit dashboard…"
  nohup node "$SKILL_DIR/scripts/server.mjs" >> "$LOG" 2>&1 &
  for _ in $(seq 1 30); do
    sleep 1
    PORT="$(find_port || true)"
    [ -n "${PORT:-}" ] && break
  done
fi

if [ -z "${PORT:-}" ]; then
  echo "could not start the dashboard — see $LOG"
  exit 1
fi

PLIST="$HOME/Library/LaunchAgents/com.primetrace.feature-audit-monitor.plist"
if [ -f "$PLIST" ] && ! launchctl print "gui/$UID/com.primetrace.feature-audit-monitor" >/dev/null 2>&1; then
  launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null && echo "monitor re-armed (runs every 5 min)"
fi

echo "dashboard ready on http://localhost:$PORT"
echo "log: $LOG"
open "http://localhost:$PORT" 2>/dev/null || true
