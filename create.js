// New-entry sessions: builds the request for new entries in one target lorebook, sends it on the chosen profile and
// turns the reply into review items (same card format as revisions; see review.js). No DOM here.
// Writing (Approve / Undo) is in apply.js; pure helpers and the default prompt parts are in create-core.js.

import { splitKeywordsAndRegexes } from '../../../world-info.js';
import { parseRevisionReply } from './parse.js';
import { getSettings } from './settings.js';
import { normalizeChangeType } from './changetype.js';
import { gatherContext, countTokens, resolveContextLimit } from './prompt.js';
import { ask, describeEnd, describeError, isAbort } from './revision.js';
import { buildCreateMessages, toProposal, proposalId, proposalLabel, effectiveCreatePrompt } from './create-core.js';

/**
 * Create items look like revision items, with kind 'create':
 *   id N1, N2 ...; book = target lorebook; uid = null until Approve created the entry (then its uid);
 *   original = empty version (the "Old" side of every view is empty); attempts = proposals {title, keys, secondary, content, note, ...};
 *   copyFrom = {uid, title} of the entry whose settings are copied, or null (SillyTavern's defaults);
 *   written / writtenTitle = what Approve saved (used by Undo, and as the expected state when re-approving after an edit).
 * Statuses: proposed / loading / approved / rejected (there is no "no changes" or "not returned" for new entries).
 */

const ctx = () => SillyTavern.getContext();
const EMPTY = () => ({ keys: [], secondary: [], content: '' });
const split = (s) => splitKeywordsAndRegexes(s);

/** Default reply budget for new entries (0 in "Reply tokens" = automatic). Generous because thinking models spend part of it. */
export const CREATE_REPLY_TOKENS = 8192;

/** Title or first keys of a lorebook entry. */
const entryTitle = (e) => e?.comment?.trim() || e?.key?.slice(0, 3).join(', ') || `Entry #${e?.uid}`;

/**
 * The entries of a lorebook, for the "Copy settings from" list and the prompt.
 * @returns {Promise<{uid: number, title: string, comment: string, keys: string[], secondary: string[], content: string, disabled: boolean}[]|null>} null if the book does not exist
 */
export async function loadBookEntries(book) {
    if (!book || !ctx().getWorldInfoNames().includes(book)) return null;
    const data = await ctx().loadWorldInfo(book);
    return Object.values(data?.entries ?? {})
        .sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid))
        .map(e => ({ uid: e.uid, title: entryTitle(e), comment: e.comment ?? '', keys: [...(e.key ?? [])], secondary: [...(e.keysecondary ?? [])], content: e.content ?? '', disabled: !!e.disable }));
}

/** Makes a review item from a proposal. */
export function makeCreateItem(session, proposal, index) {
    return {
        kind: 'create', id: proposalId(index), book: session.book, uid: null, title: proposalLabel(proposal),
        original: EMPTY(), attempts: [proposal], index: 0, status: 'proposed', error: null, copyFrom: session.copyFrom,
    };
}

/**
 * Prepares a new-entry request: loads the target book, gathers the same context as a revision (card, active lore,
 * chat by depth), builds the prompt and the token estimate. Nothing is sent.
 * @param {{profile: object, settings: object, book: string, copyFrom: number|null, useExample: boolean, instruction: string}} p
 */
export async function prepareCreateSession({ profile, settings, book, copyFrom = null, useExample = true, instruction }) {
    const existing = await loadBookEntries(book);
    if (!existing) throw new Error(`The lorebook "${book}" does not exist (was it renamed or deleted?).`);
    let source = null;
    if (copyFrom !== null && copyFrom !== undefined && copyFrom !== '') {
        source = existing.find(e => e.uid === Number(copyFrom));
        if (!source) throw new Error(`The entry to copy settings from (#${copyFrom}) is no longer in "${book}". Pick another one.`);
    }
    const ctxInfo = resolveContextLimit(profile, settings);
    const context = await gatherContext(settings.depth, [], ctxInfo);
    const changeType = normalizeChangeType(settings.changeType);
    const session = {
        kind: 'create', id: Date.now(), instruction, profile: { id: profile.id, name: profile.name }, book,
        copyFrom: source ? { uid: source.uid, title: source.title } : null,
        example: source && useExample ? { title: source.comment || source.title, keys: source.keys, secondary: source.secondary, content: source.content } : null,
        existing: existing.map(e => ({ uid: e.uid, title: e.title, comment: e.comment, keys: e.keys })),
        systemPrompt: effectiveCreatePrompt(settings.createSystemPrompt), formatRules: settings.createFormatRules,
        changeType, changeTypeTexts: { ...settings.changeTypeTexts },
        context, items: [], maxTokens: settings.replyTokens > 0 ? settings.replyTokens : CREATE_REPLY_TOKENS, rawReplies: [],
        status: 'ready', error: null, parse: null, createdAt: new Date(),
    };
    session.messages = messagesFor(session, { changeType, changeTypeTexts: session.changeTypeTexts });
    const promptTokens = await countTokens(session.messages);
    session.tokens = { promptTokens, maxTokens: session.maxTokens, limit: ctxInfo.limit, source: ctxInfo.source, tooBig: promptTokens + session.maxTokens > ctxInfo.limit * 0.97 };
    return session;
}

function messagesFor(session, { changeType, changeTypeTexts, regen = null }) {
    const c = session.context;
    return buildCreateMessages({
        systemPrompt: session.systemPrompt, formatRules: session.formatRules, changeType, changeTypeTexts,
        context: { card: c.card, lore: c.lore, history: c.history, noChat: c.noChat, messagesUsed: c.messagesUsed, messagesTotal: c.messagesTotal },
        book: session.book, existing: session.existing, example: session.example, instruction: session.instruction, regen,
    });
}

/** Sends the prepared request and turns the reply into review items. Sets session.status / error. */
export async function sendCreateSession(session, signal) {
    const profile = ctx().ConnectionManagerRequestService.getProfile(session.profile.id);
    session.status = 'running';
    try {
        const info = await ask(profile, session.messages, session.maxTokens, signal);
        session.rawReplies.push(info.text);
        const parsed = parseRevisionReply(info.text);
        session.parse = { truncated: parsed.truncated, skipped: parsed.skipped, repaired: parsed.repaired, error: parsed.error, info, recovered: 0, dropped: 0 };
        // "[]" is a valid answer (no new entry needed); parseRevisionReply reports it as zero entries without an error
        if (parsed.error) {
            let err = parsed.error;
            if (!info.text.trim() && info.lengthHit) err = `The model used its whole reply budget (${describeEnd(info, session.maxTokens)}) and produced no answer. Models that think before answering need a larger "Reply tokens" value.`;
            else if (info.lengthHit) err += ` The model hit the reply limit (${describeEnd(info, session.maxTokens)}).`;
            session.status = 'failed'; session.error = err; session.parse.error = err;
            return session;
        }
        const proposals = parsed.entries.map(el => toProposal(el, { split, changeType: session.changeType }));
        session.parse.dropped = proposals.filter(p => !p).length;
        session.items = proposals.filter(Boolean).map((p, i) => makeCreateItem(session, p, i));
        session.parse.recovered = session.items.length;
        session.status = 'done';
    } catch (e) {
        session.status = isAbort(e, signal) ? 'cancelled' : 'failed';
        session.error = session.status === 'cancelled' ? 'Cancelled.' : describeError(e);
    }
    return session;
}

/**
 * Regenerates one proposal, swipe-style: the model sees the earlier attempts for it and the optional extra request.
 * The change type chosen in the modal now applies. Throws on failure; the item keeps its attempts.
 */
export async function regenerateCreateItem(session, item, note, signal) {
    const profile = ctx().ConnectionManagerRequestService.getProfile(session.profile.id);
    const live = getSettings().settings;
    const changeType = normalizeChangeType(live.changeType);
    const messages = messagesFor(session, { changeType, changeTypeTexts: live.changeTypeTexts, regen: { id: item.id, attempts: item.attempts, note } });
    const info = await ask(profile, messages, session.maxTokens, signal);
    session.rawReplies.push(info.text);
    const parsed = parseRevisionReply(info.text);
    if (parsed.error) throw new Error(`Could not read the model's reply: ${parsed.error}${info.lengthHit ? ` (the model hit the reply limit: ${describeEnd(info, session.maxTokens)})` : ''}`);
    const proposal = parsed.entries.map(el => toProposal(el, { split, changeType, request: String(note ?? '').trim() })).find(Boolean);
    if (!proposal) throw new Error(parsed.truncated ? `The reply ended before the entry was complete (${describeEnd(info, session.maxTokens)}). Raise "Reply tokens" and try again.` : 'The model did not return a usable entry.');
    item.attempts.push(proposal);
    item.index = item.attempts.length - 1;
    item.title = proposalLabel(proposal);
    item.status = 'proposed';
}

export { describeError };
