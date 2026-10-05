// Revision logic: sends the prompt on the chosen Connection Manager profile and turns replies into review items.
// No DOM here; review.js draws the cards, modal.js wires everything together.

import { splitKeywordsAndRegexes } from '../../../world-info.js';
import { extractMessageFromData } from '../../../../script.js';
import { parseRevisionReply, sameAsOriginal } from './parse.js';
import { buildMessages, countTokens, verifyEntriesSent, gatherContext, loadSelectedEntries, resolveContextLimit, resolveReplyTokens } from './prompt.js';

/**
 * Review item statuses:
 *  proposed   the model suggested a change (see attempts / index)
 *  unchanged  the model left the entry alone
 *  missing    the model did not return it AND the reply shows real damage (cut off, or that part was unreadable JSON),
 *             so we can't say it is unchanged. A cleanly parsed array that simply omits an entry means "no changes".
 *             item.missingNote says which case it is. "Retry missing entries" re-requests just these.
 *  loading    a regeneration is running
 *  approved / rejected   the user's decision (Approve only marks it for now, see apply.js)
 */

/** True while a request is running (one at a time). Shared by Send and the per-entry Regenerate buttons. */
export const runState = { busy: false };

const ctx = () => SillyTavern.getContext();

/** Normalises a model-supplied id ("e1", "1", " E1 ") to "E1". */
const normId = (v) => { const m = String(v ?? '').trim().match(/^e?(\d+)$/i); return m ? `E${Number(m[1])}` : String(v ?? '').trim().toUpperCase(); };

/** Key list from whatever the model sent: array, comma separated string, or missing (keep the fallback). */
function normKeys(value, fallback) {
    let list;
    if (Array.isArray(value)) list = value.map(String);
    else if (typeof value === 'string') list = splitKeywordsAndRegexes(value);
    else return [...fallback];
    return [...new Set(list.map(k => k.trim()).filter(Boolean))];
}

/** Turns a parsed reply element into a complete proposal. Missing fields keep the original values. */
function toAttempt(el, original) {
    return {
        keys: normKeys(el.keys, original.keys),
        secondary: normKeys(el.secondary_keys, original.secondary),
        content: typeof el.content === 'string' ? el.content : original.content,
        note: typeof el.note === 'string' ? el.note.trim() : '',
        edited: false,
    };
}

/** Human-readable text for a failed request. */
export function describeError(e) {
    const cause = e?.cause?.message || e?.cause;
    return [e?.message, cause && cause !== e?.message ? cause : null].filter(Boolean).join(': ') || String(e);
}
const isAbort = (e, signal) => signal?.aborted || e?.name === 'AbortError' || e?.cause?.name === 'AbortError';

const LENGTH_REASONS = /^(length|max_tokens|max_output_tokens)$/i;

/**
 * Sends messages on the profile. Returns the reply text plus what the backend told us about how it ended.
 * We ask for the raw response (extractData: false) to see finish_reason and token usage; the text is extracted with
 * ST's own extractMessageFromData so every backend keeps working.
 * @returns {Promise<{text: string, finishReason: string|null, lengthHit: boolean, completionTokens: number|null, reasoningTokens: number|null}>}
 */
async function ask(profile, messages, maxTokens, signal) {
    const c = ctx();
    const svc = c.ConnectionManagerRequestService;
    const prompt = svc.constructPrompt(messages, profile.id); // chat completion: unchanged; text completion: instruct-formatted string
    const json = await svc.sendRequest(profile.id, prompt, maxTokens, { stream: false, signal, extractData: false, includePreset: true });
    if (typeof json === 'string') return { text: json, finishReason: null, lengthHit: false, completionTokens: null, reasoningTokens: null };
    const api = c.CONNECT_API_MAP[profile.api]?.selected === 'openai' ? 'openai' : 'textgenerationwebui';
    let text = '';
    try { text = String(extractMessageFromData(json, api) ?? ''); } catch { /* unknown shape: handled below */ }
    const finishReason = json?.choices?.[0]?.finish_reason ?? json?.stop_reason ?? json?.candidates?.[0]?.finishReason ?? null;
    const usage = json?.usage ?? {};
    const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? json?.usageMetadata?.candidatesTokenCount ?? null;
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? null;
    return { text, finishReason, lengthHit: finishReason != null && (LENGTH_REASONS.test(String(finishReason)) || /^MAX_TOKENS$/.test(String(finishReason))), completionTokens, reasoningTokens };
}

/** "stopped at the reply limit (finish_reason: length) after 4096 tokens (limit 4096)" style detail, from what is known. */
export function describeEnd(info, allowed) {
    const bits = [];
    if (info.lengthHit) bits.push(`the model hit the reply limit (finish_reason: ${info.finishReason})`);
    else if (info.finishReason) bits.push(`finish_reason: ${info.finishReason}`);
    if (info.completionTokens != null) bits.push(`${info.completionTokens} tokens received${info.reasoningTokens ? `, ${info.reasoningTokens} of them thinking` : ''}`);
    bits.push(`${allowed} tokens allowed`);
    return bits.join('; ');
}

/**
 * Applies one parsed reply to the given items (all items on Send, only the missing ones on retry).
 * Entries the model returned unchanged, or omitted from a cleanly parsed array, are "unchanged".
 * Entries are "missing" only with real evidence: the reply ended inside the JSON, or that entry's object was unreadable.
 */
function applyReply(session, items, parsed) {
    const seen = new Set();
    session.parse.unknownIds = [];
    for (const el of parsed.entries) {
        const id = normId(el.id);
        const item = items.find(i => i.id === id);
        if (!item) { session.parse.unknownIds.push(String(el.id)); continue; }
        seen.add(id);
        const attempt = toAttempt(el, item.original);
        item.missingNote = null;
        if (sameAsOriginal(item.original, attempt)) { item.status = 'unchanged'; continue; } // returned but identical: no change
        item.attempts = [attempt]; item.index = 0; item.status = 'proposed';
    }
    const unknownSkipped = parsed.skipped > parsed.skippedIds.length; // damaged objects whose id we couldn't read
    for (const item of items) {
        if (seen.has(item.id)) continue;
        item.attempts = []; item.index = -1;
        if (parsed.skippedIds.includes(item.id)) {
            item.status = 'missing';
            item.missingNote = 'The model did return this entry, but that part of its reply was not valid JSON and could not be read. See "Raw reply".';
        } else if (parsed.truncated) {
            item.status = 'missing';
            item.missingNote = `The reply ended before this entry (${describeEnd(session.parse.info, session.maxTokens)}).`;
        } else if (unknownSkipped) {
            item.status = 'missing';
            item.missingNote = 'Part of the model\'s reply was not valid JSON and could not be read, so it is unknown whether this entry was meant to change. See "Raw reply".';
        } else {
            item.status = 'unchanged'; item.missingNote = null;
        }
    }
}

/** Parses a reply and records the outcome on session.parse. Returns the parse result. */
function readReply(session, info) {
    session.rawReplies.push(info.text);
    const parsed = parseRevisionReply(info.text);
    session.parse = { truncated: parsed.truncated, skipped: parsed.skipped, error: parsed.error, unknownIds: [], recovered: parsed.entries.length, repaired: parsed.repaired, info };
    if (parsed.error && !info.text.trim() && info.lengthHit) {
        parsed.error = `The model used its whole reply budget (${describeEnd(info, session.maxTokens)}) and produced no answer. Models that think before answering need a larger "Reply tokens" value.`;
    } else if (parsed.error && info.lengthHit) {
        parsed.error += ` The model hit the reply limit (${describeEnd(info, session.maxTokens)}).`;
    }
    session.parse.error = parsed.error;
    return parsed;
}

/**
 * Prepares a revision: loads entries, gathers context, builds the prompt and the token estimate. No request is sent.
 * @returns {Promise<object>} a session; call sendSession() to run it
 */
export async function prepareSession({ profile, settings, selection, instruction }) {
    const items = await loadSelectedEntries(selection);
    if (!items.length) throw new Error('None of the selected entries could be loaded (were they deleted?).');
    const context = await gatherContext(settings.depth, items);
    const maxTokens = await resolveReplyTokens(settings, items);
    const session = {
        id: Date.now(), instruction, profile: { id: profile.id, name: profile.name },
        systemPrompt: settings.systemPrompt, context, items, maxTokens, rawReplies: [],
        status: 'ready', error: null, parse: null, createdAt: new Date(),
    };
    for (const it of items) Object.assign(it, { attempts: [], index: -1, status: 'unchanged', error: null });
    const messages = buildMessages({ systemPrompt: session.systemPrompt, context, items, instruction });
    const check = verifyEntriesSent(items, messages);
    const dupes = context.loreRemoved.map(x => x.id);
    console.info(`[LoreReviser] entries requested: ${check.requested.join(',')}; entries in prompt: ${check.sent.join(',')}; already active, sent once (removed from active lore): ${dupes.join(',') || '-'}; still also in active lore: ${check.alsoInLore.join(',') || '-'}`);
    if (context.loreRemoved.length) console.info('[LoreReviser] removed from active lore:', context.loreRemoved.map(x => `${x.id} (${x.from}, matched by ${x.via})`).join('; '));
    if (context.loreNotFound.length) console.warn(`[LoreReviser] active selected entries whose text could not be located in the active lore, left as is: ${context.loreNotFound.join(',')}`);
    if (check.missing.length) throw new Error(`Internal error: entries ${check.missing.join(', ')} are not in the prompt. Nothing was sent.`);
    session.entriesSent = check.sent;
    const promptTokens = await countTokens(messages);
    const { limit, source } = resolveContextLimit(profile, settings);
    session.tokens = { promptTokens, maxTokens, limit, source, tooBig: promptTokens + maxTokens > limit * 0.97 };
    session.messages = messages;
    return session;
}

/** Sends the prepared session's prompt and fills in the review items. Sets session.status/error. */
export async function sendSession(session, signal) {
    const profile = ctx().ConnectionManagerRequestService.getProfile(session.profile.id);
    session.status = 'running';
    try {
        const info = await ask(profile, session.messages, session.maxTokens, signal);
        const parsed = readReply(session, info);
        if (parsed.error) {
            session.status = 'failed';
            session.error = parsed.error;
            return session;
        }
        applyReply(session, session.items, parsed);
        session.status = 'done';
    } catch (e) {
        session.status = isAbort(e, signal) ? 'cancelled' : 'failed';
        session.error = session.status === 'cancelled' ? 'Cancelled.' : describeError(e);
    }
    return session;
}

/** Re-requests only the given (not returned) items (plain request, no earlier attempts). Throws on failure; items stay missing. */
export async function retryMissing(session, items, signal) {
    if (!items.length) return;
    const profile = ctx().ConnectionManagerRequestService.getProfile(session.profile.id);
    const messages = buildMessages({ systemPrompt: session.systemPrompt, context: session.context, items, instruction: session.instruction });
    const info = await ask(profile, messages, session.maxTokens, signal);
    const parsed = readReply(session, info);
    if (parsed.error) throw new Error(parsed.error);
    applyReply(session, items, parsed);
}

/**
 * Regenerates one entry, swipe-style: the model sees its earlier attempts for the entry plus optional new guidance.
 * Adds an attempt and selects it. Throws on failure (the caller shows the error); the item keeps its old attempts.
 */
export async function regenerateItem(session, item, note, signal) {
    const profile = ctx().ConnectionManagerRequestService.getProfile(session.profile.id);
    const messages = buildMessages({
        systemPrompt: session.systemPrompt, context: session.context, items: [item], instruction: session.instruction,
        attempts: item.attempts.length ? item.attempts : null, regenNote: note,
    });
    // Without earlier attempts (entry was "no changes"), still pass the guidance through the regeneration path
    if (!item.attempts.length) messages[1].content = messages[1].content.replace('Reply with the JSON array only.',
        `<regeneration_request>\nThe first pass found no change for entry ${item.id}. Look at it again${note.trim() ? ` with this extra guidance: ${note.trim()}` : ''}. Reply with a JSON array containing only entry ${item.id}.\n</regeneration_request>`);
    const info = await ask(profile, messages, session.maxTokens, signal);
    session.rawReplies.push(info.text);
    const parsed = parseRevisionReply(info.text);
    if (parsed.error) throw new Error(`Could not read the model's reply: ${parsed.error}${info.lengthHit ? ` (the model hit the reply limit: ${describeEnd(info, session.maxTokens)})` : ''}`);
    const el = parsed.entries.find(e => normId(e.id) === item.id) ?? (parsed.entries.length === 1 ? parsed.entries[0] : null);
    if (!el) throw new Error(parsed.truncated ? `The reply ended before this entry (${describeEnd(info, session.maxTokens)}). Raise "Reply tokens" and try again.` : 'The model did not return this entry.');
    item.attempts.push(toAttempt(el, item.original));
    item.index = item.attempts.length - 1;
    item.status = 'proposed';
}
