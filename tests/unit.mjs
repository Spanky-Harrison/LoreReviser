// Unit tests for the pure modules (parse.js, diff.js). Run: node tests/unit.mjs
import assert from 'node:assert/strict';
import { parseRevisionReply as P, integrityWarnings as W, sameAsOriginal } from '../parse.js';
import { normalizeDepth, sliceByDepth, depthLabel } from '../depth.js';
import { removeBlock, dedupeLore, assembleLore } from '../dedupe.js';
import { INTENSITIES, DEFAULT_INTENSITY, normalizeIntensity, intensitySection, intensityText } from '../intensity.js';
import { CHANGE_TYPES, DEFAULT_CHANGE_TYPE, normalizeChangeType, changeTypeText, changeTypeSection } from '../changetype.js';
import { wiBudget, wiScanContext, budgetNote } from '../budget.js';
import { DEFAULT_FORMAT_RULES, checkFormatRules, effectiveFormatRules, FORMAT_RULES_NOTE } from '../rules.js';
import { DEFAULT_SYSTEM_PROMPT, getSettings, LEGACY_DEFAULT_PROMPTS, LEGACY_CREATE_PROMPTS } from '../settings.js';
import { blockDiff, splitBlocks, listDiff, sentenceSpans, proposalHunks, applyHunkEdits } from '../diff.js';
import { slugify, shortHash, archiveFileName, isValidFileName, ARCHIVE_PREFIX, newArchive, normalizeArchive, makeRecord, recordsFor, latestRecord, sameVersion, findOrphans, relinkIndex, actionLabel, createdByRecord, removedByRecord, uidsInArchive, CLEAR_CHOICES, DEFAULT_CLEAR_CHOICE, clearChoice, recordsToClear, removeRecords } from '../archive-core.js';
import { DEFAULT_CREATE_SYSTEM_PROMPT, DEFAULT_CREATE_FORMAT_RULES, checkCreateRules, effectiveCreateRules, effectiveCreatePrompt, proposalId, NOT_COPIED, settingsFrom, freeUid, nextDisplayIndex, toProposal, proposalLabel, proposalWarnings, entryMatches, buildCreateMessages } from '../create-core.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS:', name); };

const good = '[{"id":"E1","keys":["a"],"content":"one\\ntwo"},{"id":"E2","content":"x"}]';
t('plain array', () => { const r = P(good); assert.equal(r.entries.length, 2); assert.equal(r.truncated, false); assert.equal(r.entries[0].content, 'one\ntwo'); });
t('code fence + chatter', () => { const r = P('Sure!\n```json\n' + good + '\n```\nHope that helps.'); assert.equal(r.entries.length, 2); assert.equal(r.error, null); });
t('think block removed', () => { const r = P('<think>[{"id":"X"}]</think>' + good); assert.equal(r.entries.length, 2); });
t('trailing comma', () => { const r = P('[{"id":"E1","content":"a"},]'); assert.equal(r.entries.length, 1); });
t('wrapper object', () => { const r = P('{"entries":' + good + '}'); assert.equal(r.entries.length, 2); });
t('single object', () => { const r = P('{"id":"E1","content":"a"}'); assert.equal(r.entries.length, 1); });
t('truncated mid-entry: salvage complete ones', () => {
    const r = P('[{"id":"E1","content":"done"},{"id":"E2","content":"cut off here, with a } and \\" inside');
    assert.equal(r.truncated, true); assert.equal(r.entries.length, 1); assert.equal(r.entries[0].id, 'E1'); assert.equal(r.error, null);
});
t('truncated after complete entry (no closing bracket)', () => {
    const r = P('[{"id":"E1","content":"done"},'); assert.equal(r.truncated, true); assert.equal(r.entries.length, 1);
});
t('truncated inside open fence', () => {
    const r = P('```json\n[{"id":"E1","content":"a"},{"id":"E2","con'); assert.equal(r.truncated, true); assert.equal(r.entries.length, 1);
});
t('truncated before first entry', () => { const r = P('[{"id":"E1","content":"abc'); assert.equal(r.entries.length, 0); assert.ok(r.error); assert.equal(r.truncated, true); });
t('braces and brackets inside strings are ignored', () => {
    const r = P('[{"id":"E1","content":"a ] } { [ b"},{"id":"E2"'); assert.equal(r.entries.length, 1); assert.equal(r.entries[0].content, 'a ] } { [ b');
});
t('malformed object skipped, others kept', () => {
    const r = P('[{"id":"E1","content":"ok"},{"id":"E2" "content":"missing comma"},{"id":"E3","content":"ok"}]');
    assert.deepEqual(r.entries.map(e => e.id), ['E1', 'E3']); assert.equal(r.skipped, 1); assert.equal(r.truncated, false);
});
t('no JSON', () => { const r = P('I could not do that, sorry.'); assert.equal(r.entries.length, 0); assert.ok(r.error); });
t('empty', () => { assert.ok(P('').error); assert.ok(P(null).error); });
t('empty array', () => { const r = P('[]'); assert.equal(r.entries.length, 0); assert.equal(r.error, null); });

t('blockDiff: changed sentence shows as removed block then added block', () => {
    const o = 'The queen is stern. She rules Eldoria. She is 54 years old.';
    const n = 'The queen is stern. She rules Eldoria. She is 55 years old and has a limp.';
    assert.deepEqual(blockDiff(o, n, 'sentence'), [
        { type: 'same', blocks: ['The queen is stern.', 'She rules Eldoria.'] },
        { type: 'del', blocks: ['She is 54 years old.'] },
        { type: 'ins', blocks: ['She is 55 years old and has a limp.'] }]);
});
t('blockDiff: paragraphs, identical and empty', () => {
    assert.deepEqual(blockDiff('a\nb', 'a\nb'), [{ type: 'same', blocks: ['a', 'b'] }]);
    assert.deepEqual(blockDiff('', 'new'), [{ type: 'ins', blocks: ['new'] }]);
    assert.deepEqual(blockDiff('old', ''), [{ type: 'del', blocks: ['old'] }]);
    assert.deepEqual(blockDiff('a\nb\nc', 'a\nX\nY\nc'), [
        { type: 'same', blocks: ['a'] }, { type: 'del', blocks: ['b'] }, { type: 'ins', blocks: ['X', 'Y'] }, { type: 'same', blocks: ['c'] }]);
});
t('splitBlocks keeps odd text whole', () => {
    assert.deepEqual(splitBlocks('No end punctuation here', 'sentence'), ['No end punctuation here']);
    assert.deepEqual(splitBlocks('He said "Go." Then left!\nNew line', 'sentence'), ['He said "Go."', 'Then left!', 'New line']);
    assert.deepEqual(splitBlocks('@@activate\nText', 'paragraph'), ['@@activate', 'Text']);
});
t('blockDiff big input does not blow up', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `Line ${i}.`).join('\n'), b = a.replace('Line 700.', 'Changed.');
    assert.ok(blockDiff(a, b).length >= 3);
});
t('listDiff', () => {
    assert.deepEqual(listDiff(['a', 'b'], ['b', 'c']), [{ type: 'del', text: 'a' }, { type: 'same', text: 'b' }, { type: 'ins', text: 'c' }]);
});
t('integrityWarnings', () => {
    const o = { keys: ['Maren', '/qu?een/i'], secondary: [], content: '@@activate\nHello {{user}}' };
    assert.deepEqual(W(o, { ...o }), []);
    const w = W(o, { keys: ['Maren'], secondary: [], content: 'Hello' });
    assert.equal(w.length, 3);
    assert.ok(w.some(x => x.includes('@@activate')) && w.some(x => x.includes('/qu?een/i')) && w.some(x => x.includes('{{user}}')));
});
t('sameAsOriginal', () => {
    const o = { keys: ['a'], secondary: [], content: 'x' };
    assert.ok(sameAsOriginal(o, { keys: ['a'], secondary: [], content: 'x' }));
    assert.ok(!sameAsOriginal(o, { keys: ['a', 'b'], secondary: [], content: 'x' }));
});
t('raw newlines inside a string are accepted (very common with roleplay text)', () => {
    const r = P('[{"id":"E1","content":"para one\n\npara two"},{"id":"E2","content":"x"}]'.replace(/\\n/g, '\n'));
    assert.equal(r.entries.length, 2); assert.equal(r.truncated, false); assert.equal(r.skipped, 0); assert.equal(r.entries[0].content, 'para one\n\npara two');
});
t('unescaped inner quotes and \\\' escapes are repaired', () => {
    const r = P('[{"id":"E1","content":"She said "run" and left. Don\\\'t follow."},{"id":"E2","content":"ok"}]');
    assert.equal(r.entries.length, 2); assert.equal(r.skipped, 0);
    assert.equal(r.entries[0].content, 'She said "run" and left. Don\'t follow.');
});
t('clean array that omits entries is NOT truncated or damaged', () => {
    const r = P('[{"id":"E2","content":"x"}]');
    assert.equal(r.truncated, false); assert.equal(r.skipped, 0); assert.equal(r.error, null);
    const e = P('[]'); assert.equal(e.entries.length, 0); assert.equal(e.truncated, false); assert.equal(e.error, null);
});
t('truncated repaired text with raw newlines still salvages complete entries', () => {
    const r = P('[{"id":"E1","content":"a\nb"},{"id":"E2","content":"cut off here\nand');
    assert.equal(r.entries.length, 1); assert.equal(r.truncated, true);
});
t('skipped object reports its id so only that entry is flagged', () => {
    const r = P('[{"id":"E1","content":"ok"},{"id":"E2","content": broken },{"id":"E3","content":"ok"}]');
    assert.equal(r.entries.length, 2); assert.equal(r.skipped, 1); assert.deepEqual(r.skippedIds, ['E2']); assert.equal(r.truncated, false);
});
t('normalizeDepth: -1 allowed, below -1 clamps, 0 stays, junk -> 0', () => {
    assert.equal(normalizeDepth(-1), -1); assert.equal(normalizeDepth(-5), -1); assert.equal(normalizeDepth(0), 0);
    assert.equal(normalizeDepth('3'), 3); assert.equal(normalizeDepth(2.7), 2); assert.equal(normalizeDepth(-0.5), -1);
    assert.equal(normalizeDepth(''), 0); assert.equal(normalizeDepth(undefined), 0); assert.equal(normalizeDepth('abc'), 0); assert.equal(normalizeDepth(null), 0);
});
t('sliceByDepth: -1 = none, 0 = all, N = last N (also when N > length)', () => {
    const m = ['a', 'b', 'c', 'd'];
    assert.deepEqual(sliceByDepth(m, -1), []); assert.deepEqual(sliceByDepth(m, 0), m); assert.deepEqual(sliceByDepth(m, 2), ['c', 'd']);
    assert.deepEqual(sliceByDepth(m, 10), m); assert.deepEqual(sliceByDepth(m, -7), []); assert.deepEqual(sliceByDepth([], -1), []);
    assert.notEqual(sliceByDepth(m, 0), m); // a copy
});
t('depthLabel', () => {
    assert.equal(depthLabel(-1, 8), 'No chat will be sent'); assert.equal(depthLabel(0, 8), '8 of 8 messages will be sent');
    assert.equal(depthLabel(3, 8), '3 of 8 messages will be sent'); assert.equal(depthLabel(20, 8), '8 of 8 messages will be sent');
});
const L = (before, after = '', lists = []) => ({ before, after, lists });
t('removeBlock: first, middle, last and only block; newlines stay tidy', () => {
    assert.deepEqual(removeBlock('A\nB\nC', 'A'), { text: 'B\nC', removed: true });
    assert.deepEqual(removeBlock('A\nB\nC', 'B'), { text: 'A\nC', removed: true });
    assert.deepEqual(removeBlock('A\nB\nC', 'C'), { text: 'A\nB', removed: true });
    assert.deepEqual(removeBlock('A', 'A'), { text: '', removed: true });
    assert.deepEqual(removeBlock('', 'A'), { text: '', removed: false });
});
t('removeBlock: multi-line entry text; never a part of a line or of another entry', () => {
    assert.deepEqual(removeBlock('one\ntwo\nlines\nlast', 'two\nlines'), { text: 'one\nlast', removed: true });
    assert.deepEqual(removeBlock('Silver crowns and gold\nx', 'Silver crowns'), { text: 'Silver crowns and gold\nx', removed: false });
    assert.deepEqual(removeBlock('prefix Silver crowns', 'Silver crowns'), { text: 'prefix Silver crowns', removed: false });
    assert.deepEqual(removeBlock('xx Silver\nSilver', 'Silver'), { text: 'xx Silver', removed: true }); // skips the non-standalone first hit
});
const cand = (id, ...texts) => ({ id, texts: texts.map(t => (typeof t === 'string' ? { text: t, via: 'uid' } : t)) });
t('dedupe: selected+active removed from before; only-active and only-selected untouched', () => {
    const src = L('Lore A\nLore B\nLore C');
    // E1 selected+active (B); E2 selected but not active -> no candidate at all (caller skips it)
    const r = dedupeLore(src, [cand('E1', 'Lore B')]);
    assert.equal(r.src.before, 'Lore A\nLore C'); assert.deepEqual(r.removed, [{ id: 'E1', from: 'before', via: 'uid' }]); assert.deepEqual(r.notFound, []);
    assert.equal(src.before, 'Lore A\nLore B\nLore C'); // input not mutated
});
t('dedupe: all positions (after, depth list, AN, outlet) and the assembled order', () => {
    const src = L('B1', 'A1\nA2', [{ label: 'depth 4', items: ['D1', 'D2'] }, { label: "author's note top", items: ['N1'] }, { label: 'outlet x', items: ['O1'] }]);
    const r = dedupeLore(src, [cand('E1', 'A2'), cand('E2', 'D1'), cand('E3', 'N1'), cand('E4', 'O1'), cand('E5', 'B1')]);
    assert.deepEqual(r.removed.map(x => `${x.id}:${x.from}`), ['E1:after', 'E2:depth 4', 'E3:author\'s note top', 'E4:outlet x', 'E5:before']);
    assert.equal(assembleLore(r.src), 'A1\n\nD2');
});
t('dedupe: empty active lore after removing everything; and empty source', () => {
    assert.equal(assembleLore(dedupeLore(L('Only'), [cand('E1', 'Only')]).src), '');
    const r = dedupeLore(L(''), [{ ...cand('E1', 'x'), optional: true }]);
    assert.deepEqual(r.removed, []); assert.deepEqual(r.notFound, []); assert.equal(assembleLore(r.src), '');
});
t('dedupe: fallback text order (scan text first, then stored content), reports via and not-found', () => {
    const r = dedupeLore(L('stored text'), [cand('E1', { text: 'rendered by regex', via: 'uid' }, { text: 'stored text', via: 'content' })]);
    assert.deepEqual(r.removed, [{ id: 'E1', from: 'before', via: 'content' }]);
    const nf = dedupeLore(L('something else'), [cand('E2', 'gone')]);
    assert.deepEqual(nf.notFound, ['E2']); assert.equal(nf.src.before, 'something else');
});
t('dedupe: identical text twice in the lore -> only one occurrence per selected entry is removed', () => {
    const r = dedupeLore(L('Same\nSame'), [cand('E1', 'Same')]);
    assert.equal(r.src.before, 'Same');
    assert.equal(dedupeLore(L('Same\nSame'), [cand('E1', 'Same'), cand('E2', 'Same')]).src.before, '');
});
t('intensity: three levels, default Balanced, junk falls back', () => {
    assert.deepEqual(Object.keys(INTENSITIES), ['light', 'balanced', 'heavy']); assert.equal(DEFAULT_INTENSITY, 'balanced');
    assert.equal(normalizeIntensity('heavy'), 'heavy'); assert.equal(normalizeIntensity('nope'), 'balanced'); assert.equal(normalizeIntensity(undefined), 'balanced');
    assert.equal(normalizeIntensity('toString'), 'balanced'); assert.equal(normalizeIntensity('__proto__'), 'balanced');
});
t('intensity wording: each level says what it allows', () => {
    const l = intensitySection('light'), b = intensitySection('balanced'), h = intensitySection('heavy');
    assert.match(l, /Light touch/); assert.match(l, /MUST change/); assert.match(l, /pronouns/); assert.match(l, /verbatim/);
    assert.match(b, /Balanced/); assert.match(b, /essence/); assert.match(h, /Heavy-handed/); assert.match(h, /restructure/);
    assert.equal(intensitySection('garbage'), b);
    assert.ok(new Set([l, b, h]).size === 3);
});
t('intensity: edited wording replaces only that level; heading stays fixed', () => {
    const o = { light: 'MY LIGHT' };
    assert.equal(intensitySection('light', o), '## Rewrite intensity: Light touch\nMY LIGHT');
    assert.equal(intensityText('balanced', o), INTENSITIES.balanced.text);
    assert.equal(intensitySection('balanced', o), intensitySection('balanced'));
    assert.equal(intensityText('light', { light: '   ' }), INTENSITIES.light.text); // blank = default
    assert.equal(intensityText('light', { light: 5 }), INTENSITIES.light.text);
    assert.equal(intensityText('light', null), INTENSITIES.light.text);
});
t('system prompt refers to the fixed "Rewrite intensity" heading', () => {
    assert.match(DEFAULT_SYSTEM_PROMPT, /Rewrite intensity/);
    for (const k of Object.keys(INTENSITIES)) assert.ok(intensitySection(k, { [k]: 'x' }).startsWith('## Rewrite intensity: '));
});
t('format rules: default is fine, broken edits are flagged', () => {
    assert.deepEqual(checkFormatRules(DEFAULT_FORMAT_RULES), []);
    assert.ok(DEFAULT_FORMAT_RULES.startsWith('## Reply format (strict)'));
    assert.equal(checkFormatRules('').length, 1); assert.equal(checkFormatRules(undefined).length, 1);
    assert.ok(checkFormatRules('Answer with a poem.').length >= 3);
    assert.deepEqual(checkFormatRules('Reply with a JSON array of {id, content}.'), []);
    assert.match(checkFormatRules('Reply with an array of {id, content}.').join(), /JSON/);
    assert.match(FORMAT_RULES_NOTE, /JSON array of \{id, keys\?, secondary_keys\?, content\?, note\?\}/);
});
t('format rules: blank means the default', () => {
    assert.equal(effectiveFormatRules(''), DEFAULT_FORMAT_RULES); assert.equal(effectiveFormatRules(undefined), DEFAULT_FORMAT_RULES);
    assert.equal(effectiveFormatRules('  \n'), DEFAULT_FORMAT_RULES); assert.equal(effectiveFormatRules('mine json array id content'), 'mine json array id content');
});
t('change type: Development (default) and Retcon, junk falls back', () => {
    assert.deepEqual(Object.keys(CHANGE_TYPES), ['development', 'retcon']); assert.equal(DEFAULT_CHANGE_TYPE, 'development');
    assert.equal(normalizeChangeType('retcon'), 'retcon'); assert.equal(normalizeChangeType('x'), 'development'); assert.equal(normalizeChangeType(undefined), 'development');
    assert.equal(normalizeChangeType('__proto__'), 'development'); assert.equal(normalizeChangeType('toString'), 'development');
});
t('change type wording: development allows before/after, retcon forbids acknowledging the change', () => {
    const d = changeTypeSection('development'), r = changeTypeSection('retcon');
    assert.match(d, /^## Change type: Development\nDEVELOPMENT\./); assert.match(d, /before and after/); assert.match(d, /history/);
    assert.match(r, /^## Change type: Retcon\nRETCON\./); assert.match(r, /always true/); assert.match(r, /do not acknowledge the change/i);
    for (const w of ['new', 'now', 'recently', 'no longer', 'changed', 'became']) assert.ok(r.includes(`"${w}"`), w);
    assert.equal(changeTypeSection('junk'), d);
});
t('change type: edited wording replaces only that type; heading stays fixed; blank = default', () => {
    assert.equal(changeTypeSection('retcon', { retcon: 'MINE' }), '## Change type: Retcon\nMINE');
    assert.equal(changeTypeSection('development', { retcon: 'MINE' }), changeTypeSection('development'));
    assert.equal(changeTypeText('retcon', { retcon: ' ' }), CHANGE_TYPES.retcon.text); assert.equal(changeTypeText('retcon', null), CHANGE_TYPES.retcon.text);
});
t('default system prompt refers to the "Change type" section', () => {
    assert.match(DEFAULT_SYSTEM_PROMPT, /"Change type" section/);
});
t('WI budget: same arithmetic as ST (percent of context, cap wins when smaller)', () => {
    assert.equal(wiBudget(50, 262144 - 300), 130922);
    assert.equal(wiBudget(50, 512), 256);
    assert.equal(wiBudget(50, 262144, 8000), 8000); assert.equal(wiBudget(10, 1000, 8000), 100); // cap only when smaller
    assert.equal(wiBudget(0, 1000), 1);
    assert.equal(wiScanContext(262144, 300), 261844); assert.equal(wiScanContext(1000, 0), 1000); assert.equal(wiScanContext(200, 500), 200); assert.equal(wiScanContext(0, 0), 1);
});
t('budget note: only for a real cut, with the numbers and sources', () => {
    const b = { budget: 12, used: 10, percent: 50, cap: 12, scanContext: 261844, limit: 262144, response: 300, source: 'your current Chat Completion settings', cut: ['Currency', 'Moon Calendar'], cutSelected: [] };
    assert.equal(budgetNote({ ...b, cut: [] }), ''); assert.equal(budgetNote(null), '');
    const n = budgetNote(b);
    assert.match(n, /about 10 of 12 tokens used/); assert.match(n, /capped at 12 tokens by your "Budget Cap" setting/);
    assert.match(n, /50% of 261844 tokens \(context 262144 from your current Chat Completion settings, minus 300 response tokens/);
    assert.match(n, /left out 2 entries/); assert.match(n, /Currency, Moon Calendar/); assert.match(n, /not an error/);
    assert.doesNotMatch(budgetNote({ ...b, cap: 0 }), /capped/);
    assert.match(budgetNote({ ...b, cutSelected: ['X'] }), /1 more left-out entry is selected for revision and sent in full anyway/);
    assert.match(budgetNote({ ...b, cut: Array.from({ length: 10 }, (_, i) => `E${i}`) }), /and 2 more/);
});
// ---------- archive (milestone 4) ----------
const STRULE = /^[a-zA-Z0-9_\-.]+$/; // ST's validateAssetFileName
t('archive slug: ASCII only, accents dropped, separators collapsed, capped at 40', () => {
    assert.equal(slugify('Eldoria'), 'Eldoria');
    assert.equal(slugify('The Wishing Game - Frankie'), 'The-Wishing-Game-Frankie');
    assert.equal(slugify('Ça/va  très   bien!'), 'Ca-va-tres-bien');
    assert.equal(slugify('日本語の本'), 'book'); assert.equal(slugify('   '), 'book'); assert.equal(slugify(''), 'book');
    const long = slugify('Intimate Encounters - Complete Compendium of Everything Ever Written');
    assert.ok(long.length <= 40 && !long.endsWith('-'), long);
});
t('archive hash: 8 hex digits, stable, differs for different names (incl. same slug)', () => {
    assert.match(shortHash('Eldoria'), /^[0-9a-f]{8}$/);
    assert.equal(shortHash('Eldoria'), shortHash('Eldoria'));
    assert.notEqual(shortHash('A/B'), shortHash('A B')); assert.equal(slugify('A/B'), slugify('A B'));
    assert.equal(shortHash(''), '811c9dc5'); // FNV-1a offset basis
});
t('archive file name: LoreReviser-archive__<slug>__<hash>.json, passes ST\'s filename rule', () => {
    for (const name of ['Eldoria', 'Chat Lore', 'Ça/va', '日本語', '.hidden', 'a'.repeat(300), '../../etc/passwd']) {
        const f = archiveFileName(name);
        assert.ok(f.startsWith(ARCHIVE_PREFIX) && f.endsWith('.json'), f);
        assert.match(f, STRULE); assert.ok(isValidFileName(f), f); assert.ok(f.length < 100, f);
        assert.equal(f, `${ARCHIVE_PREFIX}${slugify(name)}__${shortHash(name)}.json`);
    }
    assert.ok(!isValidFileName('a b.json') && !isValidFileName('.x.json') && !isValidFileName('a/b.json'));
});
t('archive file name: never reuses a name already taken by another book', () => {
    const f = archiveFileName('Eldoria');
    const g = archiveFileName('Eldoria', [f]);
    assert.notEqual(f, g); assert.match(g, /^LoreReviser-archive__Eldoria__[0-9a-f]{8}\.json$/);
    assert.equal(archiveFileName('Eldoria', ['something-else.json']), f);
});
t('archive: new / normalize (rejects foreign files, keeps the book name)', () => {
    const a = newArchive('Chat Lore', new Date('2026-10-05T00:00:00Z'));
    assert.deepEqual(a, { format: 'LoreReviser-archive', version: 1, book: 'Chat Lore', created: '2026-10-05T00:00:00.000Z', records: [] });
    assert.equal(normalizeArchive({ hello: 1 }, 'x'), null); assert.equal(normalizeArchive(null, 'x'), null);
    assert.equal(normalizeArchive({ format: 'LoreReviser-archive', records: [] }, 'X').book, 'X');
});
t('archive record: old/new copies, metadata only when present, uid as number', () => {
    const before = { keys: ['a'], secondary: [], content: 'old' }, after = { keys: ['a', 'b'], secondary: ['s'], content: 'new' };
    const r = makeRecord({ action: 'approve', uid: '3', title: 'T', before, after, instructions: 'do it', request: 'shorter', intensity: 'light', changeType: 'retcon', edited: true, now: new Date('2026-10-05T01:02:03Z') });
    assert.equal(r.uid, 3); assert.equal(r.time, '2026-10-05T01:02:03.000Z'); assert.equal(r.action, 'approve'); assert.equal(r.title, 'T');
    assert.deepEqual(r.old, before); assert.deepEqual(r.new, after); assert.notEqual(r.old.keys, before.keys); // copied
    assert.equal(r.instructions, 'do it'); assert.equal(r.request, 'shorter'); assert.equal(r.intensity, 'light'); assert.equal(r.changeType, 'retcon'); assert.equal(r.edited, true);
    assert.ok(r.id);
    const bare = makeRecord({ action: 'undo', uid: 1, title: '', before: after, after: before });
    for (const k of ['instructions', 'request', 'intensity', 'changeType', 'edited', 'restoredFrom']) assert.ok(!(k in bare), k);
    assert.equal(makeRecord({ action: 'restore', uid: 1, before, after, restoredFrom: 'x1' }).restoredFrom, 'x1');
});
t('archive records: per entry, newest first (ties: later appended first); latestRecord', () => {
    const a = newArchive('B');
    const mk = (uid, time, c) => ({ ...makeRecord({ action: 'approve', uid, before: { keys: [], secondary: [], content: '' }, after: { keys: [], secondary: [], content: c } }), time });
    a.records.push(mk(1, '2026-10-05T01:00:00.000Z', 'one'), mk(2, '2026-10-05T02:00:00.000Z', 'two'), mk(1, '2026-10-05T03:00:00.000Z', 'three'), mk(1, '2026-10-05T03:00:00.000Z', 'four'));
    assert.deepEqual(recordsFor(a, 1).map(r => r.new.content), ['four', 'three', 'one']);
    assert.deepEqual(recordsFor(a).map(r => r.new.content), ['four', 'three', 'two', 'one']);
    assert.equal(latestRecord(a, 2).new.content, 'two'); assert.equal(latestRecord(a, 9), null); assert.deepEqual(recordsFor(null, 1), []);
});
t('sameVersion: keys, secondary keys and content all compared', () => {
    const v = { keys: ['a'], secondary: ['b'], content: 'c' };
    assert.ok(sameVersion(v, structuredClone(v)));
    assert.ok(!sameVersion(v, { ...v, content: 'd' })); assert.ok(!sameVersion(v, { ...v, keys: ['a', 'x'] })); assert.ok(!sameVersion(v, { ...v, secondary: [] }));
    assert.ok(!sameVersion(v, null));
});
t('orphans: index entries whose lorebook is gone', () => {
    const index = { Eldoria: 'f1.json', 'Old Name': 'f2.json' };
    assert.deepEqual(findOrphans(index, ['Eldoria', 'New Name']), [{ book: 'Old Name', file: 'f2.json' }]);
    assert.deepEqual(findOrphans({}, ['x']), []);
});
t('relink: renames the index key, keeps the file, refuses to clobber another archive', () => {
    const index = { Eldoria: 'f1.json', 'Old Name': 'f2.json' };
    assert.equal(relinkIndex(index, 'Old Name', 'New Name'), null);
    assert.deepEqual(index, { Eldoria: 'f1.json', 'New Name': 'f2.json' });
    assert.match(relinkIndex(index, 'New Name', 'Eldoria'), /already has its own history/);
    assert.match(relinkIndex(index, 'Nope', 'X'), /no archive/i);
    assert.match(relinkIndex(index, 'New Name', ''), /Pick/);
    assert.deepEqual(index, { Eldoria: 'f1.json', 'New Name': 'f2.json' });
});
t('record action labels are plain words', () => {
    assert.equal(actionLabel('approve'), 'Approved change'); assert.match(actionLabel('restore'), /Restored/); assert.match(actionLabel('undo'), /Undone/);
});

// ---------- clearing old History ----------
{
    const NOW = new Date('2026-10-06T12:00:00.000Z');
    const ago = (days, extraMs = 0) => new Date(NOW.getTime() - days * 86400000 - extraMs).toISOString();
    const mk = (id, time, extra = {}) => ({ ...makeRecord({ action: 'approve', uid: 1, before: { keys: [], secondary: [], content: 'o' }, after: { keys: [], secondary: [], content: id } }), id, time, ...extra });
    const sample = () => { const a = newArchive('B'); a.records.push(mk('a', ago(400)), mk('b', ago(100)), mk('c', ago(30, 1)), mk('d', ago(30)), mk('e', ago(8)), mk('f', ago(1)), mk('g', 'not a date'), mk('h', undefined)); return a; };
    const ids = (list) => list.map(r => r.id).join(',');
    t('clear choices: 7 / 30 / 90 days, 1 year, all; unknown id -> default', () => {
        assert.deepEqual(CLEAR_CHOICES.map(c => c.id), ['7d', '30d', '90d', '1y', 'all']);
        assert.equal(clearChoice('1y').days, 365); assert.equal(clearChoice('all').days, null);
        assert.equal(clearChoice('nope').id, DEFAULT_CLEAR_CHOICE);
        for (const c of CLEAR_CHOICES) assert.match(c.label, /older than|all history/);
    });
    t('clear older than: strict age cutoff, newer records kept', () => {
        const a = sample();
        assert.equal(ids(recordsToClear(a, '7d', NOW)), 'a,b,c,d,e');
        assert.equal(ids(recordsToClear(a, '30d', NOW)), 'a,b,c'); // exactly 30 days old is not "older than"
        assert.equal(ids(recordsToClear(a, '90d', NOW)), 'a,b');
        assert.equal(ids(recordsToClear(a, '1y', NOW)), 'a');
    });
    t('clear older than: records without a readable time are kept', () => {
        const a = sample();
        for (const c of ['7d', '30d', '90d', '1y']) assert.ok(!recordsToClear(a, c, NOW).some(r => r.id === 'g' || r.id === 'h'));
    });
    t('clear all: every record, whatever its time; empty/missing archive -> nothing', () => {
        assert.equal(ids(recordsToClear(sample(), 'all', NOW)), 'a,b,c,d,e,f,g,h');
        assert.deepEqual(recordsToClear(newArchive('B'), 'all', NOW), []);
        assert.deepEqual(recordsToClear(null, '7d', NOW), []);
    });
    t('removeRecords: removes exactly the listed ids, keeps order, notes the clean-up', () => {
        const a = sample();
        const n = removeRecords(a, recordsToClear(a, '90d', NOW).map(r => r.id), { how: '90d', now: NOW });
        assert.equal(n, 2); assert.equal(ids(a.records), 'c,d,e,f,g,h');
        assert.deepEqual(a.cleared, [{ time: NOW.toISOString(), removed: 2, how: '90d' }]);
        assert.equal(a.book, 'B'); assert.equal(a.format, 'LoreReviser-archive');
    });
    t('removeRecords: clear all leaves an empty but valid archive', () => {
        const a = sample();
        assert.equal(removeRecords(a, recordsToClear(a, 'all', NOW).map(r => r.id), { how: 'all', now: NOW }), 8);
        assert.deepEqual(a.records, []); assert.ok(normalizeArchive(a, 'B'));
        assert.equal(recordsFor(a).length, 0);
    });
    t('removeRecords: a record added after confirming is never removed; unknown ids ignored; nothing removed -> no note', () => {
        const a = sample();
        const planned = recordsToClear(a, 'all', NOW).map(r => r.id);
        a.records.push(mk('late', NOW.toISOString()));
        assert.equal(removeRecords(a, planned, { now: NOW }), 8); assert.equal(ids(a.records), 'late');
        assert.equal(removeRecords(a, ['zzz'], { now: NOW }), 0); assert.equal(a.cleared.length, 1);
        assert.equal(removeRecords(null, ['a']), 0);
    });
    t('removeRecords: one record (trash icon)', () => {
        const a = sample();
        assert.equal(removeRecords(a, ['e']), 1); assert.equal(ids(a.records), 'a,b,c,d,f,g,h');
    });
}

// ---------- milestone 5: new entries ----------
t('new-entry reply: single object without id, wrapper keys', () => {
    assert.equal(P('{"title":"Tom","keys":["Tom"],"content":"A smith."}').entries.length, 1);
    assert.equal(P('{"new_entries":[{"title":"A","content":"a"},{"title":"B","content":"b"}]}').entries.length, 2);
    assert.equal(P('{"proposals":[{"title":"A","content":"a"}]}').entries.length, 1);
    const cut = P('{"new_entries":[{"title":"A","content":"a"},{"title":"B","content":"cut');
    assert.equal(cut.entries.length, 1); assert.equal(cut.truncated, true);
    const empty = P('[]'); assert.equal(empty.entries.length, 0); assert.equal(empty.error, null);
});
t('toProposal: field aliases, key strings, trimming, empty dropped', () => {
    const p = toProposal({ title: ' Tom ', keys: 'Tom, smith, Tom', secondary_keys: [], content: 'A smith.', note: ' why ' }, { changeType: 'retcon' });
    assert.deepEqual([p.title, p.keys, p.secondary, p.content, p.note, p.changeType, p.intensity, p.edited], ['Tom', ['Tom', 'smith'], [], 'A smith.', 'why', 'retcon', null, false]);
    const q = toProposal({ comment: 'X', key: ['x'], keysecondary: ['y'], text: 'body' });
    assert.deepEqual([q.title, q.keys, q.secondary, q.content], ['X', ['x'], ['y'], 'body']);
    assert.equal(toProposal({ name: 'N', content: '' }), null);
    assert.equal(toProposal(null), null);
    assert.ok(toProposal({ keys: ['only keys'] }));
    assert.deepEqual(toProposal({ content: 'c', keys: '/a, b/i, c' }, { split: (s) => ['/a, b/i', 'c'] }).keys, ['/a, b/i', 'c']);
    assert.equal(proposalLabel({ title: '', keys: ['a', 'b', 'c', 'd'] }), 'a, b, c'); assert.equal(proposalLabel({ title: 'T', keys: [] }), 'T'); assert.equal(proposalLabel({ title: '', keys: [] }), 'New entry');
    assert.equal(proposalId(0), 'N1');
});
t('settingsFrom copies everything except content, title, keys, uid, displayIndex', () => {
    const src = { uid: 3, key: ['k'], keysecondary: ['s'], comment: 'T', content: 'C', displayIndex: 7, order: 42, position: 4, depth: 2, probability: 70, group: 'royals', characterFilter: { names: ['a'] }, disable: true, selective: false };
    const out = settingsFrom(src);
    for (const k of NOT_COPIED) assert.ok(!(k in out), k);
    assert.deepEqual(out, { order: 42, position: 4, depth: 2, probability: 70, group: 'royals', characterFilter: { names: ['a'] }, disable: true, selective: false });
    out.characterFilter.names.push('b'); assert.deepEqual(src.characterFilter.names, ['a']); // deep copy
    assert.deepEqual(settingsFrom(null), {});
});
t('freeUid skips uids used in the book and in History; nextDisplayIndex goes last', () => {
    assert.equal(freeUid(['0', '1', '2', '3'], []), 4);
    assert.equal(freeUid(['0', '1', '3'], new Set([2, 4])), 5);
    assert.equal(freeUid([], []), 0);
    assert.equal(nextDisplayIndex({ 0: { uid: 0, displayIndex: 0 }, 1: { uid: 1, displayIndex: 9 }, 2: { uid: 5 } }), 10);
    assert.equal(nextDisplayIndex({}), 0);
});
t('proposalWarnings: no keys, no content, duplicate title, shared keys', () => {
    const existing = [{ uid: 0, title: 'Kingdom of Eldoria', keys: ['Eldoria'] }, { uid: 2, title: 'Silverwood', keys: ['Silverwood', 'forest'] }];
    assert.deepEqual(proposalWarnings({ title: 'Tom', keys: ['Tom'], content: 'x' }, existing), []);
    const w = proposalWarnings({ title: 'silverwood', keys: ['Forest'], content: 'x' }, existing);
    assert.equal(w.length, 1); assert.match(w[0], /already has an entry titled "Silverwood" \(#2\)/);
    const w2 = proposalWarnings({ title: 'Woods', keys: ['FOREST', 'eldoria'], content: '' }, existing);
    assert.equal(w2.length, 3); assert.match(w2[0], /no content/); assert.match(w2.join('|'), /"Eldoria" already used by "Kingdom of Eldoria"/); assert.match(w2.join('|'), /"forest" already used by "Silverwood"/);
    assert.match(proposalWarnings({ title: '', keys: [], content: 'x' })[0], /no keys/);
    // the real title (comment) is compared, not the fallback label of an untitled entry
    assert.deepEqual(proposalWarnings({ title: 'Silverwood, forest', keys: ['x'], content: 'x' }, [{ uid: 2, title: 'Silverwood, forest', comment: '', keys: ['y'] }]), []);
});
t('entryMatches compares keys, secondary keys, content and title', () => {
    const e = { key: ['a'], keysecondary: [], content: 'c', comment: 'T' };
    const v = { keys: ['a'], secondary: [], content: 'c' };
    assert.ok(entryMatches(e, v, 'T')); assert.ok(!entryMatches(e, v, 'U')); assert.ok(!entryMatches({ ...e, content: 'd' }, v, 'T'));
    assert.ok(!entryMatches(null, v, 'T')); assert.ok(entryMatches({ key: [], content: '' }, { keys: [], secondary: [], content: '' }, ''));
});
t('new-entry rules check and defaults', () => {
    assert.deepEqual(checkCreateRules(DEFAULT_CREATE_FORMAT_RULES), []);
    assert.equal(checkCreateRules('').length, 1);
    assert.equal(checkCreateRules('Write some prose.').length, 4);
    assert.equal(effectiveCreateRules(''), DEFAULT_CREATE_FORMAT_RULES); assert.equal(effectiveCreateRules('mine'), 'mine');
    assert.equal(effectiveCreatePrompt('  '), DEFAULT_CREATE_SYSTEM_PROMPT);
    assert.match(DEFAULT_CREATE_SYSTEM_PROMPT, /"Change type" section/); assert.doesNotMatch(DEFAULT_CREATE_SYSTEM_PROMPT, /Rewrite intensity/);
});
t('buildCreateMessages: sections, change type (no intensity), format example, regeneration', () => {
    const context = { card: 'Character: Q', lore: '', history: 'User: hi', noChat: false, messagesUsed: 1, messagesTotal: 3 };
    const existing = [{ uid: 0, title: 'Kingdom', keys: ['Eldoria'] }];
    const m = buildCreateMessages({ systemPrompt: 'SYS', changeType: 'retcon', context, book: 'Eldoria', existing, example: { title: 'Queen', keys: ['Maren'], secondary: [], content: 'Stern.' }, instruction: 'Add Tom.' });
    assert.equal(m.length, 2); assert.equal(m[0].role, 'system');
    assert.ok(m[0].content.startsWith('SYS\n\n## Change type: Retcon')); assert.ok(m[0].content.endsWith(DEFAULT_CREATE_FORMAT_RULES)); assert.doesNotMatch(m[0].content, /Rewrite intensity/);
    const u = m[1].content;
    for (const tag of ['<character_card>', '<active_lore>\n(none active)', '<chat_history messages="1 of 3">', '<target_lorebook name="Eldoria" existing_entries="1">', '<existing_entry title="Kingdom" keys=["Eldoria"]/>', '<format_example title="Queen">', 'Stern.', '<instructions>\nAdd Tom.', 'Reply with the JSON array of new entries only.']) assert.ok(u.includes(tag), tag);
    assert.ok(u.indexOf('<target_lorebook') < u.indexOf('<format_example') && u.indexOf('<format_example') < u.indexOf('<instructions>'));
    const noEx = buildCreateMessages({ systemPrompt: 'SYS', changeType: 'development', context: { ...context, noChat: true }, book: 'B', existing: [], instruction: 'x', formatRules: 'MY RULES' })[1].content;
    assert.ok(!noEx.includes('<format_example')); assert.ok(noEx.includes('(the lorebook has no entries yet)')); assert.ok(noEx.includes('messages="0 of 3"'));
    const r = buildCreateMessages({ systemPrompt: 'SYS', changeType: 'development', context, book: 'B', existing: [], instruction: 'x', formatRules: 'MY RULES',
        regen: { id: 'N2', attempts: [{ title: 'Tom', keys: ['Tom'], secondary: [], content: 'v1' }, { title: 'Tom', keys: ['Tom'], secondary: [], content: 'v2', edited: true, request: 'shorter' }], note: 'add his age' } });
    assert.ok(r[0].content.endsWith('MY RULES'));
    assert.ok(r[1].content.includes('<previous_attempts proposal="N2">')); assert.ok(r[1].content.includes('<attempt n="2" edited_by_user="true" user_request="shorter">{"title":"Tom"'));
    assert.match(r[1].content, /<regeneration_request>\nThe user wants a new version of the proposed new entry N2\..*follow it\): add his age Reply with a JSON array containing exactly one entry\./);
    assert.ok(!r[1].content.includes('Reply with the JSON array of new entries only.'));
});
t('History records for new entries: create / remove / recreate', () => {
    const empty = { keys: [], secondary: [], content: '' };
    const c = makeRecord({ action: 'create', uid: 4, title: 'Tom', before: empty, after: { keys: ['Tom'], secondary: [], content: 'A smith.' }, extra: { comment: 'Tom', settingsFrom: { uid: 1, title: 'Queen Maren' }, nothing: null, gone: undefined, uid: 99 } });
    assert.equal(c.uid, 4); assert.equal(c.comment, 'Tom'); assert.deepEqual(c.settingsFrom, { uid: 1, title: 'Queen Maren' }); assert.ok(!('nothing' in c) && !('gone' in c));
    assert.deepEqual(c.old, empty);
    const r = makeRecord({ action: 'remove', uid: 4, title: 'Tom', before: c.new, after: empty, extra: { snapshot: { uid: 4, order: 42 }, via: 'undo' } });
    const rc = makeRecord({ action: 'recreate', uid: 6, title: 'Tom', before: empty, after: c.new, extra: { originalUid: 4 } });
    assert.ok(createdByRecord(c) && createdByRecord(rc) && !createdByRecord(r)); assert.ok(removedByRecord(r) && !removedByRecord(c));
    assert.ok(!createdByRecord(null) && !removedByRecord(undefined));
    assert.deepEqual([...uidsInArchive({ records: [c, r, rc, { uid: 'x' }] })].sort(), [4, 6]);
    assert.deepEqual([...uidsInArchive({ records: [{ uid: 1, snapshot: { uid: 9 } }] })].sort(), [1, 9]);
    assert.equal(uidsInArchive(null).size, 0);
    assert.equal(actionLabel('create'), 'New entry created'); assert.match(actionLabel('remove'), /removed/); assert.match(actionLabel('recreate'), /created again/);
});
t('sentenceSpans: exact slices that join back to the text', () => {
    for (const s of ['A. B! C?\nD e.f g.\n\n  E.  ', '\n\nX. Y', '', 'No end', 'Say "hi." Then. 3.5 is ok.', 'HEIGHT: 180 cm\nHAIR: black\n']) assert.equal(sentenceSpans(s).join(''), s);
    assert.deepEqual(sentenceSpans('One. Two.\nThree'), ['One. ', 'Two.\n', 'Three']);
    assert.deepEqual(sentenceSpans(''), []);
});
t('proposalHunks: changed sentences become hunks, the rest is kept', () => {
    const h = proposalHunks('One. Two. Three.\nFour.', 'One. Deux. Three.\nFour. Five.');
    assert.deepEqual(h.map(x => x.type), ['same', 'change', 'same', 'change']);
    assert.deepEqual([h[1].old, h[1].core, h[1].tail], ['Two.', 'Deux.', ' ']);
    assert.deepEqual([h[3].old, h[3].core], ['', 'Five.']);
    assert.deepEqual(proposalHunks('a. b.', 'a. b.').map(x => x.type), ['same']);
    const del = proposalHunks('A. B. C.', 'A. C.');
    assert.deepEqual(del[1], { type: 'change', old: 'B.', text: '', core: '', tail: '' });
});
t('applyHunkEdits: no edits = the proposal exactly; edits land in place; untouched text stays byte for byte', () => {
    const o = 'NAME: Mara\nHEIGHT: 170 cm\nHAIR: brown, long.\nShe likes  tea.', n = 'NAME: Mara\nHEIGHT: 172 cm\nHAIR: grey, short.\nShe likes  tea.';
    const h = proposalHunks(o, n);
    assert.equal(applyHunkEdits(h), n); assert.equal(applyHunkEdits(h, {}), n);
    const k = h.findIndex(x => x.type === 'change');
    assert.equal(h[k].core, 'HEIGHT: 172 cm\nHAIR: grey, short.');
    assert.equal(applyHunkEdits(h, { [k]: 'HEIGHT: 175 cm\nHAIR: grey, short.' }), 'NAME: Mara\nHEIGHT: 175 cm\nHAIR: grey, short.\nShe likes  tea.');
    const h2 = proposalHunks('One. Two. Three.\nFour.', 'One. Deux. Three.\nFour. Five.');
    assert.equal(applyHunkEdits(h2, { 1: 'Zwei.' }), 'One. Zwei. Three.\nFour. Five.');
    assert.equal(applyHunkEdits(h2, { 1: '' }), 'One. Three.\nFour. Five.'); // emptied hunk is removed
    assert.equal(applyHunkEdits(h2, { 3: '  ' }), 'One. Deux. Three.\nFour.');
});
t('applyHunkEdits: text typed into a pure removal is inserted with matching separators', () => {
    assert.equal(applyHunkEdits(proposalHunks('A. B. C.', 'A. C.'), { 1: 'B2.' }), 'A. B2. C.');
    assert.equal(applyHunkEdits(proposalHunks('A.\nB.\nC.', 'A.\nC.'), { 1: 'B2.' }), 'A.\nB2.\nC.');
    assert.equal(applyHunkEdits(proposalHunks('A. B.', 'A.'), { 1: 'B.' }), 'A. B.');
    assert.equal(applyHunkEdits(proposalHunks('A. B.', 'B.'), { 0: 'A.' }), 'A. B.');
});
t('every default prompt part forbids renaming or misspelling existing headings', () => {
    const parts = { system: DEFAULT_SYSTEM_PROMPT, rules: DEFAULT_FORMAT_RULES, createSystem: DEFAULT_CREATE_SYSTEM_PROMPT, createRules: DEFAULT_CREATE_FORMAT_RULES,
        ...Object.fromEntries(Object.entries(INTENSITIES).map(([k, v]) => [k, v.text])), ...Object.fromEntries(Object.entries(CHANGE_TYPES).map(([k, v]) => [k, v.text])) };
    for (const [name, text] of Object.entries(parts)) assert.match(text, /heading/i, name);
    for (const name of ['system', 'rules', 'createSystem', 'createRules', 'balanced']) assert.match(parts[name], /HIGHT/, name);
    for (const name of ['system', 'rules', 'heavy']) assert.match(parts[name], /explicitly asks/, name);
    assert.match(DEFAULT_FORMAT_RULES, /use \\n in the JSON string\)/); // escaped, not a raw line break
});
t('settings: untouched old default prompts are upgraded, edited ones are kept', () => {
    const store = {};
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings: store, saveSettingsDebounced: () => {} }) };
    assert.ok(LEGACY_DEFAULT_PROMPTS.length >= 4 && LEGACY_CREATE_PROMPTS.length >= 1);
    assert.ok(!LEGACY_DEFAULT_PROMPTS.includes(DEFAULT_SYSTEM_PROMPT) && !LEGACY_CREATE_PROMPTS.includes(DEFAULT_CREATE_SYSTEM_PROMPT));
    store.LoreReviser = { systemPrompt: LEGACY_DEFAULT_PROMPTS[0], createSystemPrompt: LEGACY_CREATE_PROMPTS[0], intensityTexts: { light: 'MINE' } };
    let { settings } = getSettings();
    assert.equal(settings.systemPrompt, DEFAULT_SYSTEM_PROMPT); assert.equal(settings.createSystemPrompt, DEFAULT_CREATE_SYSTEM_PROMPT);
    assert.deepEqual(settings.intensityTexts, { light: 'MINE' });
    store.LoreReviser = { systemPrompt: LEGACY_DEFAULT_PROMPTS[0] + ' (my addition)', createSystemPrompt: 'My own create prompt' };
    ({ settings } = getSettings());
    assert.equal(settings.systemPrompt, LEGACY_DEFAULT_PROMPTS[0] + ' (my addition)'); assert.equal(settings.createSystemPrompt, 'My own create prompt');
    delete globalThis.SillyTavern;
});
console.log(`${n} unit tests passed`);
