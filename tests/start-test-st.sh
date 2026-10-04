#!/bin/bash
# Starts a throwaway SillyTavern on port 8766 (temp data dir) with this extension copied in.
# Usage: ST_SRC=/path/to/SillyTavern tests/start-test-st.sh
ST_SRC="${ST_SRC:-/workspace/SillyTavern-src}"
EXT_SRC="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf /tmp/st-m2 /tmp/st-m2.yaml
mkdir -p /tmp/st-m2/default-user/extensions/LoreReviser
(cd "$EXT_SRC" && cp manifest.json index.js modal.js lorebooks.js settings.js style.css /tmp/st-m2/default-user/extensions/LoreReviser/)
cd "$ST_SRC"
nohup node server.js --port 8766 --dataRoot /tmp/st-m2 --configPath /tmp/st-m2.yaml > /tmp/st-m2.log 2>&1 &
echo "Started SillyTavern on http://localhost:8766 (log: /tmp/st-m2.log). Wait ~60 s for first start."
