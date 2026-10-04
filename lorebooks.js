// Finds the lorebooks linked to the current chat, and lists their entries.
//
// SillyTavern has no public "get this chat's lorebooks" function; its own logic is private
// (getGlobalLore / getCharacterLore / getChatLore / getPersonaLore in public/scripts/world-info.js).
// This module mirrors it. If a future ST version changes how books are linked, fix it here only.

import { selected_world_info, world_info, world_names, loadWorldInfo, METADATA_KEY } from '../../../world-info.js';

/** Removes the file extension from a character avatar file name ("Bob.png" -> "Bob"), as ST does for charLore keys. */
const avatarKey = (avatar) => String(avatar ?? '').replace(/\.[^/.]+$/, '');

/** Primary + extra lorebook names for one character object. */
function booksOfCharacter(character) {
    const names = [];
    if (character?.data?.extensions?.world) names.push(character.data.extensions.world);
    const extra = (world_info.charLore ?? []).find(e => e.name === avatarKey(character?.avatar));
    if (extra?.extraBooks) names.push(...extra.extraBooks);
    return names;
}

/**
 * Lorebooks linked to the current chat, one row per book.
 * A book linked in several ways appears once with several source labels.
 * @returns {{name: string, sources: string[]}[]}
 */
export function getLinkedBookNames() {
    const ctx = SillyTavern.getContext(); // call fresh: chatMetadata is replaced on chat change
    const found = new Map(); // name -> Set of source labels
    const add = (name, source) => {
        if (!name || !world_names?.includes(name)) return; // ignore empty or stale links
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(source);
    };

    // Chat-bound book
    add(ctx.chatMetadata?.[METADATA_KEY], 'Chat');

    // Persona-bound book
    add(ctx.powerUserSettings?.persona_description_lorebook, 'Persona');

    // Character books: the open character, or every member of the open group
    if (ctx.groupId) {
        const group = ctx.groups.find(g => g.id === ctx.groupId);
        for (const avatar of group?.members ?? []) {
            const member = ctx.characters.find(c => c.avatar === avatar);
            booksOfCharacter(member).forEach(n => add(n, 'Character'));
        }
    } else if (ctx.characterId !== undefined) {
        booksOfCharacter(ctx.characters[ctx.characterId]).forEach(n => add(n, 'Character'));
    }

    // Globally active books
    (selected_world_info ?? []).forEach(n => add(n, 'Global'));

    return [...found].map(([name, sources]) => ({ name, sources: [...sources] }));
}

/** Short label for an entry: its title (comment), else its first keys, else its id. */
function entryLabel(entry) {
    if (entry.comment?.trim()) return entry.comment.trim();
    if (entry.key?.length) return entry.key.slice(0, 3).join(', ');
    return `Entry #${entry.uid}`;
}

/**
 * Linked books together with a light summary of their entries (no content; that is loaded at revision time).
 * @returns {Promise<{name: string, sources: string[], entries: {uid: number, label: string, disabled: boolean}[]}[]>}
 */
export async function getLinkedBooks() {
    const books = [];
    for (const { name, sources } of getLinkedBookNames()) {
        const data = await loadWorldInfo(name); // returns a clone, safe to read
        const entries = Object.values(data?.entries ?? {})
            .sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid))
            .map(e => ({ uid: e.uid, label: entryLabel(e), disabled: !!e.disable }));
        books.push({ name, sources, entries });
    }
    return books;
}
