# LoreReviser: Planning Doc (DRAFT)

A SillyTavern extension that reads and updates lorebooks to reflect story and character changes.

## Decisions so far
- One big model call per revision run, covering all selected entries. If the model gets confused, the user shortens the selection.
- A **depth** setting limits how many recent chat messages are sent (default: whole chat).
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
   - the chat history (last X non-hidden messages, from the depth setting),
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
- Known quirk: ST's **Data Maid** lists every file in `user/files` that no chat references as a "loose file", so the archive files will appear there and can be deleted by the user. Documented in the README. Not worked around.
- Writes happen only on approval, and use `saveWorldInfo(name, data, true)` followed by `reloadWorldInfoEditor` so the World Info editor does not show or overwrite stale data.

## Resolved questions
- **Regeneration works like swipes.** Each regeneration shows the model its previous attempt(s) for that entry, plus any new instructions, and the user can page back and forth between attempts for an entry.
- **Output format.** The model's reply is parsed into JSON for writing to ST, while the user sees it as readable text in the review UI. The exact format the model emits (JSON vs. delimited blocks) will be tested with a real model during milestone 3. Truncated replies (invalid or missing entries) are detected and the user is offered to retry with fewer entries.
- **Scope of revisions.** Content and keys only. No other entry settings (title, position, order, etc.) are touched.
- **New entries.** The user picks the target lorebook. Proposed entries use the same review format as revisions (approve / edit / regenerate). The user can optionally pick an existing entry to copy its detailed settings from (everything except content, title, and keys); otherwise the defaults are used.
- **ST version.** Latest release only.

## Open questions
- None currently.

## Milestones
1. ~~Verify ST APIs~~ Done: see `docs/milestone1-findings.md`.
2. ~~Modal and sidebar with no model calls~~ Done (wand entry, wide modal, chat window, profile selector, editable system prompt, linked-lorebook sidebar, depth setting, README).
3. ~~Revision call and review UI~~ Built and tested against a scripted fake model server; **still to do: try it with a real model** and adjust the default prompt/format if needed. Prompt and reply format: `docs/prompt-format.md`. Differences from the plan: when a reply is cut off, the user is told to select fewer entries / raise "Reply tokens" (no automatic "retry with fewer entries" button), and the context limit comes from the profile's preset or a "Context" box in the modal. Added after first real-model tests: block-level diff views, Edit on every card state, "Retry missing entries", repair of common JSON slips, bigger automatic reply budget, WI budget toast suppressed for our dry run.
4. Approve/write, archive (file naming, index, relink for renames), and history/restore. Hook: `applyApproval()` in `apply.js` is called on Approve and currently only reports that nothing was saved.
5. New-entry function.
