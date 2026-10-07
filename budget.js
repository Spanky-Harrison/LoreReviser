// World Info budget arithmetic, the "active lore was cut" note, and the automatic reply-token budget. Pure module (unit-tested in tests/unit.mjs).
// Mirrors SillyTavern 1.19 world-info.js checkWorldInfo():
//   budget = round(world_info_budget% * maxContext / 100) || 1, then capped by world_info_budget_cap when that is > 0.
// ST's own Generate() passes maxContext = context size - response length (getMaxPromptTokens), so we do the same.

import { normalizeReplyStyle } from './rules.js';

/** The token budget ST computes for a scan. */
export function wiBudget(percent, maxContext, cap = 0) {
    let budget = Math.round(Number(percent) * Number(maxContext) / 100) || 1;
    if (Number(cap) > 0 && budget > Number(cap)) budget = Number(cap);
    return budget;
}

/** The maxContext to hand to the WI scan: context minus the response length, like ST; never below 1. */
export function wiScanContext(limit, response = 0) {
    const l = Math.max(0, Math.floor(Number(limit) || 0));
    const r = Math.max(0, Math.floor(Number(response) || 0));
    return l - r > 0 ? l - r : Math.max(1, l);
}

/**
 * Text of the modal note when ST's budget really dropped entries from the active lore.
 * @param {{budget:number, used:number, percent:number, cap:number, scanContext:number, limit:number, response:number, source:string, cut:string[], cutSelected:string[]}} b
 * @returns {string} '' when nothing that matters was cut
 */
export function budgetNote(b) {
    const cut = b?.cut ?? [];
    if (!cut.length) return '';
    const capPart = b.cap > 0 ? `, capped at ${b.cap} tokens by your "Budget Cap" setting` : '';
    const ctxPart = b.response > 0
        ? `${b.percent}% of ${b.scanContext} tokens (context ${b.limit} from ${b.source}, minus ${b.response} response tokens, as SillyTavern does)`
        : `${b.percent}% of ${b.scanContext} tokens (context from ${b.source})`;
    const names = cut.slice(0, 8).join(', ') + (cut.length > 8 ? `, and ${cut.length - 8} more` : '');
    const ns = b.cutSelected?.length ?? 0;
    const sel = ns ? ` (${ns} more left-out ${ns === 1 ? 'entry is' : 'entries are'} selected for revision and sent in full anyway.)` : '';
    return `Note: SillyTavern's World Info budget was reached while working out the currently active lore: about ${b.used} of ${b.budget} tokens used (budget = ${ctxPart}${capPart}). It left out ${cut.length} ${cut.length === 1 ? 'entry' : 'entries'} from the "active lore" part of the prompt, exactly as a normal chat message would: ${names}.${sel} The entries you selected for revision are always sent in full. (This is not an error. If the numbers look wrong, set "Context" in LoreReviser or check SillyTavern's World Info budget settings.)`;
}

/**
 * Automatic reply budget from the size of the entries (pure; see resolveReplyTokens).
 * Full rewrite: about 2x the entries + 2500 (the reply holds every changed entry in full, JSON-escaped).
 * Changed passages: about 1.25x + 2500, because only changed passages come back (each quoted once as "find" and once as
 * "replace"). Heavy-handed rewrites can change most of the text, so they keep the full-rewrite budget.
 * Both stay generous on purpose: "thinking" models spend part of the budget before they answer, and unused budget costs nothing.
 */
export function autoReplyTokens(entryTokens, style = 'full', intensity = null) {
    const factor = normalizeReplyStyle(style) === 'passages' && intensity !== 'heavy' ? 1.25 : 2;
    return Math.min(32000, Math.max(4096, Math.ceil(Number(entryTokens || 0) * factor) + 2500));
}
