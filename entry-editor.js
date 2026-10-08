// Direct entry editor: opened from the pencil icon next to an entry in the modal's lorebook sidebar. Shows the entry's
// title, keys, secondary keys and text (loaded fresh from the lorebook) in a large popup on top of the modal, ready to
// edit. No model is used. Save writes through apply.js's saveManualEdit (same queue, stale check and History record as
// Approve; recorded as a "Manual edit"). Cancel / Esc with unsaved changes asks first. Pure logic: manual-core.js.

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { splitKeywordsAndRegexes } from '../../../world-info.js';
import { $el } from './views.js';
import { readEntryForEdit, saveManualEdit } from './apply.js';
import { openHistory } from './history.js';
import { formFromVersion, formDirty, buildManualVersion, describeChanged, textStats } from './manual-core.js';

const confirm = async (heading, text, okButton, cancelButton) =>
    (await new Popup($el('div', 'lorerev_ed_confirm').append($el('h3', '', heading), $el('p', '', text)), POPUP_TYPE.CONFIRM, '', { okButton, cancelButton }).show()) === POPUP_RESULT.AFFIRMATIVE;

/**
 * @param {object} p
 * @param {string} p.book lorebook name
 * @param {number} p.uid entry uid
 * @param {() => void} [p.onSaved] called after a successful save or a restore from the editor's History (e.g. to refresh the sidebar)
 * @returns {Promise<boolean>} true when something was saved
 */
export async function openEntryEditor({ book, uid, onSaved } = {}) {
    const first = await readEntryForEdit(book, uid);
    if (first.error) { toastr.warning(`Can't open this entry: ${first.error}.`, 'LoreReviser'); return false; }

    let info = first;                  // title, disabled, ... of the version on screen
    let base = first.version;          // the entry as it was when opened / last reloaded (the stale check compares with this)
    let initial = formFromVersion(base);
    let saved = false;
    let busy = false;

    const $root = $el('div', 'lorerev_ed_root').attr('data-book', book).attr('data-uid', String(uid));
    const $title = $el('h3', 'lorerev_ed_heading');
    const $meta = $el('div', 'lorerev_dim lorerev_ed_meta');
    const $dirty = $el('span', 'lorerev_ed_dirty');
    const $tools = $el('div', 'lorerev_ed_tools').append(
        $el('div', 'menu_button lorerev_ed_hist').append($el('span', 'fa-solid fa-clock-rotate-left'), ' History for this entry')
            .attr('title', 'Earlier saved versions of this entry, with Restore'),
        $el('div', 'menu_button lorerev_ed_reload').append($el('span', 'fa-solid fa-rotate'), ' Reload from lorebook')
            .attr('title', 'Load the entry\'s current keys and text from the lorebook again'),
        $dirty);
    const $msg = $el('div', 'lorerev_ed_msg').hide();
    const $keys = $('<input type="text" class="text_pole lorerev_ed_keys">');
    const $sec = $('<input type="text" class="text_pole lorerev_ed_sec">');
    const $content = $('<textarea class="text_pole lorerev_ed_text" spellcheck="true">');
    const $stats = $el('div', 'lorerev_dim lorerev_ed_stats');
    const $draft = $el('details', 'lorerev_ed_draft').hide();
    $root.append($title, $meta, $tools, $msg,
        $el('div', 'lorerev_ed_keyrow').append(
            $el('label', '', 'Keys (comma separated; /regex/ allowed)').append($keys),
            $el('label', '', 'Secondary keys').append($sec)),
        $el('label', 'lorerev_ed_text_label', 'Content'), $content, $stats, $draft);

    const form = () => ({ keys: String($keys.val()), secondary: String($sec.val()), content: String($content.val()) });
    const dirty = () => formDirty(initial, form());
    const refresh = () => {
        $dirty.text(dirty() ? 'Unsaved changes' : '').toggleClass('lorerev_ed_dirty_on', dirty());
        $stats.text(textStats($content.val()));
    };
    const showMsg = (text, kind = 'warn') => { $msg.removeClass('lorerev_warn lorerev_ok_line').addClass(kind === 'ok' ? 'lorerev_ok_line' : 'lorerev_warn').text(text).show(); };
    function fill() {
        $title.text(info.title);
        $meta.text(`Entry #${info.uid} in “${book}”${info.disabled ? ' · disabled in the lorebook' : ''} · No model is used here: what you save goes straight into the lorebook, and the previous version is kept in History.`);
        $keys.val(initial.keys); $sec.val(initial.secondary); $content.val(initial.content);
        refresh();
    }
    $root.on('input', 'input, textarea', refresh);
    fill();

    /** Loads the entry's current version. What was typed (if anything) is kept in a box below, to copy from. */
    async function reload({ ask = true } = {}) {
        if (busy) return false;
        const typed = form();
        const hadEdits = dirty();
        if (ask && hadEdits && !(await confirm('Reload from the lorebook?', 'The boxes get the entry\'s current keys and text. What you typed is not lost: it stays in a box below the editor so you can copy it back in.', 'Reload', 'Cancel'))) return false;
        const fresh = await readEntryForEdit(book, uid);
        if (fresh.error) { showMsg(`Can't reload: ${fresh.error}.`); return false; }
        info = fresh; base = fresh.version; initial = formFromVersion(base);
        fill();
        if (hadEdits) {
            $draft.empty().append($el('summary', '', 'Your unsaved text from before the reload (copy what you need)'),
                $el('label', '', 'Keys'), $('<input type="text" class="text_pole" readonly>').val(typed.keys),
                $el('label', '', 'Secondary keys'), $('<input type="text" class="text_pole" readonly>').val(typed.secondary),
                $el('label', '', 'Content'), $('<textarea class="text_pole lorerev_ed_draft_text" readonly>').val(typed.content)).attr('open', '').show();
        }
        showMsg('Loaded the current keys and text from the lorebook.', 'ok');
        return true;
    }
    $tools.find('.lorerev_ed_reload').on('click', () => reload());
    $tools.find('.lorerev_ed_hist').on('click', async () => {
        let restored = false;
        await openHistory({ book, uid, onRestore: () => { restored = true; onSaved?.(); } });
        if (!restored) return;
        // the entry changed under the editor: take the restored version when nothing was typed, else say so
        if (!dirty()) await reload({ ask: false });
        else showMsg('The entry was restored from History while you had unsaved changes here. Saving now would be refused; press "Reload from lorebook" to load the restored text (what you typed is kept below).');
    });

    async function save() {
        if (busy) return false;
        const { version, changed } = buildManualVersion(base, initial, form(), splitKeywordsAndRegexes);
        if (!changed.length) {
            if (dirty()) toastr.info('Nothing to save: the keys and text are the same as in the lorebook.', 'LoreReviser');
            return true; // nothing changed: just close
        }
        busy = true;
        $root.addClass('lorerev_ed_busy');
        showMsg('Saving…', 'ok');
        try {
            const res = await saveManualEdit(book, uid, base, version, { changed });
            if (res.written) {
                saved = true;
                toastr.success(`${res.message} Changed: ${describeChanged(changed)}.`, 'LoreReviser');
                onSaved?.();
                return true;
            }
            if (res.unchanged) { toastr.info(res.message, 'LoreReviser'); return true; }
            showMsg(res.message);
            if (res.stale) $tools.find('.lorerev_ed_reload').addClass('lorerev_ed_attention');
            toastr.warning(res.message, 'LoreReviser', { timeOut: 10000 });
            return false;
        } finally {
            busy = false;
            $root.removeClass('lorerev_ed_busy');
        }
    }

    const popup = new Popup($root, POPUP_TYPE.TEXT, '', {
        wide: true, large: true, okButton: 'Save', cancelButton: 'Cancel', allowVerticalScrolling: false,
        onOpen: () => { $content.trigger('focus'); $content[0].setSelectionRange(0, 0); $content.scrollTop(0); },
        onClosing: async (p) => {
            if (busy) return false;
            if (p.result === POPUP_RESULT.AFFIRMATIVE) return save();
            if (!dirty()) return true;
            return confirm('Discard your changes?', 'You changed this entry but did not save. If you close now, nothing is written to the lorebook.', 'Discard', 'Keep editing');
        },
    });
    popup.dlg.classList.add('lorerev_entry_popup');
    await popup.show();
    return saved;
}
