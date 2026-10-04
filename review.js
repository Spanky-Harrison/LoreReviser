// Review UI: draws one revision session in the chat window as a list of per-entry cards.
// Each card: Approve / Reject / Edit / Regenerate, plus swipe-style paging between attempts.
// All state lives on the session/item objects (see revision.js), so a card can be re-drawn at any time.

import { splitKeywordsAndRegexes } from '../../../world-info.js';
import { integrityWarnings } from './parse.js';
import { wordDiff, listDiff } from './diff.js';
import { applyApproval } from './apply.js';
import { regenerateItem, describeError, runState } from './revision.js';

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

/** Renders text as old / new / diff. */
function contentView(item, attempt, view) {
    const box = $el('div', 'lorerev_text');
    if (view === 'old') return box.text(item.original.content || '(empty)');
    if (view === 'new') return box.text(attempt.content || '(empty)');
    for (const op of wordDiff(item.original.content, attempt.content)) {
        box.append(op.type === 'same' ? document.createTextNode(op.text) : $el('span', `lorerev_${op.type}`, op.text));
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
        if (p?.truncated) $notes.append($el('div', 'lorerev_warn',
            `The reply was cut off (probably by the reply token limit, ${session.maxTokens}). Recovered ${p.recovered} complete entr${p.recovered === 1 ? 'y' : 'ies'}; the rest are marked "not returned". Raise "Reply tokens", or select fewer entries.`));
        if (p?.skipped) $notes.append($el('div', 'lorerev_warn', `${p.skipped} part(s) of the reply were not valid JSON and were skipped.`));
        if (p?.unknownIds?.length) $notes.append($el('div', 'lorerev_warn', `The reply mentioned unknown entry ids and they were ignored: ${p.unknownIds.join(', ')}`));
    }

    // ----- one card -----
    function rerender(item) {
        const old = $cards.children().filter((_, c) => c.dataset.id === item.id);
        old.replaceWith(buildCard(item));
        drawHead();
        hooks.onChange?.();
    }

    function buildCard(item) {
        item.ui ??= { view: 'diff', editing: false, regenOpen: false, regenText: '' };
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
                ? 'The model did not return this entry, and the reply was cut off or damaged, so it is unknown whether it needs changes.'
                : 'The model left this entry as it is.'));
            $card.append(buttonsRow(item, ['regen']));
            return $card;
        }

        const attempt = currentAttempt(item);

        // --- decided ---
        if (item.status === 'approved' || item.status === 'rejected') {
            if (item.status === 'approved') {
                $card.append($el('div', 'lorerev_ok_line', item.applyMessage ?? 'Approved.'));
            }
            $card.append(buttonsRow(item, ['undo']));
            return $card;
        }

        // --- proposed: pager, note, warnings, keys, content ---
        if (item.attempts.length > 1) {
            const pager = $el('div', 'lorerev_pager').append(
                $el('span', 'menu_button lorerev_pg', '‹').on('click', () => { item.index = (item.index + item.attempts.length - 1) % item.attempts.length; rerender(item); }),
                $el('span', '', `${item.index + 1}/${item.attempts.length}`),
                $el('span', 'menu_button lorerev_pg', '›').on('click', () => { item.index = (item.index + 1) % item.attempts.length; rerender(item); }));
            title.append(pager);
        }
        if (attempt.note) $card.append($el('div', 'lorerev_note', attempt.note));
        if (attempt.edited) $card.append($el('div', 'lorerev_dim', '(edited by you)'));
        for (const w of integrityWarnings(item.original, attempt)) $card.append($el('div', 'lorerev_warn', w));

        if (ui.editing) {
            $card.append(editForm(item, attempt));
            return $card;
        }

        $card.append(keyChips('Keys', item.original.keys, attempt.keys));
        if (item.original.secondary.length || attempt.secondary.length) $card.append(keyChips('Secondary keys', item.original.secondary, attempt.secondary));
        const views = $el('div', 'lorerev_views');
        for (const [v, label] of [['diff', 'Changes'], ['new', 'New'], ['old', 'Old']]) {
            views.append($el('span', `lorerev_view${ui.view === v ? ' lorerev_view_on' : ''}`, label).on('click', () => { ui.view = v; rerender(item); }));
        }
        $card.append(views, contentView(item, attempt, ui.view), buttonsRow(item, ['approve', 'reject', 'edit', 'regen']));
        return $card;
    }

    /** Inline editor for the current attempt. */
    function editForm(item, attempt) {
        const $f = $el('div', 'lorerev_edit');
        const keys = $('<input type="text" class="text_pole">').val(attempt.keys.join(', '));
        const sec = $('<input type="text" class="text_pole">').val(attempt.secondary.join(', '));
        const content = $('<textarea class="text_pole" rows="10">').val(attempt.content);
        $f.append($el('label', '', 'Keys (comma separated; /regex/ allowed)'), keys, $el('label', '', 'Secondary keys'), sec, $el('label', '', 'Content'), content);
        $f.append($el('div', 'lorerev_buttons').append(
            $el('div', 'menu_button', 'Save edit').on('click', () => {
                Object.assign(attempt, { keys: splitKeywordsAndRegexes(String(keys.val())), secondary: splitKeywordsAndRegexes(String(sec.val())), content: String(content.val()), edited: true });
                item.ui.editing = false; rerender(item);
            }),
            $el('div', 'menu_button', 'Cancel').on('click', () => { item.ui.editing = false; rerender(item); })));
        return $f;
    }

    function buttonsRow(item, which) {
        const ui = item.ui;
        const row = $el('div', 'lorerev_buttons');
        const btn = (label, cls, fn) => row.append($el('div', `menu_button ${cls ?? ''}`, label).on('click', fn));
        if (which.includes('approve')) btn('Approve', 'lorerev_btn_ok', async () => {
            const attempt = currentAttempt(item);
            item.status = 'approved'; item.approvedAttempt = item.index;
            item.applyMessage = (await applyApproval(item, attempt)).message; // stub until milestone 4
            rerender(item);
        });
        if (which.includes('reject')) btn('Reject', 'lorerev_btn_no', () => { item.status = 'rejected'; rerender(item); });
        if (which.includes('edit')) btn('Edit', '', () => { ui.editing = true; rerender(item); });
        if (which.includes('undo')) btn('Undo', '', () => { item.status = 'proposed'; rerender(item); });
        if (which.includes('regen')) btn('Regenerate…', '', () => { ui.regenOpen = !ui.regenOpen; rerender(item); });
        if (!(which.includes('regen') && ui.regenOpen)) return row;

        // Regenerate panel: optional guidance for this entry
        const note = $('<textarea class="text_pole" rows="2" placeholder="Optional: what should be different this time?">').val(ui.regenText);
        note.on('input', () => { ui.regenText = String(note.val()); });
        const go = $el('div', 'menu_button', 'Regenerate').on('click', () => regen(item));
        return $('<div>').append(row, $el('div', 'lorerev_regen').append(note, go));
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
            item.ui.regenOpen = false; item.ui.regenText = '';
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
