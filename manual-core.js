// Direct entry editor logic without SillyTavern imports (unit-tested in tests/unit.mjs).
// The editor (entry-editor.js) shows keys as comma-separated text. Keys are only replaced when their text box was
// actually changed, so opening and saving an entry never rewrites its keys just because of how they were displayed.

/** The text shown in a key box: the keys joined with ", " (as SillyTavern's World Info editor shows them). */
export const keysText = (list) => (list ?? []).join(', ');

/** The editor form for a version: { keys, secondary, content } as the strings shown in the boxes. */
export const formFromVersion = (v) => ({ keys: keysText(v?.keys), secondary: keysText(v?.secondary), content: String(v?.content ?? '') });

/** True when the form differs from what it was opened (or last reloaded) with. */
export function formDirty(initial, current) {
    return !!initial && !!current && (initial.keys !== current.keys || initial.secondary !== current.secondary || initial.content !== current.content);
}

/**
 * Builds the version to save from the form.
 * @param {{keys: string[], secondary: string[], content: string}} original the entry's version when the editor was opened / reloaded
 * @param {{keys: string, secondary: string, content: string}} initial the form strings at that moment
 * @param {{keys: string, secondary: string, content: string}} current the form strings now
 * @param {(text: string) => string[]} split turns a key box into a key list (SillyTavern's splitKeywordsAndRegexes)
 * @returns {{version: {keys: string[], secondary: string[], content: string}, changed: string[]}} changed lists 'content', 'keys',
 *          'secondary' (in that order) for the parts that really differ from `original`
 */
export function buildManualVersion(original, initial, current, split) {
    const keys = current.keys !== initial.keys ? split(current.keys) : [...(original.keys ?? [])];
    const secondary = current.secondary !== initial.secondary ? split(current.secondary) : [...(original.secondary ?? [])];
    const content = String(current.content ?? '');
    const eq = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);
    const changed = [];
    if (content !== (original.content ?? '')) changed.push('content');
    if (!eq(keys, original.keys)) changed.push('keys');
    if (!eq(secondary, original.secondary)) changed.push('secondary');
    return { version: { keys, secondary, content }, changed };
}

/** Plain words for what a manual edit changed (History info line, toast). */
export function describeChanged(changed) {
    const words = { content: 'text', keys: 'keys', secondary: 'secondary keys' };
    const list = (changed ?? []).map(c => words[c] ?? c);
    if (!list.length) return 'nothing';
    return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/** "N characters · M words" for the editor's status line. */
export function textStats(text) {
    const s = String(text ?? '');
    const words = s.trim() ? s.trim().split(/\s+/).length : 0;
    return `${s.length} character${s.length === 1 ? '' : 's'} · ${words} word${words === 1 ? '' : 's'}`;
}
