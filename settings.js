// Extension settings (saved by ST in settings.json under extension_settings.LoreReviser).

export const MODULE_NAME = 'LoreReviser';

/** Default system prompt for revision requests (used from milestone 3; editable in the modal). */
export const DEFAULT_SYSTEM_PROMPT = [
    'You are a lorebook editor for a roleplay. You are given the recent chat, the character information,',
    'the currently active lore, and a set of lorebook entries to revise.',
    'Update each entry (its content and its keys) so it reflects what happened in the chat,',
    'following the user\'s instructions. Keep the existing style and format. Do not invent facts.',
    'Leave special syntax such as {{macros}}, @@decorators and /regex/ keys untouched.',
].join(' ');

const DEFAULT_SETTINGS = {
    profileId: '',                    // Connection Manager profile id ('' = none chosen)
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    depth: 0,                         // last X chat messages to send; 0 = whole chat
};

/** Returns this extension's settings, filling in any missing defaults. */
export function getSettings() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    // Fill in defaults in place so every caller shares the same object that ST saves.
    const settings = (extensionSettings[MODULE_NAME] ??= {});
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) settings[key] ??= value;
    return { settings, save: saveSettingsDebounced };
}
