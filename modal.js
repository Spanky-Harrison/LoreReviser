// The LoreReviser modal: profile + system prompt settings, linked-lorebook sidebar, chat-style window.
// Send builds one prompt (prompt.js), sends it on the chosen profile (revision.js) and shows the proposed
// changes as review cards (review.js). Approving does not write to lorebooks yet (apply.js, milestone 4).

import { Popup, POPUP_TYPE } from '../../../popup.js';
import { getLinkedBooks } from './lorebooks.js';
import { MODULE_NAME, getSettings, DEFAULT_SYSTEM_PROMPT } from './settings.js';
import { prepareSession, sendSession, runState, describeError } from './revision.js';
import { renderSession } from './review.js';
import { normalizeDepth, depthLabel } from './depth.js';

/** Conversation shown in the chat window. Kept while the page is open; cleared when the chat changes. */
let conversation = [];
/** Redraws the chat window of the currently open modal (set by openModal; async work finishes after the modal may be closed). */
let redraw = () => {};
/** Aborts the running Send request, if any. */
let abortSend = null;
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
        <label title="Send only the last X chat messages. 0 = whole chat. -1 = no chat at all.">Depth
            <input id="lorerev_depth" type="number" min="-1" step="1" class="text_pole"></label>
        <span id="lorerev_depth_info" class="lorerev_dim"></span>
        <label title="Maximum tokens for the model's reply. 0 = automatic (based on the size of the selected entries).">Reply tokens
            <input id="lorerev_reply" type="number" min="0" step="100" class="text_pole"></label>
        <label title="Context size used for the 'prompt may be too large' warning. 0 = take it from the profile's preset.">Context
            <input id="lorerev_context" type="number" min="0" step="1000" class="text_pole"></label>
    </div>
    <div class="lorerev_body">
        <div class="lorerev_sidebar">
            <div class="lorerev_sidebar_title">Linked lorebooks</div>
            <div id="lorerev_books"></div>
        </div>
        <div class="lorerev_main">
            <details class="lorerev_system">
                <summary>System prompt</summary>
                <textarea id="lorerev_system" class="text_pole" rows="6"></textarea>
                <div class="menu_button" id="lorerev_system_reset">Reset to default</div>
            </details>
            <div id="lorerev_chat" class="lorerev_chat"></div>
            <div id="lorerev_selected_info" class="lorerev_dim"></div>
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
    $system.on('input', () => { settings.systemPrompt = String($system.val()); save(); });
    $root.find('#lorerev_system_reset').on('click', () => {
        $system.val(DEFAULT_SYSTEM_PROMPT).trigger('input');
    });

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
            );
            $book.append($row, $('<div class="lorerev_book_sources lorerev_dim">').text(book.sources.join(' · ')));

            const $list = $('<div class="lorerev_entries">').toggle(isOpen);
            if (!book.entries.length) $list.append($('<div class="lorerev_dim">').text('(no entries)'));
            for (const e of book.entries) {
                $list.append($('<label class="lorerev_entry">').toggleClass('lorerev_disabled', e.disabled).append(
                    $('<input type="checkbox" class="lorerev_entry_check">').attr('data-uid', e.uid),
                    $('<span>').text(e.label),
                ));
            }
            $book.append($list);

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

    // --- chat-style window ---
    const $chat = $root.find('#lorerev_chat');
    function renderChat({ keepScroll = false } = {}) {
        const top = $chat.scrollTop();
        $chat.children().detach(); // detach (not empty) so cached review cards keep their event handlers
        $chat.empty();
        if (!conversation.length) {
            $chat.append($('<div class="lorerev_dim">').text('Pick lore entries on the left, then describe what should be updated.'));
        }
        for (const m of conversation) {
            if (m.role === 'session') {
                m.session.$el ??= renderSession(m.session, {});
                $chat.append(m.session.$el);
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

    async function send() {
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
            // 1. build the prompt and check its size (warn only)
            const session = await prepareSession({ profile, settings, selection, instruction: text });
            const t = session.tokens;
            if (t.tooBig) {
                const warn = `The prompt is about ${t.promptTokens} tokens and the reply may use up to ${t.maxTokens}, which may not fit in the context of ${t.limit} tokens (from ${t.source}). Sending anyway; if it fails or is cut off, select fewer entries, lower the depth, or raise "Context" if your model allows more.`;
                toastr.warning(warn, 'LoreReviser', { timeOut: 15000 });
                conversation.splice(-1, 0, { role: 'warn', text: warn });
            }
            const nDup = session.context.loreRemoved.length;
            if (nDup) {
                conversation.splice(-1, 0, { role: 'info', text: `${nDup} selected ${nDup === 1 ? 'entry was' : 'entries were'} already active in the current lore; sent once, in full, with the entries to revise (not repeated in the active lore).` });
            }
            if (session.context.loreBudgetHit) {
                // Informational: the active-lore part of the prompt is what ST itself would send (cut off by its World Info budget).
                conversation.splice(-1, 0, { role: 'warn', text: 'Note: SillyTavern\'s World Info budget was reached while working out the currently active lore, so the "active lore" part of the prompt is cut off, exactly as it would be in a normal chat message. The entries you selected are always sent in full. (This is not an error.)' });
            }
            conversation.at(-1).text = `Waiting for "${profile.name}" (about ${t.promptTokens} prompt tokens, up to ${t.maxTokens} reply tokens)…`;
            redraw({ keepScroll: false });

            // 2. send and parse
            await sendSession(session, abort.signal);
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
        },
    });
    // ST's 'large' option sets height and max-width but leaves the popup at its default 500px width,
    // so add our own class (see style.css) that makes it wide.
    popup.dlg.classList.add('lorerev_popup');
    await popup.show();
}
