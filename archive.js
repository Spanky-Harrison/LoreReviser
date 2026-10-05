// Archive storage: one JSON file per lorebook in <user>/user/files/, plus the index in extension settings.
// Pure logic (names, records, index) is in archive-core.js. Writing is serialised by apply.js.

import { convertTextToBase64 } from '../../../utils.js';
import { getSettings } from './settings.js';
import { archiveFileName, isValidFileName, newArchive, normalizeArchive, relinkIndex } from './archive-core.js';

const ctx = () => SillyTavern.getContext();

/** The index: { "<lorebook name>": "<archive file name>" } (lives in extension settings). */
export function getArchiveIndex() {
    return getSettings().settings.archiveIndex;
}

/**
 * The archive file name for a book: from the index, otherwise the name it would get now. The name is deterministic
 * from the book name, so an archive whose index entry was lost (settings not saved yet) is still found.
 */
export function archiveFileFor(book) {
    const index = getArchiveIndex();
    if (index[book]) return index[book];
    return archiveFileName(book, Object.entries(index).filter(([b]) => b !== book).map(([, f]) => f));
}

const fileUrl = (file) => `/user/files/${encodeURIComponent(file)}`;

/** Reads a book's archive file. Returns null when there is none yet. Throws on other errors. */
export async function readArchive(book) {
    const file = archiveFileFor(book);
    // no-cache: ST's own attachment helper uses force-cache, which would return an old copy after an overwrite
    const res = await fetch(fileUrl(file), { cache: 'no-cache', headers: ctx().getRequestHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not read the history file ${file} (HTTP ${res.status}).`);
    let data;
    try { data = await res.json(); } catch { throw new Error(`The history file ${file} is damaged (not valid JSON).`); }
    const archive = normalizeArchive(data, book);
    if (!archive) throw new Error(`The file ${file} is not a LoreReviser history file.`);
    return archive;
}

/** Uploads the whole archive (same name overwrites) and makes sure the index points to it. */
export async function writeArchive(book, archive) {
    const file = archiveFileFor(book);
    if (!isValidFileName(file)) throw new Error(`Invalid history file name: ${file}`);
    archive.book = book; // the real (current) book name is kept inside the file
    archive.updated = new Date().toISOString();
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name: file, data: convertTextToBase64(JSON.stringify(archive, null, 1)) }),
    });
    if (!res.ok) throw new Error(`Could not save the history file ${file} (HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}).`);
    const index = getArchiveIndex();
    if (index[book] !== file) { index[book] = file; getSettings().save(); }
    return file;
}

/** Read, append one record, write back. */
export async function appendRecord(book, record) {
    const archive = (await readArchive(book)) ?? newArchive(book);
    archive.records.push(record);
    await writeArchive(book, archive);
    return archive;
}

/**
 * Links an orphaned archive (its lorebook was renamed or deleted) to an existing lorebook: renames the index key and
 * updates the book name stored inside the file. The file itself keeps its name. Returns an error text or null.
 */
export async function relinkArchive(from, to) {
    const index = getArchiveIndex();
    const err = relinkIndex(index, from, to);
    if (err) return err;
    getSettings().save();
    try {
        const archive = await readArchive(to);
        if (archive) { archive.renamedFrom = [...(archive.renamedFrom ?? []), from]; await writeArchive(to, archive); }
    } catch (e) { console.warn('[LoreReviser] relink: could not update the name inside the history file', e); }
    return null;
}
