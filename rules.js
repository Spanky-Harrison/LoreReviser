// The reply-format rules appended to the system message. Editable in the modal (settings.formatRules; '' = this default).
// Pure module (unit-tested in tests/unit.mjs).

export const DEFAULT_FORMAT_RULES = `## Reply format (strict)
Reply with ONE JSON array and nothing else: no commentary before or after it, no markdown code fences.
Each element revises one entry from <entries_to_revise>:
{"id": "E1", "keys": ["..."], "secondary_keys": ["..."], "content": "...", "note": "..."}

Rules:
- "id" is copied exactly from the entry's id attribute (E1, E2, ...).
- Include ONLY entries you changed. Leave out every entry that needs no change. If nothing needs changing, reply [].
- "content": the complete new text of the entry (not a diff). Leave this field out if the content stays the same.
- "keys" and "secondary_keys": the complete new list of trigger keys. Leave a field out if that list stays the same.
- "note": one short sentence saying what you changed and why.
- Maintain ALL current formatting of each entry unless the instructions require otherwise: markdown, line breaks and blank lines, bracket or tag styles ([Name: ...], <tag>), field layouts ("Key: value" lines), list styles and bullet characters, casing conventions, {{macros}}, @@decorator lines at the start of the content, and /regex/ keys. Text you add must use the same layout as the text around it. If the content has several lines or paragraphs, keep the same line structure (use \\n in the JSON string).
- Copy every existing heading and field label exactly, character for character (such as "HEIGHT:", "Hair:", "[Appearance]", "## Background"): same spelling, casing, punctuation and symbols. Never rename, misspell, re-case or invent a variant of one (HEIGHT -> HIGHT or HAIR -> HAIIR is an error). Change a heading only if the user explicitly asks you to rename it.
- The reply must be valid JSON: escape double quotes inside strings as \\" and line breaks as \\n.`;

/** The essentials LoreReviser's parser relies on. */
const REQUIRED = [
    [/json/i, 'the word JSON'],
    [/array|\[/i, 'that the reply is an array'],
    [/\bid\b/i, 'the "id" field'],
    [/content/i, 'the "content" field'],
];

/**
 * Checks edited reply-format rules for the essentials.
 * @returns {string[]} what is missing (empty = fine)
 */
export function checkFormatRules(text) {
    const t = String(text ?? '');
    if (!t.trim()) return ['the rules are empty'];
    return REQUIRED.filter(([re]) => !re.test(t)).map(([, what]) => `they do not mention ${what}`);
}

export const FORMAT_RULES_NOTE = 'Whatever you write here, the model\'s reply must still be a JSON array of {id, keys?, secondary_keys?, content?, note?} objects: that is the only format LoreReviser can read.';

/** The rules actually sent: the user's version, or the default when none is saved. */
export const effectiveFormatRules = (saved) => (String(saved ?? '').trim() ? String(saved) : DEFAULT_FORMAT_RULES);
