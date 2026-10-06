# LoreReviser: Planning Doc (DRAFT)

A SillyTavern extension that reads and updates lorebooks to reflect story and character changes.

## Decisions so far
- One big model call per revision run, covering all selected entries. If the model gets confused, the user shortens the selection.
- A **depth** setting limits how many recent chat messages are sent (default `0` = whole chat; `-1` = no chat at all).
- Archive is plain JSON files, one per lorebook, not a hidden database.
- Revisions cover entry content **and keys** (add/revise primary and secondary keys).
- Creating **new entries** is a separate function from revision, with its own command and review step. Deletion is not included.
- Plan approved; built milestone by milestone.

## Elements
1. **Modal chat window**, opened from the wand (extensions) menu next to the main input. Implementation: append a `div` to `#extensionsMenu` and open a large `Popup` (`POPUP_TYPE.TEXT`, `large: true`). There is no wand registration API.
2. **Own connection profile and own system prompt**, separate from the main chat. The profile's preset supplies the sampler settings; the profile selector and system prompt are set in the modal and saved in extension settings.
3. **Sidebar** listing only lorebooks linked to the current chat (global, character, chat, persona). Checkboxes for whole books or single entries. Books expand and collapse to show entries.
4. **Input box** takes instructions on what information to use to edit the lore. Sending starts the revision.
5. **Revision process**: one request to the chosen profile, **with the prompt built by the extension itself** (not captured from a real send, and not `generateQuietPrompt`, which always uses the main connection). It contains
   - the chat history (last X non-hidden messages, from the depth setting; block kept but marked "no chat history provided" at depth -1),
   - character information (`getCharacterCardFields()`),
   - currently active lore (`getWorldInfoPrompt(..., dryRun = true)`), close to a normal send but not byte-identical,
   - the full content and keys of every selected book/entry,
   - the user's instructions.
   Before sending, a **token pre-flight check** estimates the prompt size (`getTokenCountAsync`) against the profile's context limit and warns if the prompt plus the reply budget will not fit. The model returns a revised version of each selected entry.
6. **Review UI**: each entry is approved or rejected individually. The user can edit the text and keys directly, or regenerate that one entry with new instructions. Approved entries are written straight to the lore entry.
7. **New entry function** (separate from revision): the user asks for new entries, the model proposes them, and each goes through the same approve / edit / regenerate review before it is created.

## Archive
- Storage: ST's upload endpoint (`/api/files/upload`), verified on ST 1.19.0. It only writes flat files into `<user>/user/files/`; subfolders, spaces and non-ASCII names are rejected. So there is **no `LoreReviser-archive` folder**. Instead one JSON file per lorebook named `LoreReviser-archive__<slug>__<hash>.json` (`slug` = ASCII-safe version of the book name, `hash` = short hash of the name when the archive was first created). The real book name is stored inside the file.
- ST has no endpoint to list these files, so the extension keeps its own **index** in extension settings: `archiveIndex = { "<lorebook name>": "<archive file name>" }`.
- Each approval appends a record: entry id, old content and keys, new content and keys, timestamp, user instructions. The file is re-uploaded whole (read, append, write; same name overwrites).
- Each entry has a History view with one-click restore.
- Reads use `fetch(url, { cache: 'no-cache' })`. ST's own attachment helper uses `force-cache`, which would return stale archives.
- **Lorebook renames.** ST does not notify extensions when a book is renamed. The archive file name never changes after creation; only the index entry does. If an index name no longer exists in ST's lorebook list, the archive is shown under "Orphaned archives" in the settings, and the user picks the lorebook it now belongs to ("relink"), which renames the index key. Nothing is deleted automatically.
- **Clearing History (added on request).** In the History window: "Clear old history" (older than 7 / 30 / 90 days, 1 year, or all) for the viewed lorebook, a trash icon per record, and "Delete" for orphaned files. Always confirmed with an ST Popup that gives the count and says the lorebook is not changed and the versions can't be restored. Decisions:
  - Clearing runs through apply.js's write queue (`clearHistoryRecords`) with the usual read, filter, re-upload of the whole file. The records to remove are fixed by id when the user confirms (cutoff = now - N days, strictly older; records without a readable time are kept), so a record written meanwhile is never removed and the count shown is the count removed. Each clean-up is noted in `archive.cleared` ({time, removed, how}).
  - "All" for an existing lorebook uploads an empty-records file instead of deleting it: same write path as every other change, no index change, no file deletion for a lorebook that still exists.
  - Orphaned files are deleted with ST's `/api/files/delete` (`{path: "user/files/<file>"}`, ST 1.19.0 checks it stays inside the user's files folder), then the index entry is removed (`deleteOrphanHistory`, also queued). Refused when a lorebook of that name exists again, when the name is not `LoreReviser-archive__…`, or when the file is damaged / not a LoreReviser history file; a file that is already gone just loses its index entry.
  - Never reads or writes a lorebook. uids stay reserved only by the remaining records (`uidsInArchive`), which is fine because the cleared history can no longer mix with a new entry's.
- Known quirk: ST's **Data Maid** lists every file in `user/files` that no chat references as a "loose file", so the archive files will appear there and can be deleted by the user. Documented in the README. Not worked around.
- Writes happen only on approval, and use `saveWorldInfo(name, data, true)` followed by `reloadWorldInfoEditor` so the World Info editor does not show or overwrite stale data.

## Resolved questions
- **Regeneration works like swipes.** Each regeneration shows the model its previous attempt(s) for that entry, plus any new instructions, and the user can page back and forth between attempts for an entry.
- **Output format.** The model's reply is parsed into JSON for writing to ST, while the user sees it as readable text in the review UI. The exact format the model emits (JSON vs. delimited blocks) will be tested with a real model during milestone 3. Truncated replies (invalid or missing entries) are detected and the user is offered to retry with fewer entries.
- **Scope of revisions.** Content and keys only. No other entry settings (title, position, order, etc.) are touched.
- **New entries.** The user picks the target lorebook. Proposed entries use the same review format as revisions (approve / edit / regenerate). The user can optionally pick an existing entry to copy its detailed settings from (everything except content, title, and keys); otherwise the defaults are used.
- **ST version.** Latest release only.

## Editable system-message parts (done)
Rewrite-intensity wordings (per level) and the reply-format rules are editable in the modal, stored only when edited (`settings.intensityTexts`, `settings.formatRules`), with Restore default buttons and a parse-safety warning. Modal buttons no longer wrap (`.lorerev_root .menu_button { white-space: nowrap; width: auto }`).

## Change type (done)
Development / Retcon toggle (default Development), editable wording per type, persisted, applied on Send and Regenerate and shown on each attempt. Not enforced by code: Retcon is an instruction to the model only.

## WI budget fix (done)
The active-lore scan was given `ctx.maxContext` (only the Text Completion slider), so with Chat Completion the World Info budget was tiny and the "budget reached" note appeared for modest lorebooks. Now it uses the profile's context (Context box > profile preset > current settings of the profile's API > ST main) minus the response length, like ST's Generate(); the note only appears when entries were really cut and shows the numbers. See docs/prompt-format.md.

## Open questions
- None currently.

## Milestones
1. ~~Verify ST APIs~~ Done: see `docs/milestone1-findings.md`.
2. ~~Modal and sidebar with no model calls~~ Done (wand entry, wide modal, chat window, profile selector, editable system prompt, linked-lorebook sidebar, depth setting, README).
3. ~~Revision call and review UI~~ Built and tested against a scripted fake model server; **still to do: try it with a real model** and adjust the default prompt/format if needed. Prompt and reply format: `docs/prompt-format.md`. Differences from the plan: when a reply is cut off, the user is told to select fewer entries / raise "Reply tokens" (no automatic "retry with fewer entries" button), and the context limit comes from the profile's preset or a "Context" box in the modal. Added after first real-model tests: block-level diff views, Edit on every card state, "Retry missing entries", repair of common JSON slips, bigger automatic reply budget, WI budget toast suppressed for our dry run; selected entries sent once (removed from the active lore); depth -1; rewrite intensity (Light touch / Balanced / Heavy-handed); formatting-preservation rules; always-visible regenerate request box; Clear chat.
4. ~~Approve/write, archive (file naming, index, relink for renames), and history/restore~~ Done, tested against the fake model (`tests/e2e-archive.mjs`). As planned: `saveWorldInfo(name, data, true)` + `reloadWorldInfoEditor`, only key / keysecondary / content (and `setWIOriginalDataValue`), one `LoreReviser-archive__<slug>__<hash>.json` per book via `/api/files/upload` (slug = ASCII letters/digits/dashes, max 40; hash = 8-hex FNV-1a of the name), `archiveIndex` in extension settings, `no-cache` reads, whole-file re-upload, orphan list with relink, nothing deleted. Details and differences from the plan:
   - **Stale check:** before every write the entry is re-read; if its keys/content differ from what the card was based on, nothing is written and the card goes back to "Proposed" with the reason (no overwrite prompt). The old apply.js note said cards stay approved on failure; they don't, so a card never says Approved without being saved.
   - **Undo** after a saved approval is a real revert (with the same check) and is archived as an `undo` record. Reject on a card edited after a saved approval also reverts.
   - **Restore** asks first, warns if the entry was changed outside LoreReviser since its last record, and refuses if it changes while the question is open. It is archived as a `restore` record whose "old" side is the replaced text.
   - Writes are serialised (one at a time) so two quick approvals can't overwrite each other's lorebook or archive changes.
   - History is opened per book (sidebar clock icon, with an entry filter) and per entry (card button), not from a settings panel. The orphan list and relink live in the modal sidebar (the extension has no settings panel). Relink refuses a book that already has its own history file and updates the book name stored inside the file.
   - If the index entry is missing (settings not saved yet), the archive is still found, because its name is derived from the book name. A file with that name that is not a LoreReviser archive is never overwritten.
   - Added on request: review cards fold to their header line (click the header); approved cards fold automatically, Undo unfolds; the state is kept on the item, so it survives redraws and reopening.
5. ~~New-entry function~~ Done, tested against the fake model (`tests/e2e-create.mjs`, unit tests for `create-core.js`). As planned: a separate mode in the modal ("New entries", next to "Revise selected entries") with its own request and review step; the user picks the target lorebook (linked ones first, then all others) and optionally an entry of that book to copy settings from (everything except content, title and keys; otherwise SillyTavern's defaults via `createWorldInfoEntry`); proposals (title + keys + secondary keys + content + note) use the same review cards (approve / reject / edit incl. title / regenerate with swipes; Old side empty, "New" view by default); Approve creates the entry (`createWorldInfoEntry`, copied settings read at approve time, `saveWorldInfo(..., true)` + `reloadWorldInfoEditor`), archives a `create` record and folds the card. No deletion feature; revisions still touch only content and keys. Prompt and format: `docs/prompt-format.md#new-entries`. Details and decisions:
   - **Own prompt parts:** a separate, editable system prompt and reply-format rules for new entries ("New entry prompt", Restore default, parse-safety warning). The Change type section applies; **rewrite intensity does not** (there is no existing text to rewrite). Reply tokens 0 = 8192.
   - **Extra context (prompt only):** the titles and keys (not content) of the target book's existing entries are sent so the model avoids duplicates, and the "copy settings from" entry's text is sent as a `<format_example>` (checkbox, on by default). Cards warn about a possible duplicate (same title, or a key already used in that book), no keys, or no content.
   - **Undo / Reject** on an approved new-entry card removes the entry again, only if it is still exactly as created (keys, text, title); otherwise it refuses. Editing an approved card and approving again updates the created entry (text, keys, title) instead of creating a second one.
   - **History:** `create` records (old side empty, with the settings source) offer **Remove this entry** instead of Restore, which works only while the entry is still exactly as created (refuses otherwise); removals are `remove` records with a full snapshot of the entry, offering **Create it again** (same uid if free; refuses if the same entry already exists); re-creations are `recreate` records. Nothing is lost.
   - **uids:** a new entry never gets a uid that already appears in the book's History (ST reuses the lowest free uid), so two entries' histories never mix.
   - **Safety:** nothing is created if the target book or the copy-source entry no longer exists at Approve time; the card stays "Proposed" with the reason.
   - "Copy settings from" lists entries of the target book only (not other books).
