// New-entry logic without SillyTavern imports (unit-tested in tests/unit.mjs): the default prompt parts for new
// entries, building the request, reading proposals, copying settings, and choosing a uid for a new entry.
//
// Creating entries is separate from revising: its own mode in the modal, its own system prompt and reply-format rules,
// its own review cards. Revisions still only touch content and keys of existing entries.

import { changeTypeSection } from './changetype.js';

/** Editable system prompt for new entries (settings.createSystemPrompt; edited in the modal under "New entry prompt"). */
export const DEFAULT_CREATE_SYSTEM_PROMPT = `You are a careful lorebook writer for an ongoing roleplay. Lorebook entries are short reference texts that are injected into the roleplay prompt when their keywords appear.

You will receive the character card, the lore that is currently active, the recent chat, a list of the entries that already exist in the target lorebook, and the user's request. Write the NEW lorebook entries the user asks for.

Guidelines:
- Write only new entries. Do not rewrite or repeat existing entries, and do not create an entry for something an existing entry already covers.
- Base every fact on the chat, the character information, the active lore and the user's instructions. Do not contradict them. Only fill gaps with invented detail where the user asks for it.
- One subject per entry (a person, place, item, faction, event, custom, concept ...). Entries are compact reference texts, not summaries of the chat.
- If a <format_example> is given, write every entry in the same style and layout as it: markdown, line breaks, bracket or tag styles (such as [Name: ...] or <tag>), field layouts (such as "Key: value" lines), list styles, casing, point of view and rough length. Use it for the format only; do not copy its facts. Without an example, follow the style of the existing lore.
- Headings and field labels you take from the <format_example> or the existing lore (such as "HEIGHT:", "Hair:" or "[Appearance]") are copied exactly, character for character: same spelling, casing and punctuation. Never misspell them or invent variants (HEIGHT must not become HIGHT, HAIR must not become HAIIR), unless the user explicitly asks for different labels.
- Follow the "Change type" section: it says whether the lore may describe how things came to be (a development in the story) or must read as though it had always been true (retcon).
- Keys are the trigger words: names, nicknames or terms that will really appear in the chat. Give each entry 1 to 5 natural keys and avoid very common words.
- Give each entry a short title, usually the name of its subject.`;

/** Reply-format rules for new entries (settings.createFormatRules; '' = this default). */
export const DEFAULT_CREATE_FORMAT_RULES = `## Reply format (strict)
Reply with ONE JSON array and nothing else: no commentary before or after it, no markdown code fences.
Each element is one new entry:
{"title": "...", "keys": ["..."], "secondary_keys": [], "content": "...", "note": "..."}

Rules:
- "title": a short name for the entry (shown as its title in the lorebook).
- "keys": the trigger keys, at least one. "secondary_keys": optional extra keys; usually leave it as [].
- "content": the complete text of the entry.
- "note": one short sentence for the user saying what the entry covers and why it is useful.
- Propose as many entries as the request needs, usually one per subject. If no new entry is needed, reply [].
- If the content has several lines or paragraphs, use \\n in the JSON string.
- Headings and field labels taken from the <format_example> or the existing lore are spelled exactly as there (never a variant such as HIGHT for HEIGHT).
- The reply must be valid JSON: escape double quotes inside strings as \\" and line breaks as \\n.`;

const REQUIRED = [
    [/json/i, 'the word JSON'],
    [/array|\[/i, 'that the reply is an array'],
    [/content/i, 'the "content" field'],
    [/keys/i, 'the "keys" field'],
];

/** Checks edited new-entry rules for the essentials. @returns {string[]} what is missing (empty = fine) */
export function checkCreateRules(text) {
    const t = String(text ?? '');
    if (!t.trim()) return ['the rules are empty'];
    return REQUIRED.filter(([re]) => !re.test(t)).map(([, what]) => `they do not mention ${what}`);
}

export const CREATE_RULES_NOTE = 'Whatever you write here, the model\'s reply must still be a JSON array of {title, keys, secondary_keys?, content, note?} objects: that is the only format LoreReviser can read for new entries.';

export const effectiveCreateRules = (saved) => (String(saved ?? '').trim() ? String(saved) : DEFAULT_CREATE_FORMAT_RULES);
export const effectiveCreatePrompt = (saved) => (String(saved ?? '').trim() ? String(saved) : DEFAULT_CREATE_SYSTEM_PROMPT);

/** Short ids for proposals in one new-entry session: N1, N2, ... */
export const proposalId = (index) => `N${index + 1}`;

/**
 * Entry fields that are NOT copied by "Copy settings from": the text, the title, the keys, and the entry's identity
 * and place in the editor list. Everything else (order, position, depth, role, probability, groups, filters, timed
 * effects, recursion and match options, disable, constant, selective, ...) is copied.
 */
export const NOT_COPIED = ['uid', 'content', 'comment', 'key', 'keysecondary', 'displayIndex'];

/** The settings to copy from an existing entry: a deep copy without NOT_COPIED fields. */
export function settingsFrom(source) {
    if (!source || typeof source !== 'object') return {};
    const out = structuredClone(source);
    for (const k of NOT_COPIED) delete out[k];
    return out;
}

/**
 * A uid for a new entry: the lowest number that is neither used in the book nor mentioned in the book's History.
 * (ST's own getFreeWorldEntryUid reuses the lowest free number; a number that History already uses for an earlier,
 * removed entry would mix two entries' histories, so those are skipped too.)
 * @param {Iterable<number|string>} usedInBook
 * @param {Iterable<number|string>} usedInHistory
 */
export function freeUid(usedInBook, usedInHistory = []) {
    const taken = new Set([...usedInBook, ...usedInHistory].map(Number));
    for (let uid = 0; uid < 1_000_000; uid++) if (!taken.has(uid)) return uid;
    return null;
}

/** displayIndex for a new entry: after every existing one, so it shows at the end of the editor list. */
export function nextDisplayIndex(entries) {
    return Object.values(entries ?? {}).reduce((max, e) => Math.max(max, Number(e?.displayIndex ?? e?.uid ?? -1)), -1) + 1;
}

const simpleSplit = (s) => String(s).split(',');

/** Key list from whatever the model sent (array or comma separated string). */
function keyList(value, split) {
    let list;
    if (Array.isArray(value)) list = value.map(String);
    else if (typeof value === 'string') list = split(value);
    else return [];
    return [...new Set(list.map(k => k.trim()).filter(Boolean))];
}

/**
 * Turns one element of the model's reply into a proposal (attempt), or null if it holds nothing usable.
 * Accepts the field names the model is most likely to use ("title"/"comment"/"name", "keys"/"key", ...).
 * @param {object} el
 * @param {{split?: (s: string) => string[], changeType?: string|null, request?: string}} [opts] split: key splitter (ST's splitKeywordsAndRegexes in the browser)
 */
export function toProposal(el, { split = simpleSplit, changeType = null, request = '' } = {}) {
    if (!el || typeof el !== 'object') return null;
    const str = (v) => (typeof v === 'string' ? v : '');
    const p = {
        title: str(el.title ?? el.comment ?? el.name).trim(),
        keys: keyList(el.keys ?? el.key ?? el.primary_keys, split),
        secondary: keyList(el.secondary_keys ?? el.keysecondary ?? el.secondary, split),
        content: str(el.content ?? el.text),
        note: str(el.note).trim(),
        edited: false,
        intensity: null, // rewrite intensity does not apply to new entries
        changeType,
        request,
    };
    if (!p.content.trim() && !p.keys.length) return null;
    return p;
}

/** A label for a proposal: its title, else its first keys. */
export const proposalLabel = (p) => p?.title?.trim() || p?.keys?.slice(0, 3).join(', ') || 'New entry';

/**
 * Yellow warnings for a proposal: no keys, empty content, or a title/key that an existing entry of the target book
 * already has (a possible duplicate). Warn only; the user decides.
 * @param {{title: string, keys: string[], content: string}} p
 * @param {{uid: number, title: string, comment?: string, keys: string[]}[]} existing entries of the target book (title = label for display, comment = the real title)
 */
export function proposalWarnings(p, existing = []) {
    const out = [];
    if (!p.keys.length) out.push('This entry has no keys, so it would never be triggered by the chat (unless you make it constant in the World Info editor).');
    if (!p.content.trim()) out.push('This entry has no content.');
    const low = (s) => String(s ?? '').trim().toLowerCase();
    const t = low(p.title);
    const sameTitle = t ? existing.filter(e => low(e.comment ?? e.title) === t) : [];
    for (const e of sameTitle) out.push(`The lorebook already has an entry titled "${e.title}" (#${e.uid}). Is this a duplicate?`);
    const keys = new Set(p.keys.map(low));
    for (const e of existing) {
        if (sameTitle.includes(e)) continue;
        const shared = e.keys.filter(k => keys.has(low(k)));
        if (shared.length) out.push(`Key${shared.length > 1 ? 's' : ''} ${shared.map(k => `"${k}"`).join(', ')} already used by "${e.title || `Entry #${e.uid}`}" (#${e.uid}).`);
    }
    return out;
}

/** True when a version + title equals what is in an entry (keys, secondary keys, content, title). */
export function entryMatches(entry, version, title) {
    const eq = (x = [], y = []) => x.length === y.length && x.every((v, i) => v === y[i]);
    return !!entry && !!version && eq(entry.key ?? [], version.keys) && eq(entry.keysecondary ?? [], version.secondary)
        && (entry.content ?? '') === (version.content ?? '') && (entry.comment ?? '') === (title ?? '');
}

const attemptJson = (a) => JSON.stringify({ title: a.title, keys: a.keys, secondary_keys: a.secondary, content: a.content });

/**
 * Builds the chat-completion messages for a new-entry request.
 * @param {object} p
 * @param {string} p.systemPrompt the new-entry system prompt
 * @param {string} p.formatRules edited new-entry rules ('' = default)
 * @param {string} p.changeType 'development' | 'retcon'
 * @param {Record<string,string>} [p.changeTypeTexts]
 * @param {{card: string, lore: string, history: string, noChat: boolean, messagesUsed: number, messagesTotal: number}} p.context
 * @param {string} p.book target lorebook name
 * @param {{uid: number, title: string, comment?: string, keys: string[]}[]} p.existing entries already in the target book (comment = real title; title = label fallback)
 * @param {{title: string, keys: string[], secondary: string[], content: string}|null} [p.example] format example (the "copy settings from" entry)
 * @param {string} p.instruction
 * @param {{id: string, attempts: object[], note: string}|null} [p.regen] regeneration of one proposal
 */
export function buildCreateMessages({ systemPrompt, formatRules = '', changeType, changeTypeTexts = {}, context, book, existing = [], example = null, instruction, regen = null }) {
    const sections = [
        `<character_card>\n${context.card}\n</character_card>`,
        `<active_lore>\n${context.lore || '(none active)'}\n</active_lore>`,
        context.noChat
            ? `<chat_history messages="0 of ${context.messagesTotal}">\n(No chat history is provided for this request. Work only from the character information, active lore, existing entries and instructions.)\n</chat_history>`
            : `<chat_history messages="${context.messagesUsed} of ${context.messagesTotal}">\n${context.history || '(empty)'}\n</chat_history>`,
        `<target_lorebook name=${JSON.stringify(book)} existing_entries="${existing.length}">\n${existing.length
            ? existing.map(e => `<existing_entry title=${JSON.stringify(e.comment ?? e.title)} keys=${JSON.stringify(e.keys)}/>`).join('\n')
            : '(the lorebook has no entries yet)'}\n</target_lorebook>`,
    ];
    if (example) {
        sections.push(`<format_example title=${JSON.stringify(example.title)}>\n<keys>${JSON.stringify(example.keys)}</keys>\n<secondary_keys>${JSON.stringify(example.secondary)}</secondary_keys>\n<content>\n${example.content}\n</content>\n</format_example>`);
    }
    sections.push(`<instructions>\n${instruction}\n</instructions>`);
    if (regen) {
        sections.push(`<previous_attempts proposal="${regen.id}">\n${regen.attempts.map((a, i) =>
            `<attempt n="${i + 1}"${a.edited ? ' edited_by_user="true"' : ''}${a.request ? ` user_request=${JSON.stringify(a.request)}` : ''}>${attemptJson(a)}</attempt>`).join('\n')}\n</previous_attempts>`);
        sections.push(`<regeneration_request>\nThe user wants a new version of the proposed new entry ${regen.id}. Write a different, better version than the previous attempts, about the same subject.`
            + `${String(regen.note ?? '').trim() ? ` The user's extra request for this regeneration (follow it): ${String(regen.note).trim()}` : ''} Reply with a JSON array containing exactly one entry.\n</regeneration_request>`);
    } else {
        sections.push('Reply with the JSON array of new entries only.');
    }
    return [
        { role: 'system', content: `${String(systemPrompt).trim()}\n\n${changeTypeSection(changeType, changeTypeTexts)}\n\n${effectiveCreateRules(formatRules)}` },
        { role: 'user', content: sections.join('\n\n') },
    ];
}
