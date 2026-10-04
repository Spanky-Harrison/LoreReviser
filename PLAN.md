# LoreReviser: Planning Doc (DRAFT)

A SillyTavern extension that reads and updates lorebooks to reflect story and character changes.

## Decisions so far
- One big model call per revision run, covering all selected entries. If the model gets confused, the user shortens the selection.
- A **depth** setting limits how many recent chat messages are sent (default: whole chat).
- Archive is plain JSON files, one per lorebook, not a hidden database.
- Revisions cover entry content **and keys** (add/revise primary and secondary keys).
- Creating **new entries** is a separate function from revision, with its own command and review step. Deletion is not included.
- Nothing is built until this plan is approved.

## Elements
1. **Modal chat window**, opened from the wand (extensions) menu next to the main input.
2. **Own connection profile / chat preset and own prompt**, separate from the main chat.
3. **Sidebar** listing only lorebooks linked to the current chat (global, character, chat, persona). Checkboxes for whole books or single entries. Books expand and collapse to show entries.
4. **Input box** takes instructions on what information to use to edit the lore. Sending starts the revision.
5. **Revision process**: one request to the chosen profile containing
   - the chat history (limited by depth),
   - character information,
   - currently active lore, as in a normal send,
   - the full content and keys of every selected book/entry,
   - the user's instructions.
   The model returns a revised version of each selected entry.
6. **Review UI**: each entry is approved or rejected individually. The user can edit the text and keys directly, or regenerate that one entry with new instructions. Approved entries are written straight to the lore entry.
7. **New entry function** (separate from revision): the user asks for new entries, the model proposes them, and each goes through the same approve / edit / regenerate review before it is created.

## Archive
- Folder: `LoreReviser-archive` in the user data directory, one JSON file per lorebook.
- Each approval appends a record: entry id, old content and keys, new content and keys, timestamp, user instructions.
- Each entry has a History view with one-click restore.
- Written through ST's file upload endpoint (to verify on the user's ST version before committing).

## Resolved questions
- **Regeneration works like swipes.** Each regeneration shows the model its previous attempt(s) for that entry, plus any new instructions, and the user can page back and forth between attempts for an entry.
- **Output format.** The model's reply is parsed into JSON for writing to ST, while the user sees it as readable text in the review UI. The exact format the model emits (JSON vs. delimited blocks) will be tested with a real model during milestone 3.
- **Scope of revisions.** Content and keys only. No other entry settings (title, position, order, etc.) are touched.
- **New entries.** The user picks the target lorebook. Proposed entries use the same review format as revisions (approve / edit / regenerate). The user can optionally pick an existing entry to copy its detailed settings from (everything except content, title, and keys); otherwise the defaults are used.
- **ST version.** Latest release only.

## Open questions
- None currently.

## Milestones (proposed)
1. Verify ST APIs: reading and writing lorebooks, listing chat-linked books, connection profile requests, file saving.
2. Modal and sidebar with no model calls.
3. Revision call and review UI.
4. Approve/write, archive, and history/restore.
5. New-entry function.
