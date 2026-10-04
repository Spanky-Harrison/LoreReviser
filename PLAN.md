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

## Open questions
- Should a regeneration also show the model its previous attempt for that entry?
- What output format should the model use (JSON per entry vs. delimited blocks)? Needs a test with a real model.
- Should revisions also touch other settings (comment/title, position, order, etc.), or only content and keys?
- How should the new-entry function pick the target lorebook and show proposed entries for approval?
- Which ST version(s) must this support?

## Milestones (proposed)
1. Verify ST APIs: reading and writing lorebooks, listing chat-linked books, connection profile requests, file saving.
2. Modal and sidebar with no model calls.
3. Revision call and review UI.
4. Approve/write, archive, and history/restore.
5. New-entry function.
