// Unit tests for the pure modules (parse.js, diff.js). Run: node tests/unit.mjs
import assert from 'node:assert/strict';
import { parseRevisionReply as P, integrityWarnings as W, sameAsOriginal } from '../parse.js';
import { normalizeDepth, sliceByDepth, depthLabel } from '../depth.js';
import { blockDiff, splitBlocks, listDiff } from '../diff.js';

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
console.log(`${n} unit tests passed`);
