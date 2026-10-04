# Milestone 1 Findings: SillyTavern API research

Source: SillyTavern **1.19.0** (latest release, 2026-09-14), shallow clone at `/workspace/SillyTavern-src`, commit `7e8663c`.
Paths are relative to the repo root (`public/...` is client code, `src/...` is server code). Line numbers are for 1.19.0.

Bottom line: everything in PLAN.md is feasible with public/stable APIs. Two plan details need changing: the archive "folder" cannot be a real subfolder, and "currently active lore as in a normal send" should be built by the extension rather than captured from a real send (see 3 and the plan changes at the end).

---

## 1. Wand menu button and modal

- The wand button and `#extensionsMenu` dropdown are created in `public/scripts/extensions.js` `addExtensionsButtonAndMenu()` (line 688), template `public/scripts/templates/wandMenu.html`. It runs from `initExtensions()`, called from `public/script.js:747`, **before** third-party extensions are activated, so `#extensionsMenu` exists when the extension loads.
- There is no registration API. Extensions append their own DOM. Built-in pattern (`public/scripts/extensions/token-counter/index.js` `init()`):
  ```js
  $('#extensionsMenu').append(`
    <div id="lorereviser_wand_container" class="extension_container">
      <div id="lorereviser_open" class="list-group-item flex-container flexGap5">
        <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div>
        <span>LoreReviser</span>
      </div>
    </div>`);
  $('#lorereviser_open').on('click', openModal);
  ```
  The menu closes on outside click automatically. The wand button is hidden until the menu has at least one visible child (`showHideExtensionsMenu`, polled each second), so appending is enough.
- Modal: `Popup` / `callGenericPopup` / `POPUP_TYPE` in `public/scripts/popup.js`. Also on `SillyTavern.getContext()` as `Popup`, `callGenericPopup`, `POPUP_TYPE`, `POPUP_RESULT`.
  ```js
  const popup = new Popup($(html), POPUP_TYPE.TEXT, '', {
    large: true, allowVerticalScrolling: true,
    okButton: false, cancelButton: 'Close', // or customButtons: [...]
    onOpen: (p) => { /* bind handlers, populate sidebar */ },
    onClosing: (p) => true,
  });
  await popup.show(); // resolves when closed
  ```
  Options: `wide`, `wider`, `large` (90% of screen), `transparent`, `customButtons`, `customInputs`, `allowEscapeClose`, `onOpen`, `onClosing`, `onClose`. Popups stack, so confirmation popups can be shown on top (`Popup.show.confirm`, `Popup.show.input`).
- Extension skeleton: `data/<user>/extensions/LoreReviser/manifest.json` (`display_name`, `loading_order`, `js`, `css`, `author`, `version`, optional `dependencies: ["connection-manager"]`). It is served from `/scripts/extensions/third-party/LoreReviser/`. Import core modules by relative path, e.g. `../../../world-info.js`, `../../../popup.js`, `../../../extensions/shared.js`. Template loading: `renderExtensionTemplateAsync('third-party/LoreReviser', 'modal')`.

**Recommendation:** append a wand entry, build the modal as a `Popup` (large, TEXT, custom body), do all sidebar and review UI in `onOpen`.

---

## 2. Lorebooks and entries

### Listing the lorebooks linked to the current chat
There is **no single "get chat lorebooks" export**. The core logic is in private functions (`getGlobalLore`, `getCharacterLore`, `getChatLore`, `getPersonaLore`, around lines 4527-4580 of `public/scripts/world-info.js`), so the extension re-implements them. The data sources:

| Kind | Where | How to read |
|---|---|---|
| All lorebook names | `world_names` (export `let`), or `getContext().getWorldInfoNames()` | `/api/worldinfo/list` populates it via `updateWorldInfoList()` |
| Global / active | `selected_world_info` (export `let`, reassigned, so use the live binding via `import`, don't cache the array) | `import { selected_world_info } from '../../../world-info.js'` |
| Character primary | `characters[chid].data.extensions.world` | `getContext().characters[getContext().characterId]` |
| Character extra | `world_info.charLore` (export `world_info`) array of `{name: <avatar filename without extension>, extraBooks: string[]}` | key from `getCharaFilename()` (`public/scripts/utils.js:1342`), then `.find(e => e.name === fileName)?.extraBooks` |
| Chat | `chat_metadata['world_info']` (`METADATA_KEY` export) | `getContext().chatMetadata['world_info']`. **Call `getContext()` fresh each time**, since `chat_metadata` is reassigned on chat change |
| Persona | `power_user.persona_description_lorebook` | `getContext().powerUserSettings.persona_description_lorebook` |

Notes:
- Core de-duplicates: a book already in a higher-priority source (global, then chat, then persona) is skipped in the lower ones (see `getCharacterLore`, `getChatLore`, `getPersonaLore`). Do the same dedupe for the sidebar, but show the source labels ("Global", "Character", "Chat", "Persona").
- Names that are not in `world_names` should be dropped (stale links).
- **Group chats:** core `getCharacterLore` uses only `this_chid`. Members' lorebooks are not read from there. For groups, iterate `getContext().groups.find(g => g.id === groupId).members` (avatar filenames) and resolve each member's `data.extensions.world` and `charLore` entry yourself. Not tested.
- The character's embedded `character_book` is not a lorebook file until imported (`importEmbeddedWorldInfo`). Out of scope.
- Events to refresh the sidebar: `event_types.CHAT_CHANGED`, `WORLDINFO_SETTINGS_UPDATED`, `WORLDINFO_UPDATED`. There is no event for char/persona link changes, so rebuild the list each time the modal opens.

### Exports available to extensions
Via `SillyTavern.getContext()` (`public/scripts/st-context.js`): `loadWorldInfo`, `saveWorldInfo`, `reloadWorldInfoEditor`, `updateWorldInfoList`, `getWorldInfoNames`, `getWorldInfoPrompt`, `convertCharacterBook`, `chatMetadata`, `powerUserSettings`, `characters`, `characterId`, `groups`, `groupId`.
Direct import from `public/scripts/world-info.js` (not on the context object): `createWorldInfoEntry`, `duplicateWorldInfoEntry`, `deleteWorldInfoEntry`, `newWorldInfoEntryTemplate` / `newWorldInfoEntryDefinition`, `getFreeWorldEntryUid`, `setWIOriginalDataValue`, `originalWIDataKeyMap`, `splitKeywordsAndRegexes`, `selected_world_info`, `world_info`, `world_names`, `METADATA_KEY`, `createNewWorldInfo`, `moveWorldInfoEntry`, `getSortedEntries`.

### Load and save
- `loadWorldInfo(name)` (line 2036): POST `/api/worldinfo/get`, cached in `worldInfoCache`. **The cache returns a deep clone on every get** (`StructuredCloneMap {cloneOnGet:true}`), so mutating the result is safe until you save. Returns `{entries: {[uid]: entry}, ...}`. Gotcha: for a missing book the server returns `{entries:{}}` with HTTP 200 (`src/endpoints/worldinfo.js` `readWorldInfoFile(..., allowDummy=true)`). Verified by curl. Check `world_names.includes(name)` instead of null-checking.
- `saveWorldInfo(name, data, immediately=false)` (line 4177): updates the cache (**without cloning**, so don't touch `data` afterwards) then POSTs `/api/worldinfo/edit`, then emits `WORLDINFO_UPDATED(name, data)`. Default is **debounced** (`debounce_timeout.relaxed`). Use `immediately = true` for approval writes so the archive and book stay in step.
- Server write (`/api/worldinfo/edit`) is atomic and stores the JSON as is. It requires only `entries` to be present. Round trip verified by curl.
- Entry fields (`newWorldInfoEntryDefinition`, line 4082): `uid`, `key` (string[]), `keysecondary` (string[]), `comment` (the title), `content`, `constant`, `vectorized`, `selective`, `selectiveLogic`, `order`, `position`, `depth`, `role`, `disable`, `probability`, `useProbability`, `group*`, `sticky`, `cooldown`, `delay`, `scanDepth`, `triggers`, `characterFilter*`, `outletName`, `match*`, and so on. Entries are keyed by uid in `data.entries`.
- `data.originalData` exists only for books imported from character cards. When changing `content` / `key` / `keysecondary` the editor also calls `setWIOriginalDataValue(data, uid, 'content' | 'keys' | 'secondary_keys', value)` (`originalWIDataKeyMap`, line 2687, and `enableKeysInputHelper`, line 2938). Do the same to keep both copies consistent.
- Key parsing: use `splitKeywordsAndRegexes(str)` (line 2797) for user-edited comma-separated key text, so `/regex, with comma/i` keys survive.

### Creating an entry and copying settings
- `createWorldInfoEntry(name, data)` (line 4137): assigns the next free uid via `getFreeWorldEntryUid`, inserts a `structuredClone(newWorldInfoEntryTemplate)` into `data.entries`, and **returns the entry** (it is already in `data`). It does not save.
- Copy from another entry: `duplicateWorldInfoEntry(data, uid)` (line 4019) = `createWorldInfoEntry` + `Object.assign(entry, structuredClone(source minus uid))`. For the plan ("copy everything except content, title, keys") do it manually:
  ```js
  const entry = createWorldInfoEntry(book, data);
  const src = structuredClone(data.entries[srcUid]);
  for (const k of ['uid','content','comment','key','keysecondary','displayIndex']) delete src[k];
  Object.assign(entry, src);
  entry.content = ...; entry.comment = ...; entry.key = [...]; entry.keysecondary = [...];
  await saveWorldInfo(book, data, true);
  ```
  Core's own `/createentry` slash command (`createEntryCallback`, line 1313) does `createWorldInfoEntry`, sets fields, `saveWorldInfo`, then `reloadEditor(file)`.

### UI refresh after an edit
- Nothing in core listens to `WORLDINFO_UPDATED`. After saving call `getContext().reloadWorldInfoEditor(name, true)` (`reloadEditor`, line 1040; with `loadIfNotSelected=false` it only reloads if that book is currently open in the World Info editor). If the editor shows a stale copy and the user edits it, it would overwrite our change, so always reload.
- Lore activation is re-computed from the cache at next generation, so no extra refresh is needed for prompts.

---

## 3. Sending requests on a specific profile

### ConnectionManagerRequestService (`public/scripts/extensions/shared.js:392`, also `getContext().ConnectionManagerRequestService`)
- `getSupportedProfiles()` lists usable profiles (Chat Completion and Text Completion only). `getProfile(id)`, `validateProfile`, `handleDropdown(selector, selectedId, onChange, ...)` builds a profile `<select>`. Throws if the Connection Manager extension is disabled, so declare `dependencies: ["connection-manager"]` and handle the error.
- `sendRequest(profileId, prompt, maxTokens, custom, overridePayload)`:
  - `prompt` = string, or an array of `{role, content}` messages (CC). For TC it's a string (use `constructPrompt(messages, profileId)` to apply the profile's instruct template).
  - `custom`: `{stream, signal, extractData=true, includePreset=true, includeInstruct=true, instructSettings}`.
  - Returns `{content, reasoning}` when not streaming (`extractData` true). Pass an `AbortSignal` to support cancel.
  - Uses the profile's API, model, secret, proxy, api-url, prompt-post-processing; does **not** touch the user's active connection. No UI switch.
- **Preset:** the profile's preset is applied (`includePreset`) via `ChatCompletionService.processRequest` → `presetToGeneratePayload` (`public/scripts/custom-request.js:544-606`). That applies the **sampler/generation parameters** of the preset (temperature, top_p, etc., through `createGenerationParameters`). It does **not** apply the preset's Prompt Manager content (system prompt, prompt order, jailbreak), because the messages are supplied by the caller. To use "a different prompt", the extension writes its own system message. For a different preset, pick a profile that references it. Sampler overrides: pass `overridePayload` (e.g. `{temperature: 0.3}`).
- Limits: no automatic context trimming, no WI/AN/extension-prompt injection, no instruct wrapping for CC, no stop strings/start-reply-with from the profile, no regex scripts. The extension must keep the payload within the model's context.

### "As though a normal send"
Options, in order of recommendation:

**A. Build the prompt ourselves (recommended).** Feasible with exports:
- chat: `getContext().chat` (filter out `is_system` = hidden/comment messages as a normal send does), slice the last `depth` messages. Fields: `name`, `mes`, `is_user`. Depth is purely ours; core has no message-count option.
- character info: `getContext().getCharacterCardFields()` returns `{system, mesExamples, description, personality, persona, scenario, jailbreak, charDepthPrompt, creatorNotes, firstMessage, ...}` (`public/script.js:3476`). `substituteParams()` to expand macros.
- active lore "as normal": `getContext().getWorldInfoPrompt(chatForWI, maxContext, true /*dryRun*/, globalScanData)` (`world-info.js:892`) returns `{worldInfoString, worldInfoBefore, worldInfoAfter, worldInfoDepth, worldInfoExamples, outletEntries, ...}`. `chatForWI` is an array of strings, **newest first** (`${name}: ${mes}` when `world_info_include_names`), `globalScanData` as built in `Generate` (`script.js:4617`: `personaDescription, characterDescription, characterPersonality, characterDepthPrompt, scenario, creatorNotes, trigger:'normal'`). `isDryRun=true` skips timed-effect state changes (sticky/cooldown) and the `WORLD_INFO_ACTIVATED` event. Scan only the same `depth`-limited messages, or the full chat if we want "as normal"; the lore activated may differ slightly from a real send. Worth stating in the UI.
- Pros: independent of main API/preset/instruct, works with any profile type, depth is exact, no side effects. Cons: not byte-identical to a real send (no Prompt Manager layout, Author's Note, extension prompts / injections, example-message handling, instruct formatting).

**B. Capture a real prompt (dry run).** `Generate('quiet', {quiet_prompt: ..., skipWIAN:false}, true)` runs the full prompt build and returns nothing; for CC the finished message array is emitted via `event_types.CHAT_COMPLETION_PROMPT_READY` as `{chat, dryRun:true}` (`openai.js:1618`) and can be captured with a one-shot listener. Gives the true normal-send prompt, but: only for the **main** API's settings (main preset/prompt manager and context trimming), only CC main API gives message arrays (TC gives a string via `GENERATE_AFTER_COMBINE_PROMPTS`/`GENERATE_AFTER_DATA`), other extensions react to `GENERATION_STARTED` etc., it can't take a depth limit except by post-trimming the array, and the shape differs if the profile is a different API type. Not tested in a browser. Use only as an optional "match my normal prompt" mode.

**C. `generateQuietPrompt` / `generateRaw` (not suitable).** Both always use the **main connection** (`main_api`, active preset). `generateRaw({api})` can choose an API type but not a profile. The only way to use another profile would be to switch the user's active profile (`/profile`), which is global, visible, racy, and risky. `generateQuietPrompt` also sends the entire chat to the context limit with no depth control.

**Token limits:** use `getContext().getTokenCountAsync(text)` for the pre-flight estimate. `getContext().maxContext` is the main connection's limit, not the chosen profile's. The preset's `openai_max_context` (via `getPresetManager('openai').getCompletionPresetByName(profile.preset)`) is the best available guess, so let the user override it. Warn when `prompt tokens + maxTokens` exceed it. Reasoning models return `reasoning` separately.

---

## 4. Persisting archive JSON in the user data directory

Tested against a real SillyTavern 1.19.0 server (`node server.js --port 8765 --dataRoot /tmp/st-data`, default user, no accounts), with curl, a session cookie and `X-CSRF-Token` from `GET /csrf-token`.

Server code: `src/endpoints/files.js`, `validateAssetFileName` in `src/endpoints/assets.js:21`, static route `src/users.js:1218`.

| Endpoint | Behavior (verified) |
|---|---|
| `POST /api/files/upload` `{name, data: <base64>}` | Writes `<user>/user/files/<name>` atomically. **Overwrites** existing. Returns `{path: "/user/files/<name>"}`. HTTP 200 for `LoreReviser-archive__TestBook.json`, UTF-8 content and a 3.7 MB file (body limit 500 MB). |
| Filename rules | Must match `^[a-zA-Z0-9_\-.]+$`. **No `/`, spaces, or non-ASCII** (400, "Illegal character"). Cannot start with `.`. Blocked extensions (`UNSAFE_EXTENSIONS` in `src/constants.js:64`): `.js .html .pdf .py .sh .exe ...`. `.json` and `.txt` are fine. Extension check is case-insensitive. Max length enforced by `sanitize-filename`. |
| `GET /user/files/<name>` | **Served.** Verified `200`, `Content-Type: application/json`, content byte-identical to what was uploaded. `Cache-Control: public, max-age=0` + ETag. Path-traversal guarded (`isPathUnderParent`). It worked without the cookie in this no-accounts setup; with user accounts enabled the session is required (served per-user via `req.user.directories.files`). |
| `POST /api/files/verify` `{urls:[...]}` | Returns `{url: bool}`; accepts both `user/files/x.json` and `/user/files/x.json`. Paths outside `user/files` are silently omitted. |
| `POST /api/files/delete` `{path}` | `path` is root-relative, e.g. `/user/files/x.json`. 200 `OK`; 404 if missing; 400 `Invalid path` for anything outside `user/files`. |
| CSRF | All POSTs need `X-CSRF-Token` (403 without). In the extension, use `getContext().getRequestHeaders()`, which includes it. |
| Listing | **No list endpoint** for `user/files`. |

How to read back in the extension: `fetch(path, {cache: 'no-cache', headers: getContext().getRequestHeaders()})`, then `.json()`. Core's `getFileAttachment` (`public/scripts/chats.js:303`) uses `cache: 'force-cache'`, which would return stale archives after an overwrite, so do **not** use it for this purpose. Base64 encode: `btoa(unescape(encodeURIComponent(json)))` (core uses `convertTextToBase64`, in `public/scripts/utils.js`) so non-ASCII text survives.

**Consequences for the design:**
1. A real `LoreReviser-archive/` subfolder is **not possible** through this endpoint. Use a flat filename prefix: `LoreReviser-archive__<slug>__<hash>.json` in `<user>/user/files/`. Lorebook names with spaces / unicode / `/` must be mapped to the allowed charset: slug (ASCII-safe) + short hash of the real name, with the real name stored inside the JSON. The name is then deterministic from the lorebook name, so no listing is needed.
2. Archive writes are read-modify-write of one file per book (append a record, re-upload). The whole file is re-sent each approval, which is fine at expected sizes (MBs).
3. No server-side locking. Two browser tabs can race; low risk, mention in docs.
4. **Data Maid** (`src/endpoints/data-maid.js`, `#collectFiles`, line 244) treats every file in `user/files` not referenced by chat/attachment metadata as a "loose file" the user may delete from its UI. Archive files will be listed there. Only the user's own action deletes them, but it must be documented. Avoid registering fake entries in `extension_settings.attachments` to hide them, as that pollutes the Data Bank.
5. Lorebook rename in ST (`renameWorldInfo`) does not tell the extension. The hash-derived archive filename would then no longer match. Fix: store a stable id inside each lorebook (e.g. a `LoreReviser` id in the book's `extensions` field, or keep a name→file map in `extension_settings.LoreReviser`) rather than hashing the name. Needs a decision.
6. `/user/files` is included in ST's user-data backups, which is good.

Alternative if the above is unacceptable: store the archive in `extension_settings.LoreReviser` (goes into `settings.json`; large, written on every save, so not recommended) or require a small server plugin (rejected, since the plan says extension only).

---

## 5. Other points, risks and open issues

Risks / things to handle:
- **Stale editor overwrite** (see 2): always `saveWorldInfo(..., true)` then `reloadWorldInfoEditor(name, true)`.
- **Debounced saves from the editor**: if the user has unsaved debounced edits in the World Info editor (up to a few seconds) when we `loadWorldInfo`, we read the cache (updated immediately by `saveWorldInfo`), so the cache is current. Still, load fresh right before writing each approval, then apply only that one entry's changes, to avoid clobbering concurrent edits.
- **`selective` / secondary keys:** secondary keys only work when `selective` is true. Template default is true, but older entries can have it false. When the model adds secondary keys to an entry with `selective:false`, they would silently do nothing. The plan says "keys only"; recommended: show a warning, or set `selective` true only when secondary keys go from empty to non-empty (needs a decision).
- **Decorators and special syntax in `content`:** `@@activate`, `@@dont_activate` etc. at the start of content (`parseDecorators`, line 4630) and `{{macros}}` must be preserved. Tell the model to leave them, and diff-check (decorator lines unchanged) before saving. Keys may be regexes `/.../flags`, which should be sent and returned verbatim.
- **Token / output limits:** one big call (the plan) can exceed the context or output limit, and a truncated JSON reply breaks parsing. Pre-flight token count (see 3), show it in the UI, set `maxTokens` generously, detect truncation (invalid JSON / missing entries) and offer "retry with fewer entries". Reasoning models: strip/ignore `reasoning`; `content` only.
- **Output parsing:** the connection manager's `extractData` returns text. For CC, `custom_prompt_post_processing` on the profile may reshape system messages. `jsonSchema` structured output exists for main-connection helpers (`generateQuietPrompt({jsonSchema})`) and `ChatCompletionService` (`json_schema` in payload), but provider support varies. Milestone 3 should still test delimited blocks vs JSON.
- **Prompt injection:** chat text and lore are untrusted model input. The output only writes to selected entries, and the review UI is the safeguard (keep it mandatory, never auto-approve).
- **uid types:** `data.entries` keys are strings, `entry.uid` is a number. Use `entry.uid` consistently and match returned IDs by that.
- **Group chats and `this_chid` undefined** (see 2). **No chat open**: `characterId` is undefined, so disable the sidebar.
- **Hidden messages:** `is_system` messages are skipped in a normal send; depth counting should also skip them.
- **Version drift:** `getContext()` additions are stable, but private functions (`getCharacterLore` etc.) may change; keep the linked-lorebook logic in one module with a note to re-check on ST upgrades. The plan says latest release only, so this is acceptable.
- **Not verified in a browser:** the wand/popup snippets and the dry-run capture (B) were checked by reading source only. The server endpoints were verified by running the server. Milestone 2 will exercise the UI.

Open decisions for Knarfy: (a) archive filename scheme and rename handling; (b) selective/secondary-key rule; (c) prompt mode A vs. optional B; (d) which context-limit source to use for the pre-flight check.

---

## Recommended plan changes
1. Archive: replace "folder `LoreReviser-archive`" with "files prefixed `LoreReviser-archive__` in `user/files`" (subfolders are impossible via upload); decide on rename handling; mention Data Maid.
2. Request building: "currently active lore, as in a normal send" = build via `getWorldInfoPrompt(..., dryRun=true)` + character card fields + depth-limited chat (option A); optionally add option B later.
3. The sidebar's book discovery must be our own code (no core export), including dedupe, and group-chat handling.
4. Add a token-budget pre-flight and truncation detection to Milestone 3.
5. Reads of the archive must bypass the HTTP cache (`cache: 'no-cache'`).
