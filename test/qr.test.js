'use strict';
/**
 * browser/qr.js — QR encoder.
 * Checks: (1) codewords of the standard example (HELLO WORLD, 1-M), (2) format / version information bits
 *         against the published tables, (3) finder, timing and dark-module placement, (4) a small decoder in this
 *         test re-reads every matrix: format info, codewords, Reed-Solomon syndromes and the original text.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../browser/qr.js');

// -- Independent GF(256) for the syndrome check --
const EXP = [], LOG = [];
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } }
const mul = (a, b) => (a && b) ? EXP[(LOG[a] + LOG[b]) % 255] : 0;

// -- Independent mask predicates (ISO/IEC 18004 table 10), (i = row, j = column) --
const MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
    (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0,
    (i, j) => ((i + j) % 2 + (i * j) % 3) % 2 === 0
];

test('HELLO WORLD 1-M: data and EC codewords (standard example)', function () {
    const qr = Q.encode('HELLO WORLD', { ecl: 'M' });
    assert.equal(qr.version, 1);
    assert.equal(qr.mode, 'alphanumeric');
    assert.deepEqual(qr.dataCodewords, [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
    assert.deepEqual(Q.rsEncode(qr.dataCodewords, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    assert.deepEqual(qr.codewords.slice(16), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('format information bits (standard table)', function () {
    assert.equal(Q.bitString(Q.formatBits('L', 4), 15), '110011000101111');
    assert.equal(Q.bitString(Q.formatBits('M', 0), 15), '101010000010010');
    assert.equal(Q.bitString(Q.formatBits('Q', 0), 15), '011010101011111');
    assert.equal(Q.bitString(Q.formatBits('Q', 7), 15), '010101111101101');
    assert.equal(Q.bitString(Q.formatBits('H', 0), 15), '001011010001001');
});

test('version information bits', function () {
    assert.equal(Q.bitString(Q.versionBits(7), 18), '000111110010010100');
    assert.equal(Q.bitString(Q.versionBits(40), 18), '101000110001101001');
});

test('capacity tables: data codeword counts and alignment pattern positions', function () {
    assert.deepEqual(['L', 'M', 'Q', 'H'].map((e) => Q.dataCodewordCount(1, e)), [19, 16, 13, 9]);
    assert.deepEqual(['L', 'M', 'Q', 'H'].map((e) => Q.dataCodewordCount(40, e)), [2956, 2334, 1666, 1276]);
    assert.equal(Q.dataCodewordCount(5, 'Q'), 62);
    assert.equal(Q.dataCodewordCount(10, 'H'), 122);
    assert.equal(Q.totalCodewords(40), 3706);
    assert.deepEqual(Q.alignmentPositions(1), []);
    assert.deepEqual(Q.alignmentPositions(7), [6, 22, 38]);
    assert.deepEqual(Q.alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
    assert.deepEqual(Q.alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

test('mode selection and automatic version selection (maximum capacity)', function () {
    assert.equal(Q.pickMode('0123456789'), 'numeric');
    assert.equal(Q.pickMode('HELLO WORLD'), 'alphanumeric');
    assert.equal(Q.pickMode('hello'), 'byte');
    assert.equal(Q.pickMode('한글'), 'byte');
    assert.deepEqual(Q.utf8('가'), [0xEA, 0xB0, 0x80]);
    assert.equal(Q.encode('a'.repeat(2953), { ecl: 'L' }).version, 40);
    assert.throws(() => Q.encode('a'.repeat(2954), { ecl: 'L' }), (e) => e.code === 'TOO_LONG');
    assert.equal(Q.encode('1'.repeat(7089), { ecl: 'L' }).version, 40);
    assert.throws(() => Q.encode('1'.repeat(7090), { ecl: 'L' }));
    assert.equal(Q.encode('A'.repeat(4296), { ecl: 'L' }).version, 40);
    assert.equal(Q.encode('a'.repeat(17), { ecl: 'L' }).version, 1);
    assert.equal(Q.encode('a'.repeat(18), { ecl: 'L' }).version, 2);
    assert.equal(Q.encode('a'.repeat(1273), { ecl: 'H' }).version, 40);
});

test('option validation: mask, mode, version range, ecl', function () {
    assert.throws(() => Q.encode('x', { mask: 8 }), RangeError);
    assert.throws(() => Q.encode('x', { mask: 1.5 }), RangeError);
    assert.throws(() => Q.encode('x', { ecl: 'Z' }), RangeError);
    assert.throws(() => Q.encode('x', { ecl: 'constructor' }), RangeError);
    assert.throws(() => Q.encode('abc', { mode: 'numeric' }), RangeError);
    assert.throws(() => Q.encode('abc', { mode: 'alphanumeric' }), RangeError);
    assert.throws(() => Q.encode('x', { mode: 'kanji' }), RangeError);
    assert.throws(() => Q.encode('x', { minVersion: 0 }), RangeError);
    assert.throws(() => Q.encode('x', { minVersion: 10, maxVersion: 5 }), RangeError);
    assert.throws(() => Q.encode('x'.repeat(100), { maxVersion: 2 }), (e) => e.code === 'TOO_LONG');
    assert.equal(Q.encode('123', { mode: 'byte' }).mode, 'byte');
    assert.equal(Q.encode('x', { ecl: 'h' }).ecl, 'H');
});

function checkFinder(m, x0, y0) {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(m[y0 + dy][x0 + dx], d !== 2, 'finder ' + x0 + ',' + y0);
    }
}

test('structure: finders, separators, timing, dark module', function () {
    for (const v of [1, 2, 7, 14, 40]) {
        const qr = Q.encode('x', { ecl: 'L', minVersion: v });
        const m = qr.modules, n = qr.size;
        assert.equal(qr.version, v);
        assert.equal(n, v * 4 + 17);
        checkFinder(m, 0, 0); checkFinder(m, n - 7, 0); checkFinder(m, 0, n - 7);
        for (let i = 0; i < 8; i++) {
            assert.equal(m[7][i], false); assert.equal(m[i][7], false);
            assert.equal(m[7][n - 1 - i], false); assert.equal(m[n - 1 - i][7], false);
        }
        for (let i = 8; i < n - 8; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
        assert.equal(m[n - 8][8], true);
    }
});

// -- Small decoder (error-free matrices only) --
const ECLS = ['L', 'M', 'Q', 'H'];
function popcount(x) { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; }

function readFormat(m) {
    const n = m.length;
    let a = 0, b = 0;
    const bitA = (i, v) => { if (v) a |= 1 << i; };
    const bitB = (i, v) => { if (v) b |= 1 << i; };
    for (let i = 0; i <= 5; i++) bitA(i, m[i][8]);
    bitA(6, m[7][8]); bitA(7, m[8][8]); bitA(8, m[8][7]);
    for (let j = 9; j < 15; j++) bitA(j, m[8][14 - j]);
    for (let k = 0; k < 8; k++) bitB(k, m[8][n - 1 - k]);
    for (let l = 8; l < 15; l++) bitB(l, m[n - 15 + l][8]);
    let best = null;
    for (const e of ECLS) for (let mask = 0; mask < 8; mask++) {
        const f = Q.formatBits(e, mask);
        const d = popcount(f ^ a);
        if (!best || d < best.d) best = { e, mask, d, b: popcount(f ^ b) };
    }
    return best;
}

function readVersion(m) {
    const n = m.length;
    let a = 0, b = 0;
    for (let i = 0; i < 18; i++) {
        const p = n - 11 + i % 3, q = Math.floor(i / 3);
        if (m[q][p]) a |= 1 << i;   // top-right
        if (m[p][q]) b |= 1 << i;   // bottom-left
    }
    return { a, b };
}

// Function-pattern area, computed by the decoder on its own.
function functionArea(ver) {
    const n = ver * 4 + 17;
    const fn = Array.from({ length: n }, () => new Array(n).fill(false));
    const mark = (x, y) => { if (x >= 0 && y >= 0 && x < n && y < n) fn[y][x] = true; };
    // top-left 9x9 (finder + separator + format); top-right and bottom-left: 8 columns + format strip
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) mark(x, y);
    for (let y = 0; y < 9; y++) for (let x = 0; x < 8; x++) { mark(n - 1 - x, y); mark(y, n - 1 - x); }
    for (let i = 0; i < n; i++) { mark(6, i); mark(i, 6); }
    const al = Q.alignmentPositions(ver);
    for (const ax of al) for (const ay of al) {
        const last = al[al.length - 1];
        if ((ax === 6 && ay === 6) || (ax === 6 && ay === last) || (ax === last && ay === 6)) continue;   // finder positions
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(ax + dx, ay + dy);
    }
    if (ver >= 7) for (let i = 0; i < 18; i++) { const p = n - 11 + i % 3, q = Math.floor(i / 3); mark(p, q); mark(q, p); }
    return fn;
}

function decode(m) {
    const n = m.length, ver = (n - 17) / 4;
    const fmt = readFormat(m);
    assert.equal(fmt.d, 0, 'format info, first copy');
    assert.equal(fmt.b, 0, 'format info, second copy');
    if (ver >= 7) { const vi = readVersion(m); assert.equal(vi.a, Q.versionBits(ver)); assert.equal(vi.b, Q.versionBits(ver)); }
    const fn = functionArea(ver);
    const mf = MASKS[fmt.mask];
    const bits = [];
    for (let right = n - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
            const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
            if (fn[y][x]) continue;
            bits.push((m[y][x] !== mf(y, x)) ? 1 : 0);
        }
    }
    const total = Q.totalCodewords(ver);
    const cw = [];
    for (let i = 0; i < total; i++) { let v = 0; for (let t = 0; t < 8; t++) v = (v << 1) | bits[i * 8 + t]; cw.push(v); }
    // de-interleave
    const nb = Q.numBlocks(ver, fmt.e), ecc = Q.eccPerBlock(ver, fmt.e);
    const shortLen = Math.floor(total / nb), numShort = nb - total % nb;
    const blocks = Array.from({ length: nb }, (_, i) => ({ data: [], ecc: [], dlen: shortLen - ecc + (i < numShort ? 0 : 1) }));
    let k = 0;
    const maxD = shortLen - ecc + 1;
    for (let c = 0; c < maxD; c++) for (const b of blocks) if (c < b.dlen) b.data.push(cw[k++]);
    for (let c = 0; c < ecc; c++) for (const b of blocks) b.ecc.push(cw[k++]);
    assert.equal(k, total);
    // RS syndromes: the codeword polynomial must vanish at the generator roots a^0..a^(ecc-1)
    for (const b of blocks) {
        const word = b.data.concat(b.ecc);
        for (let r = 0; r < ecc; r++) {
            const alpha = EXP[r];
            let s = 0;
            for (const c of word) s = mul(s, alpha) ^ c;
            assert.equal(s, 0, 'syndrome v' + ver + fmt.e);
        }
    }
    const data = [].concat(...blocks.map((b) => b.data));
    // unpack the bit stream (single segment)
    const ds = []; for (const b of data) for (let t = 7; t >= 0; t--) ds.push((b >> t) & 1);
    let p = 0; const take = (len) => { let v = 0; for (let i = 0; i < len; i++) v = (v << 1) | ds[p++]; return v; };
    const mode = take(4), gi = ver <= 9 ? 0 : ver <= 26 ? 1 : 2;
    let text = '';
    const AN = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
    if (mode === 1) {
        let cnt = take([10, 12, 14][gi]);
        while (cnt >= 3) { text += String(take(10)).padStart(3, '0'); cnt -= 3; }
        if (cnt === 2) text += String(take(7)).padStart(2, '0'); else if (cnt === 1) text += String(take(4));
    } else if (mode === 2) {
        let cnt = take([9, 11, 13][gi]);
        while (cnt >= 2) { const v = take(11); text += AN[Math.floor(v / 45)] + AN[v % 45]; cnt -= 2; }
        if (cnt) text += AN[take(6)];
    } else if (mode === 4) {
        const cnt = take([8, 16, 16][gi]); const bytes = [];
        for (let i = 0; i < cnt; i++) bytes.push(take(8));
        text = Buffer.from(bytes).toString('utf8');
    } else throw new Error('mode ' + mode);
    return { ver, ecl: fmt.e, mask: fmt.mask, data, text };
}

test('round trip through the test decoder: several versions, levels and modes', function () {
    const cases = [
        ['HELLO WORLD', 'M', 1],
        ['https://example.com/한글/path?q=1', 'L', 0],
        ['x'.repeat(40), 'Q', 5],
        ['y'.repeat(100), 'H', 10],
        ['0123456789'.repeat(50), 'M', 0],
        ['ABC $%*+-./:'.repeat(30), 'Q', 0],
        ['가나다 🎉 emoji'.repeat(10), 'H', 0],
        ['z'.repeat(2953), 'L', 40]
    ];
    for (const [text, ecl, wantVer] of cases) {
        const qr = Q.encode(text, { ecl, minVersion: wantVer || 1 });
        if (wantVer) assert.equal(qr.version, wantVer, text.slice(0, 10));
        const out = decode(qr.modules);
        assert.equal(out.ver, qr.version);
        assert.equal(out.ecl, ecl);
        assert.equal(out.mask, qr.mask);
        assert.deepEqual(out.data, qr.dataCodewords);
        assert.equal(out.text, text);
    }
});

test('every version 1-40 x L/M/Q/H: round trip and RS syndromes', function () {
    for (let v = 1; v <= 40; v++) for (const e of ECLS) {
        const qr = Q.encode('V' + v + e, { ecl: e, minVersion: v, mask: v % 8 });
        assert.equal(qr.version, v);
        const out = decode(qr.modules);
        assert.equal(out.text, 'V' + v + e);
        assert.equal(out.mask, v % 8);
    }
});

test('byte-mode capacity (part of the standard capacity table)', function () {
    const maxBytes = (v, e) => { const d = Q.dataCodewordCount(v, e) * 8 - 4 - (v <= 9 ? 8 : 16); return Math.floor(d / 8); };
    assert.deepEqual(['L', 'M', 'Q', 'H'].map((e) => maxBytes(10, e)), [271, 213, 151, 119]);
    assert.deepEqual(['L', 'M', 'Q', 'H'].map((e) => maxBytes(20, e)), [858, 666, 482, 382]);
    assert.deepEqual(['L', 'M', 'Q', 'H'].map((e) => maxBytes(30, e)), [1732, 1370, 982, 742]);
});

test('all 8 masks decode; automatic choice has the lowest penalty', function () {
    const scores = [];
    for (let mask = 0; mask < 8; mask++) {
        const qr = Q.encode('QR CODE 1234', { ecl: 'Q', mask });
        assert.equal(qr.mask, mask);
        assert.equal(decode(qr.modules).text, 'QR CODE 1234');
        scores.push(Q._penalty(qr.modules));
    }
    const auto = Q.encode('QR CODE 1234', { ecl: 'Q' });
    assert.equal(auto.penalty, Math.min(...scores));
    assert.equal(scores[auto.mask], auto.penalty);
});

test('SVG: colour values are validated, size is right', function () {
    const qr = Q.encode('HELLO WORLD', { ecl: 'M' });
    const svg = Q.toSvg(qr, { border: 4, dark: '#123456', light: '"><script>' });
    assert.match(svg, /viewBox="0 0 29 29"/);
    assert.match(svg, /fill="#123456"/);
    assert.match(svg, /fill="#ffffff"/);
    assert.doesNotMatch(svg, /script/);
    // the number of dark unit squares in the path equals the number of dark modules
    let dark = 0; for (const row of qr.modules) for (const c of row) if (c) dark++;
    let area = 0; svg.replace(/h(\d+)v1/g, (_, w) => { area += Number(w); });
    assert.equal(area, dark);
});
