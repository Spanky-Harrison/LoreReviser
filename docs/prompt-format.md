# Prompt and reply format (milestone 3)

LoreReviser builds one request itself and sends it on the chosen Connection Manager profile. This file describes it;
the code is in `prompt.js` (building), `parse.js` (reading the reply) and `revision.js` (sending).
The example below is a real request captured by the test suite (`tests/e2e-revision.mjs`) with depth 3.

## Request

Two chat messages, plus `max_tokens` (the "Reply tokens" setting, or automatic: about 2x the size of the selected entries + 2500, between 4096 and 32000).
The profile's preset supplies the sampler settings (temperature etc.). For a text-completion profile the two messages are turned into one string with the profile's instruct template (`ConnectionManagerRequestService.constructPrompt`; untested).

1. **system** = the editable system prompt from the modal + a **"Rewrite intensity"** section (Light touch / Balanced / Heavy-handed, chosen in the modal) + the fixed "Reply format" rules (so editing the prompt cannot break parsing). The fixed rules and the default system prompt both tell the model to **maintain all current formatting** of every entry (markdown, line breaks, bracket/tag styles, field layouts, list styles, casing, macros, decorators, regex keys) unless the instructions require otherwise.
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

## Rewrite intensity wording (added to the system message)

| Level | Text |
|---|---|
| Light touch | LIGHT TOUCH. Change only what MUST change to account for the new reality or narrative, for example pronouns, names, a specific physical detail, a changed status or relationship. Leave every other word, sentence and line exactly as it is, verbatim. Do not rephrase, reorder, tidy up, expand or "improve" anything that does not have to change. |
| Balanced (default) | BALANCED. You may take a little more liberty: rephrase or extend sentences where that helps the entry reflect the new situation. Keep the essence, structure and voice of what was there, and keep information that is still true. Do not rewrite parts that are still accurate just to make them sound different. |
| Heavy-handed | HEAVY-HANDED. Rewrite sections as much as needed so the entry fits the narrative and the user's instructions. Consider the original context and keep facts that are still true, but you are free to restructure, merge, split, reorder or replace text. The formatting rules above still apply to the layout you produce. |

## Token pre-flight

Before sending, the prompt is counted with `getTokenCountAsync`. If prompt tokens + reply tokens are above 97% of the context limit, a warning is shown (toast and in the chat) but the request is still sent.
The limit comes from, in order: the "Context" box in the modal (if not 0), the Chat Completion preset of the profile (`openai_max_context`), your main connection's context size.
Note that a preset can hold a smaller value than the model really supports; use the "Context" box then.

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
- Keys are the trigger words for the entry. Add keys only for names, nicknames or terms that people will really use in the chat; drop keys that are no longer correct. Keep key capitalisation natural.
- Do not copy lore from one entry into another. The active lore is given for context only; it may contain the very entries you are revising.
- If an entry needs no change, leave it out of your reply.

## Rewrite intensity: Balanced
BALANCED. You may take a little more liberty: rephrase or extend sentences where that helps the entry reflect the new situation. Keep the essence, structure and voice of what was there, and keep information that is still true. Do not rewrite parts that are still accurate just to make them sound different.

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
