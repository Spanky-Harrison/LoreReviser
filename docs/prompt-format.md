# Prompt and reply format (milestones 3 and 5)

LoreReviser builds one request itself and sends it on the chosen Connection Manager profile. This file describes it;
the code is in `prompt.js` (building), `parse.js` (reading the reply) and `revision.js` (sending).
The example below is a real request captured by the test suite (`tests/e2e-revision.mjs`) with depth 3.

## Request

Two chat messages, plus `max_tokens` (the "Reply tokens" setting, or automatic: about 2x the size of the selected entries + 2500, between 4096 and 32000).
The profile's preset supplies the sampler settings (temperature etc.). For a text-completion profile the two messages are turned into one string with the profile's instruct template (`ConnectionManagerRequestService.constructPrompt`; untested).

1. **system** = the editable system prompt from the modal + a **"Rewrite intensity"** section (Light touch / Balanced / Heavy-handed, chosen in the modal) + a **"Change type"** section (Development / Retcon, chosen in the modal) + the **"Reply format (strict)"** rules. All four parts are editable in the modal (see "Editing the system message" below); with no edits the text is exactly the defaults documented here. The fixed rules and the default system prompt both tell the model to **maintain all current formatting** of every entry (markdown, line breaks, bracket/tag styles, field layouts, list styles, casing, macros, decorators, regex keys) unless the instructions require otherwise.
2. **user** = these sections, in this order:
   - `<character_card>`: character and user names, description, personality, scenario, user persona.
   - `<active_lore>`: the lore that a normal send would activate right now (`getWorldInfoPrompt` dry run, scanning the whole visible chat, plus depth/AN/outlet entries). Entries that are selected for revision are **removed from this block** (they are sent once, in full, in `<entries_to_revise>`): the scan result (`checkWorldInfo`) says which entries are active by book + uid, and their exact text is taken out of the before/after text, depth groups, author's-note and outlet lists. If a text can't be located exactly, the entry's stored content is tried as a fallback, and anything that still can't be found is left as is (and logged). Entries that are not selected are never removed, even if their text is identical. A regenerate/retry request only removes the entries it lists. If nothing is left the block reads `(none active)`.
   - `<chat_history messages="X of Y">`: the last X visible messages (the depth setting; 0 = all), `Name: text`. Hidden/system messages are skipped. With depth -1 the block is kept but says `messages="0 of Y"` and "(No chat history is provided for this request. Work only from the character information, active lore, entries and instructions.)", so the model does not think the chat is merely empty. Regenerate requests behave the same.
   - `<entries_to_revise>`: for every selected entry: id (`E1`, `E2`, ... only valid for this request), book, title, keys and secondary keys as JSON arrays, and the full content.
   - `<instructions>`: what you typed.

## Reply

A JSON array. Only changed entries; everything else is left out:

```json
[{"id": "E2", "keys": ["Maren", "queen", "Maren the Wise"], "secondary_keys": ["..."], "content": "full new text", "note": "one short sentence"}]
```

- `keys`, `secondary_keys` and `content` may be left out when unchanged. `note` is optional and shown on the card.
- Parsing is tolerant: code fences, text around the JSON, `<think>` blocks, trailing commas, a `{"entries": [...]}` wrapper, a single object.
- Raw line breaks and unescaped quotes inside JSON strings, and invalid escapes, are repaired automatically (a small note says so).
- A reply that ends inside the JSON is detected (also reported: `finish_reason`, tokens received, tokens allowed, thinking tokens when the backend says): every complete entry is kept, the rest are shown as "Not returned", and "Retry missing entries" re-asks for just those. An entry that is simply absent from a complete array is "No changes".
- Entries that are left out, or returned identical to the original, are shown as "No changes".
- If nothing can be read, the raw reply is shown in the chat window. The raw reply of every request is also available under "Raw reply" in each revision.
- Warnings (shown on the card, never blocking): a leading `@@decorator` line, a `/regex/` key, or a `{{macro}}` that the original had and the proposal lacks.

## Regenerate (swipe-style)

Same request, but `<entries_to_revise>` holds only that entry, plus:

```
<previous_attempts entry="E2">
<attempt n="1">{"keys": [...], "secondary_keys": [...], "content": "..."}</attempt>
<attempt n="2" edited_by_user="true" user_request="the request typed for this attempt">{...}</attempt>
</previous_attempts>

<regeneration_request>
The user wants a new version of entry E2. Write a different, better version than the previous attempts. The user's extra request for this regeneration (follow it): <text from the box under the card> Reply with a JSON array containing only entry E2.
</regeneration_request>
```

The extra request comes from the always-visible box on the card (multi-line, optional); each attempt remembers the request that produced it and the model sees it again as `user_request` on the next regeneration. The rewrite intensity chosen in the modal *at that moment* applies to the regeneration (each attempt shows the intensity it was made with). The character card, lore and chat history are reused from the original Send (not recomputed), so attempts are comparable.
For an entry that had "No changes", the request says the first pass found no change and asks for a second look.

## Editing the system message

The system message is four pieces, joined by blank lines: `system prompt` + `## Rewrite intensity: <Label>` section + `## Change type: <Label>` section + `## Reply format (strict)` rules. In the modal, under "System prompt", there are three more collapsible sections:

- **Rewrite intensity wording:** one text box per level (Light touch / Balanced / Heavy-handed), each with its own **Restore default** button. Only the wording of the chosen level is sent. The heading line `## Rewrite intensity: <Label>` is added by LoreReviser and cannot be edited, so the default system prompt's guideline "Follow the 'Rewrite intensity' section" stays valid whatever you write (if you edit the system prompt itself, keep that reference or drop it).
- **Change type wording:** the same for the two change types (Development / Retcon), see below. The heading `## Change type: <Label>` is fixed, so the system prompt's guideline "Follow the 'Change type' section" stays valid.
- **Reply format rules (advanced):** the rules below, sent last. **Restore default** puts the original back.

Storage (`settings.intensityTexts`, `settings.changeTypeTexts`, `settings.formatRules`): only real edits are saved (`{ light: "..." }` and a string). An empty box, or text equal to the default, removes the override, so a later improvement of the defaults reaches you. A box left empty is refilled with the default text.

**Safeguard for the reply format.** LoreReviser can only read a reply that is a JSON array of `{id, keys?, secondary_keys?, content?, note?}` objects (see "Reply" below). While you edit the rules, a warning is shown if they no longer mention JSON, an array, `id` or `content`; the same warning is added to the chat when you send (sending is not blocked). The check is a heuristic, it cannot prove your wording works; if the model's answer cannot be read, the chat shows the usual error, and Restore default brings back the working rules.

## Rewrite intensity wording (defaults)

| Level | Text |
|---|---|
| Light touch | LIGHT TOUCH. Change only what MUST change to account for the new reality or narrative, for example pronouns, names, a specific physical detail, a changed status or relationship. Leave every other word, sentence and line exactly as it is, verbatim. Do not rephrase, reorder, tidy up, expand or "improve" anything that does not have to change. |
| Balanced (default) | BALANCED. You may take a little more liberty: rephrase or extend sentences where that helps the entry reflect the new situation. Keep the essence, structure and voice of what was there, and keep information that is still true. Do not rewrite parts that are still accurate just to make them sound different. |
| Heavy-handed | HEAVY-HANDED. Rewrite sections as much as needed so the entry fits the narrative and the user's instructions. Consider the original context and keep facts that are still true, but you are free to restructure, merge, split, reorder or replace text. The formatting rules above still apply to the layout you produce. |

## Change type (Development / Retcon)

Chosen in the modal header ("Change"), saved in settings (default **Development**), used on Send, on Retry missing entries (the type of the Send) and on Regenerate (the type chosen *now*, like the intensity). Each attempt on a card shows "Change type: ..." next to the intensity. It adds this section to the system message, right after the intensity section (the heading is fixed, only the wording is editable, each with its own Restore default):

| Type | Text |
|---|---|
| Development (default) | DEVELOPMENT. The changes are a progression in the story: things used to be one way and are now another. Write the entry so that it reflects how things now are, and where it helps you may describe the before and after, the history, and what has changed. Keep what is still true, and keep the entry compact; do not retell the whole story. |
| Retcon | RETCON. The change is to the existing reality, and the entry must read as though the new version was always true. Rewrite it as established fact and do not acknowledge the change in any way. Do not use language that calls anything new or implies a change or a timeline, for example: "new", "now", "recently", "no longer", "anymore", "used to", "formerly", "previously", "originally", "changed", "became", "turned out", "has since", "revealed". Do not describe a before and after, a history of the change, or a correction. State the facts plainly in the entry's usual tense. (Your optional "note" field is for the user and may explain what you changed; the entry text itself must not.) |

The default system prompt has the guideline: *Follow the "Change type" section: it says whether the lore should describe the change as a development in the story (before and after) or be written as though it had always been true (retcon).* A saved system prompt that still equals the previous default is upgraded to the new default automatically; a prompt you edited is left alone (add the line yourself if you want it).

LoreReviser does not check the model's output for forbidden words in Retcon mode; the wording is an instruction to the model, so check the cards.

## Token pre-flight

Before sending, the prompt is counted with `getTokenCountAsync`. If prompt tokens + reply tokens are above 97% of the context limit, a warning is shown (toast and in the chat) but the request is still sent.
The limit comes from, in order: the "Context" box in the modal (if not 0); the Chat Completion preset of the profile (`openai_max_context`); for a Chat Completion profile without a preset, the current Chat Completion settings (`openai_max_context`); for a Text Completion profile, the Text Completion context slider; with no profile, ST's own `getMaxContextTokens()` for the main API.
Note that a preset can hold a smaller value than the model really supports; use the "Context" box then.
`SillyTavern.getContext().maxContext` is **not** used: it is only the Text Completion context slider, even when you use Chat Completion.

## World Info budget for `<active_lore>`

The active-lore scan uses the same context as above, minus the response length (the preset's or the current `openai_max_tokens`; for Text Completion the response length slider), because that is what ST's `Generate()` passes to `checkWorldInfo` (`getMaxPromptTokens()`). ST then computes `budget = round(world_info_budget% × that / 100)`, replaced by "Budget Cap" when the cap is set and smaller.
The note "SillyTavern's World Info budget was reached" is shown only when ST really left entries out (from the `WORLDINFO_SCAN_DONE` event of our own scan: entries that passed the checks but are not in the activated set), and only if at least one of them is not being revised anyway. It says the tokens used and allowed, the percentage and the context it was taken from (and the cap, if set), and lists the left-out entries. Each scan is also logged to the console (`[LoreReviser] WI scan: ...`).

Root cause of an earlier bug: the scan was passed `ctx.maxContext` (the Text Completion slider, e.g. 512 to 8192), so a Chat Completion user with a 262144-token context and a 50% budget got a budget of a few thousand tokens or less, and a modest lorebook "overflowed".

## Example request (captured)

### system
```
You are a careful lorebook editor for an ongoing roleplay. Lorebook entries are short reference texts that are injected into the roleplay prompt when their keywords appear.

You will receive the character card, the lore that is currently active, the recent chat, and a list of lorebook entries to revise. Revise the entries so they match what has happened in the chat and what the user asks for.

Guidelines:
- Only change what the chat or the user's instructions support. Never invent facts, names, or events.
- Keep information that is still true. Update or remove only what the story has made outdated or wrong.
- Keep each entry's existing style, point of view, tense and rough length. Entries should stay compact; do not turn them into summaries of the whole chat.
- Maintain ALL of each entry's current formatting unless the instructions require otherwise: markdown, line breaks and blank lines, bracket or tag styles (such as [Name: ...] or <tag>), field layouts (such as "Key: value" lines), list styles and bullet characters, casing conventions, {{macros}}, @@decorator lines and /regex/ keys. New text must follow the same layout as the text around it.
- Follow the "Rewrite intensity" section: it says how much of the existing wording you may change.
- Follow the "Change type" section: it says whether the lore should describe the change as a development in the story (before and after) or be written as though it had always been true (retcon).
- Keys are the trigger words for the entry. Add keys only for names, nicknames or terms that people will really use in the chat; drop keys that are no longer correct. Keep key capitalisation natural.
- Do not copy lore from one entry into another. The active lore is given for context only; it may contain the very entries you are revising.
- If an entry needs no change, leave it out of your reply.

## Rewrite intensity: Balanced
BALANCED. You may take a little more liberty: rephrase or extend sentences where that helps the entry reflect the new situation. Keep the essence, structure and voice of what was there, and keep information that is still true. Do not rewrite parts that are still accurate just to make them sound different.

## Change type: Development
DEVELOPMENT. The changes are a progression in the story: things used to be one way and are now another. Write the entry so that it reflects how things now are, and where it helps you may describe the before and after, the history, and what has changed. Keep what is still true, and keep the entry compact; do not retell the whole story.

## Reply format (strict)
Reply with ONE JSON array and nothing else: no commentary before or after it, no markdown code fences.
Each element revises one entry from <entries_to_revise>:
{"id": "E1", "keys": ["..."], "secondary_keys": ["..."], "content": "...", "note": "..."}

Rules:
- "id" is copied exactly from the entry's id attribute (E1, E2, ...).
- Include ONLY entries you changed. Leave out every entry that needs no change. If nothing needs changing, reply [].
- "content": the complete new text of the entry (not a diff). Leave this field out if the content stays the same.
- "keys" and "secondary_keys": the complete new list of trigger keys. Leave a field out if that list stays the same.
- "note": one short sentence saying what you changed and why.
- Maintain ALL current formatting of each entry unless the instructions require otherwise: markdown, line breaks and blank lines, bracket or tag styles ([Name: ...], <tag>), field layouts ("Key: value" lines), list styles and bullet characters, casing conventions, {{macros}}, @@decorator lines at the start of the content, and /regex/ keys. Text you add must use the same layout as the text around it. If the content has several lines or paragraphs, keep the same line structure (use 
 in the JSON string).
- The reply must be valid JSON: escape double quotes inside strings as \" and line breaks as \n.
```

### user
```
<character_card>
Character: Test Queen

User: User

Description:
A queen.

Personality:
stern

Scenario:
Throne room
</character_card>

<active_lore>
The Festival of Lanterns is held each autumn in the harbor town of Saltmere. Every household floats a paper lantern for someone they have lost.
The festival is run by the Harbor Guild. The guild master lights the first lantern at dusk, and nobody may speak until the last one has drifted past the lighthouse.
Children are told that the lanterns guide the dead home. Sailors say the lanterns are only there to keep the fishing boats from the rocks.
The week after the festival, the town holds a market where the guild sells the remaining lantern paper at half price.
The moon festival falls on the third full moon.
Silver crowns.
Behind the throne. User knows the way.
</active_lore>

<chat_history messages="3 of 8">
Test Queen: Message number 6

User: Message number 7

Test Queen: Message number 8
</chat_history>

<entries_to_revise>
<entry id="E1" book="Eldoria" title="Kingdom of Eldoria">
<keys>["Eldoria","the kingdom"]</keys>
<secondary_keys>[]</secondary_keys>
<content>
A northern kingdom ruled by Queen Maren.
</content>
</entry>
<entry id="E2" book="Eldoria" title="Queen Maren">
<keys>["Maren","queen"]</keys>
<secondary_keys>[]</secondary_keys>
<content>
Stern but fair monarch, 54 years old.
</content>
</entry>
<entry id="E3" book="Chat Lore" title="The Missing Heir">
<keys>["heir"]</keys>
<secondary_keys>[]</secondary_keys>
<content>
Prince Aldric vanished last winter.
</content>
</entry>
</entries_to_revise>

<instructions>
The queen turned 55 and is now also called Maren the Wise.
</instructions>

Reply with the JSON array only.
```


## New entries

Milestone 5. A separate request, sent from the modal's **New entries** mode (code: `create.js`, pure parts in `create-core.js`). Same profile, Depth, Context and Reply tokens settings as a revision; `max_tokens` is the "Reply tokens" value or, at 0, **8192**.

### Request

1. **system** = the **new-entry system prompt** + the **`## Change type: <Label>`** section (the same wording as for revisions, chosen in the modal) + the **new-entry reply-format rules**. There is **no rewrite-intensity section**: there is no existing text to rewrite. The new-entry prompt and rules are separate from the revision ones and editable in the modal under **New entry prompt** (each with Restore default; stored as `settings.createSystemPrompt` and `settings.createFormatRules`, the latter only when edited).
2. **user** = these sections, in this order:
   - `<character_card>`, `<active_lore>`, `<chat_history>`: built exactly as for a revision (nothing is removed from the active lore, because no entry is being revised; depth -1 keeps the block with the "no chat history" note).
   - `<target_lorebook name=... existing_entries=N>`: one `<existing_entry title=... keys=[...]/>` line per entry already in the chosen lorebook (title = the entry's real title, empty if it has none; no content, to save tokens), so the model can avoid duplicates.
   - `<format_example title=...>` (only when an entry is chosen under "Copy settings from" and "also send its text as a format example" is ticked): that entry's keys, secondary keys and content. The prompt says to copy its layout and style, not its facts.
   - `<instructions>`: what you typed.
   - `Reply with the JSON array of new entries only.`

Example user message (depth 3, with a format example):

```
<character_card>
Character: Test Queen
User: User

Description:
A queen.
</character_card>

<active_lore>
Silver crowns.
The moon festival falls on the third full moon.
</active_lore>

<chat_history messages="3 of 8">
User: Message number 6

Test Queen: Message number 7

User: Message number 8
</chat_history>

<target_lorebook name="Eldoria" existing_entries="3">
<existing_entry title="Kingdom of Eldoria" keys=["Eldoria","the kingdom"]/>
<existing_entry title="Queen Maren" keys=["Maren","queen"]/>
<existing_entry title="" keys=["Silverwood","forest"]/>
</target_lorebook>

<format_example title="Queen Maren">
<keys>["Maren","queen"]</keys>
<secondary_keys>[]</secondary_keys>
<content>
Stern but fair monarch, 54 years old.
</content>
</format_example>

<instructions>
Add the blacksmith Tom from the last scene.
</instructions>

Reply with the JSON array of new entries only.
```

### Default system prompt for new entries

```
You are a careful lorebook writer for an ongoing roleplay. Lorebook entries are short reference texts that are injected into the roleplay prompt when their keywords appear.

You will receive the character card, the lore that is currently active, the recent chat, a list of the entries that already exist in the target lorebook, and the user's request. Write the NEW lorebook entries the user asks for.

Guidelines:
- Write only new entries. Do not rewrite or repeat existing entries, and do not create an entry for something an existing entry already covers.
- Base every fact on the chat, the character information, the active lore and the user's instructions. Do not contradict them. Only fill gaps with invented detail where the user asks for it.
- One subject per entry (a person, place, item, faction, event, custom, concept ...). Entries are compact reference texts, not summaries of the chat.
- If a <format_example> is given, write every entry in the same style and layout as it: markdown, line breaks, bracket or tag styles (such as [Name: ...] or <tag>), field layouts (such as "Key: value" lines), list styles, casing, point of view and rough length. Use it for the format only; do not copy its facts. Without an example, follow the style of the existing lore.
- Follow the "Change type" section: it says whether the lore may describe how things came to be (a development in the story) or must read as though it had always been true (retcon).
- Keys are the trigger words: names, nicknames or terms that will really appear in the chat. Give each entry 1 to 5 natural keys and avoid very common words.
- Give each entry a short title, usually the name of its subject.
```

### Default reply-format rules for new entries

```
## Reply format (strict)
Reply with ONE JSON array and nothing else: no commentary before or after it, no markdown code fences.
Each element is one new entry:
{"title": "...", "keys": ["..."], "secondary_keys": [], "content": "...", "note": "..."}

Rules:
- "title": a short name for the entry (shown as its title in the lorebook).
- "keys": the trigger keys, at least one. "secondary_keys": optional extra keys; usually leave it as [].
- "content": the complete text of the entry.
- "note": one short sentence for the user saying what the entry covers and why it is useful.
- Propose as many entries as the request needs, usually one per subject. If no new entry is needed, reply [].
- If the content has several lines or paragraphs, use \n in the JSON string.
- The reply must be valid JSON: escape double quotes inside strings as \" and line breaks as \n.
```

### Reply

A JSON array, one element per new entry:

```json
[{"title": "Tom the Blacksmith", "keys": ["Tom", "blacksmith"], "secondary_keys": [], "content": "Tom forges blades for the royal guard.\nHe works by the north gate.", "note": "Tom appeared in the last scene."}]
```

- Read with the same tolerant parser as revisions (code fences, chatter, `<think>` blocks, trailing commas, JSON repair, cut-off replies keep every complete entry). Also accepted: a single object, a `{"new_entries": [...]}` or `{"proposals": [...]}` wrapper, `comment`/`name` for the title, `key`/`keysecondary` for the keys, keys as a comma-separated string (split like SillyTavern does, so `/regex, with comma/` keys survive).
- An element with neither content nor keys is left out (the session says how many). `[]` means "no new entry needed" and is shown as such. An unreadable reply shows the error and the raw reply.
- Each element becomes a review card (ids N1, N2, ... for this session only). Warnings (never blocking): no keys, no content, a title equal to an existing entry's title, or a key that an existing entry already uses.

### Regenerate

Same request plus:

```
<previous_attempts proposal="N1">
<attempt n="1">{"title":"Tom the Blacksmith","keys":["Tom","blacksmith"],"secondary_keys":[],"content":"..."}</attempt>
<attempt n="2" edited_by_user="true" user_request="the request typed for this attempt">{...}</attempt>
</previous_attempts>

<regeneration_request>
The user wants a new version of the proposed new entry N1. Write a different, better version than the previous attempts, about the same subject. The user's extra request for this regeneration (follow it): <text from the box under the card> Reply with a JSON array containing exactly one entry.
</regeneration_request>
```

The change type chosen in the modal at that moment applies (shown on the attempt). The first element of the reply is used.

### What Approve writes

`createWorldInfoEntry` (SillyTavern's own template = the defaults of the World Info editor's "New entry" button), then, if an entry was chosen under "Copy settings from", every field of that entry (read again at Approve time) except `uid`, `content`, `comment`, `key`, `keysecondary` and `displayIndex`; then the proposal's `comment` (title), `key`, `keysecondary` and `content`, `addMemo = true` when there is a title, and `displayIndex` after the last entry. Saved with `saveWorldInfo(name, data, true)` + `reloadWorldInfoEditor`. The uid is SillyTavern's lowest free number unless that number already appears in the book's History, in which case the next number that is free in both is used. History records: `create` (old side empty; `comment`, `settingsFrom` = {uid, title} or "defaults"), `remove` (new side empty; `snapshot` = the whole entry; `via` = "undo" or "history"), `recreate` (from a removal's snapshot; `originalUid` if it got a new number), and `approve` when an approved card is edited and approved again (`oldTitle` if the title changed).
