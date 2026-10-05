// Takes selected entries out of the "active lore" text so each entry is sent once (in full, in <entries_to_revise>).
// Pure functions, no SillyTavern imports (unit-tested in tests/unit.mjs).
//
// ST assembles the active lore as: worldInfoBefore / worldInfoAfter = entry texts joined with "\n", plus lists with one
// text per entry (depth groups, author's note top/bottom, outlets). A selected entry is found in that structure by
// its text. Which entries are active, and their exact text, comes from the scan result (book + uid), so a
// match is exact; entries that are not selected are never touched.

/**
 * Removes one entry text from a "\n"-joined block, only where it stands alone (start/end of the block or between
 * newlines), so a line inside another entry's text is not removed by accident.
 * @returns {{text: string, removed: boolean}}
 */
export function removeBlock(joined, block) {
    if (!joined || !block) return { text: joined ?? '', removed: false };
    let from = 0;
    for (;;) {
        const i = joined.indexOf(block, from);
        if (i < 0) return { text: joined, removed: false };
        const end = i + block.length;
        const startsClean = i === 0 || joined[i - 1] === '\n';
        const endsClean = end === joined.length || joined[end] === '\n';
        if (startsClean && endsClean) {
            const text = i > 0 ? joined.slice(0, i - 1) + joined.slice(end) : joined.slice(end + (end < joined.length ? 1 : 0));
            return { text, removed: true };
        }
        from = i + 1;
    }
}

/**
 * @typedef {object} LoreSource
 * @property {string} before  worldInfoBefore (entries joined by "\n")
 * @property {string} after   worldInfoAfter
 * @property {{label: string, items: string[]}[]} lists  one text per entry: depth groups, AN top/bottom, outlets
 *
 * @typedef {object} Candidate  a selected entry that is active, with the texts it may appear as
 * @property {string} id      shown in logs (e.g. "E3")
 * @property {boolean} [optional]  no complaint when the entry's text is not in the lore (it may simply not be active)
 * @property {{text: string, via: 'uid'|'content'}[]} texts  via 'uid' = text taken from the scan result for this book+uid;
 *                                                          'content' = fallback, the entry's stored content
 */

/**
 * Removes each candidate once from the lore source. Returns a new source plus a report.
 * @param {LoreSource} src
 * @param {Candidate[]} candidates
 * @returns {{src: LoreSource, removed: {id: string, from: string, via: string}[], notFound: string[]}}
 */
export function dedupeLore(src, candidates) {
    const out = { before: src.before ?? '', after: src.after ?? '', lists: src.lists.map(l => ({ label: l.label, items: [...l.items] })) };
    const removed = [], notFound = [];
    for (const c of candidates) {
        let done = false;
        for (const { text, via } of c.texts) {
            if (!text || done) continue;
            // 1. whole-entry text in a list (exact, safest)
            for (const l of out.lists) {
                const i = l.items.indexOf(text);
                if (i >= 0) { l.items.splice(i, 1); removed.push({ id: c.id, from: l.label, via }); done = true; break; }
            }
            if (done) break;
            // 2. standalone block inside the before / after strings
            for (const key of ['before', 'after']) {
                const r = removeBlock(out[key], text);
                if (r.removed) { out[key] = r.text; removed.push({ id: c.id, from: key, via }); done = true; break; }
            }
        }
        if (!done && !c.optional) notFound.push(c.id);
    }
    return { src: out, removed, notFound };
}

/** The final active-lore text, in the order the prompt has always used. */
export function assembleLore(src) {
    return [src.before, src.after, ...src.lists.flatMap(l => l.items)].filter(p => typeof p === 'string' && p.trim()).join('\n\n');
}
