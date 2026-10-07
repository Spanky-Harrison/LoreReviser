// Review UI: draws one revision session in the chat window as a list of per-entry cards.
// Each card: Approve / Reject / Edit / Regenerate, plus swipe-style paging between attempts. On a revision card "Edit proposal"
// edits only the changed (green) parts and the keys; "Edit full entry" opens the whole text.
// New-entry sessions (session.kind === 'create', see create.js) use the same cards: the "Old" side is empty, the edit
// form has a Title, Approve creates the entry and Undo removes it again.
// All state lives on the session/item objects (see revision.js), so a card can be re-drawn at any time.

import { splitKeywordsAndRegexes } from '../../../world-info.js';
import { integrityWarnings, sameAsOriginal } from './parse.js';
import { $el, keyChips, contentView } from './views.js';
import { proposalHunks, applyHunkEdits } from './diff.js';
import { openHistory } from './history.js';
import { applyApproval, undoApproval, applyCreate, undoCreate } from './apply.js';
import { regenerateCreateItem } from './create.js';
import { proposalWarnings, proposalLabel } from './create-core.js';
import { INTENSITIES } from './intensity.js';
import { CHANGE_TYPES } from './changetype.js';
import { regenerateItem, retryMissing, describeEnd, describeError, runState } from './revision.js';
import { failureReason } from './passages.js';

const currentAttempt = (item) => item.attempts[item.index];

/**
 * @param {object} session
 * @param {{ onChange?: () => void, refresh?: () => void, booksChanged?: () => void }} [hooks] refresh: redraw the open modal (used when async work finishes after a close/reopen);
 *        booksChanged: an entry was created or removed (the modal re-reads its lorebook list)
 * @returns {JQuery} the session element
 */
export function renderSession(session, hooks = {}) {
    const isCreate = session.kind === 'create';
    const $root = $el('div', `lorerev_session${isCreate ? ' lorerev_session_create' : ''}`);
    const $head = $el('div', 'lorerev_session_head');
    const $notes = $el('div', 'lorerev_session_notes');
    const $cards = $el('div', 'lorerev_cards');

    // ----- header and warnings -----
    function drawHead() {
        const count = (s) => session.items.filter(i => i.status === s).length;
        if (isCreate) {
            const bits = [`${session.items.length} proposed`];
            if (count('approved')) bits.push(`${count('approved')} approved`);
            if (count('rejected')) bits.push(`${count('rejected')} rejected`);
            $head.empty().append($el('b', '', 'New entries'), $el('span', 'lorerev_dim', ` · ${session.profile.name} · into “${session.book}” · ${bits.join(' · ')}`));
            return;
        }
        const parts = [`${session.items.length} sent`, `${count('proposed') + count('approved') + count('rejected')} changed`, `${count('unchanged')} no changes`];
        if (count('failed')) parts.push(`${count('failed')} couldn't be applied`);
        if (count('missing')) parts.push(`${count('missing')} not returned`);
        if (session.replyStyle === 'passages') parts.push('changed passages only');
        if (count('approved')) parts.push(`${count('approved')} approved`);
        if (count('rejected')) parts.push(`${count('rejected')} rejected`);
        $head.empty().append($el('b', '', `Revision`), $el('span', 'lorerev_dim', ` · ${session.profile.name} · ${parts.join(' · ')}`));
    }
    function drawNotes() {
        $notes.empty();
        const p = session.parse;
        if (isCreate) {
            $notes.append($el('div', 'lorerev_dim lorerev_create_settings', session.copyFrom
                ? `Settings for the new entries: copied from “${session.copyFrom.title}” (#${session.copyFrom.uid}) when you approve (everything except content, title and keys)${session.example ? '; its text was also sent as a format example' : ''}.`
                : 'Settings for the new entries: SillyTavern\'s defaults.'));
            if (!session.items.length) $notes.append($el('div', 'lorerev_note lorerev_create_none', 'The model did not propose any new entries (it answered with an empty list). Rephrase your request and send again.'));
            if (p?.truncated) $notes.append($el('div', 'lorerev_warn', `The reply was cut off (${p.info ? describeEnd(p.info, session.maxTokens) : `${session.maxTokens} tokens allowed`}). ${p.recovered} complete entr${p.recovered === 1 ? 'y was' : 'ies were'} recovered; anything after that is lost. Raise "Reply tokens" and send again if entries are missing.`));
            if (p?.skipped) $notes.append($el('div', 'lorerev_warn', `${p.skipped} part(s) of the reply were not valid JSON and could not be read (see "Raw reply").`));
            if (p?.dropped) $notes.append($el('div', 'lorerev_warn', `${p.dropped} proposed entr${p.dropped === 1 ? 'y had' : 'ies had'} neither content nor keys and ${p.dropped === 1 ? 'was' : 'were'} left out.`));
            if (p?.repaired && !p.error) $notes.append($el('div', 'lorerev_dim', 'The model\'s JSON had formatting slips (raw line breaks or unescaped quotes); they were fixed automatically. Check that the text looks right.'));
            return;
        }
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
            if (!$root[0].isConnected) hooks.refresh?.();
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
        const created = item.kind === 'create';
        item.ui ??= { view: created ? 'new' : 'changes', editing: false, regenText: '', collapsed: false };
        if (created && currentAttempt(item)) item.title = proposalLabel(currentAttempt(item));
        const ui = item.ui;
        const $card = $el('div', `lorerev_card lorerev_status_${item.status}`).attr('data-id', item.id);
        // Collapsible: the header line (chevron, title, book, status) toggles. ui.collapsed lives on the item, so it survives redraws and reopening.
        const canCollapse = item.status !== 'loading';
        const collapsed = canCollapse && !!ui.collapsed;
        const title = $el('div', `lorerev_card_title${canCollapse ? ' lorerev_card_toggle' : ''}`).append(
            canCollapse ? $el('span', `lorerev_collapse fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}`).attr('title', collapsed ? 'Show this card' : 'Hide the details of this card') : '',
            $el('b', '', item.title), $el('span', 'lorerev_dim', created ? ` ${item.book} · new entry${item.uid !== null && item.uid !== undefined ? ` #${item.uid}` : ''}` : ` ${item.book} · ${item.id}`),
            created ? $el('span', 'lorerev_pill lorerev_pill_new', 'New entry') : '',
            $el('span', `lorerev_pill lorerev_pill_${item.status}`, ({
                proposed: 'Proposed', unchanged: 'No changes', missing: 'Not returned', failed: "Couldn't apply", loading: 'Regenerating…', approved: 'Approved', rejected: 'Rejected',
            })[item.status]));
        $card.append(title);
        if (canCollapse) title.on('click', () => { ui.collapsed = !ui.collapsed; rerender(item); });
        if (collapsed) {
            $card.addClass('lorerev_card_folded');
            if (item.attempts[item.index]?.edited) title.find('.lorerev_pill').last().after($el('span', 'lorerev_pill lorerev_pill_edited', 'Edited by you'));
            return $card;
        }
        if (item.error) $card.append($el('div', 'lorerev_error_line', item.error));
        if (item.notice) $card.append($el('div', 'lorerev_ok_line', item.notice));

        // --- states without a proposal to show ---
        if (item.status === 'loading') {
            $card.append($el('div', 'lorerev_dim', 'Waiting for the model…'),
                $el('div', 'menu_button', 'Cancel').on('click', () => item.abort?.abort()));
            return $card;
        }
        if (item.status === 'failed') {
            // "Changed passages only": the model's edits could not be placed. Nothing was applied; say which passages, and offer a full rewrite.
            $card.append(placeErrorBox(item));
            $card.append(ui.editing ? editForm(item, null) : $('<div>').append(buttonsRow(item, ['edit', 'history']), regenBox(item)));
            return $card;
        }
        if (item.status === 'unchanged' || item.status === 'missing') {
            $card.append($el('div', 'lorerev_dim', item.status === 'missing'
                ? (item.missingNote ?? 'The model did not return this entry and the reply was damaged, so it is unknown whether it needs changes.')
                : 'The model left this entry as it is.'));
            $card.append(ui.editing ? editForm(item, null) : $('<div>').append(buttonsRow(item, ['edit', 'history']), regenBox(item)));
            return $card;
        }

        const attempt = currentAttempt(item);
        if (attempt?.edited) title.find('.lorerev_pill').last().after($el('span', 'lorerev_pill lorerev_pill_edited', 'Edited by you'));

        // --- proposed / approved / rejected: pager (proposed only), note, warnings, keys, content ---
        if (item.attempts.length > 1) {
            // Swipe-style pager, like ST's swipe arrows. Locked while approved (Undo first) so the approved text can't shift.
            const locked = item.status === 'approved';
            const go = (d) => { if (locked) return; item.index = (item.index + d + item.attempts.length) % item.attempts.length; rerender(item); };
            const pager = $el('div', `lorerev_pager${locked ? ' lorerev_pager_locked' : ''}`).append(
                $el('div', 'lorerev_swipe fa-solid fa-chevron-left').attr('title', locked ? 'Undo the approval to switch attempts' : 'Previous attempt').on('click', () => go(-1)),
                $el('span', 'lorerev_swipe_count', `${item.index + 1}/${item.attempts.length}`),
                $el('div', 'lorerev_swipe fa-solid fa-chevron-right').attr('title', locked ? 'Undo the approval to switch attempts' : 'Next attempt').on('click', () => go(1)));
            $card.append(pager);
        }
        if (item.status === 'approved') $card.append($el('div', 'lorerev_ok_line', item.applyMessage ?? 'Approved.'));
        if (item.reapprove) {
            $card.append($el('div', 'lorerev_warn', item.written
                ? 'You edited this after approving it. Approve it again to save your edited version. Until then the lorebook keeps the version you approved before (Reject puts the original back).'
                : 'You edited this after approving it. Approve it again to confirm your edited version.'));
        }
        if (item.placeError && ['proposed', 'rejected'].includes(item.status)) $card.append(placeErrorBox(item)); // the latest regeneration's edits did not fit; earlier attempts stay
        if (attempt.note) $card.append($el('div', 'lorerev_note', attempt.note));
        if (attempt.request || attempt.intensity || attempt.changeType) {
            $card.append($el('div', 'lorerev_dim lorerev_attempt_info').append(
                attempt.intensity ? $el('span', '', `Rewrite intensity: ${INTENSITIES[attempt.intensity]?.label ?? attempt.intensity}. `) : '',
                attempt.changeType ? $el('span', '', `Change type: ${CHANGE_TYPES[attempt.changeType]?.label ?? attempt.changeType}. `) : '',
                attempt.replyStyle ? $el('span', 'lorerev_style_info', `${replyStyleInfo(attempt)} `) : '',
                attempt.request ? $el('span', 'lorerev_request', `Your request for this attempt: “${attempt.request}”`) : ''));
        }
        for (const w of created ? proposalWarnings(attempt, session.existing ?? []) : integrityWarnings(item.original, attempt)) $card.append($el('div', 'lorerev_warn', w));

        if (ui.editing) { $card.append(ui.editing === 'proposal' && !created ? proposalForm(item, attempt) : editForm(item, attempt)); return $card; }

        if (created) $card.append($el('div', 'lorerev_keys lorerev_new_title').append($el('span', 'lorerev_dim', 'Title: '), attempt.title ? $el('b', '', attempt.title) : $el('span', 'lorerev_dim', '(none)')));
        $card.append(keyChips('Keys', item.original.keys, attempt.keys));
        if (item.original.secondary.length || attempt.secondary.length) $card.append(keyChips('Secondary keys', item.original.secondary, attempt.secondary));
        $card.append(viewToggle(item), contentView(item, attempt, ui.view));
        if (item.saving) { $card.append($el('div', 'lorerev_dim lorerev_saving', 'Saving…')); return $card; }
        $card.append(buttonsRow(item, ({
            proposed: ['approve', 'reject', 'edit', 'history'], approved: ['undo', 'edit', 'history'], rejected: ['undo', 'edit', 'history'],
        })[item.status]));
        if (item.status !== 'approved') $card.append(regenBox(item)); // approved cards: Undo first, then regenerate
        return $card;
    }

    /** "Reply: 2 changed passages." / "Reply: full rewrite." for the attempt info line. */
    function replyStyleInfo(a) {
        if (a.replyStyle === 'passages' && a.source === 'edits') return `Reply: ${a.editCount} changed passage${a.editCount === 1 ? '' : 's'}, put into the full text.`;
        if (a.replyStyle === 'passages' && a.source === 'content') return 'Reply: the model sent the whole text instead of passages.';
        if (a.replyStyle === 'passages') return 'Reply: keys only.';
        return 'Reply: full rewrite.';
    }

    /**
     * The red box for passage edits that could not be placed: which passages, why, and the way out
     * ("Retry this entry as a full rewrite"; Regenerate and Edit are on the card as usual).
     */
    function placeErrorBox(item) {
        const pe = item.placeError;
        const n = pe.failures.length, total = pe.total || n;
        const $box = $el('div', 'lorerev_place_error');
        $box.append($el('div', 'lorerev_place_error_head', item.status === 'failed'
            ? `The model's changes could not be applied: ${n} of its ${total} passage edit${total === 1 ? '' : 's'} could not be placed in the entry, so nothing was changed (no partial edits).`
            : `The last regeneration could not be applied: ${n} of its ${total} passage edit${total === 1 ? '' : 's'} could not be placed in the entry, so no new attempt was added. The attempts below are unchanged.`));
        const $list = $el('ul', 'lorerev_place_list');
        for (const f of pe.failures) {
            $list.append($el('li', '').append(
                $el('span', 'lorerev_dim', `Edit ${f.index + 1}${f.kind === 'after' ? ' (insert after)' : f.kind === 'before' ? ' (insert before)' : ''}: `),
                $el('q', 'lorerev_place_passage', String(f.anchor ?? '').length > 300 ? `${String(f.anchor).slice(0, 300)}…` : String(f.anchor ?? '')),
                $el('span', 'lorerev_place_reason', ` – ${failureReason(f)}`)));
        }
        $box.append($list);
        if (pe.note) $box.append($el('div', 'lorerev_dim', `The model's note: ${pe.note}`));
        $box.append($el('div', 'lorerev_dim', 'Retry it as a full rewrite (one request for this entry that asks for the whole text), Regenerate to ask for passage edits again, or write the change yourself with Edit. The model\'s reply is under "Raw reply".'));
        $box.append($el('div', 'lorerev_buttons').append(
            $el('div', 'menu_button lorerev_btn_fullretry', 'Retry this entry as a full rewrite').attr('title', 'Ask the model again for just this entry, this time for its complete new text (uses the Full rewrite reply rules)').on('click', () => regen(item, { style: 'full' }))));
        return $box;
    }

    function viewToggle(item) {
        const views = $el('div', 'lorerev_views');
        for (const [v, label] of [['changes', 'Changes'], ['compare', 'Full Compare'], ['new', 'New'], ['old', 'Old']]) {
            views.append($el('span', `lorerev_view${item.ui.view === v ? ' lorerev_view_on' : ''}`, label).on('click', () => { item.ui.view = v; rerender(item); }));
        }
        return views;
    }

    /** After a saved edit: back to "Proposed" (an approved card needs approving again). */
    function afterEdit(item) {
        if (item.status === 'approved') item.reapprove = true;
        item.status = 'proposed'; item.applyMessage = null; item.notice = null; item.placeError = null; item.ui.editing = false; item.ui.draft = null; rerender(item);
    }

    /**
     * Writes an edit into the pending proposal (the attempt on screen), so what was in the boxes is exactly what Approve
     * will hand to the writer later. For entries the model left unchanged (attempt = null) it creates a proposal written by you.
     * @param {{title?: string, keys: string[], secondary: string[], content: string}} v
     */
    function commitEdit(item, attempt, v) {
        const created = item.kind === 'create';
        const sameAs = (a, b) => sameAsOriginal(a, b) && (!created || (a.title ?? '') === (b.title ?? ''));
        if (!attempt) {
            if (sameAsOriginal(item.original, v)) { toastr.info('Nothing was changed.', 'LoreReviser'); item.ui.editing = false; item.ui.draft = null; return rerender(item); }
            item.attempts.push({ ...v, note: item.status === 'failed' ? 'Written by you: the model\'s changes could not be applied.' : 'Written by you: the model had left this entry unchanged.', edited: true, manual: true });
            item.index = item.attempts.length - 1;
        } else {
            // remember what the model wrote so the edit can be undone
            if (!attempt.modelVersion && !attempt.manual) attempt.modelVersion = { ...(created ? { title: attempt.title } : {}), keys: [...attempt.keys], secondary: [...attempt.secondary], content: attempt.content };
            Object.assign(attempt, v);
            const mv = attempt.modelVersion;
            attempt.edited = attempt.manual || !(mv && sameAs(mv, v));
        }
        afterEdit(item);
    }

    /** "Save edit", "Cancel" and (when there is a model version) "Reset to the model's version". */
    function editButtons(item, attempt, read, extra = []) {
        const buttons = $el('div', 'lorerev_buttons');
        buttons.append($el('div', 'menu_button lorerev_btn_save', 'Save edit').on('click', () => commitEdit(item, attempt, read())),
            $el('div', 'menu_button', 'Cancel').on('click', () => { item.ui.editing = false; item.ui.draft = null; rerender(item); }), ...extra);
        if (attempt?.modelVersion) buttons.append($el('div', 'menu_button lorerev_btn_reset', "Reset to the model's version").on('click', () => {
            Object.assign(attempt, structuredClone(attempt.modelVersion), { edited: false }); delete attempt.modelVersion; afterEdit(item);
        }));
        return buttons;
    }

    const keyInputs = (base) => ({
        keys: $('<input type="text" class="text_pole lorerev_ed_keys">').val(base.keys.join(', ')),
        sec: $('<input type="text" class="text_pole lorerev_ed_sec">').val(base.secondary.join(', ')),
    });

    /**
     * Full editor ("Edit full entry"; plain "Edit" on new-entry and "No changes" cards): title (new entries), keys and the
     * whole text. Works in every state: after Approve/Reject the card goes back to "Proposed" and needs approving again.
     */
    function editForm(item, attempt) {
        const base = item.ui.draft ?? attempt ?? item.original; // draft = what was typed in "Edit proposal" before switching here
        const created = item.kind === 'create';
        const $f = $el('div', 'lorerev_edit lorerev_edit_full');
        const titleBox = created ? $('<input type="text" class="text_pole lorerev_ed_title">').val(base.title ?? '') : null;
        if (created) $f.append($el('label', '', 'Title'), titleBox);
        const { keys, sec } = keyInputs(base);
        const content = $('<textarea class="text_pole lorerev_ed_content" rows="12">').val(base.content);
        $f.append($el('label', '', 'Keys (comma separated; /regex/ allowed)'), keys, $el('label', '', 'Secondary keys'), sec,
            $el('label', '', 'Content: exactly this text is what will be saved when you approve'), content);
        const read = () => ({ ...(created ? { title: String(titleBox.val()).trim() } : {}), keys: splitKeywordsAndRegexes(String(keys.val())), secondary: splitKeywordsAndRegexes(String(sec.val())), content: String(content.val()) });
        return $f.append(editButtons(item, attempt, read));
    }

    /**
     * "Edit proposal" (the default Edit on a revision card): the keys plus one box per changed part of the text, filled
     * with the proposed (green) text, with the removed old text above it for reference. Unchanged text is shown dimmed
     * and is kept exactly as it is; saving puts the edited parts back in place (diff.js applyHunkEdits).
     */
    function proposalForm(item, attempt) {
        const segs = proposalHunks(item.original.content, attempt.content);
        const $f = $el('div', 'lorerev_edit lorerev_edit_proposal');
        const { keys, sec } = keyInputs(attempt);
        $f.append($el('label', '', 'Keys (comma separated; /regex/ allowed)'), keys, $el('label', '', 'Secondary keys'), sec);
        const boxes = new Map();
        const $parts = $el('div', 'lorerev_hunks');
        segs.forEach((seg, k) => {
            if (seg.type === 'same') {
                const full = seg.text.trim();
                if (!full) return;
                const $s = $el('div', 'lorerev_blk lorerev_blk_same lorerev_hunk_same');
                if (full.length > 240) {
                    $s.text(`${full.slice(0, 100)} … ${full.slice(-100)}`).addClass('lorerev_hunk_more').attr('title', 'Unchanged text (click to show all of it)')
                        .one('click', () => $s.text(full).removeClass('lorerev_hunk_more').removeAttr('title'));
                } else $s.text(full);
                $parts.append($s);
                return;
            }
            const $h = $el('div', 'lorerev_hunk');
            if (seg.old) $h.append($el('div', 'lorerev_blk lorerev_blk_del', seg.old).attr('data-mark', 'Removed'));
            const rows = Math.min(10, Math.max(2, seg.core.split('\n').length + Math.floor(seg.core.length / 90)));
            const box = $(`<textarea class="text_pole lorerev_ed_hunk" rows="${rows}">`).val(seg.core)
                .attr('placeholder', seg.core ? '' : 'Nothing is added here (the old text above is removed). Type to put text at this spot.');
            boxes.set(k, box);
            $h.append(box);
            if (seg.old) $h.append($el('div', 'lorerev_hunk_tools').append(
                $el('div', 'menu_button lorerev_btn_mini lorerev_btn_hunk_old', 'Use old text').attr('title', 'Put the removed old text back in this box').on('click', () => box.val(seg.old).trigger('focus'))));
            $parts.append($h);
        });
        $f.append($el('label', '', boxes.size ? 'Proposed changes: edit the green text. The dimmed text is unchanged and stays exactly as it is.' : 'Text'));
        if (!boxes.size) $parts.append($el('div', 'lorerev_dim', 'The text is unchanged (only keys differ). Use "Edit full entry" to change the text.'));
        $f.append($parts);
        const read = () => {
            const edits = {};
            for (const [k, box] of boxes) edits[k] = String(box.val());
            return { keys: splitKeywordsAndRegexes(String(keys.val())), secondary: splitKeywordsAndRegexes(String(sec.val())), content: applyHunkEdits(segs, edits) };
        };
        const toFull = $el('div', 'menu_button lorerev_btn_edit_full', 'Edit full entry').attr('title', 'Edit the whole entry text instead (keeps what you typed here)')
            .on('click', () => { item.ui.draft = read(); item.ui.editing = 'full'; rerender(item); });
        $f.append(editButtons(item, attempt, read, [toFull]));
        setTimeout(() => $f.find('.lorerev_ed_hunk').first().trigger('focus'), 0);
        return $f;
    }

    function buttonsRow(item, which) {
        const ui = item.ui;
        const row = $el('div', 'lorerev_buttons');
        const btn = (label, cls, fn) => row.append($el('div', `menu_button ${cls ?? ''}`, label).on('click', fn));
        if (which.includes('approve')) btn('Approve', 'lorerev_btn_ok', async () => {
            // Writes to the lorebook (apply.js). If it can't (entry changed meanwhile, book gone...), the card stays Proposed with the reason.
            const attempt = currentAttempt(item);
            const wasReapprove = item.reapprove;
            Object.assign(item, { status: 'approved', approvedAttempt: item.index, reapprove: false, error: null, notice: null, saving: true, applyMessage: null });
            rerender(item);
            const res = await (item.kind === 'create' ? applyCreate : applyApproval)(item, attempt, { instructions: session.instruction });
            item.saving = false;
            if (res.written) { item.applyMessage = res.message; ui.collapsed = true; if (item.kind === 'create') hooks.booksChanged?.(); } // approved cards fold away; click the header to look again
            else {
                Object.assign(item, { status: 'proposed', reapprove: wasReapprove, error: res.message });
                ui.collapsed = false;
                toastr.warning(res.message, 'LoreReviser', { timeOut: 10000 });
            }
            afterAsync(item);
        });
        if (which.includes('reject')) btn('Reject', 'lorerev_btn_no', async () => {
            // A card edited after a saved approval: rejecting means "not this change", so the original goes back too.
            if (item.written && !(await revert(item))) return;
            item.status = 'rejected'; item.reapprove = false; item.error = null; rerender(item);
        });
        if (which.includes('edit')) {
            // A revision card with a proposal: "Edit proposal" (just the changed parts and the keys) is the main one; the
            // whole text is one click further. New-entry and "No changes" cards have only the full editor.
            const hasProposal = item.kind !== 'create' && ['proposed', 'approved', 'rejected'].includes(item.status) && !!currentAttempt(item);
            if (hasProposal) {
                btn('Edit proposal', 'lorerev_btn_edit', () => { ui.editing = 'proposal'; ui.draft = null; rerender(item); });
                row.find('.lorerev_btn_edit').attr('title', 'Edit the proposed (green) changes and the keys');
                btn('Edit full entry', 'lorerev_btn_edit_full', () => { ui.editing = 'full'; ui.draft = null; rerender(item); });
                row.find('.lorerev_btn_edit_full').attr('title', 'Edit the whole entry text');
            } else btn('Edit', 'lorerev_btn_edit', () => { ui.editing = 'full'; ui.draft = null; rerender(item); });
        }
        if (which.includes('undo')) btn('Undo', '', async () => {
            if (item.status === 'approved' && item.written && !(await revert(item))) return;
            if (item.status !== 'approved') item.notice = null;
            item.status = 'proposed'; item.reapprove = false; item.applyMessage = null; item.error = null; ui.collapsed = false; afterAsync(item);
        });
        if (which.includes('history')) btn('History', 'lorerev_btn_hist', () => openHistory({ book: item.book, uid: item.uid ?? null, onRestore: hooks.booksChanged })).find('.lorerev_btn_hist').attr('title', 'Earlier saved versions of this entry');
        return row;
    }

    /** Puts the version from before the approval back into the lorebook. Returns false (and shows why) if that wasn't possible. */
    async function revert(item) {
        item.saving = true; item.error = null; rerender(item);
        const res = await (item.kind === 'create' ? undoCreate : undoApproval)(item);
        item.saving = false;
        if (res.reverted && item.kind === 'create') hooks.booksChanged?.();
        if (!res.reverted) {
            item.error = res.message; item.ui.collapsed = false; // show why
            toastr.warning(res.message, 'LoreReviser', { timeOut: 10000 });
            afterAsync(item);
            return false;
        }
        item.notice = res.message || null;
        return true;
    }
    /** Redraws a card after awaited work; if the modal was closed/reopened meanwhile, redraws the new modal instead. */
    function afterAsync(item) {
        rerender(item);
        if (!$root[0].isConnected) hooks.refresh?.();
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

    /**
     * Runs a regeneration for one entry (one request at a time). opts.style = 'full' is "Retry this entry as a full rewrite".
     * If the reply's passage edits can't be placed, no attempt is added: the card keeps its attempts (or shows "Couldn't apply").
     */
    async function regen(item, opts = {}) {
        if (runState.busy) { toastr.warning('Another request is still running.', 'LoreReviser'); return; }
        const note = item.ui.regenText;
        const before = item.status;
        runState.busy = true; item.abort = new AbortController();
        item.status = 'loading'; item.error = null; rerender(item);
        try {
            const res = await (item.kind === 'create' ? regenerateCreateItem : regenerateItem)(session, item, note, item.abort.signal, opts);
            if (res && res.placed === false) {
                item.status = item.attempts.length ? before : 'failed'; // earlier attempts stay as they were
                toastr.warning('The model\'s passage edits could not be placed in the entry, so nothing was applied. See the card.', 'LoreReviser', { timeOut: 8000 });
            } else item.ui.regenText = ''; // consumed: it now lives on the new attempt
        } catch (e) {
            item.status = before;
            item.error = item.abort.signal.aborted ? 'Regeneration cancelled.' : `Regeneration failed: ${describeError(e)}`;
            if (!item.abort.signal.aborted) toastr.error(item.error, 'LoreReviser');
        } finally {
            runState.busy = false; item.abort = null;
            rerender(item); drawNotes();
            if (!$root[0].isConnected) hooks.refresh?.(); // modal was closed/reopened meanwhile
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
