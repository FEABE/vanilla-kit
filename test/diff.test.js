'use strict';
/**
 * browser/diff.js — Myers diff.
 * Checks: (1) the result rebuilds both inputs exactly, (2) the number of equal lines equals the longest common
 * subsequence (LCS), i.e. the edit script is minimal.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('./helpers/subject.js')('browser/diff.js');

function lcsLength(a, b) {
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
    return dp[a.length][b.length];
}
function rebuild(ops) {
    return {
        a: ops.filter((o) => o.type !== 'ins').map((o) => o.text),
        b: ops.filter((o) => o.type !== 'del').map((o) => o.type === 'equal' ? o.other : o.text)
    };
}

test('simple change: added, removed and edited lines with line numbers', function () {
    const ops = D.diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
    assert.deepEqual(ops.map((o) => o.type + ':' + o.text), ['equal:a', 'del:b', 'ins:B', 'equal:c', 'equal:d', 'ins:e']);
    assert.deepEqual(ops.map((o) => [o.a, o.b]), [[1, 1], [2, null], [null, 2], [3, 3], [4, 4], [null, 5]]);
    assert.deepEqual(D.stats(ops), { added: 2, removed: 1, same: 3 });
});

test('300 random pairs: both sides rebuild, and the script is minimal (LCS)', function () {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let round = 0; round < 300; round++) {
        const len = () => Math.floor(rnd() * 25);
        const gen = () => Array.from({ length: len() }, () => 'xyzw'[Math.floor(rnd() * 4)]);
        const a = gen(), b = gen();
        const ops = D.diffLines(a.join('\n'), b.join('\n'));
        const r = rebuild(ops);
        assert.deepEqual(r.a, a, 'a ' + a.join('') + ' / ' + b.join(''));
        assert.deepEqual(r.b, b, 'b ' + a.join('') + ' / ' + b.join(''));
        assert.equal(ops.filter((o) => o.type === 'equal').length, lcsLength(a, b), a.join('') + ' / ' + b.join(''));
    }
});

test('empty input, CRLF, trailing newline', function () {
    assert.deepEqual(D.diffLines('', ''), []);
    assert.deepEqual(D.diffLines('', 'x').map((o) => o.type), ['ins']);
    assert.deepEqual(D.diffLines('a\r\nb\r\n', 'a\nb').map((o) => o.type), ['equal', 'equal']);
    assert.deepEqual(D.diffLines(null, undefined), []);
});

test('options: ignore whitespace, ignore case', function () {
    assert.deepEqual(D.diffLines('  if (x)  {\n', 'if (x) {\n', { ignoreWhitespace: true }).map((o) => o.type), ['equal']);
    assert.deepEqual(D.diffLines('Hello\n', 'hello\n', { ignoreCase: true }).map((o) => o.type), ['equal']);
    assert.deepEqual(D.diffLines('Hello\n', 'hello\n').map((o) => o.type), ['del', 'ins']);
    const eq = D.diffLines('Hello\n', 'hello\n', { ignoreCase: true })[0];
    assert.equal(eq.text, 'Hello');
    assert.equal(eq.other, 'hello');
});

test('word-level diff within a line', function () {
    const w = D.diffWords('const total = price * 2;', 'const total = price * 3;');
    assert.deepEqual(w.filter((p) => p.type !== 'equal'), [{ type: 'del', text: '2' }, { type: 'ins', text: '3' }]);
    const k = D.diffWords('price is 1000 won', 'price is 1200 won');
    assert.equal(k.filter((p) => p.type === 'equal').map((p) => p.text).join(''), 'price is  won');
    const u = D.diffWords('café au lait', 'café noir');
    assert.equal(u[0].type, 'equal');
    assert.equal(u[0].text, 'café ');
});

test('hunks: 3 lines of context, nearby hunks merged', function () {
    const a = Array.from({ length: 40 }, (_, i) => 'line ' + i);
    const b = a.slice(); b[5] = 'changed 5'; b[8] = 'changed 8'; b[30] = 'changed 30';
    const ops = D.diffLines(a.join('\n'), b.join('\n'));
    const h = D.hunks(ops, 3);
    assert.equal(h.length, 2, JSON.stringify(h));
    assert.ok(h[0].start <= 2 && h[1].end >= 34);
    assert.deepEqual(D.hunks(D.diffLines('a\nb', 'a\nb')), []);
});

test('large input stays fast (20,000 lines, a few edits)', function () {
    const a = Array.from({ length: 20000 }, (_, i) => 'row ' + i);
    const b = a.slice(); b.splice(100, 1); b.splice(15000, 0, 'inserted'); b[19000] = 'edited';
    const t0 = Date.now();
    const ops = D.diffLines(a.join('\n'), b.join('\n'));
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual(D.stats(ops), { added: 2, removed: 2, same: 19998 });
});

test('edit distance above the limit falls back to delete + insert, still rebuildable', function () {
    const a = Array.from({ length: 5000 }, (_, i) => 'a' + i);
    const b = Array.from({ length: 5000 }, (_, i) => 'b' + i);
    const ops = D.diffLines(a.join('\n'), b.join('\n'));
    const r = rebuild(ops);
    assert.deepEqual(r.a, a);
    assert.deepEqual(r.b, b);
});
