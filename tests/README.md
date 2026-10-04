# Tests

End-to-end checks of the modal in headless Chrome. They need a throwaway SillyTavern 1.19.0, Node 20, Google Chrome and `playwright-core`.

```bash
npm i playwright-core                  # in this folder or anywhere on the module path
ST_SRC=/path/to/SillyTavern tests/start-test-st.sh   # temp data dir /tmp/st-m2, port 8766
node tests/fixtures.mjs                # lorebooks, a character linked to "Eldoria", a chat linked to "Chat Lore"
SHOTS_DIR=/tmp/shots node tests/e2e.mjs        # main checks; screenshots go to SHOTS_DIR
SHOTS_DIR=/tmp/shots node tests/e2e-extra.mjs  # no-chat warning, per-chat selection after reload, edited titles
```

Run the fixtures once per fresh instance, and `e2e.mjs` before `e2e-extra.mjs` (the second relies on the saved selection).
The Chrome path is `/usr/bin/google-chrome` (edit `executablePath` in the scripts if different).
The test data (a "Test Queen" character, "Eldoria" etc.) is only ever written to the temp data dir.
