// Review UI: draws one revision session in the chat window as a list of per-entry cards.
// Each card: Approve / Reject / Edit / Regenerate, plus swipe-style paging between attempts.
// All state lives on the session/item objects (see revision.js), so a card can be re-drawn at any time.

import { splitKeywordsAndRegexes } from '../../../world-info.js';
import { integrityWarnings, sameAsOriginal } from './parse.js';
import { blockDiff, listDiff } from './diff.js';
import { applyApproval } from './apply.js';
import { INTENSITIES } from './intensity.js';
import { CHANGE_TYPES } from './changetype.js';
import { regenerateItem, retryMissing, describeEnd, describeError, runState } from './revision.js';

const $el = (tag, cls, text) => { const e = $(`<${tag}>`); if (cls) e.addClass(cls); if (text !== undefined) e.text(text); return e; };
const currentAttempt = (item) => item.attempts[item.index];

/** Chips for a key list change: removed keys struck through, added keys highlighted. */
function keyChips(label, oldList, newList) {
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
 */
function contentView(item, attempt, view) {
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

/**
 * @param {object} session
 * @param {{ onChange?: () => void }} [hooks]
 * @returns {JQuery} the session element
 */
export function renderSession(session, hooks = {}) {
    const $root = $el('div', 'lorerev_session');
    const $head = $el('div', 'lorerev_session_head');
    const $notes = $el('div', 'lorerev_session_notes');
    const $cards = $el('div', 'lorerev_cards');

    // ----- header and warnings -----
    function drawHead() {
        const count = (s) => session.items.filter(i => i.status === s).length;
        const parts = [`${session.items.length} sent`, `${count('proposed') + count('approved') + count('rejected')} changed`, `${count('unchanged')} no changes`];
        if (count('missing')) parts.push(`${count('missing')} not returned`);
        if (count('approved')) parts.push(`${count('approved')} approved`);
        if (count('rejected')) parts.push(`${count('rejected')} rejected`);
        $head.empty().append($el('b', '', `Revision`), $el('span', 'lorerev_dim', ` · ${session.profile.name} · ${parts.join(' · ')}`));
    }
    function drawNotes() {
        $notes.empty();
        const p = session.parse;
        if (p?.truncated) {
            const how = p.info?.lengthHit ? 'The reply was cut off by the reply token limit' : 'The reply stopped in the middle of the JSON';
            $notes.append($el('div', 'lorerev_warn',
                `${how} (${p.info ? describeEnd(p.info, session.maxTokens) : `${session.maxTokens} tokens allowed`}). Recovered ${p.recovered} complete entr${p.recovered === 1 ? 'y' : 'ies'}; the rest are marked "not returned". `
                + (p.info?.reasoningTokens ? 'Much of the budget went into thinking; raise "Reply tokens". ' : 'Raise "Reply tokens", or select fewer entries. ')
                + 'Use "Retry missing entries" to ask again for just those.'));
        }
        if (p?.skipped) $notes.append($el('div', 'lorerev_warn', `${p.skipped} part(s) of the reply were not valid JSON and could not be read (see "Raw reply").`));
        if (p?.repaired && !p.error) $notes.append($el('div', 'lorerev_dim', 'The model\'s JSON had formatting slips (raw line breaks or unescaped quotes); they were fixed automatically. Check that the text looks right.'));
        if (p?.unknownIds?.length) $notes.append($el('div', 'lorerev_warn', `The reply mentioned unknown entry ids and they were ignored: ${p.unknownIds.join(', ')}`));
        const missing = session.items.filter(i => i.status === 'missing').length;
        if (missing) $notes.append($el('div', 'lorerev_buttons').append(
            $el('div', 'menu_button lorerev_btn_retry', `Retry missing entries (${missing})`).on('click', () => retryAll())));
    }

    /** One request for all "not returned" entries. */
    async function retryAll() {
        if (runState.busy) { toastr.warning('Another request is still running.', 'LoreReviser'); return; }
        const items = session.items.filter(i => i.status === 'missing');
        if (!items.length) return;
        const abort = new AbortController();
        runState.busy = true;
        for (const it of items) { it.status = 'loading'; it.error = null; it.abort = abort; }
        redrawAll();
        try {
            await retryMissing(session, items, abort.signal);
        } catch (e) {
            for (const it of items) {
                it.status = 'missing';
                it.error = abort.signal.aborted ? 'Retry cancelled.' : `Retry failed: ${describeError(e)}`;
            }
            if (!abort.signal.aborted) toastr.error(`Retry failed: ${describeError(e)}`, 'LoreReviser');
        } finally {
            runState.busy = false; for (const it of items) it.abort = null;
            redrawAll();
        }
    }
    function redrawAll() {
        $cards.empty().append(session.items.map(buildCard));
        drawHead(); drawNotes(); hooks.onChange?.();
    }

    // ----- one card -----
    function rerender(item) {
        const old = $cards.children().filter((_, c) => c.dataset.id === item.id);
        old.replaceWith(buildCard(item));
        drawHead();
        hooks.onChange?.();
    }

    function buildCard(item) {
        item.ui ??= { view: 'compare', editing: false, regenText: '' };
        const ui = item.ui;
        const $card = $el('div', `lorerev_card lorerev_status_${item.status}`).attr('data-id', item.id);
        const title = $el('div', 'lorerev_card_title').append(
            $el('b', '', item.title), $el('span', 'lorerev_dim', ` ${item.book} · ${item.id}`),
            $el('span', `lorerev_pill lorerev_pill_${item.status}`, ({
                proposed: 'Proposed', unchanged: 'No changes', missing: 'Not returned', loading: 'Regenerating…', approved: 'Approved', rejected: 'Rejected',
            })[item.status]));
        $card.append(title);
        if (item.error) $card.append($el('div', 'lorerev_error_line', item.error));

        // --- states without a proposal to show ---
        if (item.status === 'loading') {
            $card.append($el('div', 'lorerev_dim', 'Waiting for the model…'),
                $el('div', 'menu_button', 'Cancel').on('click', () => item.abort?.abort()));
            return $card;
        }
        if (item.status === 'unchanged' || item.status === 'missing') {
            $card.append($el('div', 'lorerev_dim', item.status === 'missing'
                ? (item.missingNote ?? 'The model did not return this entry and the reply was damaged, so it is unknown whether it needs changes.')
                : 'The model left this entry as it is.'));
            $card.append(ui.editing ? editForm(item, null) : $('<div>').append(buttonsRow(item, ['edit']), regenBox(item)));
            return $card;
        }

        const attempt = currentAttempt(item);
        if (attempt?.edited) title.find('.lorerev_pill').last().after($el('span', 'lorerev_pill lorerev_pill_edited', 'Edited by you'));

        // --- proposed / approved / rejected: pager (proposed only), note, warnings, keys, content ---
        if (item.status === 'proposed' && item.attempts.length > 1) {
            const pager = $el('div', 'lorerev_pager').append(
                $el('span', 'menu_button lorerev_pg', '‹').on('click', () => { item.index = (item.index + item.attempts.length - 1) % item.attempts.length; rerender(item); }),
                $el('span', '', `${item.index + 1}/${item.attempts.length}`),
                $el('span', 'menu_button lorerev_pg', '›').on('click', () => { item.index = (item.index + 1) % item.attempts.length; rerender(item); }));
            title.append(pager);
        }
        if (item.status === 'approved') $card.append($el('div', 'lorerev_ok_line', item.applyMessage ?? 'Approved.'));
        if (item.reapprove) $card.append($el('div', 'lorerev_warn', 'You edited this after approving it. Approve it again to confirm your edited version.'));
        if (attempt.note) $card.append($el('div', 'lorerev_note', attempt.note));
        if (attempt.request || attempt.intensity || attempt.changeType) {
            $card.append($el('div', 'lorerev_dim lorerev_attempt_info').append(
                attempt.intensity ? $el('span', '', `Rewrite intensity: ${INTENSITIES[attempt.intensity]?.label ?? attempt.intensity}. `) : '',
                attempt.changeType ? $el('span', '', `Change type: ${CHANGE_TYPES[attempt.changeType]?.label ?? attempt.changeType}. `) : '',
                attempt.request ? $el('span', 'lorerev_request', `Your request for this attempt: “${attempt.request}”`) : ''));
        }
        for (const w of integrityWarnings(item.original, attempt)) $card.append($el('div', 'lorerev_warn', w));

        if (ui.editing) { $card.append(editForm(item, attempt)); return $card; }

        $card.append(keyChips('Keys', item.original.keys, attempt.keys));
        if (item.original.secondary.length || attempt.secondary.length) $card.append(keyChips('Secondary keys', item.original.secondary, attempt.secondary));
        $card.append(viewToggle(item), contentView(item, attempt, ui.view));
        $card.append(buttonsRow(item, ({
            proposed: ['approve', 'reject', 'edit'], approved: ['undo', 'edit'], rejected: ['undo', 'edit'],
        })[item.status]));
        if (item.status !== 'approved') $card.append(regenBox(item)); // approved cards: Undo first, then regenerate
        return $card;
    }

    function viewToggle(item) {
        const views = $el('div', 'lorerev_views');
        for (const [v, label] of [['compare', 'Compare'], ['changes', 'Changes'], ['new', 'New'], ['old', 'Old']]) {
            views.append($el('span', `lorerev_view${item.ui.view === v ? ' lorerev_view_on' : ''}`, label).on('click', () => { item.ui.view = v; rerender(item); }));
        }
        return views;
    }

    /**
     * Inline editor. Edits go straight into the pending proposal (the attempt on screen), so what is in the boxes
     * when you press "Save edit" is exactly what Approve will hand to the writer later. Works in every state:
     * after Approve/Reject the card goes back to "Proposed" and needs approving again. For entries the model left
     * unchanged (attempt = null) it creates a proposal written by you.
     */
    function editForm(item, attempt) {
        const base = attempt ?? item.original;
        const $f = $el('div', 'lorerev_edit');
        const keys = $('<input type="text" class="text_pole lorerev_ed_keys">').val(base.keys.join(', '));
        const sec = $('<input type="text" class="text_pole lorerev_ed_sec">').val(base.secondary.join(', '));
        const content = $('<textarea class="text_pole lorerev_ed_content" rows="12">').val(base.content);
        $f.append($el('label', '', 'Keys (comma separated; /regex/ allowed)'), keys, $el('label', '', 'Secondary keys'), sec,
            $el('label', '', 'Content: exactly this text is what will be saved when you approve'), content);
        const read = () => ({ keys: splitKeywordsAndRegexes(String(keys.val())), secondary: splitKeywordsAndRegexes(String(sec.val())), content: String(content.val()) });
        const afterEdit = () => {
            if (item.status === 'approved') item.reapprove = true;
            item.status = 'proposed'; item.applyMessage = null; item.ui.editing = false; rerender(item);
        };
        const buttons = $el('div', 'lorerev_buttons');
        buttons.append($el('div', 'menu_button lorerev_btn_save', 'Save edit').on('click', () => {
            const v = read();
            if (!attempt) {
                if (sameAsOriginal(item.original, v)) { toastr.info('Nothing was changed.', 'LoreReviser'); item.ui.editing = false; return rerender(item); }
                item.attempts.push({ ...v, note: 'Written by you: the model had left this entry unchanged.', edited: true, manual: true });
                item.index = item.attempts.length - 1;
            } else {
                // remember what the model wrote so the edit can be undone
                if (!attempt.modelVersion && !attempt.manual) attempt.modelVersion = { keys: [...attempt.keys], secondary: [...attempt.secondary], content: attempt.content };
                Object.assign(attempt, v);
                const mv = attempt.modelVersion;
                attempt.edited = attempt.manual || !(mv && sameAsOriginal(mv, v));
            }
            afterEdit();
        }), $el('div', 'menu_button', 'Cancel').on('click', () => { item.ui.editing = false; rerender(item); }));
        if (attempt?.modelVersion) buttons.append($el('div', 'menu_button lorerev_btn_reset', "Reset to the model's version").on('click', () => {
            Object.assign(attempt, structuredClone(attempt.modelVersion), { edited: false }); delete attempt.modelVersion; afterEdit();
        }));
        return $f.append(buttons);
    }

    function buttonsRow(item, which) {
        const ui = item.ui;
        const row = $el('div', 'lorerev_buttons');
        const btn = (label, cls, fn) => row.append($el('div', `menu_button ${cls ?? ''}`, label).on('click', fn));
        if (which.includes('approve')) btn('Approve', 'lorerev_btn_ok', async () => {
            const attempt = currentAttempt(item);
            item.status = 'approved'; item.approvedAttempt = item.index; item.reapprove = false;
            item.applyMessage = (await applyApproval(item, attempt)).message; // stub until milestone 4
            rerender(item);
        });
        if (which.includes('reject')) btn('Reject', 'lorerev_btn_no', () => { item.status = 'rejected'; rerender(item); });
        if (which.includes('edit')) btn('Edit', '', () => { ui.editing = true; rerender(item); });
        if (which.includes('undo')) btn('Undo', '', () => { item.status = 'proposed'; item.reapprove = false; item.applyMessage = null; rerender(item); });
        return row;
    }

    /**
     * Always-visible box for an extra request ("secondary prompt") for the next regeneration of this entry.
     * It is sent as <regeneration_request> and remembered on the new attempt (shown when you page to it).
     */
    function regenBox(item) {
        const ui = item.ui;
        const note = $('<textarea class="text_pole lorerev_regen_text" rows="3">')
            .attr('placeholder', 'Extra request for the next regeneration (optional), e.g. "keep it shorter" or "leave the second paragraph alone"')
            .val(ui.regenText);
        note.on('input', () => { ui.regenText = String(note.val()); });
        const go = $el('div', 'menu_button lorerev_btn_regen', 'Regenerate').on('click', () => regen(item));
        return $el('div', 'lorerev_regen').append(note, go);
    }

    /** Runs a regeneration for one entry (one request at a time). */
    async function regen(item) {
        if (runState.busy) { toastr.warning('Another request is still running.', 'LoreReviser'); return; }
        const note = item.ui.regenText;
        const before = item.status;
        runState.busy = true; item.abort = new AbortController();
        item.status = 'loading'; item.error = null; rerender(item);
        try {
            await regenerateItem(session, item, note, item.abort.signal);
            item.ui.regenText = ''; // consumed: it now lives on the new attempt
        } catch (e) {
            item.status = before;
            item.error = item.abort.signal.aborted ? 'Regeneration cancelled.' : `Regeneration failed: ${describeError(e)}`;
            if (!item.abort.signal.aborted) toastr.error(item.error, 'LoreReviser');
        } finally {
            runState.busy = false; item.abort = null;
            rerender(item); drawNotes();
        }
    }

    drawHead(); drawNotes();
    for (const item of session.items) $cards.append(buildCard(item));
    $root.append($head, $notes, $cards);

    // The raw reply(ies) are always available, e.g. to see what the model really said
    const raw = $el('details', 'lorerev_raw').append($el('summary', '', 'Raw reply'));
    $root.append(raw);
    raw.on('toggle', () => {
        if (!raw[0].open) return;
        raw.find('pre').remove();
        raw.append($el('pre', 'lorerev_pre', session.rawReplies.map((r, i) => `--- reply ${i + 1} ---\n${r}`).join('\n\n')));
    });
    return $root;
}
