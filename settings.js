// Extension settings (saved by ST in settings.json under extension_settings.LoreReviser).

import { normalizeDepth } from './depth.js';
import { DEFAULT_INTENSITY, normalizeIntensity } from './intensity.js';
import { DEFAULT_CHANGE_TYPE, normalizeChangeType } from './changetype.js';
import { DEFAULT_CREATE_SYSTEM_PROMPT } from './create-core.js';
import { DEFAULT_REPLY_STYLE, normalizeReplyStyle } from './rules.js';

export const MODULE_NAME = 'LoreReviser';

/** The editable part of the system prompt. The fixed reply-format rules are appended separately (see prompt.js). */
export const DEFAULT_SYSTEM_PROMPT = `You are a careful lorebook editor for an ongoing roleplay. Lorebook entries are short reference texts that are injected into the roleplay prompt when their keywords appear.

You will receive the character card, the lore that is currently active, the recent chat, and a list of lorebook entries to revise. Revise the entries so they match what has happened in the chat and what the user asks for.

Guidelines:
- Only change what the chat or the user's instructions support. Never invent facts, names, or events.
- Keep information that is still true. Update or remove only what the story has made outdated or wrong.
- Keep each entry's existing style, point of view, tense and rough length. Entries should stay compact; do not turn them into summaries of the whole chat.
- Maintain ALL of each entry's current formatting unless the instructions require otherwise: markdown, line breaks and blank lines, bracket or tag styles (such as [Name: ...] or <tag>), field layouts (such as "Key: value" lines), list styles and bullet characters, casing conventions, {{macros}}, @@decorator lines and /regex/ keys. New text must follow the same layout as the text around it.
- Keep every existing heading and field label exactly as it is written, character for character (for example "HEIGHT:", "Hair:", "[Appearance]" or "## Background"): same spelling, casing, punctuation and symbols. Never rename, reword, translate, re-case, abbreviate or misspell one, and never invent a variant of it (HEIGHT must not become HIGHT, HAIR must not become HAIIR). Change only the text that belongs to the label. Rename a heading only if the user explicitly asks for it. A field you add uses the same label style as the existing ones.
- Follow the "Rewrite intensity" section: it says how much of the existing wording you may change.
- Follow the "Change type" section: it says whether the lore should describe the change as a development in the story (before and after) or be written as though it had always been true (retcon).
- Keys are the trigger words for the entry. Add keys only for names, nicknames or terms that people will really use in the chat; drop keys that are no longer correct. Keep key capitalisation natural.
- Do not copy lore from one entry into another. The active lore is given for context only; it may contain the very entries you are revising.
- If an entry needs no change, leave it out of your reply.`;

/** Earlier default prompts. A saved prompt equal to one of these is replaced by the current default. */
export const LEGACY_DEFAULT_PROMPTS = [
    "You are a careful lorebook editor for an ongoing roleplay. Lorebook entries are short reference texts that are injected into the roleplay prompt when their keywords appear.\n\nYou will receive the character card, the lore that is currently active, the recent chat, and a list of lorebook entries to revise. Revise the entries so they match what has happened in the chat and what the user asks for.\n\nGuidelines:\n- Only change what the chat or the user's instructions support. Never invent facts, names, or events.\n- Keep information that is still true. Update or remove only what the story has made outdated or wrong.\n- Keep each entry's existing style, point of view, tense and rough length. Entries should stay compact; do not turn them into summaries of the whole chat.\n- Maintain ALL of each entry's current formatting unless the instructions require otherwise: markdown, line breaks and blank lines, bracket or tag styles (such as [Name: ...] or <tag>), field layouts (such as \"Key: value\" lines), list styles and bullet characters, casing conventions, {{macros}}, @@decorator lines and /regex/ keys. New text must follow the same layout as the text around it.\n- Follow the \"Rewrite intensity\" section: it says how much of the existing wording you may change.\n- Follow the \"Change type\" section: it says whether the lore should describe the change as a development in the story (before and after) or be written as though it had always been true (retcon).\n- Keys are the trigger words for the entry. Add keys only for names, nicknames or terms that people will really use in the chat; drop keys that are no longer correct. Keep key capitalisation natural.\n- Do not copy lore from one entry into another. The active lore is given for context only; it may contain the very entries you are revising.\n- If an entry needs no change, leave it out of your reply.",
    "You are a careful lorebook editor for an ongoing roleplay. Lorebook entries are short reference texts that are injected into the roleplay prompt when their keywords appear.\n\nYou will receive the character card, the lore that is currently active, the recent chat, and a list of lorebook entries to revise. Revise the entries so they match what has happened in the chat and what the user asks for.\n\nGuidelines:\n- Only change what the chat or the user's instructions support. Never invent facts, names, or events.\n- Keep information that is still true. Update or remove only what the story has made outdated or wrong.\n- Keep each entry's existing style, point of view, tense and rough length. Entries should stay compact; do not turn them into summaries of the whole chat.\n- Maintain ALL of each entry's current formatting unless the instructions require otherwise: markdown, line breaks and blank lines, bracket or tag styles (such as [Name: ...] or <tag>), field layouts (such as \"Key: value\" lines), list styles and bullet characters, casing conventions, {{macros}}, @@decorator lines and /regex/ keys. New text must follow the same layout as the text around it.\n- Follow the \"Rewrite intensity\" section: it says how much of the existing wording you may change.\n- Keys are the trigger words for the entry. Add keys only for names, nicknames or terms that people will really use in the chat; drop keys that are no longer correct. Keep key capitalisation natural.\n- Do not copy lore from one entry into another. The active lore is given for context only; it may contain the very entries you are revising.\n- If an entry needs no change, leave it out of your reply.",
    "You are a careful lorebook editor for an ongoing roleplay. Lorebook entries are short reference texts that are injected into the roleplay prompt when their keywords appear.\n\nYou will receive the character card, the lore that is currently active, the recent chat, and a list of lorebook entries to revise. Revise the entries so they match what has happened in the chat and what the user asks for.\n\nGuidelines:\n- Only change what the chat or the user's instructions support. Never invent facts, names, or events.\n- Keep information that is still true. Update or remove only what the story has made outdated or wrong.\n- Keep each entry's existing style, point of view, tense, format and rough length. Entries should stay compact; do not turn them into summaries of the whole chat.\n- Keys are the trigger words for the entry. Add keys only for names, nicknames or terms that people will really use in the chat; drop keys that are no longer correct. Keep key capitalisation natural.\n- Do not copy lore from one entry into another. The active lore is given for context only; it may contain the very entries you are revising.\n- If an entry needs no change, leave it out of your reply.",
    [
        'You are a lorebook editor for a roleplay. You are given the recent chat, the character information,',
        'the currently active lore, and a set of lorebook entries to revise.',
        'Update each entry (its content and its keys) so it reflects what happened in the chat,',
        'following the user\'s instructions. Keep the existing style and format. Do not invent facts.',
        'Leave special syntax such as {{macros}}, @@decorators and /regex/ keys untouched.',
    ].join(' '),
];

/** Earlier default new-entry prompts. A saved one equal to one of these is replaced by the current default. */
export const LEGACY_CREATE_PROMPTS = [
    "You are a careful lorebook writer for an ongoing roleplay. Lorebook entries are short reference texts that are injected into the roleplay prompt when their keywords appear.\n\nYou will receive the character card, the lore that is currently active, the recent chat, a list of the entries that already exist in the target lorebook, and the user's request. Write the NEW lorebook entries the user asks for.\n\nGuidelines:\n- Write only new entries. Do not rewrite or repeat existing entries, and do not create an entry for something an existing entry already covers.\n- Base every fact on the chat, the character information, the active lore and the user's instructions. Do not contradict them. Only fill gaps with invented detail where the user asks for it.\n- One subject per entry (a person, place, item, faction, event, custom, concept ...). Entries are compact reference texts, not summaries of the chat.\n- If a <format_example> is given, write every entry in the same style and layout as it: markdown, line breaks, bracket or tag styles (such as [Name: ...] or <tag>), field layouts (such as \"Key: value\" lines), list styles, casing, point of view and rough length. Use it for the format only; do not copy its facts. Without an example, follow the style of the existing lore.\n- Follow the \"Change type\" section: it says whether the lore may describe how things came to be (a development in the story) or must read as though it had always been true (retcon).\n- Keys are the trigger words: names, nicknames or terms that will really appear in the chat. Give each entry 1 to 5 natural keys and avoid very common words.\n- Give each entry a short title, usually the name of its subject.",
];

const DEFAULT_SETTINGS = {
    profileId: '',                    // Connection Manager profile id ('' = none chosen)
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    intensityTexts: {},               // edited wordings per intensity level; a missing/blank level uses the default (see intensity.js)
    formatRules: '',                  // edited Full rewrite reply-format rules; '' = the default (see rules.js)
    passageFormatRules: '',           // edited "Changed passages only" reply-format rules; '' = the default (see rules.js)
    replyStyle: DEFAULT_REPLY_STYLE,  // how the model answers for existing entries: 'passages' (find/replace edits) | 'full'
    changeTypeTexts: {},              // edited wordings per change type (see changetype.js)
    changeType: DEFAULT_CHANGE_TYPE,  // 'development' | 'retcon'
    intensity: DEFAULT_INTENSITY,     // rewrite intensity: 'light' | 'balanced' | 'heavy'
    depth: 0,                         // last X chat messages to send; 0 = whole chat; -1 = no chat at all
    replyTokens: 0,                   // max tokens for the model's reply; 0 = automatic
    contextLimit: 0,                  // context size used for the "too large" warning; 0 = take it from the profile's preset
    createSystemPrompt: DEFAULT_CREATE_SYSTEM_PROMPT, // system prompt for new entries (see create-core.js)
    createFormatRules: '',            // edited reply-format rules for new entries; '' = the default (see create-core.js)
    createBook: '',                   // last lorebook chosen for new entries
    archiveIndex: {},                 // History files: { "<lorebook name>": "<archive file name in user/files>" } (see archive.js)
};

/** Returns this extension's settings, filling in any missing defaults. */
export function getSettings() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    // Fill in defaults in place so every caller shares the same object that ST saves.
    const settings = (extensionSettings[MODULE_NAME] ??= {});
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) settings[key] ??= structuredClone(value);
    if (!settings.intensityTexts || typeof settings.intensityTexts !== 'object' || Array.isArray(settings.intensityTexts)) settings.intensityTexts = {};
    if (!settings.archiveIndex || typeof settings.archiveIndex !== 'object' || Array.isArray(settings.archiveIndex)) settings.archiveIndex = {};
    if (typeof settings.formatRules !== 'string') settings.formatRules = '';
    if (typeof settings.passageFormatRules !== 'string') settings.passageFormatRules = '';
    settings.replyStyle = normalizeReplyStyle(settings.replyStyle);
    if (typeof settings.createFormatRules !== 'string') settings.createFormatRules = '';
    if (typeof settings.createSystemPrompt !== 'string' || !settings.createSystemPrompt.trim()) settings.createSystemPrompt = DEFAULT_CREATE_SYSTEM_PROMPT;
    if (typeof settings.createBook !== 'string') settings.createBook = '';
    if (!settings.changeTypeTexts || typeof settings.changeTypeTexts !== 'object' || Array.isArray(settings.changeTypeTexts)) settings.changeTypeTexts = {};
    settings.changeType = normalizeChangeType(settings.changeType);
    settings.intensity = normalizeIntensity(settings.intensity);
    settings.depth = normalizeDepth(settings.depth); // hand-edited / old values: whole number, at least -1
    // Untouched copies of an earlier default get the current one, so default improvements reach everyone who never edited them.
    if (LEGACY_DEFAULT_PROMPTS.includes(settings.systemPrompt)) settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    if (LEGACY_CREATE_PROMPTS.includes(settings.createSystemPrompt)) settings.createSystemPrompt = DEFAULT_CREATE_SYSTEM_PROMPT;
    return { settings, save: saveSettingsDebounced };
}
