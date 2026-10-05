// Builds the revision prompt ourselves (we do not capture a real "send"): see docs/milestone1-findings.md, section 3.
//
// The request is two chat messages:
//   system: the user's system prompt + the rewrite-intensity section + the change-type section + the reply-format rules (rules.js), all editable in the modal
//   user:   <character_card> <active_lore> <chat_history> <entries_to_revise> <instructions>
// Regeneration adds <previous_attempts> and <regeneration_request> and lists only the entry being redone.

import { loadWorldInfo, getWorldInfoPrompt } from '../../../world-info.js';
import * as worldInfo from '../../../world-info.js';
import * as stScript from '../../../../script.js';
import { wiBudget, wiScanContext } from './budget.js';
import * as regexEngine from '../../regex/engine.js';
import { normalizeDepth, sliceByDepth } from './depth.js';
import { dedupeLore, assembleLore } from './dedupe.js';
import { intensitySection } from './intensity.js';
import { changeTypeSection } from './changetype.js';
import { effectiveFormatRules } from './rules.js';


/** Short ids for the entries in one request: E1, E2, ... They map back to (book, uid) in the session. */
export const entryId = (index) => `E${index + 1}`;

const sub = (text) => SillyTavern.getContext().substituteParams(String(text ?? ''));

/**
 * Loads the full, current data of the selected entries.
 * @param {Map<string, Set<number>>} selection book name -> selected entry uids
 * @returns {Promise<object[]>} items with id, book, uid, title and `original` {keys, secondary, content}
 */
export async function loadSelectedEntries(selection) {
    const items = [];
    for (const [book, uids] of selection) {
        if (!uids.size) continue;
        const data = await loadWorldInfo(book);
        for (const uid of [...uids].sort((a, b) => a - b)) {
            const e = data?.entries?.[uid];
            if (!e) continue;
            items.push({
                id: entryId(items.length), book, uid,
                title: e.comment?.trim() || (e.key?.slice(0, 3).join(', ')) || `Entry #${uid}`,
                original: { keys: [...(e.key ?? [])], secondary: [...(e.keysecondary ?? [])], content: e.content ?? '' },
            });
        }
    }
    return items;
}

/**
 * Collects the parts of the prompt that do not depend on which entries are revised.
 * Computed once per Send and reused for regenerations.
 * @param {number} depth last X visible chat messages; 0 = all; -1 = no chat history at all
 * @param {object[]} items the selected entries
 * @param {{limit:number, source:string, response:number}} [ctxInfo] context size for the World Info scan (resolveContextLimit)
 */
export async function gatherContext(depth, items = [], ctxInfo = null) {
    const ctx = SillyTavern.getContext();
    const visible = ctx.chat.filter(m => !m.is_system); // hidden messages are not part of a normal prompt either
    const shown = sliceByDepth(visible, depth);
    const noChat = normalizeDepth(depth) < 0;
    const history = shown.map(m => `${m.name}: ${m.mes}`).join('\n\n');

    // Character card fields (not available in some group-chat states)
    let card = {};
    try { card = ctx.getCharacterCardFields() ?? {}; } catch { /* no character selected */ }
    const cardText = [
        `Character: ${ctx.name2}`,
        `User: ${ctx.name1}`,
        card.description && `Description:\n${sub(card.description)}`,
        card.personality && `Personality:\n${sub(card.personality)}`,
        card.scenario && `Scenario:\n${sub(card.scenario)}`,
        card.persona && `User persona:\n${sub(card.persona)}`,
    ].filter(Boolean).join('\n\n');

    // Lore that would be active in a normal send. Dry run: no timed-effect changes, no events.
    // The scan input is newest-first, like Generate() builds it.
    // The WI scan gets the same maxContext ST's Generate() would use for this connection: context - response length.
    // (ctx.maxContext is only the Text Completion slider; with Chat Completion it is NOT the real context size.)
    const info = ctxInfo ?? resolveContextLimit(null, { contextLimit: 0 });
    const scanContext = wiScanContext(info.limit, info.response);
    const percent = Number(worldInfo.world_info_budget ?? 25), cap = Number(worldInfo.world_info_budget_cap ?? 0);
    const expectedBudget = wiBudget(percent, scanContext, cap);
    let loreSource = null, loreActivated = null;
    // Budget facts from the scan-done event(s) of OUR scan (matched by the budget value; ST may scan for itself meanwhile).
    // ST sets budget.overflowed as soon as one entry does not fit; that entry and the rest of that loop are left out.
    // Entries that passed the checks but are not in activated.entries are the ones the budget really cut.
    let overflowed = false, ourScan = false;
    const cutKeys = new Map();
    // ST shows a "World info budget reached" toast from inside the scan whenever the user has "Alert On Overflow" on,
    // even for a dry run. That toast would look like a LoreReviser error, so hide exactly that one message while we
    // scan and read the real answer from the scan-done event instead (budget.overflowed). Always restored in `finally`.
    const realWarning = toastr.warning;
    const onScanDone = (args) => {
        if (!ourScan || Number(args?.budget?.current) !== expectedBudget) return;
        if (!args.budget.overflowed) return;
        overflowed = true;
        const active = args.activated?.entries;
        for (const e of args.new?.successful ?? []) {
            const k = `${e.world}.${e.uid}`;
            if (!e.ignoreBudget && !(active?.has?.(k))) cutKeys.set(k, e);
        }
    };
    try {
        toastr.warning = function (message, title, ...rest) {
            if (typeof message === 'string' && /^World info budget reached/i.test(message)) return undefined;
            return realWarning.call(this, message, title, ...rest);
        };
        ctx.eventSource.on(ctx.eventTypes.WORLDINFO_SCAN_DONE, onScanDone);
        const scan = visible.map(m => `${m.name}: ${m.mes}`).reverse();
        const globalScan = {
            personaDescription: card.persona ?? '', characterDescription: card.description ?? '',
            characterPersonality: card.personality ?? '', characterDepthPrompt: card.charDepthPrompt ?? '',
            scenario: card.scenario ?? '', creatorNotes: card.creatorNotes ?? '', trigger: 'normal',
        };
        // checkWorldInfo is what getWorldInfoPrompt wraps; it also hands back the activated entries (book + uid), which
        // is what lets us take the selected entries out exactly. Older/newer ST without it: use getWorldInfoPrompt.
        let r, activated = null;
        if (typeof worldInfo.checkWorldInfo === 'function') {
            ourScan = true;
            r = await worldInfo.checkWorldInfo(scan, scanContext, true, globalScan);
            if (r?.allActivatedEntries) activated = new Map([...r.allActivatedEntries].map(e => [`${e.world}.${e.uid}`, e]));
        } else {
            ourScan = true;
            const w = await getWorldInfoPrompt(scan, scanContext, true, globalScan);
            r = { worldInfoBefore: w.worldInfoBefore, worldInfoAfter: w.worldInfoAfter, WIDepthEntries: w.worldInfoDepth, ANBeforeEntries: w.anBefore, ANAfterEntries: w.anAfter, outletEntries: w.outletEntries };
        }
        loreSource = {
            before: r.worldInfoBefore ?? '', after: r.worldInfoAfter ?? '',
            lists: [
                ...(r.WIDepthEntries ?? []).map(d => ({ label: `depth ${d.depth}`, items: [...(d.entries ?? [])] })),
                { label: 'author\'s note top', items: [...(r.ANBeforeEntries ?? [])] },
                { label: 'author\'s note bottom', items: [...(r.ANAfterEntries ?? [])] },
                ...Object.entries(r.outletEntries ?? {}).map(([name, list]) => ({ label: `outlet ${name}`, items: [...list] })),
            ],
        };
        loreActivated = activated;
    } catch (e) {
        console.warn('[LoreReviser] could not compute active lore', e);
    } finally {
        ourScan = false;
        toastr.warning = realWarning;
        ctx.eventSource.removeListener(ctx.eventTypes.WORLDINFO_SCAN_DONE, onScanDone);
    }

    // Only a real cut counts: entries the budget left out, still active in the end (a later loop may have added them) excluded.
    const cut = [...cutKeys].filter(([k]) => !loreActivated?.has(k)).map(([, e]) => e);
    const selectedKeys = new Set(items.map(i => `${i.book}.${i.uid}`));
    const label = (e) => e.comment?.trim() || e.key?.slice(0, 2).join(', ') || `${e.world} #${e.uid}`;
    let used = 0;
    try { used = loreActivated ? await ctx.getTokenCountAsync([...loreActivated.values()].filter(e => !e.ignoreBudget).map(e => e.content).join('\n')) : 0; } catch { /* estimate only */ }
    const loreBudget = {
        budget: expectedBudget, used, percent, cap, scanContext, limit: info.limit, response: info.response, source: info.source, overflowed,
        cut: cut.filter(e => !selectedKeys.has(`${e.world}.${e.uid}`)).map(label),
        cutSelected: cut.filter(e => selectedKeys.has(`${e.world}.${e.uid}`)).map(label),
    };
    console.info(`[LoreReviser] WI scan: context ${info.limit} (${info.source}) - response ${info.response} = ${scanContext}; budget ${percent}%${cap > 0 ? ` cap ${cap}` : ''} = ${expectedBudget} tokens; used ~${used}; overflowed: ${overflowed}; cut: ${cut.map(label).join(', ') || '-'}`);
    const loreBudgetHit = loreBudget.cut.length > 0; // only when ST really left out lore that is not being revised anyway
    const context = { card: cardText, loreSource, loreCandidates: [], loreBudgetHit, loreBudget, history, messagesUsed: shown.length, messagesTotal: visible.length, noChat };
    context.loreCandidates = loreCandidatesFor(items, loreActivated, loreSource);
    Object.assign(context, loreFor(context, items));
    return context;
}

/**
 * Which selected entries are currently active, and the texts they may appear as in the active lore.
 * With the scan result we match by book + uid (exact text from the scan, via 'uid'); the entry's stored content is a
 * fallback (via 'content'). Without a scan result (fallback mode) only content matching is possible and the candidate
 * is optional (no complaint if its text is not in the lore, because it may simply not be active).
 */
function loreCandidatesFor(items, activated, source) {
    if (!source) return [];
    const out = [];
    for (const item of items) {
        const texts = [];
        const add = (text, via) => { if (text && !texts.some(t => t.text === text)) texts.push({ text, via }); };
        if (activated) {
            const e = activated.get(`${item.book}.${item.uid}`);
            if (!e) continue; // not active in this scan: nothing to remove, and nothing else may be removed for it
            add(e.content, 'uid');
            try {
                add(regexEngine.getRegexedString(e.content, regexEngine.regex_placement.WORLD_INFO, { depth: e.position === 4 ? (e.depth ?? 4) : null, isMarkdown: false, isPrompt: true }), 'uid');
            } catch { /* regex engine unavailable: raw text only */ }
        }
        add(item.original.content, 'content');
        add(sub(item.original.content), 'content');
        out.push({ id: item.id, texts, optional: !activated });
    }
    return out;
}

/**
 * The active-lore text for a request that revises exactly these items: every one of them that is active is taken out
 * (it is sent in full in <entries_to_revise>); entries that are not part of the request stay in. Regenerations and
 * retries pass a subset, so entries not in that request remain visible as lore.
 */
export function loreFor(context, items) {
    if (!context.loreSource) return { lore: '', loreRemoved: [], loreNotFound: [] };
    const ids = new Set(items.map(i => i.id));
    const res = dedupeLore(context.loreSource, context.loreCandidates.filter(c => ids.has(c.id)));
    return { lore: sub(assembleLore(res.src)), loreRemoved: res.removed, loreNotFound: res.notFound };
}

/** One entry as shown to the model. Keys are JSON arrays so commas inside regex keys stay unambiguous. */
function entryBlock(item) {
    const o = item.original;
    return `<entry id="${item.id}" book=${JSON.stringify(item.book)} title=${JSON.stringify(item.title)}>
<keys>${JSON.stringify(o.keys)}</keys>
<secondary_keys>${JSON.stringify(o.secondary)}</secondary_keys>
<content>
${o.content}
</content>
</entry>`;
}

/** A previous attempt as JSON, in the same shape as a reply element. */
const attemptJson = (a) => JSON.stringify({ keys: a.keys, secondary_keys: a.secondary, content: a.content });

/**
 * Builds the chat-completion message list.
 * @param {object} p
 * @param {string} p.systemPrompt the user's editable prompt
 * @param {Awaited<ReturnType<typeof gatherContext>>} p.context
 * @param {object[]} p.items entries to revise
 * @param {string} p.instruction the user's instructions
 * @param {string} [p.intensity] 'light' | 'balanced' | 'heavy' (see intensity.js)
 * @param {string} [p.changeType] 'development' | 'retcon' (see changetype.js)
 * @param {Record<string,string>} [p.changeTypeTexts] the user's edited wordings per change type (missing = default)
 * @param {Record<string,string>} [p.intensityTexts] the user's edited wordings per level (missing = default)
 * @param {string} [p.formatRules] the user's edited reply-format rules ('' = default)
 * @param {object[]} [p.attempts] regeneration only: earlier attempts of the single entry
 * @param {string} [p.regenNote] regeneration only: extra guidance
 */
export function buildMessages({ systemPrompt, context, items, instruction, intensity, intensityTexts = {}, changeType, changeTypeTexts = {}, formatRules = '', attempts = null, regenNote = '' }) {
    const sections = [
        `<character_card>\n${context.card}\n</character_card>`,
        `<active_lore>\n${loreFor(context, items).lore || '(none active)'}\n</active_lore>`,
        context.noChat
            ? `<chat_history messages="0 of ${context.messagesTotal}">\n(No chat history is provided for this request. Work only from the character information, active lore, entries and instructions.)\n</chat_history>`
            : `<chat_history messages="${context.messagesUsed} of ${context.messagesTotal}">\n${context.history || '(empty)'}\n</chat_history>`,
        `<entries_to_revise>\n${items.map(entryBlock).join('\n')}\n</entries_to_revise>`,
        `<instructions>\n${instruction}\n</instructions>`,
    ];
    if (attempts) {
        const id = items[0].id;
        sections.push(`<previous_attempts entry="${id}">\n${attempts.map((a, i) =>
            `<attempt n="${i + 1}"${a.edited ? ' edited_by_user="true"' : ''}${a.request ? ` user_request=${JSON.stringify(a.request)}` : ''}>${attemptJson(a)}</attempt>`).join('\n')}\n</previous_attempts>`);
        sections.push(`<regeneration_request>\nThe user wants a new version of entry ${id}. Write a different, better version than the previous attempts.`
            + `${regenNote.trim() ? ` The user's extra request for this regeneration (follow it): ${regenNote.trim()}` : ''} Reply with a JSON array containing only entry ${id}.\n</regeneration_request>`);
    } else {
        sections.push('Reply with the JSON array only.');
    }
    return [
        { role: 'system', content: `${systemPrompt.trim()}\n\n${intensitySection(intensity, intensityTexts)}\n\n${changeTypeSection(changeType, changeTypeTexts)}\n\n${effectiveFormatRules(formatRules)}` },
        { role: 'user', content: sections.join('\n\n') },
    ];
}

/** Rough token count of a message list. */
export async function countTokens(messages) {
    const { getTokenCountAsync } = SillyTavern.getContext();
    return getTokenCountAsync(messages.map(m => m.content).join('\n\n'));
}

/**
 * Context size of the chosen connection: the user's "Context" box, else the profile's Chat Completion preset, else the
 * current settings of the API the profile uses (Chat Completion: openai_max_context; Text Completion: the context slider),
 * else ST's own main-connection value. `response` is the response length ST would subtract for its World Info scan.
 * Note: ctx.maxContext is ONLY the Text Completion context slider, so it is wrong for Chat Completion connections.
 * @param {object|null} profile Connection Manager profile (null = main connection)
 * @returns {{limit: number, source: string, response: number}}
 */
export function resolveContextLimit(profile, settings) {
    const ctx = SillyTavern.getContext();
    const cc = ctx.chatCompletionSettings ?? {};
    let isCC = ctx.mainApi === 'openai';
    try { if (profile) isCC = profile.mode === 'cc' || ctx.CONNECT_API_MAP?.[profile.api]?.selected === 'openai'; } catch { /* keep main */ }
    let preset = null;
    try { if (isCC && profile?.preset) preset = ctx.getPresetManager('openai')?.getCompletionPresetByName(profile.preset) ?? null; } catch { /* none */ }
    const mainResponse = () => { try { return Number(stScript.getMaxResponseTokens?.()) || 0; } catch { return 0; } };
    const response = isCC ? Number(preset?.openai_max_tokens ?? cc.openai_max_tokens) || 0 : (Number(stScript.amount_gen) || mainResponse());
    if (settings?.contextLimit > 0) return { limit: settings.contextLimit, source: 'your "Context" box in LoreReviser', response };
    if (Number(preset?.openai_max_context) > 0) return { limit: Number(preset.openai_max_context), source: `the profile's preset "${profile.preset}"`, response };
    if (profile && isCC && Number(cc.openai_max_context) > 0) return { limit: Number(cc.openai_max_context), source: 'your current Chat Completion settings', response };
    if (profile && !isCC && ctx.maxContext > 0) return { limit: ctx.maxContext, source: 'your Text Completion context size', response };
    try {
        const main = Number(stScript.getMaxContextTokens?.());
        if (main > 0) return { limit: main, source: 'your main connection', response: mainResponse() };
    } catch { /* fall through */ }
    return { limit: isCC && cc.openai_max_context > 0 ? Number(cc.openai_max_context) : ctx.maxContext, source: 'your main connection', response };
}

/** Reply budget: the user's setting, or an estimate from the size of the entries being revised. */
export async function resolveReplyTokens(settings, items) {
    if (settings.replyTokens > 0) return settings.replyTokens;
    const { getTokenCountAsync } = SillyTavern.getContext();
    const text = items.map(i => i.original.content + JSON.stringify(i.original.keys) + JSON.stringify(i.original.secondary)).join('\n');
    const entryTokens = await getTokenCountAsync(text);
    // Generous on purpose: the reply has to hold every changed entry in full (JSON-escaped), and "thinking" models spend
    // part of this budget before they write the answer. Unused budget costs nothing.
    return Math.min(32000, Math.max(4096, Math.ceil(entryTokens * 2) + 2500));
}

/**
 * Proves that every selected entry made it into the prompt in full. Selected entries are read straight from the
 * lorebook files with loadWorldInfo and put into <entries_to_revise>; they never go through World Info activation,
 * so ST's World Info budget, recursion limits etc. cannot drop or shorten them (those only shape <active_lore>).
 * @returns {{requested: string[], sent: string[], missing: string[], alsoInLore: string[]}} alsoInLore = entries whose text is still in <active_lore> (should be empty)
 */
export function verifyEntriesSent(items, messages) {
    const user = messages.find(m => m.role === 'user')?.content ?? '';
    const block = user.slice(user.indexOf('<entries_to_revise>'), user.indexOf('</entries_to_revise>'));
    const sent = items.filter(i => block.includes(`<entry id="${i.id}" `) && block.includes(i.original.content) && block.includes(JSON.stringify(i.original.keys)));
    const lore = user.slice(user.indexOf('<active_lore>'), user.indexOf('</active_lore>'));
    const alsoInLore = items.filter(i => i.original.content.trim() && lore.includes(i.original.content)).map(i => i.id);
    return { requested: items.map(i => i.id), sent: sent.map(i => i.id), missing: items.filter(i => !sent.includes(i)).map(i => i.id), alsoInLore };
}
