# LoreReviser

A SillyTavern extension that reads and updates lorebooks to reflect story and character changes.
See [PLAN.md](PLAN.md) for the design and milestones, and [docs/milestone1-findings.md](docs/milestone1-findings.md) for the SillyTavern API research.

**Status: milestone 5 (new entries).** Send asks the model to revise the selected entries and shows the proposals for review. **Approve saves the change into your lorebook**, and the old version is kept in a History file, so every change can be looked at and undone later. **New entries** mode asks the model for new entries in a lorebook you pick; they go through the same review cards, and Approve creates them. Tested with a scripted fake model; not yet with a real model.

Requires SillyTavern **1.19.0 or newer** (the Connection Manager extension must be enabled, which it is by default).

![Review cards](docs/screenshots/review-cards.png)

## What it does now
- Adds **LoreReviser** to the wand (extensions) menu next to the chat input. It opens a large modal.
- **Sidebar:** only the lorebooks linked to the open chat: global, character (primary and extra), chat, and persona. Each book expands to show its entries (title, or first keys if untitled; disabled entries are dimmed). Tick a whole book (tri-state box) or single entries. The selection is saved per chat.
- **Profile:** a Connection Manager profile used only by LoreReviser (independent of your main connection).
- **System prompt:** editable, with a **Restore default** button. Saved in extension settings.
- **Change:** *Development* (default) = the change is a progression in the story, so the lore may describe before/after, history and what changed. *Retcon* = the existing reality is changed and must be written as though it was always true: no "new", "now", "recently", "no longer", "changed", "became" and no acknowledgement of the change. Saved between sessions, used on Send and on Regenerate, and shown on every attempt next to the Rewrite intensity. The wording of each is editable under **Change type wording** (Restore default per type).
- **Rewrite intensity wording** and **Reply format rules (advanced):** collapsible sections under the system prompt (together with **Change type wording**). They hold the other parts of the system message that LoreReviser appends: the text for each of the three Rewrite levels (edited separately) and the strict reply-format rules. Each has its own **Restore default** button, and the rewrite-intensity heading stays fixed so the system prompt's reference to it remains valid. If you edit the reply-format rules so that they no longer ask for a JSON array of `{id, keys?, secondary_keys?, content?, note?}`, a warning is shown in the section and in the chat when you send (sending still works). See `docs/prompt-format.md`.

![Editable prompt parts](docs/screenshots/editable-prompt-parts.png)
![Reply format warning](docs/screenshots/rules-warning.png)
![Change type](docs/screenshots/change-type.png)
- **Rewrite:** how much the model may change. *Light touch* = only what must change for the new narrative (pronouns, a physical detail, ...), everything else verbatim. *Balanced* (default) = a little liberty, same essence. *Heavy-handed* = rewrite sections as needed to fit the narrative. Saved between sessions and also used by Regenerate. The prompt also tells the model to keep each entry's existing formatting (markdown, line breaks, bracket styles, field layouts, lists, casing, macros, decorators, regex keys). Every level (and every other default prompt part, including the new-entry prompt) also forbids changing existing headings and field labels: `HEIGHT:` stays `HEIGHT:` (never `HIGHT:`, never renamed or re-cased) unless you explicitly ask for a rename. Texts you customized keep your version; **Restore default** brings in the current wording.
- **Depth:** send only the last X chat messages. `0` = whole chat, `-1` = **no chat at all** (the label then reads "No chat will be sent"; the character card, active lore, selected entries and your instructions are still sent, and the prompt says that no chat history is provided). Hidden messages are never counted or sent. The "active lore" part is still worked out from the chat the way SillyTavern normally does, so lore that the chat would trigger can appear, but no chat text is sent.
- **Chat window:** type instructions and press Enter (Shift+Enter for a new line). Sending needs a profile, at least one selected entry, and non-empty instructions; otherwise a red error is shown and nothing is sent.
- **Reply tokens / Context:** the reply budget (0 = automatic) and the context size used for the "prompt may be too large" warning and for SillyTavern's World Info budget when working out the active lore (0 = taken from the profile's preset, else the current settings of the profile's API). The warning never blocks sending.

## How a revision works
1. Pick entries in the sidebar, write what should change, press Send. One request goes to the chosen profile with your system prompt, the character card, the lore that is active right now (without the entries you selected: an entry that is both selected and active is sent only once, in full, with the entries to revise; the chat shows a note such as "2 selected entries were already active; sent once"), the last X chat messages (Depth; none at -1), the full text and keys of every selected entry, and your instructions. Exact format: [docs/prompt-format.md](docs/prompt-format.md).
2. The model answers with the entries it changed. Each shows up as a card with the key changes and a block-level comparison. **Changes** (the default) lists unchanged sentences dimmed, then removed and added blocks, with each sentence on its own line so multi-paragraph lore stays readable (not flattened into one blob); **Full Compare** shows old and new side by side (stacked on narrow screens) with unchanged paragraphs dimmed and each changed region as a removed block next to the added block; **New** / **Old** show the plain text with newlines preserved. There is no word-by-word marking. Entries the model did not change are shown as "No changes". After a regenerate, swipe arrows with an n/N counter page between attempts, and the modal remembers which attempt you were on when you close and reopen it.
3. Per card: **Approve** (saves it to the lorebook, see "Saving and History" below), **Reject**, **Edit proposal** (the main edit button: the keys plus one box per changed part of the text, filled with the proposed green text, with the removed old text shown above it and a **Use old text** button; the unchanged text is shown dimmed and stays exactly as it is, so you don't have to find your way through the whole entry; empty a box to drop that change), **Edit full entry** (the keys and the whole text in one box; also reachable from inside Edit proposal, keeping what you typed). Editing is available on every card, also after Approve/Reject; "No changes" entries and new-entry cards have a single **Edit** with the whole text. The card shows "Edited by you", an edit after approval needs approving again, what you save is exactly what Approve will write, and **Reset to the model's version** undoes your edits, **Regenerate** (a multi-line box is always shown under the card: type an extra request for that regeneration if you like; the model sees its earlier attempts and their requests, each attempt remembers its request and rewrite intensity, and you can page between attempts with ‹ ›).
   Cards can be folded: click a card's header line (or the small arrow at its left) to hide or show its details; a folded card shows just the entry name, its book and its status. Approved cards fold up by themselves, so the ones still waiting for a decision stand out; Undo, or a click on the header, opens it again. Folding is remembered while the page is open, also when you close and reopen LoreReviser.

   ![Edit proposal](docs/screenshots/edit-proposal.png)
   ![Folded approved card](docs/screenshots/collapsed-approved.png)
4. Yellow warnings appear when a proposal drops a `@@decorator` line, a `/regex/` key or a `{{macro}}` the original had.
5. Entries the model leaves out of a complete reply show "No changes". "Not returned" appears only with real evidence: the reply ended inside the JSON (the warning shows the finish reason and tokens received / allowed), or that entry's part was unreadable. **Retry missing entries** asks again for just those. The automatic reply budget is generous (at least 4096 tokens, up to 32000) because thinking models spend part of it before answering; common JSON slips (raw line breaks, unescaped quotes) are repaired automatically. If the reply can't be read at all, you see an error plus the raw reply. Every revision also has a "Raw reply" section.
6. **Clear chat** (under the chat window) removes all messages and review cards but keeps your settings and selection; it asks first if proposals are still undecided. **Cancel** stops a running request. Models that "think" before answering use part of the reply tokens for that; raise Reply tokens if replies get cut off.

## New entries
Creating entries is separate from revising. Below the chat window, switch from **Revise selected entries** to **New entries**:

![New entries](docs/screenshots/new-entry-cards.png)

1. **Lorebook:** where the new entries go. The lorebooks linked to the chat are listed first, then every other lorebook. The last choice is remembered.
2. **Copy settings from** (optional): an entry of that lorebook whose settings the new entries get: everything except its content, title and keys (order, position, depth, role, probability, inclusion group, filters, timed effects, recursion and match options, constant/selective, even "disabled"). With "(none)" the new entries get SillyTavern's defaults, exactly as the World Info editor's "New entry" button makes them. The settings are copied when you press Approve, so they are the entry's current ones.
3. **also send its text as a format example** (on by default, only with an entry chosen): the chosen entry's keys and text are sent to the model so the new entries follow its layout and style. The model is told not to copy its facts.
4. Type what you want ("an entry for the blacksmith Tom from the last scene", "entries for the three guild leaders") and press **Propose** (or Enter). One request goes to the profile, with the character card, the active lore, the chat (Depth), the titles and keys of the entries already in the target lorebook (so the model avoids duplicates; no content), the format example and your instructions. The model can propose one or more entries; each comes back with a title, keys (and secondary keys) and content. Exact format: [docs/prompt-format.md](docs/prompt-format.md#new-entries).
5. Each proposal is a **review card** like a revision card, with a green "New entry" label: the Old side is empty, so **New** is the default view (Changes / Full Compare / Old also work). Yellow warnings appear when a proposal has no keys or no content, or when its title or a key is already used by an entry in that lorebook (a possible duplicate). **Edit** includes the **Title**. **Regenerate** works as for revisions (swipe arrows, extra request per attempt; the model sees its earlier attempts).
6. **Approve** creates the entry in the lorebook (title, keys, secondary keys, text, plus the copied or default settings) at the end of the editor's list, refreshes the World Info editor if that book is open, and records it in History. The card folds up and shows "Created in the lorebook ... as entry #N". The sidebar shows the new entry right away; from then on it is an ordinary entry that can be revised.
7. **Undo** on an approved new-entry card removes the entry again, but only if it is still exactly as created (keys, text and title); if it was changed meanwhile, Undo refuses (delete it in the World Info editor if you don't want it). **Reject** on a card you edited after approving it also removes the entry. Editing an approved card and approving again updates the created entry (text, keys and title) instead of making a second one.
8. Safety: if the lorebook was deleted or renamed, or the entry to copy settings from no longer exists, nothing is created and the card stays "Proposed" with the reason. If the model proposes nothing (`[]`), the chat says so.

Change type (Development / Retcon) applies to new entries too (Retcon: written as though it was always true). **Rewrite intensity is not used** for new entries, because there is no existing text to rewrite. The system prompt and reply-format rules for new entries are separate from the revision ones and editable under **New entry prompt** (each with Restore default; a warning appears if edited rules no longer ask for a JSON array with content and keys). Reply tokens: 0 = 8192 for new entries. Deleting entries is not part of LoreReviser (only removing an entry it created, see above).

## Saving and History
- **Approve** writes the approved keys, secondary keys and text into the lorebook entry straight away (nothing else about the entry is touched: title, order, position and other settings stay as they are). The World Info editor is refreshed if that book is open in it. The card says "Saved to the lorebook".
- **Safety check:** before saving, LoreReviser reads the entry again. If it was changed since the revision was made (for example by you in the World Info editor, or by another approval), it does **not** overwrite it: the card goes back to "Proposed" with a red note. Send a new revision for that entry to work from its current text.

  ![Not saved: entry changed meanwhile](docs/screenshots/stale-not-saved.png)
- **Undo** on an approved card puts the old version back into the lorebook (and notes that in History). If the entry was changed again after you approved it, Undo refuses and tells you to use History instead. **Reject** on a card you edited after approving it also puts the original back.
- **History:** every saved change is recorded: the entry, its old and new keys and text, the time, your instructions, and the rewrite intensity and change type. Open it anytime (even with an empty chat / no review cards) via the **clock icon** next to a lorebook in the sidebar, the **History** button in the sidebar title (picks a lorebook that has saved changes), or the **History** button on a card (just that entry). Changes are listed newest first; each row is **collapsible** like a review card (click the header to fold/unfold; newest starts expanded, older ones start collapsed), with the same Changes / Full Compare / New / Old views as the cards when expanded.
- **Restore old version** (in History) puts the "Old" side of a change back into the lorebook after asking you. The text it replaces is recorded in History first, so a restore can be restored again and nothing is lost. If the entry was changed outside LoreReviser since its last recorded change, the question says so. If the entry changes while the question is open, nothing is written.
- Entries that were deleted, or lorebooks that no longer exist, can't be written to; you get a plain message instead.
- **New entries in History:** a created entry shows as "New entry created" (Old side empty, with where its settings came from). Its button is **Remove this entry** instead of Restore: it takes the entry out of the lorebook again after asking, but only while it is still exactly as created; if it was changed since (by a later revision or in the World Info editor), it refuses. A removal (from Undo or from History) is listed as "Entry removed (creation undone)" and keeps a full copy of the entry with all its settings; its button **Create it again** puts it back (under its old number if that is free, otherwise a new one; it refuses if the same entry is already there). Removing, Undo of a creation and Create it again are recorded in History as well, so nothing is lost.
- A new entry never reuses the number (uid) of an entry that already has History in that lorebook (SillyTavern itself reuses the lowest free number), so two entries' histories never mix.

![History](docs/screenshots/history.png)
![History of a new entry](docs/screenshots/history-new-entry.png)

### Where History is stored
One file per lorebook in SillyTavern's `data/<user>/user/files/` folder, named `LoreReviser-archive__<name>__<code>.json` (the name is the lorebook name reduced to plain letters, digits and dashes; the code is a short fingerprint of the full name, so different books never share a file). SillyTavern only allows flat file names with plain letters there, which is why there is no folder. The real lorebook name is stored inside the file. They are ordinary JSON files and are included in SillyTavern's backups of your user data. LoreReviser remembers which file belongs to which lorebook in its settings.

### Renamed lorebooks: "Orphaned history files"
SillyTavern doesn't tell extensions when a lorebook is renamed. If a lorebook with saved History no longer exists under that name, the sidebar shows it under **Orphaned history files**. Pick the lorebook it belongs to now and press **Relink**; its History then shows up under the new name (the file itself keeps its name). **View** lets you look at it first. Nothing is ever deleted automatically: if you deleted the lorebook on purpose, you can simply ignore the entry.

![Orphaned history files](docs/screenshots/orphaned-archive.png)

Things to know: the lore being revised is usually also part of the "active lore" in the prompt (the model is told). Selected entries are read straight from the lorebook files and always sent in full: SillyTavern's World Info budget, recursion and activation limits only affect the "active lore" block (it can be shortened, and a note tells you when SillyTavern's budget really left entries out, with the numbers: tokens used/allowed, the percentage, which context size it came from and the cap if set; SillyTavern's own "budget reached" toast is suppressed for LoreReviser's lookup).

![World Info budget note](docs/screenshots/budget-note-numbers.png) Group chats are untested. Text-completion profiles are untested (chat-completion profiles are what the tests use).

## Install on Windows (PowerShell)

SillyTavern here is at `C:\sillyTavern\SillyTavern-Launcher\SillyTavern`. Extensions live in `data\default-user\extensions`.

### Option 1: git clone (simplest)
```powershell
cd C:\sillyTavern\SillyTavern-Launcher\SillyTavern\data\default-user\extensions
git clone https://github.com/Spanky-Harrison/LoreReviser.git
```
Update later:
```powershell
cd C:\sillyTavern\SillyTavern-Launcher\SillyTavern\data\default-user\extensions\LoreReviser
git pull
```

### Option 2: keep your working copy elsewhere and use a junction
Useful if you develop in another folder. Clone it wherever you like, then link it in:
```powershell
git clone https://github.com/Spanky-Harrison/LoreReviser.git C:\dev\LoreReviser
New-Item -ItemType Junction `
  -Path "C:\sillyTavern\SillyTavern-Launcher\SillyTavern\data\default-user\extensions\LoreReviser" `
  -Target "C:\dev\LoreReviser"
```
Remove the link without deleting your files: `(Get-Item <link path>).Delete()` (or `cmd /c rmdir <link path>`).

### Option 3: from inside SillyTavern
Extensions panel -> **Install extension** -> paste `https://github.com/Spanky-Harrison/LoreReviser`.

After installing, **hard-refresh the SillyTavern tab (Ctrl+F5)**. Open a chat, click the wand next to the message box, then **LoreReviser**.
If it does not appear, check the Extensions panel for load errors and the browser console (F12) for red errors.

## Known quirks
- **Data Maid lists the History files.** SillyTavern's **Data Maid** tool lists every file in `user/files` that no chat refers to as a "loose file", so the `LoreReviser-archive__....json` files show up there. Deleting them there deletes that lorebook's History (your lorebooks themselves are not affected). Leave them unticked unless you really want the History gone.
- Two browser tabs approving changes to the same lorebook at the same moment could each miss the other's History record. Use one tab at a time.
- Group chats: the sidebar tries to include each group member's character lorebooks, but this has not been tested yet.

## Files
| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest |
| `index.js` | Entry point: adds the wand menu item |
| `modal.js` | The modal UI (settings, sidebar, chat window, Send flow) |
| `prompt.js` | Builds the revision prompt, token estimate and context limit |
| `revision.js` | Sends the request on the profile, turns replies into review items, regenerate |
| `create.js` | New entries: builds and sends the request for a target lorebook, turns replies into review items, regenerate |
| `create-core.js` | New-entry default prompt and rules, request builder, proposal reading, settings copy, uid choice (no SillyTavern code; unit-tested) |
| `parse.js` | Tolerant reader for the model's JSON reply, integrity warnings |
| `diff.js` | Block diff and key-list diff for the cards; the changed-parts split used by "Edit proposal" (exact sentence slices, so edits go back in place) |
| `views.js` | Shared display pieces: key chips and the Changes / Full Compare / New / Old views |
| `review.js` | The review cards (approve / reject / edit / regenerate / paging / fold) |
| `apply.js` | Writing to lorebooks: Approve, Undo, Restore, with the safety check; creating new entries, removing them again, creating them again from History |
| `archive.js` | Reading and writing the History files, the index, relinking |
| `archive-core.js` | File names, records and index logic (no SillyTavern code; unit-tested) |
| `history.js` | The History window with Restore |
| `lorebooks.js` | Finds the lorebooks linked to the current chat and lists their entries |
| `settings.js` | Extension settings and defaults |
| `style.css` | Styling |
| `tests/` | Headless-browser test scripts (see `tests/README.md`) |

## Tests
`tests/` has unit tests for the parser, diff (including the "Edit proposal" hunks), prompt defaults and History file logic, and Playwright scripts that start a throwaway SillyTavern, seed test lorebooks, and drive the modal in headless Chrome, including a fake OpenAI-compatible model server with scripted replies (normal, truncated, malformed, error, slow). `e2e-archive.mjs` checks saving, History, Restore, the safety checks, folding cards and relinking, verifying every lorebook change through SillyTavern's own API. `e2e-create.mjs` checks the new-entry flow: the request, the cards, Approve creating entries with copied or default settings, Edit, Regenerate, Undo/Reject removing them, History remove / create again, and the safety checks. See `tests/README.md`; `tests/run-all.sh` runs everything.
