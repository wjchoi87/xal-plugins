#!/usr/bin/env bash
set -euo pipefail

XAL_DIR="${XAL_HOME:-$HOME/.xal}"
PLUGINS_DIR="$XAL_DIR/plugins"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="xal-opencode-free"
PLUGIN="opencode-free"
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

python3 - "$CONFIG" "$NAME" "$PLUGIN" <<'PY'
import json, sys

path, package, plugin = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", [])
entry = "./plugins/" + package
if entry not in plugins:
    plugins.append(entry)

cfg.setdefault("pluginConfig", {}).setdefault(plugin, {})

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY

echo ""
echo "registered ./plugins/$NAME in $CONFIG"
echo "restart Xal, then run: xal connect opencode-free"