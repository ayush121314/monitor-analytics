#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-$HOME/.claude/skills/feature-audit}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$TARGET/scripts" "$TARGET/ui"
cp "$HERE/SKILL.md" "$TARGET/SKILL.md"
cp "$HERE/scripts"/*.mjs "$TARGET/scripts/"
cp "$HERE/ui/index.html" "$TARGET/ui/index.html"
if [ ! -f "$TARGET/config.json" ]; then
  cp "$HERE/config.json" "$TARGET/config.json"
  echo "config.json installed — edit repo paths before the first run"
else
  echo "config.json already exists — left untouched"
fi

echo "installed to $TARGET"
echo "start the dashboard:  node $TARGET/scripts/server.mjs"
