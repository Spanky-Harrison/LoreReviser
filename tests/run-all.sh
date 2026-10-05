#!/bin/bash
# Runs every test on throwaway SillyTavern instances. Needs ST_SRC, playwright-core (see tests/README.md).
cd "$(dirname "$0")"
stop() { kill $(pgrep -f "^node server.js --port 8766") 2>/dev/null; sleep 1; }
fresh() { stop; ./start-test-st.sh > /dev/null; until curl -s -o /dev/null localhost:8766/csrf-token; do sleep 3; done; sleep 3; node fixtures.mjs > /dev/null; }
status=0
node unit.mjs | tail -1 || status=1
(pgrep -f "fake-openai.mjs" > /dev/null) || (nohup node fake-openai.mjs 9099 > /tmp/fake.log 2>&1 &)
fresh; node e2e.mjs | tail -1; node e2e-extra.mjs | tail -1
fresh; node e2e-revision.mjs | tail -1
fresh; node e2e-archive.mjs | tail -1
fresh; node e2e-create.mjs | tail -1
stop
