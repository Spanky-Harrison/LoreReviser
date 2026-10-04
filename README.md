# LoreReviser

A SillyTavern extension that reads and updates lorebooks to reflect story and character changes.
See [PLAN.md](PLAN.md) for the design and milestones, and [docs/milestone1-findings.md](docs/milestone1-findings.md) for the SillyTavern API research.

**Status: milestone 3 (revision and review).** Send asks the model to revise the selected entries and shows the proposals for review. **Approve only marks an entry as approved: nothing is written to your lorebooks yet** (writing and the archive come in milestone 4). Tested with a scripted fake model; not yet with a real model.

Requires SillyTavern **1.19.0 or newer** (the Connection Manager extension must be enabled, which it is by default).

![Review cards](docs/screenshots/review-cards.png)

## What it does now
- Adds **LoreReviser** to the wand (extensions) menu next to the chat input. It opens a large modal.
- **Sidebar:** only the lorebooks linked to the open chat: global, character (primary and extra), chat, and persona. Each book expands to show its entries (title, or first keys if untitled; disabled entries are dimmed). Tick a whole book (tri-state box) or single entries. The selection is saved per chat.
- **Profile:** a Connection Manager profile used only by LoreReviser (independent of your main connection).
- **System prompt:** editable, with a reset button. Saved in extension settings.
- **Depth:** send only the last X chat messages. `0` = whole chat, `-1` = **no chat at all** (the label then reads "No chat will be sent"; the character card, active lore, selected entries and your instructions are still sent, and the prompt says that no chat history is provided). Hidden messages are never counted or sent. The "active lore" part is still worked out from the chat the way SillyTavern normally does, so lore that the chat would trigger can appear, but no chat text is sent.
- **Chat window:** type instructions and press Enter (Shift+Enter for a new line). Sending needs a profile, at least one selected entry, and non-empty instructions; otherwise a red error is shown and nothing is sent.
- **Reply tokens / Context:** the reply budget (0 = automatic) and the context size used for the "prompt may be too large" warning (0 = taken from the profile's preset). The warning never blocks sending.

## How a revision works
1. Pick entries in the sidebar, write what should change, press Send. One request goes to the chosen profile with your system prompt, the character card, the lore that is active right now, the last X chat messages (Depth; none at -1), the full text and keys of every selected entry, and your instructions. Exact format: [docs/prompt-format.md](docs/prompt-format.md).
2. The model answers with the entries it changed. Each shows up as a card with the key changes and a block-level comparison: **Compare** shows old and new side by side (stacked on narrow screens) with unchanged paragraphs dimmed and each changed region as a removed block next to the added block; **Changes** lists unchanged sentences dimmed, then removed and added blocks; **New** / **Old** show the plain text. There is no word-by-word marking. Entries the model did not change are shown as "No changes".
3. Per card: **Approve** (marks it; nothing is saved yet), **Reject**, **Edit** (change the keys and text yourself; available on every card, also after Approve/Reject and on "No changes" entries; the card shows "Edited by you", an edit after approval needs approving again, and the text in the edit box is exactly what Approve will save), **Regenerate…** (optionally with new guidance; the model sees its earlier attempts for that entry, and you can page between attempts with ‹ ›).
4. Yellow warnings appear when a proposal drops a `@@decorator` line, a `/regex/` key or a `{{macro}}` the original had.
5. Entries the model leaves out of a complete reply show "No changes". "Not returned" appears only with real evidence: the reply ended inside the JSON (the warning shows the finish reason and tokens received / allowed), or that entry's part was unreadable. **Retry missing entries** asks again for just those. The automatic reply budget is generous (at least 4096 tokens, up to 32000) because thinking models spend part of it before answering; common JSON slips (raw line breaks, unescaped quotes) are repaired automatically. If the reply can't be read at all, you see an error plus the raw reply. Every revision also has a "Raw reply" section.
6. **Cancel** stops a running request. Models that "think" before answering use part of the reply tokens for that; raise Reply tokens if replies get cut off.

Things to know: the lore being revised is usually also part of the "active lore" in the prompt (the model is told). Selected entries are read straight from the lorebook files and always sent in full: SillyTavern's World Info budget, recursion and activation limits only affect the "active lore" block (it can be shortened, and a note tells you when SillyTavern's budget did that; SillyTavern's own "budget reached" toast is suppressed for LoreReviser's lookup). Group chats are untested. Text-completion profiles are untested (chat-completion profiles are what the tests use).

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
- When the archive arrives (milestone 4), its files are stored in SillyTavern's `user/files` folder as `LoreReviser-archive__<name>__<hash>.json`. SillyTavern's **Data Maid** tool lists any file there that no chat references as a "loose file", so these will show up in it. Don't delete them from there unless you mean to.
- Group chats: the sidebar tries to include each group member's character lorebooks, but this has not been tested yet.

## Files
| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest |
| `index.js` | Entry point: adds the wand menu item |
| `modal.js` | The modal UI (settings, sidebar, chat window, Send flow) |
| `prompt.js` | Builds the revision prompt, token estimate and context limit |
| `revision.js` | Sends the request on the profile, turns replies into review items, regenerate |
| `parse.js` | Tolerant reader for the model's JSON reply, integrity warnings |
| `diff.js` | Word diff and key-list diff for the cards |
| `review.js` | The review cards (approve / reject / edit / regenerate / paging) |
| `apply.js` | Stub: writing approved changes to the lorebook (milestone 4) |
| `lorebooks.js` | Finds the lorebooks linked to the current chat and lists their entries |
| `settings.js` | Extension settings and defaults |
| `style.css` | Styling |
| `tests/` | Headless-browser test scripts (see `tests/README.md`) |

## Tests
`tests/` has unit tests for the parser and diff, and Playwright scripts that start a throwaway SillyTavern, seed test lorebooks, and drive the modal in headless Chrome, including a fake OpenAI-compatible model server with scripted replies (normal, truncated, malformed, error, slow). See `tests/README.md`; `tests/run-all.sh` runs everything.
