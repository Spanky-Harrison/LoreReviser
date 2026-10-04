// Revision logic: sends the prompt on the chosen Connection Manager profile and turns replies into review items.
// No DOM here; review.js draws the cards, modal.js wires everything together.

import { splitKeywordsAndRegexes } from '../../../world-info.js';
import { parseRevisionReply, sameAsOriginal } from './parse.js';
import { buildMessages, countTokens, gatherContext, loadSelectedEntries, resolveContextLimit, resolveReplyTokens } from './prompt.js';

/**
 * Review item statuses:
 *  proposed   the model suggested a change (see attempts / index)
 *  unchanged  the model left the entry alone
 *  missing    the model did not return it and the reply was damaged (cut off), so we can't say it is unchanged
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

/** Sends messages on the profile; returns the reply text. */
async function ask(profile, messages, maxTokens, signal) {
    const svc = ctx().ConnectionManagerRequestService;
    const prompt = svc.constructPrompt(messages, profile.id); // chat completion: unchanged; text completion: instruct-formatted string
    const result = await svc.sendRequest(profile.id, prompt, maxTokens, { stream: false, signal, extractData: true, includePreset: true });
    return String(result?.content ?? '');
}

/**
 * Prepares a revision: loads entries, gathers context, builds the prompt and the token estimate. No request is sent.
 * @returns {Promise<object>} a session; call sendSession() to run it
 */
export async function prepareSession({ profile, settings, selection, instruction }) {
    const items = await loadSelectedEntries(selection);
    if (!items.length) throw new Error('None of the selected entries could be loaded (were they deleted?).');
    const context = await gatherContext(settings.depth);
    const maxTokens = await resolveReplyTokens(settings, items);
    const session = {
        id: Date.now(), instruction, profile: { id: profile.id, name: profile.name },
        systemPrompt: settings.systemPrompt, context, items, maxTokens, rawReplies: [],
        status: 'ready', error: null, parse: null, createdAt: new Date(),
    };
    for (const it of items) Object.assign(it, { attempts: [], index: -1, status: 'unchanged', error: null });
    const messages = buildMessages({ systemPrompt: session.systemPrompt, context, items, instruction });
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
        const reply = await ask(profile, session.messages, session.maxTokens, signal);
        session.rawReplies.push(reply);
        const parsed = parseRevisionReply(reply);
        session.parse = { truncated: parsed.truncated, skipped: parsed.skipped, error: parsed.error, unknownIds: [], recovered: parsed.entries.length };
        if (parsed.error) {
            session.status = 'failed';
            session.error = parsed.error;
            return session;
        }
        const damaged = parsed.truncated || parsed.skipped > 0;
        const seen = new Set();
        for (const el of parsed.entries) {
            const id = normId(el.id);
            const item = session.items.find(i => i.id === id);
            if (!item) { session.parse.unknownIds.push(String(el.id)); continue; }
            seen.add(id);
            const attempt = toAttempt(el, item.original);
            if (sameAsOriginal(item.original, attempt)) continue; // returned but identical: no change
            item.attempts = [attempt]; item.index = 0; item.status = 'proposed';
        }
        for (const item of session.items) if (!seen.has(item.id) && damaged) item.status = 'missing';
        session.status = 'done';
    } catch (e) {
        session.status = isAbort(e, signal) ? 'cancelled' : 'failed';
        session.error = session.status === 'cancelled' ? 'Cancelled.' : describeError(e);
    }
    return session;
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
    const reply = await ask(profile, messages, session.maxTokens, signal);
    session.rawReplies.push(reply);
    const parsed = parseRevisionReply(reply);
    if (parsed.error) throw new Error(`Could not read the model's reply: ${parsed.error}`);
    const el = parsed.entries.find(e => normId(e.id) === item.id) ?? (parsed.entries.length === 1 ? parsed.entries[0] : null);
    if (!el) throw new Error(parsed.truncated ? 'The reply was cut off before this entry. Raise "Reply tokens" and try again.' : 'The model did not return this entry.');
    item.attempts.push(toAttempt(el, item.original));
    item.index = item.attempts.length - 1;
    item.status = 'proposed';
}
