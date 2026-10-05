// Unit tests for the pure modules (parse.js, diff.js). Run: node tests/unit.mjs
import assert from 'node:assert/strict';
import { parseRevisionReply as P, integrityWarnings as W, sameAsOriginal } from '../parse.js';
import { normalizeDepth, sliceByDepth, depthLabel } from '../depth.js';
import { removeBlock, dedupeLore, assembleLore } from '../dedupe.js';
import { INTENSITIES, DEFAULT_INTENSITY, normalizeIntensity, intensitySection, intensityText } from '../intensity.js';
import { CHANGE_TYPES, DEFAULT_CHANGE_TYPE, normalizeChangeType, changeTypeText, changeTypeSection } from '../changetype.js';
import { wiBudget, wiScanContext, budgetNote } from '../budget.js';
import { DEFAULT_FORMAT_RULES, checkFormatRules, effectiveFormatRules, FORMAT_RULES_NOTE } from '../rules.js';
import { DEFAULT_SYSTEM_PROMPT } from '../settings.js';
import { blockDiff, splitBlocks, listDiff } from '../diff.js';
import { slugify, shortHash, archiveFileName, isValidFileName, ARCHIVE_PREFIX, newArchive, normalizeArchive, makeRecord, recordsFor, latestRecord, sameVersion, findOrphans, relinkIndex, actionLabel } from '../archive-core.js';

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
console.log(`${n} unit tests passed`);
