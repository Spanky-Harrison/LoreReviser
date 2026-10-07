// The reply-format rules appended to the system message, one set per reply style (see REPLY_STYLES). Editable in the modal:
// settings.formatRules (Full rewrite) and settings.passageFormatRules (Changed passages only); '' = the default.
// Pure module (unit-tested in tests/unit.mjs).

/** How the model answers for existing entries. New entries are always written in full (create-core.js). */
export const REPLY_STYLES = {
    passages: { label: 'Changed passages only (saves tokens)', title: 'The model sends only the passages it changes (find / replace), and LoreReviser puts them into the full text itself. Much shorter replies.' },
    full: { label: 'Full rewrite', title: 'The model sends the complete new text of every changed entry (the original behaviour). Longer replies.' },
};
export const DEFAULT_REPLY_STYLE = 'passages';
/** Any stored value -> a valid style name. */
export const normalizeReplyStyle = (v) => (Object.hasOwn(REPLY_STYLES, v) ? v : DEFAULT_REPLY_STYLE);

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

export const DEFAULT_PASSAGE_RULES = `## Reply format (strict)
Reply with ONE JSON array and nothing else: no commentary before or after it, no markdown code fences.
Do NOT write out whole entries. Send only the passages you change, as find/replace edits; LoreReviser puts them into the entry's full text itself.
Each element revises one entry from <entries_to_revise>:
{"id": "E1", "edits": [{"find": "exact passage copied from the entry", "replace": "new text for that passage"}], "keys": ["..."], "secondary_keys": ["..."], "note": "..."}

Rules:
- "id" is copied exactly from the entry's id attribute (E1, E2, ...).
- Include ONLY entries you changed. Leave out every entry that needs no change. If nothing needs changing, reply [].
- "edits": one object per changed passage, in the order they appear in the entry. Leave "edits" out if only the keys change.
- "find" is copied VERBATIM from the entry's <content> in <entries_to_revise>, character for character: same spelling, capitalisation, punctuation, quote marks, spacing and line breaks (written as \\n). Never paraphrase it, fix typos in it, or shorten it with "...".
- Keep each "find" short but unique: usually one sentence, one line or one "Label: value" field, and it must occur exactly once in that entry. If a short passage occurs more than once, add a few neighbouring words until it is unique.
- "replace" is the complete new text for exactly that passage (it replaces only the "find" text). Use "" to delete the passage.
- To add new text without changing anything, use {"after": "exact passage from the entry", "insert": "new text"}. Start "insert" with \\n to put it on a new line, or with a space to continue the same line. You may also quote a short neighbouring passage in "find" and repeat it in "replace" together with the new text.
- Edits must not overlap: never quote the same text in two edits. Every "find" and "after" refers to the entry's text as given in <entries_to_revise>, not to the result of another edit or to a previous attempt.
- For large rewrites use one edit per changed paragraph or line; unchanged text between them stays as it is.
- "keys" and "secondary_keys": the complete new list of trigger keys. Leave a field out if that list stays the same.
- "note": one short sentence saying what you changed and why.
- Maintain ALL current formatting of each entry unless the instructions require otherwise: markdown, line breaks and blank lines, bracket or tag styles ([Name: ...], <tag>), field layouts ("Key: value" lines), list styles and bullet characters, casing conventions, {{macros}}, @@decorator lines at the start of the content, and /regex/ keys. Text you add or replace must use the same layout as the text around it.
- Copy every existing heading and field label exactly, character for character (such as "HEIGHT:", "Hair:", "[Appearance]", "## Background"): same spelling, casing, punctuation and symbols. Never rename, misspell, re-case or invent a variant of one (HEIGHT -> HIGHT or HAIR -> HAIIR is an error). When a "find" includes a heading or label, "replace" must contain it unchanged. Change a heading only if the user explicitly asks you to rename it.
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

const REQUIRED_PASSAGES = [
    [/json/i, 'the word JSON'],
    [/array|\[/i, 'that the reply is an array'],
    [/\bid\b/i, 'the "id" field'],
    [/\bedits\b/i, 'the "edits" list'],
    [/\bfind\b/i, 'the "find" field'],
    [/\breplace\b/i, 'the "replace" field'],
];

/** Checks edited "changed passages" rules for the essentials. @returns {string[]} what is missing (empty = fine) */
export function checkPassageRules(text) {
    const t = String(text ?? '');
    if (!t.trim()) return ['the rules are empty'];
    return REQUIRED_PASSAGES.filter(([re]) => !re.test(t)).map(([, what]) => `they do not mention ${what}`);
}

export const PASSAGE_RULES_NOTE = 'Whatever you write here, the model\'s reply must still be a JSON array of {id, edits?: [{find, replace}], keys?, secondary_keys?, note?} objects: that is the only format LoreReviser can read in this reply style.';

export const FORMAT_RULES_NOTE = 'Whatever you write here, the model\'s reply must still be a JSON array of {id, keys?, secondary_keys?, content?, note?} objects: that is the only format LoreReviser can read.';

/** The rules actually sent: the user's version, or the default when none is saved. */
export const effectiveFormatRules = (saved) => (String(saved ?? '').trim() ? String(saved) : DEFAULT_FORMAT_RULES);

/** The "changed passages" rules actually sent: the user's version, or the default when none is saved. */
export const effectivePassageRules = (saved) => (String(saved ?? '').trim() ? String(saved) : DEFAULT_PASSAGE_RULES);

/** The rules for a reply style, from the saved texts { formatRules, passageRules }. */
export const rulesForStyle = (style, { formatRules = '', passageRules = '' } = {}) =>
    (normalizeReplyStyle(style) === 'passages' ? effectivePassageRules(passageRules) : effectiveFormatRules(formatRules));

/** The parser check for a reply style. */
export const checkRulesForStyle = (style, text) => (normalizeReplyStyle(style) === 'passages' ? checkPassageRules(text) : checkFormatRules(text));
