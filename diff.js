// Small word-level diff for the review cards. Pure functions (unit-tested in tests/unit.mjs).

/** Splits text into words and whitespace runs, keeping both so the text can be rebuilt exactly. */
const tokenize = (s) => s.split(/(\s+)/).filter(t => t !== '');

/**
 * Word diff between two strings.
 * @returns {{type: 'same'|'del'|'ins', text: string}[]}
 */
export function wordDiff(oldText, newText) {
    const a = tokenize(oldText ?? ''), b = tokenize(newText ?? '');
    // Trim the common start and end so the table below stays small
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);

    const ops = [];
    a.slice(0, head).forEach(t => ops.push({ type: 'same', text: t }));
    if (midA.length * midB.length > 4_000_000) {
        // Too big for the table: show the whole middle as replaced
        if (midA.length) ops.push({ type: 'del', text: midA.join('') });
        if (midB.length) ops.push({ type: 'ins', text: midB.join('') });
    } else {
        // Longest common subsequence table
        const n = midA.length, m = midB.length, w = m + 1;
        const t = new Int32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                t[i * w + j] = midA[i] === midB[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
            }
        }
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (midA[i] === midB[j]) { ops.push({ type: 'same', text: midA[i] }); i++; j++; }
            else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push({ type: 'del', text: midA[i++] });
            else ops.push({ type: 'ins', text: midB[j++] });
        }
        while (i < n) ops.push({ type: 'del', text: midA[i++] });
        while (j < m) ops.push({ type: 'ins', text: midB[j++] });
    }
    a.slice(a.length - tail).forEach(t => ops.push({ type: 'same', text: t }));

    // Merge neighbours of the same type
    const merged = [];
    for (const op of ops) {
        const last = merged.at(-1);
        if (last && last.type === op.type) last.text += op.text; else merged.push({ ...op });
    }
    return merged;
}

/** Added / removed / kept items between two lists (used for keys). */
export function listDiff(oldList, newList) {
    const o = oldList ?? [], n = newList ?? [];
    return [
        ...o.filter(k => !n.includes(k)).map(text => ({ type: 'del', text })),
        ...n.map(text => ({ type: o.includes(text) ? 'same' : 'ins', text })),
    ];
}
