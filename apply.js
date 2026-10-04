// Applying an approved proposal to the lorebook. NOT IMPLEMENTED YET (milestone 4).
//
// Milestone 3 only marks entries as approved in the review UI. The review UI calls applyApproval() on Approve,
// so milestone 4 only has to fill in this function:
//   1. data = await loadWorldInfo(item.book)           (fresh copy; warn if data.entries[uid] differs from item.original)
//   2. set entry.key / entry.keysecondary / entry.content, and setWIOriginalDataValue() for each
//   3. await saveWorldInfo(item.book, data, true); getContext().reloadWorldInfoEditor(item.book, true)
//   4. append the old/new record to the archive file for that book
// Cards stay approved even if this reports written:false.

/**
 * @param {object} item review item (book, uid, original, ...)
 * @param {{keys: string[], secondary: string[], content: string}} attempt the approved proposal
 * @returns {Promise<{written: boolean, message: string}>}
 */
export async function applyApproval(item, attempt) { // eslint-disable-line no-unused-vars
    return { written: false, message: 'Marked as approved. Writing to the lorebook and archiving come in the next milestone, so nothing was saved yet.' };
}
