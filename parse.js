// Tolerant parser for the model's reply. Pure functions, no SillyTavern imports (unit-tested in tests/unit.mjs).
//
// Expected reply: a JSON array like  [{"id":"E1","keys":[...],"secondary_keys":[...],"content":"...","note":"..."}]
// Real models also add code fences, chatter, <think> blocks, trailing commas, or get cut off mid-reply.
// We return every complete entry we can recover and say whether the reply looks truncated.

/**
 * @typedef {object} ParseResult
 * @property {object[]} entries   Recovered entry objects (unvalidated).
 * @property {boolean} truncated  The reply ended inside the JSON (cut off by the token limit, most likely).
 * @property {number} skipped     Objects found but not parseable as JSON.
 * @property {string|null} error  Set when nothing usable was found.
 */

/** Removes reasoning blocks and markdown code fences, returns text starting at the first [ or {. */
function cleanup(raw) {
    let text = String(raw ?? '');
    text = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    // Closed fence first, otherwise an opening fence with no end (truncated reply)
    const closed = text.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/);
    if (closed) text = closed[1];
    else {
        const open = text.match(/```[a-zA-Z]*\s*\n?([\s\S]*)$/);
        if (open) text = open[1];
    }
    const start = text.search(/[[{]/);
    return start < 0 ? '' : text.slice(start).trim();
}

/** JSON.parse that also forgives trailing commas. Returns undefined on failure. */
function tryParse(text) {
    try { return JSON.parse(text); } catch { /* fall through */ }
    try { return JSON.parse(text.replace(/,\s*([\]}])/g, '$1')); } catch { return undefined; }
}

/** Picks the entry array out of a parsed value (array, {entries:[...]}, or a single entry object). */
function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
        for (const k of ['entries', 'revisions', 'results']) if (Array.isArray(value[k])) return value[k];
        if ('id' in value) return [value];
    }
    return null;
}

/**
 * Walks the text and collects each complete top-level {...} object, string- and escape-aware.
 * Stops at the closing ] of the array. Reports whether the text ended while still inside the array/object.
 */
function salvage(text) {
    const result = { entries: [], truncated: false, skipped: 0 };
    // Start inside the entries array if there is one ("[{...}" or {"entries":[{...}).
    let i = text.startsWith('[') ? 1 : (text.startsWith('{') && /^\{\s*"(entries|revisions|results)"\s*:\s*\[/.test(text) ? text.indexOf('[') + 1 : 0);
    let depth = 0, objStart = -1, inString = false, escaped = false, closedArray = false;
    for (; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') { if (depth === 0) objStart = i; depth++; }
        else if (ch === '}' && depth > 0) {
            depth--;
            if (depth === 0) {
                const obj = tryParse(text.slice(objStart, i + 1));
                if (obj && typeof obj === 'object') result.entries.push(obj); else result.skipped++;
                objStart = -1;
            }
        } else if (ch === ']' && depth === 0) { closedArray = true; break; }
    }
    // Cut off if we ended inside an object/string, or never saw the array's closing bracket.
    result.truncated = depth > 0 || inString || (!closedArray && text.startsWith('['));
    return result;
}

/**
 * @param {string} raw The model's reply text.
 * @returns {ParseResult}
 */
export function parseRevisionReply(raw) {
    const text = cleanup(raw);
    if (!text) return { entries: [], truncated: false, skipped: 0, error: 'The reply contains no JSON.' };

    // 1. Whole text is valid JSON (optionally with chatter after the closing bracket)
    for (const candidate of [text, text.slice(0, Math.max(text.lastIndexOf(']'), text.lastIndexOf('}')) + 1)]) {
        const arr = toArray(tryParse(candidate));
        if (arr) return { entries: arr.filter(e => e && typeof e === 'object'), truncated: false, skipped: 0, error: null };
    }

    // 2. Broken or cut-off JSON: keep every complete object
    const s = salvage(text);
    if (!s.entries.length) {
        return { ...s, error: s.truncated ? 'The reply was cut off before the first complete entry.' : 'The reply is not valid JSON.' };
    }
    return { ...s, error: null };
}

const isRegexKey = (k) => /^\/.+\/[a-z]*$/i.test(k);

/**
 * Warnings for things a revision should normally keep: leading @@decorator lines, /regex/ keys, {{macros}}.
 * Warn only; the user decides.
 * @param {{keys: string[], secondary: string[], content: string}} original
 * @param {{keys: string[], secondary: string[], content: string}} next
 * @returns {string[]}
 */
export function integrityWarnings(original, next) {
    const warnings = [];
    const decorators = (original.content ?? '').split('\n').filter(l => l.startsWith('@@'));
    const newLines = new Set((next.content ?? '').split('\n'));
    for (const d of decorators) if (!newLines.has(d)) warnings.push(`Decorator line removed or changed: ${d}`);

    const newKeys = new Set([...next.keys, ...next.secondary]);
    for (const k of [...original.keys, ...original.secondary]) {
        if (isRegexKey(k) && !newKeys.has(k)) warnings.push(`Regex key removed or changed: ${k}`);
    }

    const macros = (s) => new Set((s ?? '').match(/\{\{[^}]+\}\}/g) ?? []);
    const kept = macros(next.content);
    for (const m of macros(original.content)) if (!kept.has(m)) warnings.push(`Macro removed: ${m}`);
    return warnings;
}

/** True when a proposal is identical to the original in keys, secondary keys and content. */
export function sameAsOriginal(original, next) {
    const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    return eq(original.keys, next.keys) && eq(original.secondary, next.secondary) && original.content === next.content;
}
