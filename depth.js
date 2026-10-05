// Depth setting helpers (pure, unit-tested in tests/unit.mjs).
//   depth > 0   the last X visible chat messages
//   depth = 0   the whole chat
//   depth = -1  NO chat history at all (card, active lore, entries and instructions are still sent)

/** Any input -> a whole number >= -1 (anything below -1 becomes -1; junk becomes 0). */
export function normalizeDepth(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.max(-1, n) : 0;
}

/** The messages that go into the prompt for this depth. */
export function sliceByDepth(messages, depth) {
    const d = normalizeDepth(depth);
    if (d < 0) return [];
    return d > 0 ? messages.slice(-d) : messages.slice();
}

/** Text for the depth label in the modal. */
export function depthLabel(depth, total) {
    const used = sliceByDepth(new Array(total), depth).length;
    return normalizeDepth(depth) < 0 ? 'No chat will be sent' : `${used} of ${total} messages will be sent`;
}
