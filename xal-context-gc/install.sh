#!/usr/bin/env bash
set -euo pipefail

XAL_DIR="${XAL_HOME:-$HOME/.xal}"
PLUGINS_DIR="$XAL_DIR/plugins"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="xal-context-gc"
DEST_DIR="$PLUGINS_DIR/$NAME"
CONFIG="$XAL_DIR/config.json"

mkdir -p "$PLUGINS_DIR"

if [ "$SRC_DIR" != "$DEST_DIR" ]; then
  rsync -a --exclude node_modules --exclude .git "$SRC_DIR/." "$DEST_DIR/"
  echo "installed to $DEST_DIR"
else
  echo "already installed at $DEST_DIR"
fi

if [ ! -f "$CONFIG" ]; then
  printf '{}\n' > "$CONFIG"
  chmod 600 "$CONFIG"
fi

python3 - "$CONFIG" "$NAME" <<'PY'
import json, sys

path, package = sys.argv[1], sys.argv[2]
with open(path) as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", [])
entry = "./plugins/" + package
if entry not in plugins:
    plugins.append(entry)

cfg.setdefault("pluginConfig", {}).setdefault("context-gc", {
    "enabled": True,
    "mode": "conservative",
})

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY

echo ""
echo "registered ./plugins/$NAME in $CONFIG"
echo "(optional: tune pluginConfig.xal-context-gc thresholds — see README.md)"
echo "restart Xal; large tool outputs are paged automatically, /context-gc shows stats"