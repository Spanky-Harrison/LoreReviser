// "Change type" setting: is the change a story development (before -> after may be described) or a retcon (written as if it
// was always true)? Pure module (unit-tested in tests/unit.mjs). Works like intensity.js: editable wording per type, fixed heading.

export const CHANGE_TYPES = {
    development: {
        label: 'Development',
        title: 'The change is a progression in the story: the lore may describe how things were, how they are now, and what changed.',
        text: `DEVELOPMENT. The changes are a progression in the story: things used to be one way and are now another. Write the entry so that it reflects how things now are, and where it helps you may describe the before and after, the history, and what has changed. Keep what is still true, and keep the entry compact; do not retell the whole story. Record the change under the entry's existing headings and field labels and keep those exactly as they are written; if a before and after needs its own field, add one in the same style instead of renaming an existing label.`,
    },
    retcon: {
        label: 'Retcon',
        title: 'The change is to the existing reality: write it as though it was always true, with no hint that anything changed.',
        text: `RETCON. The change is to the existing reality, and the entry must read as though the new version was always true. Rewrite it as established fact and do not acknowledge the change in any way. Do not use language that calls anything new or implies a change or a timeline, for example: "new", "now", "recently", "no longer", "anymore", "used to", "formerly", "previously", "originally", "changed", "became", "turned out", "has since", "revealed". Do not describe a before and after, a history of the change, or a correction. State the facts plainly in the entry's usual tense. Rewriting the facts does not mean rewriting the layout: keep the entry's existing headings and field labels exactly as they are written. (Your optional "note" field is for the user and may explain what you changed; the entry text itself must not.)`,
    },
};

export const DEFAULT_CHANGE_TYPE = 'development';

/** Any stored value -> a valid type name. */
export const normalizeChangeType = (v) => (Object.hasOwn(CHANGE_TYPES, v) ? v : DEFAULT_CHANGE_TYPE);

/** The wording for a type: the user's edited version (saved overrides) or the default. */
export function changeTypeText(type, overrides = {}) {
    const t = normalizeChangeType(type);
    const custom = overrides?.[t];
    return typeof custom === 'string' && custom.trim() ? custom : CHANGE_TYPES[t].text;
}

/**
 * The section added to the system message, right after the rewrite-intensity section. The heading is fixed
 * ("## Change type: <Label>") even when the wording is edited, so the system prompt's reference to the "Change type" section stays valid.
 */
export function changeTypeSection(type, overrides = {}) {
    const t = normalizeChangeType(type);
    return `## Change type: ${CHANGE_TYPES[t].label}\n${changeTypeText(t, overrides)}`;
}
