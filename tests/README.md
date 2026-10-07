# Tests

End-to-end checks of the modal in headless Chrome. They need a throwaway SillyTavern 1.19.0, Node 20, Google Chrome and `playwright-core`.

Quick way: `ST_SRC=/path/to/SillyTavern tests/run-all.sh` (needs `playwright-core` installed, see below). Step by step:

```bash
node tests/unit.mjs                    # parser, passage-edit applier, diff, archive and new-entry unit tests, no browser or ST needed
node tests/fake-openai.mjs 9099 &      # fake model server for e2e-revision.mjs
npm i playwright-core                  # in this folder or anywhere on the module path
ST_SRC=/path/to/SillyTavern tests/start-test-st.sh   # temp data dir /tmp/st-m2, port 8766
node tests/fixtures.mjs                # lorebooks, a character linked to "Eldoria", a chat linked to "Chat Lore"
SHOTS_DIR=/tmp/shots node tests/e2e.mjs        # main checks; screenshots go to SHOTS_DIR
SHOTS_DIR=/tmp/shots node tests/e2e-extra.mjs  # no-chat warning, per-chat selection after reload, edited titles
# then restart ST fresh (start-test-st.sh + fixtures.mjs) and run:
SHOTS_DIR=/tmp/shots node tests/e2e-revision.mjs  # whole revision flow against the fake model
# and once more on a fresh instance:
SHOTS_DIR=/tmp/shots node tests/e2e-archive.mjs   # saving, History/Restore, stale checks, folding cards, History without cards, collapsible History rows, relink, clearing History, deleting orphaned files
# and once more on a fresh instance:
SHOTS_DIR=/tmp/shots node tests/e2e-create.mjs    # new entries: mode switch, request, cards, Approve creates (copied settings / defaults), edit, Undo/Reject remove, regenerate, History remove / create again, safety checks
# and once more on a fresh instance:
SHOTS_DIR=/tmp/shots node tests/e2e-passage.mjs   # "Changed passages only" reply style: request, diff, Approve saves the built text, tolerant match, "Couldn't apply" + Retry as a full rewrite, setting, rule sets
```

`e2e-revision.mjs` switches the Reply style to Full rewrite at the start (it covers the original full-text replies); the other suites run with the default (Changed passages only) and use full-text replies, which that style also accepts.

Run the fixtures once per fresh instance, and `e2e.mjs` before `e2e-extra.mjs` (the second relies on the saved selection).
The Chrome path is `/usr/bin/google-chrome` (edit `executablePath` in the scripts if different).
The test data (a "Test Queen" character, "Eldoria" etc.) is only ever written to the temp data dir.
