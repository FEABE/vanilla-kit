'use strict';
/**
 * node/zip.js — ZIP writer.
 * Checks: CRC-32 known answers and agreement with node:zlib, structure re-read by an independent test reader,
 * name validation (path traversal etc.), limits, and — when the tools exist on this machine — that the archive
 * is accepted by the operating system's own extractors (bsdtar / PowerShell Expand-Archive / unzip).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync, spawnSync } = require('node:child_process');
const Z = require('../node/zip.js');
const { readZip } = require('./helpers/read-zip.js');

const FIXED = new Date(2026, 0, 2, 3, 4, 6);

function sampleEntries() {
    return [
        { name: 'hello.txt', data: 'Hello, zip!\n' },
        { name: 'dir/', },
        { name: 'dir/repeat.txt', data: 'abc'.repeat(1000) },
        { name: 'dir/random.bin', data: Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7919 + 13) & 255)) },
        { name: 'unicode-\u00e9\u00e8-\uD55C\uAE00.txt', data: 'UTF-8 name \u2713' },
        { name: 'empty.txt', data: '' }
    ];
}

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'vkit-' + tag + '-')); }

test('crc32: known answers and agreement with node:zlib', function () {
    assert.equal(Z.crc32('123456789'), 0xCBF43926);
    assert.equal(Z.crc32(''), 0);
    assert.equal(Z.crc32('The quick brown fox jumps over the lazy dog'), 0x414FA339);
    if (typeof zlib.crc32 === 'function') {
        for (let n = 0; n < 200; n++) {
            const b = Buffer.from(Array.from({ length: n * 13 }, (_, i) => (i * 31 + n) & 255));
            assert.equal(Z.crc32(b), zlib.crc32(b) >>> 0);
        }
    }
});

test('structure: entries read back with the same bytes, UTF-8 flag, methods, date', function () {
    const entries = sampleEntries();
    const buf = Z.zip(entries, { date: FIXED });
    const read = readZip(buf);
    assert.deepEqual(read.map((e) => e.name), entries.map((e) => e.name));
    for (let i = 0; i < entries.length; i++) {
        const want = entries[i].data == null ? Buffer.alloc(0) : Buffer.from(entries[i].data);
        assert.deepEqual(read[i].data, want, entries[i].name);
        assert.equal(read[i].flags & 0x0800, 0x0800, 'UTF-8 flag');
    }
    // repetitive text deflates, random-ish bytes and tiny files are stored
    assert.equal(read.find((e) => e.name === 'dir/repeat.txt').method, 8);
    assert.equal(read.find((e) => e.name === 'hello.txt').method, 0);
    // directory entry: Unix dir mode + MS-DOS directory bit
    const dir = read.find((e) => e.name === 'dir/');
    assert.equal(dir.externalAttrs >>> 16, 0o40755);
    assert.equal(dir.externalAttrs & 0x10, 0x10);
    // DOS date/time: 2026-01-02 03:04:06
    const d = read[0];
    assert.equal(d.dosDate, ((2026 - 1980) << 9) | (1 << 5) | 2);
    assert.equal(d.dosTime, (3 << 11) | (4 << 5) | 3);
});

test('deterministic output with a fixed date; compress: false stores everything', function () {
    const a = Z.zip(sampleEntries(), { date: FIXED });
    const b = Z.zip(sampleEntries(), { date: FIXED });
    assert.deepEqual(a, b);
    const stored = readZip(Z.zip(sampleEntries(), { date: FIXED, compress: false }));
    assert.ok(stored.every((e) => e.method === 0));
    const perEntry = readZip(Z.zip([{ name: 'a.txt', data: 'x'.repeat(5000), compress: false }], { date: FIXED }));
    assert.equal(perEntry[0].method, 0);
    // Uint8Array input
    const u8 = readZip(Z.zip([{ name: 'u8.bin', data: new Uint8Array([1, 2, 3]) }], { date: FIXED }));
    assert.deepEqual([...u8[0].data], [1, 2, 3]);
});

test('empty archive is a valid 22-byte zip', function () {
    const buf = Z.zip([]);
    assert.equal(buf.length, 22);
    assert.deepEqual(readZip(buf), []);
});

test('unsafe entry names are rejected', function () {
    const bad = [
        '', '/etc/passwd', '../evil.txt', 'a/../../evil.txt', 'a/..', './a', 'a/./b', 'a//b', '..', '.',
        'C:evil.txt', 'c:/windows/x', 'a\\..\\b', 'dir\\file.txt', 'nul\u0000.txt', 'line\nbreak', 'del\u007f', '//server/share'
    ];
    for (const name of bad) {
        assert.throws(() => Z.zip([{ name, data: 'x' }]), Error, JSON.stringify(name));
    }
    assert.throws(() => Z.zip([{ name: 123, data: 'x' }]), TypeError);
    assert.throws(() => Z.zip([{ name: 'a.txt', data: 'x' }, { name: 'a.txt', data: 'y' }]), /duplicate/);
    assert.throws(() => Z.zip([{ name: 'd/', data: 'x' }]), /directory entry cannot have data/);
    assert.throws(() => Z.zip([{ name: 'a.txt', data: { not: 'data' } }]), TypeError);
    assert.throws(() => Z.zip(null), TypeError);
    // ordinary names are fine
    for (const ok of ['a', 'a.b.c', '...dots', '..a', 'a..', 'deep/er/path/file.txt', 'with space.txt', 'folder/']) {
        assert.doesNotThrow(() => Z.zip([{ name: ok }]), ok);
    }
});

test('limits: more than 65535 entries is refused (no ZIP64)', function () {
    const many = Array.from({ length: 65536 }, (_, i) => ({ name: 'f' + i }));
    assert.throws(() => Z.zip(many), RangeError);
});

test('dates outside the MS-DOS range are clamped', function () {
    const early = readZip(Z.zip([{ name: 'a', data: 'x', date: new Date(1970, 0, 1) }]))[0];
    assert.equal(early.dosDate, (0 << 9) | (1 << 5) | 1);
    const late = readZip(Z.zip([{ name: 'a', data: 'x', date: new Date(2200, 0, 1) }]))[0];
    assert.equal(late.dosDate >> 9, 127);
});

// -- The operating system's own tools --------------------------------------------------------------------

function writeSample() {
    const dir = tmpDir('zip');
    const file = path.join(dir, 'sample.zip');
    fs.writeFileSync(file, Z.zip(sampleEntries(), { date: FIXED }));
    return { dir, file };
}

function checkExtracted(root) {
    for (const e of sampleEntries()) {
        const p = path.join(root, ...e.name.split('/').filter(Boolean));
        if (e.name.endsWith('/')) { assert.ok(fs.statSync(p).isDirectory(), e.name); continue; }
        assert.deepEqual(fs.readFileSync(p), Buffer.from(e.data == null ? '' : e.data), e.name);
    }
}

const BSDTAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null;
const hasBsdtar = BSDTAR && fs.existsSync(BSDTAR);

test('OS: Windows bsdtar (tar.exe) lists and extracts the archive', { skip: !hasBsdtar && 'Windows tar.exe not available' }, function () {
    const { dir, file } = writeSample();
    // tar.exe prints names in the console code page, so compare the ASCII names here; the extraction below
    // checks the Unicode name through the file system.
    const list = execFileSync(BSDTAR, ['-tf', file], { encoding: 'latin1' }).split(/\r?\n/).filter(Boolean);
    const ascii = (names) => names.filter((n) => /^[\x20-\x7e]+$/.test(n)).sort();
    assert.equal(list.length, sampleEntries().length);
    assert.deepEqual(ascii(list), ascii(sampleEntries().map((e) => e.name)));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    execFileSync(BSDTAR, ['-xf', file, '-C', out]);
    checkExtracted(out);
});

const hasPowerShell = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status === 0;

test('OS: PowerShell Expand-Archive extracts the archive', { skip: !hasPowerShell && 'PowerShell not available' }, function () {
    const { dir, file } = writeSample();
    const out = path.join(dir, 'ps-out');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:VKIT_ZIP -DestinationPath $env:VKIT_OUT -Force'],
    { env: Object.assign({}, process.env, { VKIT_ZIP: file, VKIT_OUT: out }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    checkExtracted(out);
});

const hasUnzip = process.platform !== 'win32' && spawnSync('unzip', ['-v']).status === 0;

test('OS: unzip -t reports no errors', { skip: !hasUnzip && 'unzip not available' }, function () {
    const { file } = writeSample();
    const r = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No errors detected/);
});
