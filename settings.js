// Extension settings (saved by ST in settings.json under extension_settings.LoreReviser).

import { normalizeDepth } from './depth.js';

export const MODULE_NAME = 'LoreReviser';

/** The editable part of the system prompt. The fixed reply-format rules are appended separately (see prompt.js). */
export const DEFAULT_SYSTEM_PROMPT = `You are a careful lorebook editor for an ongoing roleplay. Lorebook entries are short reference texts that are injected into the roleplay prompt when their keywords appear.

You will receive the character card, the lore that is currently active, the recent chat, and a list of lorebook entries to revise. Revise the entries so they match what has happened in the chat and what the user asks for.

Guidelines:
- Only change what the chat or the user's instructions support. Never invent facts, names, or events.
- Keep information that is still true. Update or remove only what the story has made outdated or wrong.
- Keep each entry's existing style, point of view, tense, format and rough length. Entries should stay compact; do not turn them into summaries of the whole chat.
- Keys are the trigger words for the entry. Add keys only for names, nicknames or terms that people will really use in the chat; drop keys that are no longer correct. Keep key capitalisation natural.
- Do not copy lore from one entry into another. The active lore is given for context only; it may contain the very entries you are revising.
- If an entry needs no change, leave it out of your reply.`;

/** Earlier default prompts. A saved prompt equal to one of these is replaced by the current default. */
const LEGACY_DEFAULT_PROMPTS = [
    [
        'You are a lorebook editor for a roleplay. You are given the recent chat, the character information,',
        'the currently active lore, and a set of lorebook entries to revise.',
        'Update each entry (its content and its keys) so it reflects what happened in the chat,',
        'following the user\'s instructions. Keep the existing style and format. Do not invent facts.',
        'Leave special syntax such as {{macros}}, @@decorators and /regex/ keys untouched.',
    ].join(' '),
];

const DEFAULT_SETTINGS = {
    profileId: '',                    // Connection Manager profile id ('' = none chosen)
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    depth: 0,                         // last X chat messages to send; 0 = whole chat; -1 = no chat at all
    replyTokens: 0,                   // max tokens for the model's reply; 0 = automatic
    contextLimit: 0,                  // context size used for the "too large" warning; 0 = take it from the profile's preset
};

/** Returns this extension's settings, filling in any missing defaults. */
export function getSettings() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    // Fill in defaults in place so every caller shares the same object that ST saves.
    const settings = (extensionSettings[MODULE_NAME] ??= {});
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) settings[key] ??= value;
    settings.depth = normalizeDepth(settings.depth); // hand-edited / old values: whole number, at least -1
    if (LEGACY_DEFAULT_PROMPTS.includes(settings.systemPrompt)) settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    return { settings, save: saveSettingsDebounced };
}
