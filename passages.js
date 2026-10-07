// "Changed passages only" reply style: the model sends find/replace edits instead of the whole entry text, and this module
// puts them into the text LoreReviser already has. Pure module, no SillyTavern imports (unit-tested in tests/unit.mjs).
//
// Edit shapes (one entry's "edits" list):
//   {"find": "exact passage", "replace": "new text"}     replace ("" deletes)
//   {"after": "exact passage", "insert": "new text"}     insertion right after the passage
//   {"before": "exact passage", "insert": "new text"}    insertion right before the passage
// Every passage is looked up in the ORIGINAL text (not in the result of an earlier edit). Matching: exact first; then a
// tolerant match that ignores differences in whitespace / line endings, smart vs straight quotes, dash types and "…" vs
// "...", mapped back to the original offsets. A passage must occur exactly once. Edits must not overlap.
// All or nothing: if any edit can't be placed, nothing is applied and the failures are returned.

/** Fields a model may put the edit list in. */
const LIST_FIELDS = ['edits', 'changes', 'replacements', 'patches', 'passages'];
const FIND_FIELDS = ['find', 'search', 'old', 'original', 'from', 'old_text'];
const REPLACE_FIELDS = ['replace', 'replacement', 'new', 'with', 'to', 'new_text'];
const INSERT_FIELDS = ['insert', 'text', 'add', 'content'];

const pick = (obj, fields) => { for (const f of fields) if (Object.hasOwn(obj, f)) return obj[f]; return undefined; };

/**
 * Reads the edit list of one reply element.
 * @param {object} el a parsed reply element
 * @returns {{edits: {kind: 'replace'|'after'|'before', anchor: string, text: string}[], invalid: {index: number, reason: string, raw: string}[]} | null}
 *          null when the element has no edit list at all (then the caller may use a full "content" instead)
 */
export function readEdits(el) {
    if (!el || typeof el !== 'object') return null;
    const field = LIST_FIELDS.find(f => Object.hasOwn(el, f));
    if (!field) return null;
    let list = el[field];
    if (list && typeof list === 'object' && !Array.isArray(list)) list = [list]; // a single edit object
    if (!Array.isArray(list)) return { edits: [], invalid: list == null ? [] : [{ index: 0, reason: 'not a list of edits', raw: String(list).slice(0, 200) }] };
    const edits = [], invalid = [];
    list.forEach((raw, index) => {
        const bad = (reason) => invalid.push({ index, reason, raw: (typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '').slice(0, 200) });
        if (Array.isArray(raw) && raw.length === 2 && raw.every(x => typeof x === 'string')) { edits.push({ kind: 'replace', anchor: raw[0], text: raw[1], index }); return; }
        if (!raw || typeof raw !== 'object') return bad('not an edit object');
        const after = pick(raw, ['after', 'insert_after']), before = pick(raw, ['before', 'insert_before']);
        const find = pick(raw, FIND_FIELDS);
        if (typeof find === 'string') {
            const rep = pick(raw, REPLACE_FIELDS);
            if (rep === undefined || rep === null) return bad('it has "find" but no "replace"');
            if (typeof rep !== 'string') return bad('"replace" is not text');
            edits.push({ kind: 'replace', anchor: find, text: rep, index });
            return;
        }
        const anchor = typeof after === 'string' ? after : (typeof before === 'string' ? before : null);
        if (anchor !== null) {
            const ins = pick(raw, INSERT_FIELDS);
            if (typeof ins !== 'string') return bad('it has an anchor but no "insert" text');
            edits.push({ kind: typeof after === 'string' ? 'after' : 'before', anchor, text: ins, index });
            return;
        }
        bad('it has no "find" (or "after"/"before") passage');
    });
    return { edits, invalid };
}

// ---------- tolerant matching ----------

const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/;
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032\u02bc]/;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/;
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/;
const SPACE = /[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]/;

/**
 * Normalised copy of a text plus, for every normalised character, the original range it came from.
 * Whitespace runs (spaces, tabs, line breaks of any kind) become one space; quotes, dashes and the ellipsis get their plain form.
 * @returns {{text: string, starts: number[], ends: number[]}}
 */
export function normalizeWithMap(s) {
    const src = String(s ?? '');
    let text = ''; const starts = [], ends = [];
    let inSpace = false;
    const emit = (ch, i) => { text += ch; starts.push(i); ends.push(i + 1); };
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ZERO_WIDTH.test(ch)) { if (ends.length) ends[ends.length - 1] = Math.max(ends[ends.length - 1], i + 1); continue; }
        if (SPACE.test(ch)) {
            if (inSpace) ends[ends.length - 1] = i + 1; else { emit(' ', i); inSpace = true; }
            continue;
        }
        inSpace = false;
        if (SINGLE_QUOTES.test(ch)) emit("'", i);
        else if (DOUBLE_QUOTES.test(ch)) emit('"', i);
        else if (DASHES.test(ch)) emit('-', i);
        else if (ch === '\u2026') { emit('.', i); emit('.', i); emit('.', i); }
        else emit(ch, i);
    }
    return { text, starts, ends };
}

/** All start positions of needle in hay (overlapping occurrences count). */
function occurrences(hay, needle) {
    const out = [];
    if (!needle) return out;
    for (let p = hay.indexOf(needle); p >= 0; p = hay.indexOf(needle, p + 1)) out.push(p);
    return out;
}

/**
 * Finds a passage in the text: exact first, then tolerant. Must be unique.
 * @returns {{start: number, end: number, how: 'exact'|'tolerant'} | {error: 'not_found'|'ambiguous'|'empty', count?: number}}
 */
export function locate(content, passage) {
    const text = String(content ?? ''), needle = String(passage ?? '');
    if (!needle.trim()) return { error: 'empty' };
    const exact = occurrences(text, needle);
    if (exact.length === 1) return { start: exact[0], end: exact[0] + needle.length, how: 'exact' };
    if (exact.length > 1) return { error: 'ambiguous', count: exact.length };
    const hay = normalizeWithMap(text);
    // Tolerant tiers: normalised as written; then with literal "\n" sequences read as line breaks (double-escaped JSON).
    const variants = [needle];
    if (/\\n|\\t/.test(needle)) variants.push(needle.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t'));
    for (const v of variants) {
        const n = normalizeWithMap(v).text.trim();
        if (!n) continue;
        const hits = occurrences(hay.text, n);
        if (hits.length > 1) return { error: 'ambiguous', count: hits.length };
        if (hits.length === 1) {
            const s = hits[0], e = s + n.length - 1;
            return { start: hay.starts[s], end: hay.ends[e], how: 'tolerant' };
        }
    }
    return { error: 'not_found' };
}

const leadingWs = (s) => s.match(/^\s*/)[0];
const trailingWs = (s) => s.match(/\s*$/)[0];

/**
 * Applies a list of edits to a text, all or nothing.
 * @param {string} content the entry's current (original) text
 * @param {{kind: string, anchor: string, text: string, index?: number}[]} edits from readEdits()
 * @returns {{ok: boolean, content: string, failures: {index: number, kind: string, anchor: string, reason: string, count?: number, other?: number}[], placed: {index: number, start: number, end: number, how: string}[]}}
 *          ok=false: content is the unchanged original
 */
export function applyEdits(content, edits) {
    const original = String(content ?? '');
    const crlf = original.includes('\r\n') && !/(^|[^\r])\n/.test(original);
    const fixEol = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
    // identical edits sent twice are one edit
    const seen = new Set(), list = [];
    (edits ?? []).forEach((e, i) => {
        const key = `${e.kind}\u0000${e.anchor}\u0000${e.text}`;
        if (seen.has(key)) return;
        seen.add(key); list.push({ ...e, index: e.index ?? i });
    });
    const failures = [], placed = [];
    for (const e of list) {
        let start, end, how;
        if (!String(e.anchor ?? '').trim() && e.kind === 'replace' && !original.trim()) {
            start = 0; end = original.length; how = 'exact'; // empty entry: "find": "" fills it
        } else {
            const loc = locate(original, e.anchor);
            if (loc.error) { failures.push({ index: e.index, kind: e.kind, anchor: e.anchor, reason: loc.error, count: loc.count }); continue; }
            ({ start, end, how } = loc);
        }
        let text = String(e.text ?? '');
        if (how === 'tolerant' && e.kind === 'replace') {
            // the tolerant match leaves out whitespace around the quoted passage; drop the same whitespace from the replacement
            const lw = leadingWs(e.anchor), tw = trailingWs(e.anchor);
            if (lw && text.startsWith(lw)) text = text.slice(lw.length);
            if (tw && text.endsWith(tw)) text = text.slice(0, text.length - tw.length);
        }
        if (e.kind === 'after') start = end;
        else if (e.kind === 'before') end = start;
        placed.push({ index: e.index, kind: e.kind, anchor: e.anchor, start, end, how, text: fixEol(text) });
    }
    // overlaps: sort by position (stable for equal positions: the order the model gave)
    placed.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
    const overlapping = new Set();
    const fail = (p, other) => { if (!failures.some(f => f.index === p.index)) failures.push({ index: p.index, kind: p.kind, anchor: p.anchor, reason: 'overlap', other: other.index }); };
    for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
            const a = placed[i], b = placed[j];
            if (b.start >= a.end) break; // sorted by start: nothing later can start inside a (a zero-width a never overlaps)
            overlapping.add(i); overlapping.add(j); fail(a, b); fail(b, a);
        }
    }
    if (failures.length) {
        failures.sort((a, b) => a.index - b.index);
        return { ok: false, content: original, failures, placed: placed.filter((_, i) => !overlapping.has(i)).map(({ index, start, end, how }) => ({ index, start, end, how })) };
    }
    let out = '', pos = 0;
    for (const p of placed) { out += original.slice(pos, p.start) + p.text; pos = p.end; }
    out += original.slice(pos);
    return { ok: true, content: out, failures: [], placed: placed.map(({ index, start, end, how }) => ({ index, start, end, how })) };
}

/** Plain-language reason for one failure (shown on the card). */
export function failureReason(f) {
    switch (f.reason) {
        case 'not_found': return 'this passage is not in the entry (the model did not quote it exactly)';
        case 'ambiguous': return `this passage appears ${f.count ?? 'several'} times in the entry, so it is unclear which one is meant`;
        case 'overlap': return `this edit overlaps edit ${Number(f.other) + 1}, which changes the same text`;
        case 'empty': return 'the passage to find is empty';
        default: return f.reason || 'it could not be read';
    }
}

/**
 * One reply element in "changed passages" style -> the new full text, or the reasons it can't be built.
 * Without an edit list the element's "content" (a full text the model sent anyway) is used; without either, the text stays.
 * @returns {{content: string, edits: object[]|null, failures: object[], source: 'edits'|'content'|'none'}}
 */
export function contentFromReply(el, originalContent) {
    const read = readEdits(el);
    if (read) {
        const failures = read.invalid.map(x => ({ index: x.index, kind: 'invalid', anchor: x.raw, reason: x.reason }));
        const res = applyEdits(originalContent, read.edits);
        const all = [...failures, ...res.failures].sort((a, b) => a.index - b.index);
        return { content: all.length ? String(originalContent ?? '') : res.content, edits: read.edits, failures: all, source: 'edits', total: read.edits.length + read.invalid.length };
    }
    if (typeof el?.content === 'string') return { content: el.content, edits: null, failures: [], source: 'content', total: 0 };
    return { content: String(originalContent ?? ''), edits: null, failures: [], source: 'none', total: 0 };
}
