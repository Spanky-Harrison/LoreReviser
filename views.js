// Shared display pieces: key chips and the four content views (used by the review cards and by History).

import { blockDiff, listDiff } from './diff.js';

export const $el = (tag, cls, text) => { const e = $(`<${tag}>`); if (cls) e.addClass(cls); if (text !== undefined) e.text(text); return e; };

/** Chips for a key list change: removed keys struck through, added keys highlighted. */
export function keyChips(label, oldList, newList) {
    const row = $el('div', 'lorerev_keys').append($el('span', 'lorerev_dim', `${label}: `));
    const diff = listDiff(oldList, newList);
    if (!diff.length) row.append($el('span', 'lorerev_dim', '(none)'));
    for (const d of diff) row.append($el('span', `lorerev_chip lorerev_chip_${d.type}`, d.text));
    return row;
}

/**
 * Renders the content in one of four views. All of them show whole blocks, never word-level marks:
 *  compare: old and new as two columns (stacked when narrow), changed paragraphs tinted
 *  changes: unchanged sentences dimmed, each changed run as a removed block followed by an added block
 *  new / old: just that text
 * `item` only needs item.original.content and `attempt` only .content, so History passes {original: record.old} and record.new.
 */
export function contentView(item, attempt, view) {
    const oldText = item.original.content ?? '', newText = attempt.content ?? '';
    if (view === 'old') return $el('div', 'lorerev_text', oldText || '(empty)');
    if (view === 'new') return $el('div', 'lorerev_text', newText || '(empty)');
    if (view === 'compare') {
        // Aligned rows: unchanged paragraphs span the full width and are dimmed (long runs are collapsed);
        // each changed region is one row with the removed paragraphs on the left and the added ones on the right.
        const ops = blockDiff(oldText, newText, 'paragraph');
        const wrap = $el('div', 'lorerev_cmp lorerev_text');
        if (!ops.some(o => o.type !== 'same')) return wrap.append($el('div', 'lorerev_dim', 'The text is unchanged (only keys differ).'));
        wrap.append($el('div', 'lorerev_row lorerev_col_title').append($el('div', '', 'Old'), $el('div', '', 'New')));
        const para = (text, mark) => $el('div', `lorerev_para${mark ? ` lorerev_para_${mark}` : ''}`, text);
        for (let k = 0; k < ops.length; k++) {
            const op = ops[k];
            if (op.type === 'same') {
                const run = $el('div', 'lorerev_same');
                const show = (blocks) => blocks.forEach(p => run.append(para(p)));
                if (op.blocks.length <= 3) show(op.blocks);
                else {
                    const hidden = op.blocks.slice(1, -1);
                    const mid = $el('div', 'lorerev_collapsed', `… ${hidden.length} unchanged paragraphs (click to show) …`);
                    mid.on('click', () => { mid.replaceWith(...hidden.map(p => para(p))); });
                    run.append(para(op.blocks[0]), mid, para(op.blocks.at(-1)));
                }
                wrap.append(run);
                continue;
            }
            // pair a removed run with the added run that follows it (blockDiff always emits del before ins)
            const next = ops[k + 1];
            const dels = op.type === 'del' ? op.blocks : [];
            const inss = op.type === 'ins' ? op.blocks : (next?.type === 'ins' ? next.blocks : []);
            const cell = (blocks, mark, empty) => $el('div', 'lorerev_cell').append(...(blocks.length ? blocks.map(p => para(p, mark)) : [$el('div', 'lorerev_dim', empty)]));
            wrap.append($el('div', 'lorerev_row').append(cell(dels, 'del', '(nothing removed)'), cell(inss, 'ins', '(nothing added)')));
            if (op.type === 'del' && next?.type === 'ins') k++; // the added run was shown in this row
        }
        return wrap;
    }
    // changes
    const box = $el('div', 'lorerev_text lorerev_changes');
    const ops = blockDiff(oldText, newText, 'sentence');
    if (!ops.some(o => o.type !== 'same')) return box.append($el('div', 'lorerev_dim', 'The text is unchanged (only keys differ).'));
    for (const op of ops) {
        const text = op.blocks.join(' ');
        box.append(op.type === 'same' ? $el('div', 'lorerev_blk lorerev_blk_same', text)
            : $el('div', `lorerev_blk lorerev_blk_${op.type}`, text).attr('data-mark', op.type === 'del' ? 'Removed' : 'Added'));
    }
    return box;
}
