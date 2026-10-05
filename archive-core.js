// Archive logic without SillyTavern imports (unit-tested in tests/unit.mjs): file names, records, the index.
//
// One archive file per lorebook, uploaded to <user>/user/files/ through /api/files/upload. ST only accepts flat
// names matching ^[a-zA-Z0-9_\-.]+$ (no folders, spaces or non-ASCII), so the name is
//   LoreReviser-archive__<slug>__<hash>.json
// slug = ASCII-safe version of the book name, hash = short hash of the name when the archive was first created.
// The real book name is stored inside the file. The index (extension settings) maps book name -> file name.

export const ARCHIVE_PREFIX = 'LoreReviser-archive__';
export const ARCHIVE_FORMAT = 'LoreReviser-archive';
export const ARCHIVE_VERSION = 1;
const SLUG_MAX = 40;

/** Same rule as ST's validateAssetFileName (src/endpoints/assets.js). */
export const isValidFileName = (name) => /^[a-zA-Z0-9_\-.]+$/.test(name) && !name.startsWith('.') && name.length <= 200;

/** ASCII-safe part of a book name: accents dropped, everything else that is not a letter or digit becomes "-". */
export function slugify(name) {
    const s = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');
    return s || 'book';
}

/** Short hash (FNV-1a, 32 bit, 8 hex digits) of a string. */
export function shortHash(text) {
    let h = 0x811c9dc5;
    for (const ch of new TextEncoder().encode(String(text ?? ''))) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

/**
 * Archive file name for a book. `taken` = file names already used by other books in the index; on the (very unlikely)
 * clash a counter is mixed into the hash, so two books never share a file.
 */
export function archiveFileName(bookName, taken = []) {
    const used = new Set(taken);
    for (let n = 0; ; n++) {
        const name = `${ARCHIVE_PREFIX}${slugify(bookName)}__${shortHash(n ? `${bookName}#${n}` : bookName)}.json`;
        if (!used.has(name)) return name;
    }
}

/** A new, empty archive for a book. */
export function newArchive(bookName, now = new Date()) {
    return { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, book: bookName, created: now.toISOString(), records: [] };
}

/** Checks/repairs a parsed archive file. Returns null if it is not one of ours. */
export function normalizeArchive(data, bookName) {
    if (!data || typeof data !== 'object' || data.format !== ARCHIVE_FORMAT || !Array.isArray(data.records)) return null;
    data.book ??= bookName;
    return data;
}

const version = (v) => ({ keys: [...(v?.keys ?? [])], secondary: [...(v?.secondary ?? [])], content: String(v?.content ?? '') });

/**
 * One archive record.
 * @param {object} p
 * @param {'approve'|'undo'|'restore'|'create'|'remove'|'recreate'} p.action  approve = an approved revision was saved; undo = Undo on an
 *        approved card put the old version back; restore = a version was put back from History; create = an approved new
 *        entry was created (old side empty); remove = a created entry was removed again (Undo on its card, or from History;
 *        new side empty, `snapshot` holds the whole entry); recreate = a removed entry was created again from History
 * @param {object} [p.extra] more fields for the record (e.g. settingsFrom, snapshot, via); undefined/null values are skipped
 * @param {number} p.uid entry uid
 * @param {string} p.title entry title (comment) or label
 * @param {{keys:string[], secondary:string[], content:string}} p.before what was in the lorebook before
 * @param {{keys:string[], secondary:string[], content:string}} p.after what was saved
 */
export function makeRecord({ action, uid, title, before, after, instructions = '', request = '', intensity = null, changeType = null, edited = false, restoredFrom = null, extra = {}, now = new Date() }) {
    const rec = {
        id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        time: now.toISOString(), action, uid: Number(uid), title: String(title ?? ''),
        old: version(before), new: version(after),
    };
    if (instructions) rec.instructions = String(instructions);
    if (request) rec.request = String(request);
    if (intensity) rec.intensity = intensity;
    if (changeType) rec.changeType = changeType;
    if (edited) rec.edited = true;
    if (restoredFrom) rec.restoredFrom = restoredFrom;
    for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined && v !== null && !(k in rec)) rec[k] = v;
    return rec;
}

/** Records for one entry (or all, if uid is null), newest first. */
export function recordsFor(archive, uid = null) {
    const list = (archive?.records ?? []).filter(r => uid === null || uid === undefined || Number(r.uid) === Number(uid));
    return list.map((r, i) => [r, i]).sort((a, b) => (b[0].time ?? '').localeCompare(a[0].time ?? '') || b[1] - a[1]).map(x => x[0]);
}

/** The most recent record for an entry, or null. */
export const latestRecord = (archive, uid) => recordsFor(archive, uid)[0] ?? null;

/** True when two versions have identical keys, secondary keys and content. */
export function sameVersion(a, b) {
    const eq = (x = [], y = []) => x.length === y.length && x.every((v, i) => v === y[i]);
    return !!a && !!b && eq(a.keys, b.keys) && eq(a.secondary, b.secondary) && (a.content ?? '') === (b.content ?? '');
}

/** Index entries whose lorebook no longer exists: [{book, file}]. */
export function findOrphans(index, bookNames) {
    const names = new Set(bookNames ?? []);
    return Object.entries(index ?? {}).filter(([book]) => !names.has(book)).map(([book, file]) => ({ book, file }));
}

/**
 * Moves an index entry to another book name (after a lorebook rename). Returns an error text, or null when done.
 * Refuses to overwrite a book that already has its own archive.
 */
export function relinkIndex(index, from, to) {
    if (!(from in index)) return `There is no archive listed for "${from}".`;
    if (!to) return 'Pick a lorebook first.';
    if (to === from) return null;
    if (to in index) return `"${to}" already has its own history file, so this one can't be linked to it.`;
    index[to] = index[from];
    delete index[from];
    return null;
}

/** Plain-language label for a record's action. */
export function actionLabel(action) {
    return ({
        approve: 'Approved change', undo: 'Undone (old version put back)', restore: 'Restored from History',
        create: 'New entry created', remove: 'Entry removed (creation undone)', recreate: 'Entry created again',
    })[action] ?? String(action);
}

/** The record's Old side is "no entry" (it created the entry). Restoring it means removing the entry. */
export const createdByRecord = (r) => r?.action === 'create' || r?.action === 'recreate';
/** The record's New side is "no entry" (it removed the entry). Restoring it means creating the entry again (from r.snapshot). */
export const removedByRecord = (r) => r?.action === 'remove';

/** Every uid that a book's History mentions (records and snapshots), so a new entry never reuses one. */
export function uidsInArchive(archive) {
    const out = new Set();
    for (const r of archive?.records ?? []) {
        if (Number.isInteger(Number(r.uid))) out.add(Number(r.uid));
        if (r.snapshot && Number.isInteger(Number(r.snapshot.uid))) out.add(Number(r.snapshot.uid));
    }
    return out;
}
