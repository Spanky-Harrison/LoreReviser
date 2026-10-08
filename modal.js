// The LoreReviser modal: profile + system prompt settings, linked-lorebook sidebar, chat-style window.
// Send builds one prompt (prompt.js), sends it on the chosen profile (revision.js) and shows the proposed
// changes as review cards (review.js). Approving writes to the lorebook and archives the old version (apply.js,
// archive.js); History (history.js) shows saved versions with Restore. Orphaned history files can be relinked here.
// "New entries" mode (create.js) asks the model for new entries in a chosen lorebook and shows them as the same review cards.
// The pencil next to each sidebar entry opens it in the direct editor (entry-editor.js): read and edit by hand, no model.

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { getLinkedBooks } from './lorebooks.js';
import { MODULE_NAME, getSettings, DEFAULT_SYSTEM_PROMPT } from './settings.js';
import { prepareSession, sendSession, runState, describeError } from './revision.js';
import { renderSession } from './review.js';
import { normalizeDepth, depthLabel } from './depth.js';
import { INTENSITIES, normalizeIntensity } from './intensity.js';
import { CHANGE_TYPES, normalizeChangeType } from './changetype.js';
import { budgetNote } from './budget.js';
import { DEFAULT_FORMAT_RULES, checkFormatRules, FORMAT_RULES_NOTE, DEFAULT_PASSAGE_RULES, checkPassageRules, PASSAGE_RULES_NOTE, REPLY_STYLES, normalizeReplyStyle, checkRulesForStyle } from './rules.js';
import { openHistory, openHistoryPicker } from './history.js';
import { getArchiveIndex, relinkArchive, readArchive } from './archive.js';
import { deleteOrphanHistory } from './apply.js';
import { findOrphans } from './archive-core.js';
import { prepareCreateSession, sendCreateSession, loadBookEntries } from './create.js';
import { DEFAULT_CREATE_SYSTEM_PROMPT, DEFAULT_CREATE_FORMAT_RULES, checkCreateRules, CREATE_RULES_NOTE } from './create-core.js';
import { openEntryEditor } from './entry-editor.js';

/** Conversation shown in the chat window. Kept while the page is open; cleared when the chat changes. */
let conversation = [];
/** Redraws the chat window of the currently open modal (set by openModal; async work finishes after the modal may be closed). */
let redraw = () => {};
/** Aborts the running Send request, if any. */
let abortSend = null;
/** 'revise' (selected entries) or 'create' (new entries). Kept while the page is open. */
let mode = 'revise';
/** Last "Copy settings from" choice: { book, uid } (uid null = SillyTavern defaults). */
let createCopy = { book: '', uid: null };
/** "Also send its text as a format example" checkbox. */
let createUseExample = true;
SillyTavern.getContext().eventSource.on(SillyTavern.getContext().eventTypes.CHAT_CHANGED, () => { conversation = []; });

// ---------- selection (which books/entries are ticked), saved per chat in chat metadata ----------

/** Map: book name -> Set of selected entry uids. */
function loadSelection() {
    const saved = SillyTavern.getContext().chatMetadata?.[MODULE_NAME]?.selection ?? {};
    return new Map(Object.entries(saved).map(([book, uids]) => [book, new Set(uids)]));
}

function saveSelection(selection) {
    const ctx = SillyTavern.getContext();
    const obj = {};
    for (const [book, uids] of selection) if (uids.size) obj[book] = [...uids];
    ctx.chatMetadata[MODULE_NAME] = { selection: obj };
    ctx.saveMetadataDebounced();
}

// ---------- small helpers ----------

/** Fills the profile dropdown from Connection Manager. Built by hand (ST's helper adds event listeners on every call). */
function fillProfileSelect($select, selectedId) {
    const { ConnectionManagerRequestService } = SillyTavern.getContext();
    $select.empty().append($('<option value="">Select a Connection Profile</option>'));
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles()
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const p of profiles) $select.append($('<option>').val(p.id).text(p.name));
        $select.val(profiles.some(p => p.id === selectedId) ? selectedId : '');
    } catch (e) {
        // Connection Manager extension is disabled or missing
        $select.empty().append($('<option value="">Connection Manager is not available</option>')).prop('disabled', true);
    }
}

// ---------- modal ----------

const TEMPLATE = `
<div class="lorerev_root">
    <div class="lorerev_header">
        <h3>LoreReviser</h3>
        <label>Profile <select id="lorerev_profile" class="text_pole"></select></label>
        <label title="How much the model may rewrite. Light touch: only what must change, everything else verbatim. Balanced: a little liberty, same essence. Heavy-handed: rewrite sections as needed to fit the narrative.">Rewrite
            <select id="lorerev_intensity" class="text_pole">${Object.entries(INTENSITIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
        <label title="What kind of change this is. Development: a progression in the story, the lore may describe before/after and what changed. Retcon: the existing reality is corrected and must be written as though it was always true, without acknowledging any change.">Change
            <select id="lorerev_changetype" class="text_pole">${Object.entries(CHANGE_TYPES).map(([k, v]) => `<option value="${k}" title="${v.title}">${v.label}</option>`).join('')}</select></label>
        <label class="lorerev_revise_only" title="How the model answers when revising existing entries. Changed passages only: it sends just the passages it changes (find / replace) and LoreReviser puts them into the full text, so replies are much shorter. Full rewrite: it sends the whole new text of every changed entry. New entries are always written in full.">Reply style
            <select id="lorerev_replystyle" class="text_pole">${Object.entries(REPLY_STYLES).map(([k, v]) => `<option value="${k}" title="${v.title}">${v.label}</option>`).join('')}</select></label>
        <label title="Send only the last X chat messages. 0 = whole chat. -1 = no chat at all.">Depth
            <input id="lorerev_depth" type="number" min="-1" step="1" class="text_pole"></label>
        <span id="lorerev_depth_info" class="lorerev_dim"></span>
        <label title="Maximum tokens for the model's reply. 0 = automatic (based on the size of the selected entries and the reply style).">Reply tokens
            <input id="lorerev_reply" type="number" min="0" step="100" class="text_pole"></label>
        <label title="Context size used for the 'prompt may be too large' warning. 0 = take it from the profile's preset.">Context
            <input id="lorerev_context" type="number" min="0" step="1000" class="text_pole"></label>
    </div>
    <div class="lorerev_body">
        <div class="lorerev_sidebar">
            <div class="lorerev_sidebar_title">Linked lorebooks
                <div id="lorerev_top_hist" class="menu_button" title="Open History for a lorebook that has saved changes (works even with an empty chat / no review cards)">History</div>
            </div>
            <div id="lorerev_books"></div>
            <div id="lorerev_orphans"></div>
        </div>
        <div class="lorerev_main">
            <div class="lorerev_prompts">
            <details class="lorerev_system">
                <summary>System prompt <span class="lorerev_edited" id="lorerev_system_edited"></span></summary>
                <textarea id="lorerev_system" class="text_pole" rows="6"></textarea>
                <div class="menu_button lorerev_restore" id="lorerev_system_reset" title="Put the original system prompt back">Restore default</div>
            </details>
            <details class="lorerev_system" id="lorerev_int_box">
                <summary>Rewrite intensity wording <span class="lorerev_edited" id="lorerev_int_edited"></span></summary>
                <div class="lorerev_dim">The text that is added to the system message for the intensity chosen at the top. Each level is edited separately. The heading <code>## Rewrite intensity: &lt;level&gt;</code> is added automatically and stays fixed, so the system prompt's reference to the "Rewrite intensity" section remains valid.</div>
                ${Object.entries(INTENSITIES).map(([k, v]) => `
                <div class="lorerev_part">
                    <div class="lorerev_part_head"><b>${v.label}</b> <span class="lorerev_edited" data-edited="${k}"></span>
                        <div class="menu_button lorerev_restore" data-restore="${k}" title="Put the original ${v.label} wording back">Restore default</div></div>
                    <textarea class="text_pole lorerev_int_text" data-level="${k}" rows="3"></textarea>
                </div>`).join('')}
            </details>
            <details class="lorerev_system" id="lorerev_ct_box">
                <summary>Change type wording <span class="lorerev_edited" id="lorerev_ct_edited"></span></summary>
                <div class="lorerev_dim">The text that is added to the system message, after the rewrite intensity, for the change type chosen at the top (Development or Retcon). Each type is edited separately. The heading <code>## Change type: &lt;type&gt;</code> is added automatically and stays fixed, so the system prompt's reference to the "Change type" section remains valid.</div>
                ${Object.entries(CHANGE_TYPES).map(([k, v]) => `
                <div class="lorerev_part">
                    <div class="lorerev_part_head"><b>${v.label}</b> <span class="lorerev_edited" data-ct-edited="${k}"></span>
                        <div class="menu_button lorerev_restore" data-restore-ct="${k}" title="Put the original ${v.label} wording back">Restore default</div></div>
                    <textarea class="text_pole lorerev_ct_text" data-type="${k}" rows="4"></textarea>
                </div>`).join('')}
            </details>
            <details class="lorerev_system" id="lorerev_rules_box">
                <summary>Reply format rules (advanced) <span class="lorerev_edited" id="lorerev_rules_box_edited"></span></summary>
                <div class="lorerev_dim">Appended to the system message, last. They tell the model how to answer so LoreReviser can read the reply. There is one set per <b>Reply style</b> (chosen at the top); only the set for the chosen style is sent. A warning appears below a set if an edit would break reading the reply.</div>
                <div class="lorerev_part" id="lorerev_prules_part">
                    <div class="lorerev_part_head"><b>Changed passages only</b> <span class="lorerev_edited" id="lorerev_prules_edited"></span>
                        <div class="menu_button lorerev_restore" id="lorerev_prules_reset" title="Put the original rules for “Changed passages only” back">Restore default</div></div>
                    <div class="lorerev_dim">Keep it a JSON array of objects with an <code>id</code> and an <code>edits</code> list of <code>{find, replace}</code>.</div>
                    <div id="lorerev_prules_warn" class="lorerev_rules_warn" style="display:none"></div>
                    <textarea id="lorerev_prules" class="text_pole" rows="10"></textarea>
                </div>
                <div class="lorerev_part" id="lorerev_rules_part">
                    <div class="lorerev_part_head"><b>Full rewrite</b> <span class="lorerev_edited" id="lorerev_rules_edited"></span>
                        <div class="menu_button lorerev_restore" id="lorerev_rules_reset" title="Put the original rules for “Full rewrite” back">Restore default</div></div>
                    <div class="lorerev_dim">Keep it a JSON array of objects with an <code>id</code> and the full <code>content</code>.</div>
                    <div id="lorerev_rules_warn" class="lorerev_rules_warn" style="display:none"></div>
                    <textarea id="lorerev_rules" class="text_pole" rows="10"></textarea>
                </div>
            </details>
            <details class="lorerev_system" id="lorerev_create_box">
                <summary>New entry prompt <span class="lorerev_edited" id="lorerev_create_edited"></span></summary>
                <div class="lorerev_dim">Used instead of the system prompt and reply format rules above when you ask for <b>New entries</b>. The <code>## Change type: &lt;type&gt;</code> section (chosen at the top) is added between them; the rewrite intensity is not used for new entries, because there is no existing text to rewrite.</div>
                <div class="lorerev_part">
                    <div class="lorerev_part_head"><b>System prompt for new entries</b> <span class="lorerev_edited" id="lorerev_create_sys_edited"></span>
                        <div class="menu_button lorerev_restore" id="lorerev_create_sys_reset" title="Put the original new-entry system prompt back">Restore default</div></div>
                    <textarea id="lorerev_create_sys" class="text_pole" rows="6"></textarea>
                </div>
                <div class="lorerev_part">
                    <div class="lorerev_part_head"><b>Reply format rules for new entries (advanced)</b> <span class="lorerev_edited" id="lorerev_create_rules_edited"></span>
                        <div class="menu_button lorerev_restore" id="lorerev_create_rules_reset" title="Put the original new-entry reply format rules back">Restore default</div></div>
                    <div id="lorerev_create_rules_warn" class="lorerev_rules_warn" style="display:none"></div>
                    <textarea id="lorerev_create_rules" class="text_pole" rows="8"></textarea>
                </div>
            </details>
            </div>
            <div id="lorerev_chat" class="lorerev_chat"></div>
            <div class="lorerev_infobar">
                <div id="lorerev_selected_info" class="lorerev_dim"></div>
                <div id="lorerev_clear" class="menu_button" title="Remove all messages and review cards from this window. Your settings and selection are kept.">Clear chat</div>
            </div>
            <div class="lorerev_modebar">
                <div class="lorerev_mode" data-mode="revise" title="Revise the entries ticked in the sidebar (content and keys)">Revise selected entries</div>
                <div class="lorerev_mode" data-mode="create" title="Ask the model for new entries in a lorebook you pick">New entries</div>
            </div>
            <div id="lorerev_create_panel" class="lorerev_create_panel">
                <label title="The lorebook the new entries are created in">Lorebook <select id="lorerev_new_book" class="text_pole"></select></label>
                <label title="The new entries get all settings of this entry (order, position, depth, probability, groups, filters, ...) except its content, title and keys. None = SillyTavern's defaults.">Copy settings from <select id="lorerev_new_copy" class="text_pole"></select></label>
                <label class="lorerev_new_example_lbl" title="Send the chosen entry's text to the model so the new entries follow its layout and style (not its facts)"><input type="checkbox" id="lorerev_new_example"> also send its text as a format example</label>
            </div>
            <div class="lorerev_input">
                <textarea id="lorerev_input" class="text_pole" rows="3"
                    placeholder="Tell LoreReviser what to update in the selected lore… (Enter to send, Shift+Enter for a new line)"></textarea>
                <div id="lorerev_send" class="menu_button">Send</div>
            </div>
        </div>
    </div>
</div>`;

export async function openModal() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chatId) {
        toastr.warning('Open a chat first.', 'LoreReviser');
        return;
    }

    conversation = conversation.filter(m => m.role !== 'error'); // errors don't survive closing the modal
    const { settings, save } = getSettings();
    const $root = $(TEMPLATE);
    const selection = loadSelection();
    const expanded = new Set(); // names of books whose entry list is open
    let books = [];

    // --- header: profile + depth ---
    const $profile = $root.find('#lorerev_profile');
    fillProfileSelect($profile, settings.profileId);
    $profile.on('change', () => { settings.profileId = String($profile.val()); save(); });

    const $changeType = $root.find('#lorerev_changetype').val(normalizeChangeType(settings.changeType));
    $changeType.on('change', () => { settings.changeType = normalizeChangeType($changeType.val()); save(); });
    const $intensity = $root.find('#lorerev_intensity').val(normalizeIntensity(settings.intensity));
    $intensity.on('change', () => { settings.intensity = normalizeIntensity($intensity.val()); save(); });

    const $replyStyle = $root.find('#lorerev_replystyle').val(normalizeReplyStyle(settings.replyStyle));
    $replyStyle.on('change', () => { settings.replyStyle = normalizeReplyStyle($replyStyle.val()); save(); });

    const $depth = $root.find('#lorerev_depth').val(settings.depth);
    const updateDepthInfo = () => {
        const total = SillyTavern.getContext().chat.filter(m => !m.is_system).length; // visible (non-hidden) messages
        $root.find('#lorerev_depth_info').text(depthLabel(settings.depth, total));
    };
    $depth.on('input', () => {
        settings.depth = normalizeDepth($depth.val());
        if (String($depth.val()) !== '' && Number($depth.val()) !== settings.depth) $depth.val(settings.depth); // e.g. -5 -> -1, 2.7 -> 2
        save();
        updateDepthInfo();
    });
    updateDepthInfo();

    // reply token budget and context limit (0 = automatic)
    for (const [sel, key] of [['#lorerev_reply', 'replyTokens'], ['#lorerev_context', 'contextLimit']]) {
        const $n = $root.find(sel).val(settings[key]);
        $n.on('input', () => { settings[key] = Math.max(0, Math.floor(Number($n.val()) || 0)); save(); });
    }

    // --- system prompt ---
    const $system = $root.find('#lorerev_system').val(settings.systemPrompt);
    const markEdited = ($el, on) => $el.text(on ? '(edited)' : '');
    const refreshSystemMark = () => markEdited($root.find('#lorerev_system_edited'), settings.systemPrompt.trim() !== DEFAULT_SYSTEM_PROMPT.trim());
    $system.on('input', () => { settings.systemPrompt = String($system.val()); refreshSystemMark(); save(); });
    $root.find('#lorerev_system_reset').on('click', () => {
        $system.val(DEFAULT_SYSTEM_PROMPT).trigger('input');
    });
    refreshSystemMark();

    // --- rewrite intensity wording (one editable text per level; settings keep only the edited ones) ---
    const refreshIntMarks = () => {
        let any = false;
        for (const k of Object.keys(INTENSITIES)) {
            const on = k in settings.intensityTexts;
            any ||= on;
            markEdited($root.find(`[data-edited="${k}"]`), on);
        }
        markEdited($root.find('#lorerev_int_edited'), any);
    };
    $root.find('.lorerev_int_text').each(function () {
        const $t = $(this), k = String($t.data('level'));
        const defaults = INTENSITIES[k].text;
        $t.val(settings.intensityTexts[k] ?? defaults);
        $t.on('input', () => {
            const v = String($t.val());
            // An empty or unchanged text means "use the default"; only real edits are stored, so default improvements still reach you.
            if (!v.trim() || v.trim() === defaults.trim()) delete settings.intensityTexts[k]; else settings.intensityTexts[k] = v;
            refreshIntMarks(); save();
        });
        $t.on('change', () => { if (!String($t.val()).trim()) $t.val(defaults); }); // left empty: show the default that is used
    });
    $root.find('[data-restore]').on('click', function () {
        const k = String($(this).data('restore'));
        $root.find(`.lorerev_int_text[data-level="${k}"]`).val(INTENSITIES[k].text).trigger('input');
    });
    refreshIntMarks();

    // --- change type wording (same behaviour as the intensity wording) ---
    const refreshCtMarks = () => {
        let any = false;
        for (const k of Object.keys(CHANGE_TYPES)) {
            const on = k in settings.changeTypeTexts;
            any ||= on;
            markEdited($root.find(`[data-ct-edited="${k}"]`), on);
        }
        markEdited($root.find('#lorerev_ct_edited'), any);
    };
    $root.find('.lorerev_ct_text').each(function () {
        const $t = $(this), k = String($t.data('type'));
        const defaults = CHANGE_TYPES[k].text;
        $t.val(settings.changeTypeTexts[k] ?? defaults);
        $t.on('input', () => {
            const v = String($t.val());
            if (!v.trim() || v.trim() === defaults.trim()) delete settings.changeTypeTexts[k]; else settings.changeTypeTexts[k] = v;
            refreshCtMarks(); save();
        });
        $t.on('change', () => { if (!String($t.val()).trim()) $t.val(defaults); });
    });
    $root.find('[data-restore-ct]').on('click', function () {
        const k = String($(this).data('restore-ct'));
        $root.find(`.lorerev_ct_text[data-type="${k}"]`).val(CHANGE_TYPES[k].text).trigger('input');
    });
    refreshCtMarks();

    // --- reply format rules, one set per reply style, each with a warning when it would break the parser ---
    const ruleSets = [
        { key: 'passageFormatRules', box: '#lorerev_prules', warn: '#lorerev_prules_warn', mark: '#lorerev_prules_edited', reset: '#lorerev_prules_reset', def: DEFAULT_PASSAGE_RULES, check: checkPassageRules, note: PASSAGE_RULES_NOTE },
        { key: 'formatRules', box: '#lorerev_rules', warn: '#lorerev_rules_warn', mark: '#lorerev_rules_edited', reset: '#lorerev_rules_reset', def: DEFAULT_FORMAT_RULES, check: checkFormatRules, note: FORMAT_RULES_NOTE },
    ];
    const refreshRulesBox = () => markEdited($root.find('#lorerev_rules_box_edited'), ruleSets.some(r => !!settings[r.key]));
    for (const r of ruleSets) {
        const $box = $root.find(r.box).val(settings[r.key] || r.def);
        const $warn = $root.find(r.warn);
        const refresh = () => {
            const problems = r.check(String($box.val()));
            if (problems.length) {
                $warn.text(`Warning: these rules may break reading the reply (${problems.join('; ')}). ${r.note} If the model does not answer in that format, no changes can be shown. Use "Restore default" to go back to the original rules.`).show();
            } else $warn.hide().text('');
            markEdited($root.find(r.mark), !!settings[r.key]);
            refreshRulesBox();
        };
        $box.on('input', () => {
            const v = String($box.val());
            // Only real edits are stored ('' = the default), so improvements of the default still reach you.
            settings[r.key] = !v.trim() || v.trim() === r.def.trim() ? '' : v;
            refresh(); save();
        });
        $box.on('change', () => { if (!String($box.val()).trim()) { $box.val(r.def); refresh(); } });
        $root.find(r.reset).on('click', () => $box.val(r.def).trigger('input'));
        refresh();
    }

    // --- new entry prompt: own system prompt and reply-format rules (same storage rules as above) ---
    const $cSys = $root.find('#lorerev_create_sys').val(settings.createSystemPrompt);
    const $cRules = $root.find('#lorerev_create_rules').val(settings.createFormatRules || DEFAULT_CREATE_FORMAT_RULES);
    const $cRulesWarn = $root.find('#lorerev_create_rules_warn');
    const refreshCreateMarks = () => {
        const sysEdited = settings.createSystemPrompt.trim() !== DEFAULT_CREATE_SYSTEM_PROMPT.trim();
        markEdited($root.find('#lorerev_create_sys_edited'), sysEdited);
        markEdited($root.find('#lorerev_create_rules_edited'), !!settings.createFormatRules);
        markEdited($root.find('#lorerev_create_edited'), sysEdited || !!settings.createFormatRules);
        const problems = checkCreateRules(String($cRules.val()));
        if (problems.length) $cRulesWarn.text(`Warning: these rules may break reading the reply (${problems.join('; ')}). ${CREATE_RULES_NOTE} Use "Restore default" to go back to the original rules.`).show();
        else $cRulesWarn.hide().text('');
    };
    $cSys.on('input', () => { settings.createSystemPrompt = String($cSys.val()).trim() ? String($cSys.val()) : DEFAULT_CREATE_SYSTEM_PROMPT; refreshCreateMarks(); save(); });
    $cSys.on('change', () => { if (!String($cSys.val()).trim()) $cSys.val(DEFAULT_CREATE_SYSTEM_PROMPT); });
    $root.find('#lorerev_create_sys_reset').on('click', () => $cSys.val(DEFAULT_CREATE_SYSTEM_PROMPT).trigger('input'));
    $cRules.on('input', () => {
        const v = String($cRules.val());
        settings.createFormatRules = !v.trim() || v.trim() === DEFAULT_CREATE_FORMAT_RULES.trim() ? '' : v;
        refreshCreateMarks(); save();
    });
    $cRules.on('change', () => { if (!String($cRules.val()).trim()) { $cRules.val(DEFAULT_CREATE_FORMAT_RULES); refreshCreateMarks(); } });
    $root.find('#lorerev_create_rules_reset').on('click', () => $cRules.val(DEFAULT_CREATE_FORMAT_RULES).trigger('input'));
    refreshCreateMarks();

    // --- sidebar ---
    const $books = $root.find('#lorerev_books');

    /** Re-evaluates the checkbox states and the "N selected" line from `selection`. */
    function refreshChecks() {
        let entryCount = 0, bookCount = 0;
        for (const book of books) {
            const chosen = selection.get(book.name) ?? new Set();
            const $book = $books.find('.lorerev_book').filter((_, el) => el.dataset.book === book.name);
            const $box = $book.find('.lorerev_book_check');
            $box.prop('checked', book.entries.length > 0 && chosen.size === book.entries.length);
            $box.prop('indeterminate', chosen.size > 0 && chosen.size < book.entries.length);
            $book.find('.lorerev_entry_check').each((_, el) => { el.checked = chosen.has(Number(el.dataset.uid)); });
            $book.find('.lorerev_count').text(`${chosen.size}/${book.entries.length}`);
            entryCount += chosen.size;
            if (chosen.size) bookCount++;
        }
        if (mode === 'create') {
            const target = String($root.find('#lorerev_new_book').val() ?? '');
            $root.find('#lorerev_selected_info').text(target ? `New entries will go into “${target}”` : 'Pick the lorebook for the new entries');
            return;
        }
        $root.find('#lorerev_selected_info').text(
            entryCount ? `${entryCount} entries selected in ${bookCount} book(s)` : 'No entries selected');
    }

    function renderBooks() {
        $books.empty();
        if (!books.length) {
            $books.append($('<div class="lorerev_dim">').text('No lorebooks are linked to this chat (global, character, chat or persona).'));
            return;
        }
        for (const book of books) {
            const isOpen = expanded.has(book.name);
            const $book = $('<div class="lorerev_book">').attr('data-book', book.name);
            const $row = $('<div class="lorerev_book_row">').append(
                $('<span class="lorerev_toggle fa-solid">').addClass(isOpen ? 'fa-chevron-down' : 'fa-chevron-right'),
                $('<input type="checkbox" class="lorerev_book_check">'),
                $('<span class="lorerev_book_name">').text(book.name),
                $('<span class="lorerev_count lorerev_dim">'),
                $('<span class="lorerev_hist_btn fa-solid fa-clock-rotate-left" title="History: earlier saved versions of this lorebook\'s entries, with Restore">'),
            );
            $book.append($row, $('<div class="lorerev_book_sources lorerev_dim">').text(book.sources.join(' · ')));

            const $list = $('<div class="lorerev_entries">').toggle(isOpen);
            if (!book.entries.length) $list.append($('<div class="lorerev_dim">').text('(no entries)'));
            for (const e of book.entries) {
                $list.append($('<label class="lorerev_entry">').toggleClass('lorerev_disabled', e.disabled).append(
                    $('<input type="checkbox" class="lorerev_entry_check">').attr('data-uid', e.uid),
                    $('<span>').text(e.label),
                    $('<i class="lorerev_entry_open fa-solid fa-pen-to-square">').attr('data-uid', e.uid)
                        .attr('title', 'Open this entry to read or edit its keys and text (no model is used)'),
                ));
            }
            $book.append($list);

            $row.find('.lorerev_hist_btn').on('click', (e) => { e.stopPropagation(); openHistory({ book: book.name, onRestore: refreshBooks }); });
            // expand / collapse
            $row.find('.lorerev_toggle, .lorerev_book_name').on('click', () => {
                if (expanded.has(book.name)) expanded.delete(book.name); else expanded.add(book.name);
                $list.toggle(expanded.has(book.name));
                $row.find('.lorerev_toggle').toggleClass('fa-chevron-down', expanded.has(book.name))
                    .toggleClass('fa-chevron-right', !expanded.has(book.name));
            });
            // whole-book checkbox: select all entries, or clear if all were selected
            $row.find('.lorerev_book_check').on('change', function () {
                selection.set(book.name, this.checked ? new Set(book.entries.map(e => e.uid)) : new Set());
                saveSelection(selection); refreshChecks();
            });
            // pencil: open the entry in the direct editor. It sits inside the <label>, so stop the click from ticking the checkbox.
            $list.on('click', '.lorerev_entry_open', function (e) {
                e.preventDefault(); e.stopPropagation();
                openEntryEditor({ book: book.name, uid: Number(this.dataset.uid), onSaved: refreshBooks });
            });
            // single entry checkbox
            $list.on('change', '.lorerev_entry_check', function () {
                const chosen = selection.get(book.name) ?? new Set();
                const uid = Number(this.dataset.uid);
                if (this.checked) chosen.add(uid); else chosen.delete(uid);
                selection.set(book.name, chosen);
                saveSelection(selection); refreshChecks();
            });
            $books.append($book);
        }
        refreshChecks();
    }

    /** Re-reads the linked books (entry labels can change after a restore) and redraws the sidebar. */
    async function refreshBooks() {
        books = await getLinkedBooks();
        renderBooks();
        await fillCreateBooks();
    }

    // --- mode switch (revise / new entries) and the new-entry panel ---
    const $newBook = $root.find('#lorerev_new_book');
    const $newCopy = $root.find('#lorerev_new_copy');
    const $newExample = $root.find('#lorerev_new_example').prop('checked', createUseExample);
    const PLACEHOLDERS = {
        revise: 'Tell LoreReviser what to update in the selected lore… (Enter to send, Shift+Enter for a new line)',
        create: 'Describe the new entries you want, e.g. "an entry for the blacksmith Tom from the last scene"… (Enter to send, Shift+Enter for a new line)',
    };
    function applyMode() {
        $root.find('.lorerev_mode').each((_, el) => { el.classList.toggle('lorerev_mode_on', el.dataset.mode === mode); }); // braces: returning false would stop .each
        $root.find('#lorerev_input').attr('placeholder', PLACEHOLDERS[mode]);
        $root.find('#lorerev_send').text(mode === 'create' ? 'Propose' : 'Send');
        $root.toggleClass('lorerev_mode_create', mode === 'create');
        refreshChecks();
    }
    $root.find('.lorerev_mode').on('click', function () { mode = this.dataset.mode === 'create' ? 'create' : 'revise'; applyMode(); });

    /** Target lorebook list: the linked ones first, then every other lorebook. */
    async function fillCreateBooks() {
        const all = SillyTavern.getContext().getWorldInfoNames();
        const linked = books.map(b => b.name).filter(n => all.includes(n));
        const others = all.filter(n => !linked.includes(n)).sort((a, b) => a.localeCompare(b));
        $newBook.empty().append($('<option value="">Pick a lorebook…</option>'));
        if (linked.length) $newBook.append($('<optgroup label="Linked to this chat">').append(linked.map(n => $('<option>').val(n).text(n))));
        if (others.length) $newBook.append($('<optgroup label="Other lorebooks">').append(others.map(n => $('<option>').val(n).text(n))));
        const want = all.includes(settings.createBook) ? settings.createBook : (linked[0] ?? '');
        $newBook.val(want);
        await fillCreateCopy();
    }
    /** "Copy settings from": the entries of the chosen lorebook. */
    async function fillCreateCopy() {
        const book = String($newBook.val() ?? '');
        $newCopy.empty().append($('<option value="">(none: SillyTavern defaults)</option>'));
        const entries = book ? await loadBookEntries(book) : null;
        for (const e of entries ?? []) $newCopy.append($('<option>').val(String(e.uid)).text(`${e.title} (#${e.uid})${e.disabled ? ' – disabled' : ''}`));
        const keep = createCopy.book === book && entries?.some(e => e.uid === createCopy.uid);
        $newCopy.val(keep ? String(createCopy.uid) : '');
        $newExample.prop('disabled', !keep);
        refreshChecks();
    }
    $newBook.on('change', async () => { settings.createBook = String($newBook.val() ?? ''); save(); await fillCreateCopy(); });
    $newCopy.on('change', () => {
        const v = String($newCopy.val() ?? '');
        createCopy = { book: String($newBook.val() ?? ''), uid: v === '' ? null : Number(v) };
        $newExample.prop('disabled', v === '');
    });
    $newExample.on('change', () => { createUseExample = $newExample.prop('checked'); });

    $root.find('#lorerev_top_hist').on('click', () => openHistoryPicker({ onRestore: refreshBooks }));

    // --- orphaned history files: index entries whose lorebook no longer exists (renamed or deleted) ---
    const $orphans = $root.find('#lorerev_orphans');
    function renderOrphans() {
        $orphans.empty();
        const index = getArchiveIndex();
        const names = SillyTavern.getContext().getWorldInfoNames();
        const orphans = findOrphans(index, names);
        if (!orphans.length) return;
        const targets = names.filter(n => !(n in index)).sort((a, b) => a.localeCompare(b));
        $orphans.append($('<div class="lorerev_sidebar_title lorerev_orphans_title">').text('Orphaned history files'),
            $('<div class="lorerev_dim">').text('These lorebooks have saved History but no longer exist under that name (renamed or deleted). If one was renamed, pick its new name and press Relink. If you deleted the lorebook on purpose and don\'t need its History, press Delete. Nothing is deleted without asking.'));
        for (const o of orphans) {
            const $sel = $('<select class="text_pole lorerev_relink_select">').append($('<option value="">Pick the lorebook…</option>'));
            for (const n of targets) $sel.append($('<option>').val(n).text(n));
            const $o = $('<div class="lorerev_orphan">').attr('data-book', o.book).append(
                $('<div class="lorerev_orphan_name">').text(o.book),
                $('<div class="lorerev_dim lorerev_orphan_file">').text(o.file),
                $('<div class="lorerev_orphan_row">').append($sel,
                    $('<div class="menu_button lorerev_btn_relink">').text('Relink').on('click', async () => {
                        const to = String($sel.val() ?? '');
                        if (!to) { toastr.info('Pick the lorebook this history belongs to first.', 'LoreReviser'); return; }
                        const err = await relinkArchive(o.book, to);
                        if (err) { toastr.warning(err, 'LoreReviser'); return; }
                        toastr.success(`The history of "${o.book}" now belongs to "${to}".`, 'LoreReviser');
                        renderOrphans();
                    }),
                    $('<div class="menu_button lorerev_btn_orphan_hist">').text('View').attr('title', 'Look at this saved history (Restore needs the lorebook, so relink first)')
                        .on('click', () => openHistory({ book: o.book })),
                    $('<div class="menu_button lorerev_btn_orphan_delete">').text('Delete').attr('title', 'Delete this history file (asks first; no lorebook is changed)')
                        .on('click', () => deleteOrphan(o))));
            $orphans.append($o);
        }
    }

    async function deleteOrphan(o) {
        let count = null;
        try { count = (await readArchive(o.book))?.records?.length ?? 0; } catch { /* the delete itself reports a damaged file */ }
        const n = count === null ? 'its saved changes' : `its ${count} saved change${count === 1 ? '' : 's'}`;
        const body = $('<div class="lorerev_orphan_delete_confirm">').append(
            $('<h3>').text('Delete this history file?'),
            $('<p>').text(`The History of “${o.book}” (${n}) is deleted for good, and the file ${o.file} is removed from SillyTavern's user files.`),
            $('<p>').text('No lorebook is changed. Only the saved old versions are removed, and once deleted they can\'t be restored. If the lorebook was only renamed, use Relink instead.'));
        const ok = await new Popup(body, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }).show();
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        const res = await deleteOrphanHistory(o.book);
        if (res.ok) toastr.success(res.message, 'LoreReviser'); else toastr.warning(res.message, 'LoreReviser', { timeOut: 10000 });
        renderOrphans();
    }

    // --- chat-style window ---
    const $chat = $root.find('#lorerev_chat');
    function renderChat({ keepScroll = false } = {}) {
        const top = $chat.scrollTop();
        $chat.children().detach(); // detach (not empty) so cached review cards keep their event handlers
        $chat.empty();
        if (!conversation.length) {
            $chat.append($('<div class="lorerev_dim">').text('Pick lore entries on the left, then describe what should be updated. Or switch to "New entries" below to have new entries written for a lorebook.'));
        }
        for (const m of conversation) {
            if (m.role === 'session') {
                // Re-render from state every time: cached DOM can lose its handlers when the popup closes,
                // and item.index / item.ui live on the session, so the card reopens on the attempt you were on.
                $chat.append(renderSession(m.session, { refresh: () => redraw({ keepScroll: true }), booksChanged: () => { refreshBooks(); } }));
                continue;
            }
            const $m = $('<div class="lorerev_msg">').addClass(`lorerev_${m.role}`).text(m.text);
            if (m.role === 'loading') {
                $m.prepend($('<i class="fa-solid fa-spinner fa-spin">'), ' ');
                $m.append(' ', $('<span class="menu_button lorerev_cancel">Cancel</span>').on('click', () => abortSend?.()));
            }
            if (m.raw) $m.append($('<details class="lorerev_raw" open>').append($('<summary>Raw reply</summary>'), $('<pre class="lorerev_pre">').text(m.raw)));
            $chat.append($m);
        }
        $root.find('#lorerev_send').toggleClass('disabled', runState.busy);
        $chat.scrollTop(keepScroll ? top : $chat[0].scrollHeight);
    }
    redraw = renderChat;

    // --- clear the chat window (messages + review cards); settings and selection stay ---
    $root.find('#lorerev_clear').on('click', async () => {
        if (runState.busy) { toastr.warning('A request is running. Cancel it first.', 'LoreReviser'); return; }
        const pending = conversation.filter(m => m.role === 'session').flatMap(m => m.session.items).filter(i => i.status === 'proposed').length;
        if (!conversation.length) return;
        if (pending) {
            // Proposals that were neither approved nor rejected are unsaved work.
            const popup = new Popup(`<h3>Clear the chat?</h3><p>${pending} proposed change${pending === 1 ? ' has' : 's have'} not been approved or rejected yet and will be lost.</p>`,
                POPUP_TYPE.CONFIRM, '', { okButton: 'Clear', cancelButton: 'Keep' });
            if ((await popup.show()) !== POPUP_RESULT.AFFIRMATIVE) return;
        }
        conversation = [];
        renderChat();
    });

    /** Shows an error as a toast and as a red message in the chat window (replacing a previous error). */
    function showError(text) {
        toastr.error(text, 'LoreReviser');
        if (conversation.at(-1)?.role === 'error') conversation.pop();
        conversation.push({ role: 'error', text });
        redraw();
    }

    /** The chosen Connection Manager profile, or null. The placeholder option (empty value) counts as none. */
    function getChosenProfile() {
        const id = String($profile.val() ?? '');
        if (!id) return null;
        try {
            return SillyTavern.getContext().ConnectionManagerRequestService.getSupportedProfiles().find(p => p.id === id) ?? null;
        } catch { return null; }
    }

    /** Replaces the "waiting" message (if any) with the given messages. */
    function finishLoading(...messages) {
        conversation = conversation.filter(m => m.role !== 'loading');
        conversation.push(...messages);
        redraw();
    }

    /** Shared tail of Send / Propose: warnings, the request, and the result in the chat. */
    async function runRequest(session, sendFn, abort, rulesProblems, rulesHelp) {
        const t = session.tokens;
        if (t.tooBig) {
            const warn = `The prompt is about ${t.promptTokens} tokens and the reply may use up to ${t.maxTokens}, which may not fit in the context of ${t.limit} tokens (from ${t.source}). Sending anyway; if it fails or is cut off, ${session.kind === 'create' ? 'lower the depth' : 'select fewer entries, lower the depth'}, or raise "Context" if your model allows more.`;
            toastr.warning(warn, 'LoreReviser', { timeOut: 15000 });
            conversation.splice(-1, 0, { role: 'warn', text: warn });
        }
        if (rulesProblems.length) {
            const warn = `Your edited reply format rules may break reading the model's reply (${rulesProblems.join('; ')}). ${rulesHelp}`;
            toastr.warning(warn, 'LoreReviser', { timeOut: 15000 });
            conversation.splice(-1, 0, { role: 'warn', text: warn });
        }
        const nDup = session.context.loreRemoved?.length ?? 0;
        if (nDup) {
            conversation.splice(-1, 0, { role: 'info', text: `${nDup} selected ${nDup === 1 ? 'entry was' : 'entries were'} already active in the current lore; sent once, in full, with the entries to revise (not repeated in the active lore).` });
        }
        if (session.context.loreBudgetHit) {
            // Informational: the active-lore part of the prompt is what ST itself would send (cut off by its World Info budget).
            conversation.splice(-1, 0, { role: 'warn', text: budgetNote(session.context.loreBudget) });
        }
        conversation.at(-1).text = `Waiting for "${session.profile.name}" (about ${t.promptTokens} prompt tokens, up to ${t.maxTokens} reply tokens)…`;
        redraw({ keepScroll: false });

        await sendFn(session, abort.signal);
        if (session.status === 'cancelled') return finishLoading({ role: 'assistant', text: 'Cancelled.' });
        if (session.status === 'failed') {
            const parseFailure = session.parse?.error;
            toastr.error(session.error, 'LoreReviser');
            return finishLoading({
                role: 'error',
                text: parseFailure ? `The model's reply could not be used: ${session.error} The raw reply is shown below.` : `The request failed: ${session.error}`,
                raw: parseFailure ? session.rawReplies.at(-1) : null,
            });
        }
        finishLoading({ role: 'session', session });
    }

    /** "New entries" mode: asks the model for new entries in the chosen lorebook. */
    async function sendCreate() {
        const $input = $root.find('#lorerev_input');
        const text = String($input.val()).trim();
        const profile = getChosenProfile();
        const book = String($newBook.val() ?? '');
        if (!profile) return showError('Select a connection profile first.');
        if (!book) return showError('Pick the lorebook the new entries should go into.');
        if (!SillyTavern.getContext().getWorldInfoNames().includes(book)) return showError(`The lorebook "${book}" no longer exists. Pick another one.`);
        if (!text) return showError('Write instructions first: which new entries should be written?');
        if (runState.busy) return showError('A request is still running. Wait for it or cancel it first.');
        const copyVal = String($newCopy.val() ?? '');

        $input.val('');
        conversation = conversation.filter(m => m.role !== 'error');
        conversation.push({ role: 'user', text: `New entries for “${book}”: ${text}` }, { role: 'loading', text: 'Building the prompt…' });
        runState.busy = true;
        const abort = new AbortController();
        abortSend = () => abort.abort();
        redraw();
        try {
            const session = await prepareCreateSession({ profile, settings, book, copyFrom: copyVal === '' ? null : Number(copyVal), useExample: !!$newExample.prop('checked'), instruction: text });
            await runRequest(session, sendCreateSession, abort, checkCreateRules(settings.createFormatRules || DEFAULT_CREATE_FORMAT_RULES),
                `${CREATE_RULES_NOTE} Sending anyway; if no entries show up, use "Restore default" under "New entry prompt".`);
        } catch (e) {
            console.error('[LoreReviser]', e);
            toastr.error(describeError(e), 'LoreReviser');
            finishLoading({ role: 'error', text: `Something went wrong: ${describeError(e)}` });
        } finally {
            runState.busy = false;
            abortSend = null;
            redraw();
        }
    }

    async function send() {
        if (mode === 'create') return sendCreate();
        const $input = $root.find('#lorerev_input');
        const text = String($input.val()).trim();
        const profile = getChosenProfile();
        const picked = [...selection.values()].reduce((n, s) => n + s.size, 0);

        // Validate first. On any error nothing is echoed and the typed text stays in the box.
        if (!profile) return showError('Select a connection profile first.');
        if (!picked) return showError('Select at least one lorebook entry in the sidebar first.');
        if (!text) return showError('Write instructions first: what should be updated in the selected lore?');
        if (runState.busy) return showError('A request is still running. Wait for it or cancel it first.');

        $input.val('');
        conversation = conversation.filter(m => m.role !== 'error'); // drop stale errors
        conversation.push({ role: 'user', text }, { role: 'loading', text: 'Building the prompt…' });
        runState.busy = true;
        const abort = new AbortController();
        abortSend = () => abort.abort();
        redraw();

        try {
            // build the prompt and check its size (warn only), then send and parse
            const session = await prepareSession({ profile, settings, selection, instruction: text });
            const passages = session.replyStyle === 'passages';
            await runRequest(session, sendSession, abort, checkRulesForStyle(session.replyStyle, passages ? (settings.passageFormatRules || DEFAULT_PASSAGE_RULES) : (settings.formatRules || DEFAULT_FORMAT_RULES)),
                `${passages ? PASSAGE_RULES_NOTE : FORMAT_RULES_NOTE} Sending anyway; if no changes show up, use "Restore default" under "Reply format rules (advanced)" (${passages ? 'Changed passages only' : 'Full rewrite'}).`);
        } catch (e) {
            console.error('[LoreReviser]', e);
            toastr.error(describeError(e), 'LoreReviser');
            finishLoading({ role: 'error', text: `Something went wrong: ${describeError(e)}` });
        } finally {
            runState.busy = false;
            abortSend = null;
            redraw();
        }
    }
    $root.find('#lorerev_send').on('click', send);
    $root.find('#lorerev_input').on('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    renderChat();
    applyMode();
    $books.append($('<div class="lorerev_dim">').text('Loading…'));

    // Open the popup; load books once it is on screen so the UI appears immediately.
    const popup = new Popup($root, POPUP_TYPE.TEXT, '', {
        large: true, okButton: 'Close', cancelButton: false, allowVerticalScrolling: false,
        onOpen: async () => {
            books = await getLinkedBooks();
            // Drop saved selections for books/entries that no longer exist
            for (const [name, uids] of [...selection]) {
                const book = books.find(b => b.name === name);
                if (!book) { selection.delete(name); continue; }
                const valid = new Set(book.entries.map(e => e.uid));
                selection.set(name, new Set([...uids].filter(u => valid.has(u))));
            }
            renderBooks();
            renderOrphans();
            await fillCreateBooks();
        },
    });
    // ST's 'large' option sets height and max-width but leaves the popup at its default 500px width,
    // so add our own class (see style.css) that makes it wide.
    popup.dlg.classList.add('lorerev_popup');
    await popup.show();
}
