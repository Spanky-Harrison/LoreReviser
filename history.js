// History view: past saved versions of a lorebook's entries (from its archive file), newest first, with
// the same diff views as the review cards and a one-click Restore. Opens as a popup on top of the modal.
// Each record is collapsible (same pattern as review cards): header click folds/unfolds. Default: newest
// expanded, older ones collapsed; fold state is kept for this History window session.
// "Clear old history" (top) and the trash icon on each row remove History records only; the lorebook is never touched.

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { $el, keyChips, contentView } from './views.js';
import { readArchive, getArchiveIndex } from './archive.js';
import { recordsFor, actionLabel, actionKinds, filterByAction, createdByRecord, removedByRecord, CLEAR_CHOICES, DEFAULT_CLEAR_CHOICE, clearChoice, recordsToClear } from './archive-core.js';
import { checkRestore, restoreRecord, clearHistoryRecords } from './apply.js';
import { INTENSITIES } from './intensity.js';
import { CHANGE_TYPES } from './changetype.js';
import { describeChanged } from './manual-core.js';

const changes = (n) => `${n} saved change${n === 1 ? '' : 's'}`;
const KEEP_NOTE = 'The lorebook itself is not changed: its entries keep their current text and settings. Only these saved versions are removed from History, and once removed they can\'t be restored.';
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
    // Fold state for this History window: missing = default (newest expanded, older collapsed).
    const folded = new Map();
    let clearSel = DEFAULT_CLEAR_CHOICE; // "Clear old history" choice, kept for this window
    let kind = ''; // "Kind" filter: '' = every kind of change, else one action (e.g. 'manual')

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
        // kind filter: the kinds of change in this History (approved changes, manual edits, restores, ...)
        const kinds = actionKinds(archive);
        if (kind && !kinds.some(k => k.action === kind)) kind = '';
        const $kind = $('<select class="text_pole lorerev_hist_kind">').append($('<option value="">All kinds of change</option>'));
        for (const k of kinds) $kind.append($('<option>').val(k.action).text(`${k.label} (${k.count})`));
        $kind.val(kind).on('change', () => { kind = String($kind.val() ?? ''); draw(); });
        $top.append($el('div', 'lorerev_hist_filters').append(
            $el('label', 'lorerev_hist_filter_row', 'Show: ').append($sel),
            $el('label', 'lorerev_hist_filter_row', 'Kind: ').append($kind)),
            $el('div', 'lorerev_dim', 'Every saved change is listed here, newest first. Click a row\'s header to fold or unfold it (newest starts open). "Restore old version" puts the Old side back into the lorebook (that works for "Manual edit" records, made with the pencil in the sidebar, too); the text it replaces is saved here too, so nothing is lost. For a new entry, "Remove this entry" takes it out again (only while it is still exactly as created), and "Create it again" brings back a removed entry with all its settings. "Clear old history" (or a row\'s trash icon) removes old saved changes from History only; the lorebook itself is not changed.'));

        if (archive?.records?.length) {
            const $choice = $('<select class="text_pole lorerev_hist_clear_select">');
            for (const c of CLEAR_CHOICES) $choice.append($('<option>').val(c.id).text(c.label));
            $choice.val(clearSel).on('change', () => { clearSel = String($choice.val()); });
            $top.append($el('div', 'lorerev_hist_clear').append(
                $el('span', '', 'Clear old history:'), $choice,
                $el('div', 'menu_button lorerev_btn_hist_clear', 'Clear…')
                    .attr('title', 'Remove saved changes from this lorebook\'s History (all entries). You are asked first. The lorebook itself is not changed.')
                    .on('click', clearOld)));
        }

        const records = filterByAction(recordsFor(archive, filter), kind);
        $list.empty();
        if (!records.length) {
            $list.append($el('div', 'lorerev_dim lorerev_hist_empty', kind ? `No “${actionLabel(kind)}” records${filter === null ? '' : ' for this entry'}.` : filter === null ? 'No saved changes yet for this lorebook.' : 'No saved changes yet for this entry.'));
            return;
        }
        records.forEach((r, i) => $list.append(recordView(r, i === 0)));
    }

    function recordView(r, isNewest) {
        const view = views.get(r.id) ?? (createdByRecord(r) ? 'new' : removedByRecord(r) ? 'old' : 'changes');
        // Default: newest expanded, older collapsed. User toggles persist in `folded` for this window.
        const collapsed = folded.has(r.id) ? !!folded.get(r.id) : !isNewest;
        const $r = $el('div', `lorerev_hist_rec lorerev_hist_${r.action}${collapsed ? ' lorerev_hist_folded' : ''}`).attr('data-rec', r.id);
        const title = $el('div', 'lorerev_card_title lorerev_card_toggle').append(
            $el('span', `lorerev_collapse fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}`).attr('title', collapsed ? 'Show this change' : 'Hide the details of this change'),
            $el('b', '', r.title || `Entry #${r.uid}`), $el('span', 'lorerev_dim', ` #${r.uid} · ${when(r.time)}`),
            $el('span', `lorerev_pill${r.action === 'manual' ? ' lorerev_pill_manual' : ''}`, actionLabel(r.action)), r.edited ? $el('span', 'lorerev_pill lorerev_pill_edited', 'Edited by you') : '');
        title.on('click', () => { folded.set(r.id, !collapsed); $r.replaceWith(recordView(r, isNewest)); });
        $r.append(title);
        // Summary only when folded: entry name, timestamp, action (and a short note if present)
        if (collapsed && r.instructions) title.append($el('span', 'lorerev_dim', ` · “${String(r.instructions).slice(0, 60)}${String(r.instructions).length > 60 ? '…' : ''}”`));
        title.append($el('span', 'lorerev_hist_del fa-solid fa-trash-can').attr('title', 'Delete this record from History (the lorebook is not changed)')
            .on('click', (e) => { e.stopPropagation(); deleteOne(r); }));
        if (collapsed) return $r;
        const info = [];
        if (r.instructions) info.push(`Your instructions: “${r.instructions}”`);
        if (r.request) info.push(`Extra request: “${r.request}”`);
        if (r.intensity) info.push(`Rewrite intensity: ${INTENSITIES[r.intensity]?.label ?? r.intensity}`);
        if (r.changeType) info.push(`Change type: ${CHANGE_TYPES[r.changeType]?.label ?? r.changeType}`);
        if (r.restoredFrom) {
            const src = archive.records.find(x => x.id === r.restoredFrom);
            if (r.action === 'remove') info.push(src ? `Removed from History (undoing the creation of ${when(src.time)})` : 'Removed from History');
            else if (r.action === 'recreate') info.push(src ? `Created again from the removal of ${when(src.time)}` : 'Created again from History');
            else info.push(src ? `Put back the old version from the change of ${when(src.time)}` : 'Put back an older version');
        }
        if (r.action === 'create') info.push(r.settingsFrom && typeof r.settingsFrom === 'object' ? `Settings copied from “${r.settingsFrom.title}” (#${r.settingsFrom.uid})` : 'SillyTavern\'s default settings');
        if (r.action === 'manual') info.push(`Edited by hand in LoreReviser's entry editor (no model)${Array.isArray(r.changed) && r.changed.length ? `: ${describeChanged(r.changed)}` : ''}`);
        if (r.action === 'remove' && r.via === 'undo') info.push('Removed with Undo on its review card');
        if (r.originalUid !== undefined) info.push(`Was #${r.originalUid} before it was removed`);
        if (r.oldTitle !== undefined) info.push(`Title changed from “${r.oldTitle}”`);
        if (info.length) $r.append($el('div', 'lorerev_dim lorerev_attempt_info', info.join(' · ')));
        $r.append(keyChips('Keys', r.old.keys, r.new.keys));
        if (r.old.secondary.length || r.new.secondary.length) $r.append(keyChips('Secondary keys', r.old.secondary, r.new.secondary));
        const $views = $el('div', 'lorerev_views');
        for (const [v, label] of [['changes', 'Changes'], ['compare', 'Full Compare'], ['new', 'New'], ['old', 'Old']]) {
            $views.append($el('span', `lorerev_view${view === v ? ' lorerev_view_on' : ''}`, label).on('click', () => { views.set(r.id, v); $r.replaceWith(recordView(r, isNewest)); }));
        }
        $r.append($views, contentView({ original: r.old }, r.new, view));
        const [label, tip] = createdByRecord(r) ? ['Remove this entry', 'Undo the creation: take this entry out of the lorebook again (only while it is still exactly as created)']
            : removedByRecord(r) ? ['Create it again', 'Put this removed entry back into the lorebook, with all its settings']
                : ['Restore old version', 'Put the Old side of this change back into the lorebook'];
        $r.append($el('div', 'lorerev_buttons').append(
            $el('div', 'menu_button lorerev_btn_restore', label).attr('title', tip).on('click', () => restore(r))));
        return $r;
    }

    async function restore(r) {
        const check = await checkRestore(book, r);
        if (check.error) { toastr.warning(`Can't ${createdByRecord(r) ? 'remove' : removedByRecord(r) ? 'create it again' : 'restore'}: ${check.error}.`, 'LoreReviser'); return; }
        const name = `“${r.title || `Entry #${r.uid}`}”`;
        let body, okLabel = 'Restore';
        if (check.kind === 'remove') {
            if (!check.matches) {
                toastr.warning('Not removed: this entry was changed after it was created (by a later change or outside LoreReviser), so removing it would lose that change. Delete it in the World Info editor if you no longer want it.', 'LoreReviser', { timeOut: 10000 });
                return;
            }
            okLabel = 'Remove';
            body = $el('div').append($el('h3', '', 'Remove this entry?'),
                $el('p', '', `${name} (#${r.uid}) was created by LoreReviser on ${when(r.time)} and is still unchanged. It is taken out of “${book}”. Its full data (with all settings) is kept in History, so “Create it again” can bring it back.`));
        } else if (check.kind === 'recreate') {
            if (check.duplicate !== null) { toastr.info(`Nothing to do: “${book}” already has this entry (#${check.duplicate}).`, 'LoreReviser'); return; }
            okLabel = 'Create';
            body = $el('div').append($el('h3', '', 'Create the entry again?'),
                $el('p', '', `${name} is added to “${book}” again, with the keys, text and all settings it had when it was removed on ${when(r.time)}.`));
            if (check.uidTaken) body.append($el('p', 'lorerev_dim', `Its old number #${r.uid} is used by another entry now, so it gets a new number.`));
        }
        if (body) {
            const ok = await new Popup(body, POPUP_TYPE.CONFIRM, '', { okButton: okLabel, cancelButton: 'Cancel' }).show();
            if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
            const res = await restoreRecord(book, r, check.current);
            if (res.written) { toastr.success(res.message, 'LoreReviser'); onRestore?.(); } else toastr.warning(res.message, 'LoreReviser', { timeOut: 10000 });
            await load();
            return;
        }
        body = $el('div').append(
            $el('h3', '', 'Restore the old version?'),
            $el('p', '', `“${r.title || `Entry #${r.uid}`}” in “${book}” gets the keys and text it had before the change of ${when(r.time)}. The current text is saved in History first, so you can go back.`));
        if (check.changedOutside) body.append($el('p', 'lorerev_warn', 'Note: this entry was changed outside LoreReviser since its last saved change (for example in the World Info editor). That change will be replaced too, but it is also kept in History.'));
        const ok = await new Popup(body, POPUP_TYPE.CONFIRM, '', { okButton: 'Restore', cancelButton: 'Cancel' }).show();
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        const res = await restoreRecord(book, r, check.current);
        if (res.written) { toastr.success(res.message, 'LoreReviser'); onRestore?.(); } else toastr.warning(res.message, 'LoreReviser', { timeOut: 10000 });
        await load();
    }

    /** Confirm text shared by Clear and the trash icon. */
    function clearBody(heading, what, list) {
        const body = $el('div', 'lorerev_hist_clear_confirm').append($el('h3', '', heading), $el('p', '', what), $el('p', '', KEEP_NOTE));
        const copies = list.filter(r => removedByRecord(r) && r.snapshot).length;
        if (copies) body.append($el('p', 'lorerev_warn', copies === 1
            ? 'One of them holds the saved copy of a removed entry, so that entry can no longer be created again from History.'
            : `${copies} of them hold saved copies of removed entries, so those entries can no longer be created again from History.`));
        return body;
    }

    async function runClear(ids, how, done) {
        const res = await clearHistoryRecords(book, ids, how);
        if (!res.ok) toastr.warning(res.message, 'LoreReviser', { timeOut: 10000 });
        else if (!res.removed) toastr.info('Nothing was removed: those saved changes were already gone.', 'LoreReviser');
        else toastr.success(done(res.removed), 'LoreReviser');
        await load();
    }

    async function clearOld() {
        const choice = clearChoice(clearSel);
        const now = new Date();
        const list = recordsToClear(archive, choice.id, now);
        const total = archive?.records?.length ?? 0;
        if (!list.length) {
            toastr.info(choice.days === null ? 'Nothing to clear: there are no saved changes.' : `Nothing to clear: no saved changes are ${choice.label}.`, 'LoreReviser');
            return;
        }
        const what = choice.days === null
            ? `All ${changes(list.length)} in the History of “${book}” will be removed (every entry).`
            : `${list.length === total ? 'All' : `${list.length} of the`} ${changes(total)} in the History of “${book}” ${list.length === 1 ? 'is' : 'are'} ${choice.label} (saved before ${new Date(now.getTime() - choice.days * 86400000).toLocaleString()}) and will be removed (every entry). Newer ones are kept.`;
        const ok = await new Popup(clearBody('Clear old history?', what, list), POPUP_TYPE.CONFIRM, '', { okButton: `Remove ${list.length}`, cancelButton: 'Cancel' }).show();
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        await runClear(list.map(r => r.id), choice.id, (n) => `Removed ${changes(n)} from the History of “${book}”. The lorebook was not changed.`);
    }

    async function deleteOne(r) {
        const what = `The record “${actionLabel(r.action)}” for “${r.title || `Entry #${r.uid}`}” (#${r.uid}) from ${when(r.time)} will be removed from the History of “${book}”.`;
        const ok = await new Popup(clearBody('Delete this History record?', what, [r]), POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }).show();
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        await runClear([r.id], 'one', () => `Removed that saved change from the History of “${book}”. The lorebook was not changed.`);
    }

    const popup = new Popup($root, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', cancelButton: false, allowVerticalScrolling: true, onOpen: load });
    popup.dlg.classList.add('lorerev_hist_popup');
    await popup.show();
}

/**
 * Opens History for a chosen lorebook. Used by the top-level History button when there is no review card.
 * Lists lorebooks that have a History file (and still exist); if only one, opens it directly.
 * @param {object} p
 * @param {() => void} [p.onRestore]
 */
export async function openHistoryPicker({ onRestore } = {}) {
    const index = getArchiveIndex();
    const names = SillyTavern.getContext().getWorldInfoNames();
    const withArchive = Object.keys(index).filter(n => names.includes(n)).sort((a, b) => a.localeCompare(b));
    if (!withArchive.length) {
        toastr.info('No saved History yet. Approve a change first, or use the clock next to a linked lorebook.', 'LoreReviser');
        return;
    }
    if (withArchive.length === 1) {
        await openHistory({ book: withArchive[0], onRestore });
        return;
    }
    const $sel = $('<select class="text_pole lorerev_hist_filter">');
    for (const name of withArchive) $sel.append($('<option>').val(name).text(name));
    const body = $el('div', 'lorerev_hist_pick').append(
        $el('h3', '', 'History'),
        $el('p', '', 'Pick a lorebook that has saved changes:'),
        $sel);
    const ok = await new Popup(body, POPUP_TYPE.CONFIRM, '', { okButton: 'Open', cancelButton: 'Cancel' }).show();
    if (ok === POPUP_RESULT.AFFIRMATIVE) await openHistory({ book: String($sel.val()), onRestore });
}
