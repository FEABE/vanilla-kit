'use strict';
/**
 * node/docx.js — .docx writer.
 * Checks: the package unzips (independent test reader, CRC verified), every part is well-formed XML (a strict
 * checker in this file, and the .NET XML parser through PowerShell when available), content types and
 * relationships point at parts that exist, nothing references anything outside the package, the text survives
 * with escaping, and invalid XML characters are removed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { docx, escapeXml } = require('../node/docx.js');
const { readZip } = require('./helpers/read-zip.js');

const DATE = new Date('2026-01-02T03:04:06Z');

function sample() {
    return docx({
        title: 'Quarterly <Report> & "Notes"',
        creator: 'Team',
        body: [
            { title: true, text: 'Title line' },
            { heading: 1, text: 'Heading one' },
            'A plain paragraph.\nWith a line break\tand a tab.',
            { text: ['Mixed ', { text: 'bold', bold: true }, ', ', { text: 'italic', italic: true }, ', ', { text: 'under', underline: true },
                ', ', { text: 'struck', strike: true }, ' and ', { text: 'code()', code: true }, '.'] },
            { heading: 2, text: 'Escaping' },
            '<script>alert("x")</script> & </w:t></w:r></w:p><w:p>injected',
            { text: 'Café ✓ 한글 🎉', align: 'center' },
            { pageBreak: true },
            { heading: 3, text: 'Last page', align: 'right' }
        ]
    }, { date: DATE });
}

// -- Strict little XML well-formedness checker -------------------------------------------------------------
function checkXml(xml, label) {
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), label + ': XML declaration');
    let s = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
    const stack = [];
    let roots = 0;
    const ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/;
    const NAME = '[A-Za-z_][A-Za-z0-9_.:-]*';
    const TAG = new RegExp('^<(/?)(' + NAME + ')((?:\\s+' + NAME + '="[^"<]*")*)\\s*(/?)>');
    let i = 0;
    while (i < s.length) {
        if (s[i] === '<') {
            const m = TAG.exec(s.slice(i));
            assert.ok(m, label + ': malformed tag at ' + JSON.stringify(s.slice(i, i + 40)));
            const [all, close, name, attrs, selfClose] = m;
            // attribute values: & only as an entity, no duplicates
            const seen = new Set();
            attrs.replace(new RegExp('(' + NAME + ')="([^"]*)"', 'g'), function (_, n, v) {
                assert.ok(!seen.has(n), label + ': duplicate attribute ' + n);
                seen.add(n);
                for (let k = v.indexOf('&'); k >= 0; k = v.indexOf('&', k + 1)) assert.ok(ENTITY.test(v.slice(k)), label + ': bare & in attribute');
            });
            if (close) {
                assert.ok(!selfClose && !attrs.trim(), label + ': odd closing tag');
                assert.equal(stack.pop(), name, label + ': mismatched </' + name + '>');
            } else if (!selfClose) {
                if (!stack.length) roots++;
                stack.push(name);
            } else if (!stack.length) roots++;
            i += all.length;
        } else {
            const next = s.indexOf('<', i);
            const text = s.slice(i, next < 0 ? s.length : next);
            if (!stack.length) assert.equal(text.trim(), '', label + ': text outside the root');
            for (let k = text.indexOf('&'); k >= 0; k = text.indexOf('&', k + 1)) assert.ok(ENTITY.test(text.slice(k)), label + ': bare & in text');
            assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/.test(text), label + ': invalid XML character');
            i += text.length;
        }
    }
    assert.equal(stack.length, 0, label + ': unclosed ' + stack.join(','));
    assert.equal(roots, 1, label + ': exactly one root element');
}

function partsOf(buf) {
    const entries = readZip(buf);
    const parts = {};
    for (const e of entries) parts[e.name] = e.data.toString('utf8');
    return parts;
}

function documentText(xml) {
    // w:t contents joined, w:br as \n, w:tab as \t, paragraphs separated by \n\n; entities decoded
    return xml.split('</w:p>').map(function (p) {
        let out = '';
        p.replace(/<w:t xml:space="preserve">([^<]*)<\/w:t>|<w:br\/>|<w:tab\/>/g, function (m, t) {
            out += t != null ? t : m === '<w:br/>' ? '\n' : '\t';
        });
        return out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }).filter(Boolean);
}

test('package: expected parts, all well-formed XML', function () {
    const parts = partsOf(sample());
    assert.deepEqual(Object.keys(parts).sort(), [
        '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml'
    ]);
    for (const name of Object.keys(parts)) checkXml(parts[name], name);
});

test('package: content-type overrides and relationships resolve to existing parts; nothing external', function () {
    const parts = partsOf(sample());
    const overrides = [...parts['[Content_Types].xml'].matchAll(/PartName="\/([^"]+)"/g)].map((m) => m[1]);
    for (const p of overrides) assert.ok(parts[p] != null, 'override for missing part ' + p);
    for (const p of Object.keys(parts)) {
        const ext = p.split('.').pop();
        assert.ok(overrides.includes(p) || ext === 'rels' || ext === 'xml', 'content type for ' + p);
    }
    const rootTargets = [...parts['_rels/.rels'].matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
    for (const t of rootTargets) assert.ok(parts[t] != null, 'root relationship target ' + t);
    const docTargets = [...parts['word/_rels/document.xml.rels'].matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
    for (const t of docTargets) assert.ok(parts['word/' + t] != null, 'document relationship target ' + t);
    for (const name of Object.keys(parts)) {
        assert.doesNotMatch(parts[name], /TargetMode="External"/, name);
        assert.doesNotMatch(parts[name], /r:(link|embed|id)=/, name);
    }
    // the document uses only styles that styles.xml defines
    const defined = [...parts['word/styles.xml'].matchAll(/w:styleId="([^"]+)"/g)].map((m) => m[1]);
    for (const m of parts['word/document.xml'].matchAll(/w:pStyle w:val="([^"]+)"/g)) assert.ok(defined.includes(m[1]), 'style ' + m[1]);
});

test('text, runs and escaping survive', function () {
    const parts = partsOf(sample());
    const doc = parts['word/document.xml'];
    const paras = documentText(doc);
    assert.deepEqual(paras.slice(0, 4), [
        'Title line',
        'Heading one',
        'A plain paragraph.\nWith a line break\tand a tab.',
        'Mixed bold, italic, under, struck and code().'
    ]);
    assert.equal(paras[5], '<script>alert("x")</script> & </w:t></w:r></w:p><w:p>injected');
    assert.equal(paras[6], 'Café ✓ 한글 🎉');
    assert.match(doc, /<w:pStyle w:val="Title"\/>/);
    assert.match(doc, /<w:pStyle w:val="Heading1"\/>/);
    assert.match(doc, /<w:pStyle w:val="Heading3"\/><w:jc w:val="right"\/>/);
    assert.match(doc, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">bold<\/w:t>/);
    assert.match(doc, /<w:br w:type="page"\/>/);
    const core = parts['docProps/core.xml'];
    assert.match(core, /<dc:title>Quarterly &lt;Report&gt; &amp; &quot;Notes&quot;<\/dc:title>/);
    assert.match(core, /<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:06Z<\/dcterms:created>/);
});

test('characters XML 1.0 cannot hold are removed', function () {
    assert.equal(escapeXml('a\u0000b\u0001c\u000bd\u001fe￿f'), 'abcdef');
    assert.equal(escapeXml('tab\tlf\ncr\r'), 'tab\tlf\ncr\r');
    assert.equal(escapeXml('lone \uD800 high, lone \uDC00 low, pair 🎉'), 'lone  high, lone  low, pair 🎉');
    const parts = partsOf(docx({ title: 'bad\u0000title', body: ['x\u0008y\uDFFFz'] }, { date: DATE }));
    for (const name of Object.keys(parts)) checkXml(parts[name], name);
    assert.deepEqual(documentText(parts['word/document.xml']), ['xyz']);
});

test('deterministic with a fixed date; empty document is valid; bad input throws', function () {
    assert.deepEqual(sample(), sample());
    const empty = partsOf(docx({}, { date: DATE }));
    for (const name of Object.keys(empty)) checkXml(empty[name], name);
    assert.throws(() => docx({ body: 'not an array' }), TypeError);
    assert.throws(() => docx({ body: [{ heading: 4, text: 'x' }] }), RangeError);
    assert.throws(() => docx({ body: [{ text: 'x', align: 'middle' }] }), RangeError);
    assert.throws(() => docx({ body: [42] }), TypeError);
    assert.throws(() => docx({}, { date: new Date('nope') }), RangeError);
});

const hasPowerShell = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status === 0;

test('OS: every part parses with the .NET XML parser (PowerShell)', { skip: !hasPowerShell && 'PowerShell not available' }, function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkit-docx-'));
    const file = path.join(dir, 'sample.zip');
    fs.writeFileSync(file, sample());
    const out = path.join(dir, 'x');
    const script = [
        'Expand-Archive -LiteralPath $env:VKIT_FILE -DestinationPath $env:VKIT_OUT -Force',
        '$n = 0',
        'Get-ChildItem -LiteralPath $env:VKIT_OUT -Recurse -File | ForEach-Object {',
        '  $d = New-Object System.Xml.XmlDocument; $d.Load($_.FullName); $n++ }',
        'Write-Output "parsed=$n"'
    ].join('\n');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: Object.assign({}, process.env, { VKIT_FILE: file, VKIT_OUT: out }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /parsed=6/);
    assert.ok(fs.existsSync(path.join(out, '[Content_Types].xml')));
});
