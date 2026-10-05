// Writing to lorebooks: Approve, Undo of an approval, and Restore from History; for new entries also Create, removing a
// created entry again (Undo, or Restore of a "created" History record) and creating a removed entry again from History.
// Every write: load a fresh copy, check the entry still holds what we expect (never overwrite someone else's change
// silently), set key / keysecondary / content only, save immediately, reload the World Info editor, archive a record.
// Writes run one at a time (a second approval waits for the first), so two quick approvals can't overwrite each other.

import { setWIOriginalDataValue, createWorldInfoEntry, deleteWIOriginalDataValue } from '../../../world-info.js';
import { appendRecord, readArchive } from './archive.js';
import { makeRecord, latestRecord, sameVersion, uidsInArchive, createdByRecord, removedByRecord } from './archive-core.js';
import { settingsFrom, freeUid, nextDisplayIndex, entryMatches } from './create-core.js';

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
export async function checkRestore(book, recordOrUid) {
    const record = typeof recordOrUid === 'object' ? recordOrUid : null;
    const uid = record ? record.uid : recordOrUid;
    if (createdByRecord(record)) return checkRemove(book, record);
    if (removedByRecord(record)) return checkRecreate(book, record);
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
    if (createdByRecord(record)) return removeCreated(book, record);
    if (removedByRecord(record)) return recreateRemoved(book, record);
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

// ======================= new entries =======================

const EMPTY = () => ({ keys: [], secondary: [], content: '' });

/** Loads a book. Returns {data} or {error}. */
async function loadBook(book) {
    if (!ctx().getWorldInfoNames().includes(book)) return { error: `the lorebook "${book}" no longer exists (was it renamed or deleted?)` };
    return { data: await ctx().loadWorldInfo(book) };
}

/** Every uid the book's History mentions (an unreadable History counts as none; its write fails later with a message). */
async function historyUids(book) {
    try { return uidsInArchive(await readArchive(book)); } catch { return new Set(); }
}

/**
 * Puts a new entry into `data` with ST's own createWorldInfoEntry (ST's template = the defaults), then moves it to a
 * uid that History has never used, if ST picked one that it has (ST reuses the lowest free number).
 */
function insertNewEntry(book, data, takenByHistory) {
    const displayIndex = nextDisplayIndex(data.entries);
    const entry = createWorldInfoEntry(book, data);
    if (!entry) throw new Error('SillyTavern could not assign a number (uid) to the new entry');
    if (takenByHistory.has(Number(entry.uid))) {
        delete data.entries[entry.uid];
        entry.uid = freeUid(Object.keys(data.entries), takenByHistory);
        data.entries[entry.uid] = entry;
    }
    entry.displayIndex = displayIndex;
    return entry;
}

/** Saves the book and refreshes the World Info editor if it shows that book. */
async function saveBook(book, data) {
    await ctx().saveWorldInfo(book, data, true);
    ctx().reloadWorldInfoEditor(book, false);
}

/** Removes an entry from `data` (also the copy kept for books imported from a character card). */
function deleteEntry(data, uid) {
    delete data.entries[uid];
    deleteWIOriginalDataValue(data, Number(uid));
}

/**
 * Approve on a new-entry card: creates the entry in the target lorebook. Settings come from item.copyFrom (copied at
 * this moment from that entry: everything except content, title and keys) or ST's defaults. Archived as a "create"
 * record. If the card was approved before and then edited (item.written set), the created entry is updated instead.
 * @returns {Promise<{written: boolean, message: string}>}
 */
export function applyCreate(item, attempt, meta = {}) {
    if (item.written && item.uid !== null && item.uid !== undefined) return updateCreated(item, attempt, meta);
    return serial(async () => {
        try {
            const { data, error } = await loadBook(item.book);
            if (error) return { written: false, message: `Not created: ${error}.` };
            let source = null;
            if (item.copyFrom) {
                source = data.entries?.[item.copyFrom.uid];
                if (!source) return { written: false, message: `Not created: the entry to copy settings from ("${item.copyFrom.title}", #${item.copyFrom.uid}) is no longer in "${item.book}". Send the request again and pick another entry (or none).` };
            }
            const entry = insertNewEntry(item.book, data, await historyUids(item.book));
            if (source) Object.assign(entry, settingsFrom(source));
            const after = copy(attempt);
            const title = String(attempt.title ?? '').trim();
            Object.assign(entry, { key: [...after.keys], keysecondary: [...after.secondary], content: after.content, comment: title });
            if (title) entry.addMemo = true; // as ST's /createentry does when it sets a title
            await saveBook(item.book, data);
            item.uid = entry.uid; item.written = after; item.writtenTitle = title;
            const extra = await archive(item.book, makeRecord({
                action: 'create', uid: entry.uid, title: title || titleOf(entry, entry.uid), before: EMPTY(), after,
                instructions: meta.instructions, request: attempt.request, changeType: attempt.changeType, edited: attempt.edited,
                extra: { comment: title, settingsFrom: item.copyFrom ? { uid: item.copyFrom.uid, title: item.copyFrom.title } : 'defaults' },
            }));
            const how = source ? `with the settings of "${item.copyFrom.title}"` : 'with SillyTavern\'s default settings';
            return { written: true, message: `Created in the lorebook "${item.book}" as entry #${entry.uid}, ${how}. Recorded in History.${extra}` };
        } catch (e) {
            console.error('[LoreReviser] create failed', e);
            return { written: false, message: `Not created: ${e?.message ?? e}` };
        }
    });
}

/** Re-approve of a created entry after an edit on its card: updates keys, text and title, if nobody changed the entry meanwhile. */
function updateCreated(item, attempt, meta) {
    return serial(async () => {
        try {
            const { data, entry, error } = await loadEntry(item.book, item.uid);
            if (error) return { written: false, message: `Not saved: ${error}.` };
            if (!entryMatches(entry, item.written, item.writtenTitle)) return { written: false, message: `Not saved: ${STALE}. Edit it in the World Info editor, or Undo first.` };
            const before = versionOf(entry);
            const after = copy(attempt);
            const title = String(attempt.title ?? '').trim();
            Object.assign(entry, { key: [...after.keys], keysecondary: [...after.secondary], content: after.content, comment: title });
            await saveBook(item.book, data);
            const oldTitle = item.writtenTitle;
            item.written = after; item.writtenTitle = title;
            const extra = await archive(item.book, makeRecord({
                action: 'approve', uid: item.uid, title: title || titleOf(entry, item.uid), before, after,
                instructions: meta.instructions, request: attempt.request, changeType: attempt.changeType, edited: attempt.edited,
                extra: { oldTitle: oldTitle !== title ? oldTitle : null },
            }));
            return { written: true, message: `Saved your edited version of the new entry #${item.uid} in "${item.book}". The previous text is kept in History.${extra}` };
        } catch (e) {
            console.error('[LoreReviser] update of created entry failed', e);
            return { written: false, message: `Not saved: ${e?.message ?? e}` };
        }
    });
}

/**
 * Undo (or Reject after an edit) on an approved new-entry card: removes the created entry again, but only if it is
 * still exactly as created (keys, text, title). The whole entry is kept in History (a "remove" record with a snapshot).
 * @returns {Promise<{reverted: boolean, message: string}>}
 */
export function undoCreate(item) {
    return serial(async () => {
        if (!item.written) return { reverted: true, message: '' };
        try {
            const { data, error } = await loadBook(item.book);
            if (error) return { reverted: false, message: `Not undone: ${error}.` };
            const entry = data.entries?.[item.uid];
            if (!entry) { item.uid = null; item.written = null; return { reverted: true, message: 'The new entry was already gone from the lorebook.' }; }
            if (!entryMatches(entry, item.written, item.writtenTitle)) {
                return { reverted: false, message: 'Not undone: the new entry was changed after you approved it, so removing it would lose that change. Delete it in the World Info editor if you no longer want it.' };
            }
            const snapshot = structuredClone(entry);
            const before = versionOf(entry);
            deleteEntry(data, item.uid);
            await saveBook(item.book, data);
            const uid = item.uid;
            item.uid = null; item.written = null; item.writtenTitle = null;
            const extra = await archive(item.book, makeRecord({ action: 'remove', uid, title: titleOf(snapshot, uid), before, after: EMPTY(), extra: { snapshot, via: 'undo' } }));
            return { reverted: true, message: `Undone: the new entry #${uid} was removed from the lorebook again (its full data is kept in History).${extra}` };
        } catch (e) {
            console.error('[LoreReviser] undo of create failed', e);
            return { reverted: false, message: `Not undone: ${e?.message ?? e}` };
        }
    });
}

/** The exact title (comment) a "created" record's entry got (older/odd records: the record title). */
const createdComment = (record) => record.comment ?? record.title ?? '';

/** History check for a "created" record: may the entry be removed? (only while it is still exactly as created) */
async function checkRemove(book, record) {
    try {
        const { data, error } = await loadBook(book);
        if (error) return { error };
        const entry = data.entries?.[record.uid];
        if (!entry) return { error: 'this entry is no longer in the lorebook, so there is nothing to remove' };
        return { kind: 'remove', current: versionOf(entry), matches: entryMatches(entry, record.new, createdComment(record)) };
    } catch (e) { return { error: String(e?.message ?? e) }; }
}

/** History check for a "removed" record: can it be created again, and under which uid? */
async function checkRecreate(book, record) {
    try {
        if (!record.snapshot) return { error: 'this record has no saved copy of the entry' };
        const { data, error } = await loadBook(book);
        if (error) return { error };
        const dup = Object.values(data.entries ?? {}).find(e => entryMatches(e, record.old, record.snapshot.comment ?? ''));
        return { kind: 'recreate', duplicate: dup ? dup.uid : null, uidTaken: String(record.snapshot.uid) in (data.entries ?? {}) };
    } catch (e) { return { error: String(e?.message ?? e) }; }
}

/** Restore of a "created" record = remove the entry, only if it is still exactly as created. */
function removeCreated(book, record) {
    return serial(async () => {
        try {
            const { data, error } = await loadBook(book);
            if (error) return { written: false, message: `Not removed: ${error}.` };
            const entry = data.entries?.[record.uid];
            if (!entry) return { written: false, message: 'Nothing to remove: the entry is no longer in the lorebook.' };
            if (!entryMatches(entry, record.new, createdComment(record))) {
                return { written: false, message: 'Not removed: the entry was changed after it was created (by a later change or outside LoreReviser), so removing it would lose that change. Delete it in the World Info editor if you no longer want it.' };
            }
            const snapshot = structuredClone(entry);
            const before = versionOf(entry);
            deleteEntry(data, record.uid);
            await saveBook(book, data);
            const extra = await archive(book, makeRecord({ action: 'remove', uid: record.uid, title: titleOf(snapshot, record.uid), before, after: EMPTY(), restoredFrom: record.id, extra: { snapshot, via: 'history' } }));
            return { written: true, message: `Removed: the entry #${record.uid} created on ${new Date(record.time).toLocaleString()} is no longer in "${book}". Its full data is kept in History ("Create it again").${extra}` };
        } catch (e) {
            console.error('[LoreReviser] remove failed', e);
            return { written: false, message: `Not removed: ${e?.message ?? e}` };
        }
    });
}

/** Restore of a "removed" record = create the entry again from its saved copy (same uid if free, else a new one). */
function recreateRemoved(book, record) {
    return serial(async () => {
        try {
            if (!record.snapshot) return { written: false, message: 'Not created: this record has no saved copy of the entry.' };
            const { data, error } = await loadBook(book);
            if (error) return { written: false, message: `Not created: ${error}.` };
            const dup = Object.values(data.entries ?? {}).find(e => entryMatches(e, record.old, record.snapshot.comment ?? ''));
            if (dup) return { written: false, message: `Nothing to do: "${book}" already has this entry (#${dup.uid}).` };
            const entry = structuredClone(record.snapshot);
            const wanted = Number(entry.uid);
            if (!Number.isInteger(wanted) || String(wanted) in data.entries) {
                const taken = await historyUids(book);
                entry.uid = freeUid(Object.keys(data.entries), taken);
                entry.displayIndex = nextDisplayIndex(data.entries);
            }
            data.entries[entry.uid] = entry;
            await saveBook(book, data);
            const after = versionOf(entry);
            const extra = await archive(book, makeRecord({
                action: 'recreate', uid: entry.uid, title: titleOf(entry, entry.uid), before: EMPTY(), after, restoredFrom: record.id,
                extra: { comment: entry.comment ?? '', originalUid: entry.uid !== wanted ? wanted : null },
            }));
            const moved = entry.uid !== wanted ? ` Its old number #${wanted} is in use, so it is now #${entry.uid}.` : '';
            return { written: true, message: `Created again: "${titleOf(entry, entry.uid)}" is back in "${book}" with all its settings.${moved}${extra}` };
        } catch (e) {
            console.error('[LoreReviser] recreate failed', e);
            return { written: false, message: `Not created: ${e?.message ?? e}` };
        }
    });
}
