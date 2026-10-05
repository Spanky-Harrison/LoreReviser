// Writing to lorebooks: Approve, Undo of an approval, and Restore from History.
// Every write: load a fresh copy, check the entry still holds what we expect (never overwrite someone else's change
// silently), set key / keysecondary / content only, save immediately, reload the World Info editor, archive a record.
// Writes run one at a time (a second approval waits for the first), so two quick approvals can't overwrite each other.

import { setWIOriginalDataValue } from '../../../world-info.js';
import { appendRecord, readArchive } from './archive.js';
import { makeRecord, latestRecord, sameVersion } from './archive-core.js';

const ctx = () => SillyTavern.getContext();

let chain = Promise.resolve();
/** Runs fn after every earlier write has finished. */
function serial(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
}

const versionOf = (entry) => ({ keys: [...(entry.key ?? [])], secondary: [...(entry.keysecondary ?? [])], content: entry.content ?? '' });
const copy = (v) => ({ keys: [...v.keys], secondary: [...v.secondary], content: v.content });
const titleOf = (entry, uid) => entry?.comment?.trim() || entry?.key?.slice(0, 3).join(', ') || `Entry #${uid}`;

/** Loads the book and the entry. Returns {data, entry} or {error}. */
async function loadEntry(book, uid) {
    if (!ctx().getWorldInfoNames().includes(book)) return { error: `the lorebook "${book}" no longer exists (was it renamed or deleted?)` };
    const data = await ctx().loadWorldInfo(book); // a fresh clone (ST's cache clones on every read)
    const entry = data?.entries?.[uid];
    if (!entry) return { error: `this entry no longer exists in the lorebook "${book}"` };
    return { data, entry };
}

/** Puts a version into the entry and saves the book. */
async function saveVersion(book, data, uid, v) {
    const entry = data.entries[uid];
    entry.key = [...v.keys];
    entry.keysecondary = [...v.secondary];
    entry.content = v.content;
    // books imported from a character card keep a second copy of each entry; keep it in step, as ST's editor does
    setWIOriginalDataValue(data, Number(uid), 'keys', entry.key);
    setWIOriginalDataValue(data, Number(uid), 'secondary_keys', entry.keysecondary);
    setWIOriginalDataValue(data, Number(uid), 'content', entry.content);
    await ctx().saveWorldInfo(book, data, true);
    ctx().reloadWorldInfoEditor(book, false); // only reloads if that book is open in the World Info editor, so it can't save a stale copy
}

/** Appends a record; returns an extra sentence for the message when that failed (the lorebook write already happened). */
async function archive(book, record) {
    try { await appendRecord(book, record); return ''; } catch (e) {
        console.error('[LoreReviser] archive write failed', e);
        return ` But the History record could not be saved (${e?.message ?? e}).`;
    }
}

const STALE = 'this entry was changed in the lorebook after LoreReviser read it (for example in the World Info editor, or by another approval). Saving now would overwrite that change';

/**
 * Approve: writes the approved proposal to the lorebook and archives the old and new version.
 * On success item.written holds what was saved (used by Undo, and as the expected text when re-approving after an edit).
 * @param {object} item review item (book, uid, title, original, written?)
 * @param {{keys: string[], secondary: string[], content: string, request?: string, intensity?: string, changeType?: string, edited?: boolean}} attempt the approved proposal
 * @param {{instructions?: string}} [meta]
 * @returns {Promise<{written: boolean, message: string}>}
 */
export function applyApproval(item, attempt, meta = {}) {
    return serial(async () => {
        try {
            const { data, entry, error } = await loadEntry(item.book, item.uid);
            if (error) return { written: false, message: `Not saved: ${error}.` };
            const expected = item.written ?? item.original;
            const before = versionOf(entry);
            if (!sameVersion(before, expected)) {
                return { written: false, message: `Not saved: ${STALE}. Send a new revision for this entry to work from its current text.` };
            }
            const after = copy(attempt);
            await saveVersion(item.book, data, item.uid, after);
            item.written = after;
            const extra = await archive(item.book, makeRecord({
                action: 'approve', uid: item.uid, title: titleOf(entry, item.uid), before, after,
                instructions: meta.instructions, request: attempt.request, intensity: attempt.intensity, changeType: attempt.changeType, edited: attempt.edited,
            }));
            return { written: true, message: `Saved to the lorebook "${item.book}". The old version is kept in History.${extra}` };
        } catch (e) {
            console.error('[LoreReviser] approve failed', e);
            return { written: false, message: `Not saved: ${e?.message ?? e}` };
        }
    });
}

/**
 * Undo on an approved card that was saved: puts the version from before the approval back (if nobody changed the
 * entry since) and archives that too.
 * @returns {Promise<{reverted: boolean, message: string}>}
 */
export function undoApproval(item) {
    return serial(async () => {
        if (!item.written) return { reverted: true, message: '' };
        try {
            const { data, entry, error } = await loadEntry(item.book, item.uid);
            if (error) return { reverted: false, message: `Not undone: ${error}.` };
            const before = versionOf(entry);
            if (!sameVersion(before, item.written)) {
                return { reverted: false, message: 'Not undone: the entry was changed after you approved it, so putting the old text back would overwrite that change. Use History to put an older version back.' };
            }
            const after = copy(item.original);
            await saveVersion(item.book, data, item.uid, after);
            item.written = null;
            const extra = await archive(item.book, makeRecord({ action: 'undo', uid: item.uid, title: titleOf(entry, item.uid), before, after }));
            return { reverted: true, message: `Undone: the old version is back in the lorebook (also recorded in History).${extra}` };
        } catch (e) {
            console.error('[LoreReviser] undo failed', e);
            return { reverted: false, message: `Not undone: ${e?.message ?? e}` };
        }
    });
}

/**
 * What a restore would replace: the entry's current version, and whether it differs from what History last saved
 * (i.e. it was edited outside LoreReviser since). {error} if the book or entry is gone.
 */
export async function checkRestore(book, uid) {
    try {
        const { entry, error } = await loadEntry(book, uid);
        if (error) return { error };
        const current = versionOf(entry);
        const last = latestRecord(await readArchive(book), uid);
        return { current, changedOutside: !!last && !sameVersion(current, last.new) };
    } catch (e) { return { error: String(e?.message ?? e) }; }
}

/**
 * Restore from History: writes a record's old version back. `expected` is the current version the user saw when
 * confirming (from checkRestore); if the entry changed since, nothing is written. The restore is archived as a new record
 * (its "old" side is what was replaced, so it can be restored again).
 * @returns {Promise<{written: boolean, message: string}>}
 */
export function restoreRecord(book, record, expected) {
    return serial(async () => {
        try {
            const { data, entry, error } = await loadEntry(book, record.uid);
            if (error) return { written: false, message: `Not restored: ${error}.` };
            const before = versionOf(entry);
            if (expected && !sameVersion(before, expected)) return { written: false, message: `Not restored: ${STALE}. Open History again to see the current state.` };
            if (sameVersion(before, record.old)) return { written: false, message: 'Nothing to restore: the entry already has exactly this text and keys.' };
            const after = copy(record.old);
            await saveVersion(book, data, record.uid, after);
            const extra = await archive(book, makeRecord({ action: 'restore', uid: record.uid, title: titleOf(entry, record.uid), before, after, restoredFrom: record.id }));
            return { written: true, message: `Restored: the version from ${new Date(record.time).toLocaleString()} is back in the lorebook "${book}". The text it replaced is kept in History.${extra}` };
        } catch (e) {
            console.error('[LoreReviser] restore failed', e);
            return { written: false, message: `Not restored: ${e?.message ?? e}` };
        }
    });
}
