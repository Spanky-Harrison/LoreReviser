# Prompt and reply format (milestone 3)

LoreReviser builds one request itself and sends it on the chosen Connection Manager profile. This file describes it;
the code is in `prompt.js` (building), `parse.js` (reading the reply) and `revision.js` (sending).
The example below is a real request captured by the test suite (`tests/e2e-revision.mjs`) with depth 3.

## Request

Two chat messages, plus `max_tokens` (the "Reply tokens" setting, or automatic: about 2x the size of the selected entries + 2500, between 4096 and 32000).
The profile's preset supplies the sampler settings (temperature etc.). For a text-completion profile the two messages are turned into one string with the profile's instruct template (`ConnectionManagerRequestService.constructPrompt`; untested).

1. **system** = the editable system prompt from the modal + the fixed "Reply format" rules (so editing the prompt cannot break parsing).
2. **user** = these sections, in this order:
   - `<character_card>`: character and user names, description, personality, scenario, user persona.
   - `<active_lore>`: the lore that a normal send would activate right now (`getWorldInfoPrompt` dry run, scanning the whole visible chat, plus depth/AN/outlet entries). It can contain the entries being revised.
   - `<chat_history messages="X of Y">`: the last X visible messages (the depth setting), `Name: text`. Hidden/system messages are skipped.
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
<attempt n="2" edited_by_user="true">{...}</attempt>
</previous_attempts>

<regeneration_request>
The user wants a new version of entry E2. Write a different, better version than the previous attempts, following this extra guidance: <your note>. Reply with a JSON array containing only entry E2.
</regeneration_request>
```

The character card, lore and chat history are reused from the original Send (not recomputed), so attempts are comparable.
For an entry that had "No changes", the request says the first pass found no change and asks for a second look.

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
- Keep each entry's existing style, point of view, tense, format and rough length. Entries should stay compact; do not turn them into summaries of the whole chat.
- Keys are the trigger words for the entry. Add keys only for names, nicknames or terms that people will really use in the chat; drop keys that are no longer correct. Keep key capitalisation natural.
- Do not copy lore from one entry into another. The active lore is given for context only; it may contain the very entries you are revising.
- If an entry needs no change, leave it out of your reply.

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
- Keep {{macros}}, @@decorator lines at the start of the content, and /regex/ keys exactly as they are, unless the user's instructions say otherwise.
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
Silver crowns.
Stern but fair monarch, 54 years old.
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
