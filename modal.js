// The LoreReviser modal: profile + system prompt settings, linked-lorebook sidebar, chat-style window.
// Milestone 2: no model calls. "Send" only echoes the instruction.

import { Popup, POPUP_TYPE } from '../../../popup.js';
import { getLinkedBooks } from './lorebooks.js';
import { MODULE_NAME, getSettings, DEFAULT_SYSTEM_PROMPT } from './settings.js';

/** Conversation shown in the chat window. Kept while the page is open; cleared when the chat changes. */
let conversation = [];
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

/** Last-X-messages count: visible (non-hidden) chat messages, limited by depth (0 = all). */
function messageCounts(depth) {
    const total = SillyTavern.getContext().chat.filter(m => !m.is_system).length;
    return { total, used: depth > 0 ? Math.min(depth, total) : total };
}

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
        <label title="Send only the last X chat messages. 0 = whole chat.">Depth
            <input id="lorerev_depth" type="number" min="0" step="1" class="text_pole"></label>
        <span id="lorerev_depth_info" class="lorerev_dim"></span>
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
        const { total, used } = messageCounts(settings.depth);
        $root.find('#lorerev_depth_info').text(`${used} of ${total} messages will be sent`);
    };
    $depth.on('input', () => {
        settings.depth = Math.max(0, Math.floor(Number($depth.val()) || 0));
        save();
        updateDepthInfo();
    });
    updateDepthInfo();

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
    function renderChat() {
        $chat.empty();
        if (!conversation.length) {
            $chat.append($('<div class="lorerev_dim">').text('Pick lore entries on the left, then describe what should be updated.'));
        }
        for (const m of conversation) {
            $chat.append($('<div class="lorerev_msg">').addClass(`lorerev_${m.role}`).text(m.text));
        }
        $chat.scrollTop($chat[0].scrollHeight);
    }

    function send() {
        const $input = $root.find('#lorerev_input');
        const text = String($input.val()).trim();
        if (!text) return;
        $input.val('');
        const picked = [...selection.values()].reduce((n, s) => n + s.size, 0);
        const { used, total } = messageCounts(settings.depth);
        conversation.push({ role: 'user', text });
        conversation.push({
            role: 'assistant',
            text: `Revision isn't implemented yet (coming in a later milestone). Nothing was sent to a model.\n`
                + `Would use: ${picked} selected entries, ${used} of ${total} chat messages, profile "${$profile.find('option:selected').text()}".`,
        });
        renderChat();
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
    await popup.show();
}
