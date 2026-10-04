// Unit tests for the pure modules (parse.js, diff.js). Run: node tests/unit.mjs
import assert from 'node:assert/strict';
import { parseRevisionReply as P, integrityWarnings as W, sameAsOriginal } from '../parse.js';
import { wordDiff, listDiff } from '../diff.js';

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

t('wordDiff basics', () => {
    const d = wordDiff('The queen is 54 years old.', 'The queen is 55 years old.');
    assert.deepEqual(d.map(x => x.type), ['same', 'del', 'ins', 'same']);
    assert.equal(d.map(x => x.type === 'ins' ? '' : x.text).join(''), 'The queen is 54 years old.');
    assert.equal(d.map(x => x.type === 'del' ? '' : x.text).join(''), 'The queen is 55 years old.');
});
t('wordDiff identical / empty', () => {
    assert.deepEqual(wordDiff('a b', 'a b'), [{ type: 'same', text: 'a b' }]);
    assert.deepEqual(wordDiff('', 'new'), [{ type: 'ins', text: 'new' }]);
});
t('wordDiff big input does not blow up', () => {
    const a = Array.from({ length: 3000 }, (_, i) => 'w' + i).join(' '), b = Array.from({ length: 3000 }, (_, i) => 'v' + i).join(' ');
    const d = wordDiff(a, b); assert.ok(d.length >= 2);
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
console.log(`${n} unit tests passed`);
