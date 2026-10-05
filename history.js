// History view: past saved versions of a lorebook's entries (from its archive file), newest first, with
// the same diff views as the review cards and a one-click Restore. Opens as a popup on top of the modal.

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { $el, keyChips, contentView } from './views.js';
import { readArchive } from './archive.js';
import { recordsFor, actionLabel } from './archive-core.js';
import { checkRestore, restoreRecord } from './apply.js';
import { INTENSITIES } from './intensity.js';
import { CHANGE_TYPES } from './changetype.js';

const when = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso ?? '') : d.toLocaleString(); };

/**
 * @param {object} p
 * @param {string} p.book lorebook name (the archive index key)
 * @param {number|null} [p.uid] show only this entry (null = all entries, with a filter)
 * @param {() => void} [p.onRestore] called after a successful restore (e.g. to refresh the modal)
 */
export async function openHistory({ book, uid = null, onRestore } = {}) {
    const $root = $el('div', 'lorerev_hist');
    const $top = $el('div', 'lorerev_hist_top');
    const $list = $el('div', 'lorerev_hist_list');
    $root.append($top, $list);
    let filter = uid === null || uid === undefined ? null : Number(uid);
    let archive = null;
    const views = new Map(); // record id -> chosen view

    async function load() {
        $list.empty().append($el('div', 'lorerev_dim', 'Loading…'));
        try { archive = await readArchive(book); } catch (e) {
            $list.empty().append($el('div', 'lorerev_warn', String(e?.message ?? e)));
            return;
        }
        draw();
    }

    function draw() {
        const all = recordsFor(archive, null);
        $top.empty().append($el('h3', '', `History: ${book}`));
        // entry filter: every entry that has records, newest title first
        const entries = new Map();
        for (const r of all) if (!entries.has(r.uid)) entries.set(r.uid, r.title || `Entry #${r.uid}`);
        if (filter !== null && !entries.has(filter)) entries.set(filter, `Entry #${filter}`);
        const $sel = $('<select class="text_pole lorerev_hist_filter">').append($('<option value="">All entries</option>'));
        for (const [u, t] of entries) $sel.append($('<option>').val(String(u)).text(t));
        $sel.val(filter === null ? '' : String(filter)).on('change', () => { filter = $sel.val() === '' ? null : Number($sel.val()); draw(); });
        $top.append($el('label', 'lorerev_hist_filter_row', 'Show: ').append($sel),
            $el('div', 'lorerev_dim', 'Every saved change is listed here, newest first. "Restore old version" puts the Old side back into the lorebook; the text it replaces is saved here too, so nothing is lost.'));

        const records = recordsFor(archive, filter);
        $list.empty();
        if (!records.length) {
            $list.append($el('div', 'lorerev_dim lorerev_hist_empty', filter === null ? 'No saved changes yet for this lorebook.' : 'No saved changes yet for this entry.'));
            return;
        }
        for (const r of records) $list.append(recordView(r));
    }

    function recordView(r) {
        const view = views.get(r.id) ?? 'changes';
        const $r = $el('div', `lorerev_hist_rec lorerev_hist_${r.action}`).attr('data-rec', r.id);
        $r.append($el('div', 'lorerev_card_title').append(
            $el('b', '', r.title || `Entry #${r.uid}`), $el('span', 'lorerev_dim', ` #${r.uid} · ${when(r.time)}`),
            $el('span', 'lorerev_pill', actionLabel(r.action)), r.edited ? $el('span', 'lorerev_pill lorerev_pill_edited', 'Edited by you') : ''));
        const info = [];
        if (r.instructions) info.push(`Your instructions: “${r.instructions}”`);
        if (r.request) info.push(`Extra request: “${r.request}”`);
        if (r.intensity) info.push(`Rewrite intensity: ${INTENSITIES[r.intensity]?.label ?? r.intensity}`);
        if (r.changeType) info.push(`Change type: ${CHANGE_TYPES[r.changeType]?.label ?? r.changeType}`);
        if (r.restoredFrom) {
            const src = archive.records.find(x => x.id === r.restoredFrom);
            info.push(src ? `Put back the old version from the change of ${when(src.time)}` : 'Put back an older version');
        }
        if (info.length) $r.append($el('div', 'lorerev_dim lorerev_attempt_info', info.join(' · ')));
        $r.append(keyChips('Keys', r.old.keys, r.new.keys));
        if (r.old.secondary.length || r.new.secondary.length) $r.append(keyChips('Secondary keys', r.old.secondary, r.new.secondary));
        const $views = $el('div', 'lorerev_views');
        for (const [v, label] of [['changes', 'Changes'], ['compare', 'Full Compare'], ['new', 'New'], ['old', 'Old']]) {
            $views.append($el('span', `lorerev_view${view === v ? ' lorerev_view_on' : ''}`, label).on('click', () => { views.set(r.id, v); $r.replaceWith(recordView(r)); }));
        }
        $r.append($views, contentView({ original: r.old }, r.new, view));
        $r.append($el('div', 'lorerev_buttons').append(
            $el('div', 'menu_button lorerev_btn_restore', 'Restore old version').attr('title', 'Put the Old side of this change back into the lorebook').on('click', () => restore(r))));
        return $r;
    }

    async function restore(r) {
        const check = await checkRestore(book, r.uid);
        if (check.error) { toastr.warning(`Can't restore: ${check.error}.`, 'LoreReviser'); return; }
        const body = $el('div').append(
            $el('h3', '', 'Restore the old version?'),
            $el('p', '', `“${r.title || `Entry #${r.uid}`}” in “${book}” gets the keys and text it had before the change of ${when(r.time)}. The current text is saved in History first, so you can go back.`));
        if (check.changedOutside) body.append($el('p', 'lorerev_warn', 'Note: this entry was changed outside LoreReviser since its last saved change (for example in the World Info editor). That change will be replaced too, but it is also kept in History.'));
        const ok = await new Popup(body, POPUP_TYPE.CONFIRM, '', { okButton: 'Restore', cancelButton: 'Cancel' }).show();
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        const res = await restoreRecord(book, r, check.current);
        if (res.written) { toastr.success(res.message, 'LoreReviser'); onRestore?.(); } else toastr.warning(res.message, 'LoreReviser', { timeOut: 10000 });
        await load();
    }

    const popup = new Popup($root, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', cancelButton: false, allowVerticalScrolling: true, onOpen: load });
    popup.dlg.classList.add('lorerev_hist_popup');
    await popup.show();
}
