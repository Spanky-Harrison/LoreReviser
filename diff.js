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
