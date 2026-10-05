// Small word-level diff for the review cards. Pure functions (unit-tested in tests/unit.mjs).

/**
 * Splits text into blocks. 'paragraph' = one block per non-empty line; 'sentence' = one block per sentence
 * (a newline also ends a block). Blocks keep their own text, so nothing is lost.
 */
export function splitBlocks(text, unit = 'paragraph') {
    const src = String(text ?? '');
    if (unit === 'paragraph') return src.split(/\n+/).map(x => x.trim()).filter(Boolean);
    const out = [];
    for (const line of src.split(/\n+/)) {
        const parts = line.match(/[^.!?\u2026]+(?:[.!?\u2026]+["'\u201d\u2019)\]*]*(?=\s|$)|$)/g) ?? [];
        for (const p of parts) { const t = p.trim(); if (t) out.push(t); }
    }
    return out;
}

/**
 * Block-level diff (no word-level mixing): whole paragraphs or sentences are kept, removed or added.
 * Inside a changed region all removed blocks come first, then all added blocks.
 * @returns {{type: 'same'|'del'|'ins', blocks: string[]}[]}
 */
export function blockDiff(oldText, newText, unit = 'paragraph') {
    const a = splitBlocks(oldText, unit), b = splitBlocks(newText, unit);
    const n = a.length, m = b.length, w = m + 1;
    if (n * m > 4_000_000) return [...(n ? [{ type: 'del', blocks: a }] : []), ...(m ? [{ type: 'ins', blocks: b }] : [])]; // too big for the table
    const t = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
    const ops = [];
    let i = 0, j = 0, dels = [], inss = [];
    const flush = () => {
        if (dels.length) ops.push({ type: 'del', blocks: dels });
        if (inss.length) ops.push({ type: 'ins', blocks: inss });
        dels = []; inss = [];
    };
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) {
            flush();
            const last = ops.at(-1);
            if (last?.type === 'same') last.blocks.push(a[i]); else ops.push({ type: 'same', blocks: [a[i]] });
            i++; j++;
        } else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1])) dels.push(a[i++]);
        else inss.push(b[j++]);
    }
    flush();
    return ops;
}

/** Added / removed / kept items between two lists (used for keys). */
export function listDiff(oldList, newList) {
    const o = oldList ?? [], n = newList ?? [];
    return [
        ...o.filter(k => !n.includes(k)).map(text => ({ type: 'del', text })),
        ...n.map(text => ({ type: o.includes(text) ? 'same' : 'ins', text })),
    ];
}

// ----- "Edit proposal": edit only the changed (green) parts of a proposal -----

const ENDS = /[.!?\u2026]/, CLOSERS = /["'\u201d\u2019)\]*]/, WS = /\s/;

/**
 * Splits text into sentence tokens that are exact slices: joined together they give back the text, character for
 * character (each token keeps the whitespace after it; a line break always ends a token). Leading whitespace is
 * attached to the first sentence. Used where an edit must be written back into the full text without touching the rest.
 */
export function sentenceSpans(text) {
    const s = String(text ?? '');
    const out = [];
    let start = 0, i = 0;
    const cut = (end) => { out.push(s.slice(start, end)); start = i = end; };
    while (i < s.length) {
        const c = s[i];
        if (c === '\n') { let j = i; while (j < s.length && WS.test(s[j])) j++; cut(j); continue; }
        if (ENDS.test(c)) {
            let j = i; while (j < s.length && ENDS.test(s[j])) j++;
            while (j < s.length && CLOSERS.test(s[j])) j++;
            if (j === s.length || WS.test(s[j])) { let k = j; while (k < s.length && s[k] !== '\n' && WS.test(s[k])) k++; if (s[k] === '\n') { while (k < s.length && WS.test(s[k])) k++; } cut(k); continue; }
            i = j; continue;
        }
        i++;
    }
    if (start < s.length) out.push(s.slice(start));
    // whitespace-only tokens (only possible at the very start) join the next token
    const merged = [];
    for (const t of out) {
        if (merged.length && !merged.at(-1).trim()) merged[merged.length - 1] += t; else merged.push(t);
    }
    return merged;
}

/**
 * The proposal split into unchanged runs and changed runs ("hunks"), compared sentence by sentence with the old text.
 * Every segment holds exact slices of the NEW text, so applyHunkEdits can rebuild it.
 * @returns {({type: 'same', text: string, count: number} | {type: 'change', old: string, text: string, core: string, tail: string})[]}
 *   change: old = the removed old sentences (trimmed, '' if nothing was removed); text = the added slice ('' for a pure removal);
 *   core = text without trailing whitespace (what the edit box shows); tail = that trailing whitespace
 */
export function proposalHunks(oldText, newText) {
    const a = sentenceSpans(oldText), b = sentenceSpans(newText);
    const ka = a.map(x => x.trim()), kb = b.map(x => x.trim());
    const n = a.length, m = b.length, w = m + 1;
    const segs = [];
    const pushSame = (t) => { const last = segs.at(-1); if (last?.type === 'same') { last.text += t; last.count++; } else segs.push({ type: 'same', text: t, count: 1 }); };
    let dels = [], inss = [];
    const flush = () => {
        if (!dels.length && !inss.length) return;
        const text = inss.join(''), core = text.replace(/\s+$/, '');
        segs.push({ type: 'change', old: dels.join('').trim(), text, core, tail: text.slice(core.length) });
        dels = []; inss = [];
    };
    if (n * m > 4_000_000) { dels = a; inss = b; flush(); return segs; } // too big for the table: one hunk
    const t = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = ka[i] === kb[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && ka[i] === kb[j]) { flush(); pushSame(b[j]); i++; j++; }
        else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1])) dels.push(a[i++]);
        else inss.push(b[j++]);
    }
    flush();
    return segs;
}

/**
 * Rebuilds the full text from proposalHunks segments and the edited hunk texts (edits[k] for segment k; missing =
 * unchanged). Unchanged hunks and every unchanged run are copied exactly. An emptied hunk is removed; text typed into a
 * pure-removal hunk is inserted at that spot, separated like the text around it.
 */
export function applyHunkEdits(segs, edits = {}) {
    let out = '';
    segs.forEach((seg, k) => {
        if (seg.type === 'same') { out += seg.text; return; }
        const v = edits[k] ?? seg.core;
        if (v === seg.core) { out += seg.text; return; }
        const later = segs.slice(k + 1).some(s => s.text);
        if (!v.trim()) { if (!later) out = out.replace(/\s+$/, '') + seg.tail; return; }
        if (!seg.core) {
            const lead = out && !/\s$/.test(out) ? ' ' : '';
            const trail = later ? (out.match(/\s+$/)?.[0] ?? ' ') : '';
            out += lead + v + trail;
            return;
        }
        out += v + seg.tail;
    });
    return out;
}
