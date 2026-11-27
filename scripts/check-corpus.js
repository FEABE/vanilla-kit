#!/usr/bin/env node
/**
 * scripts/check-corpus.js — runs browser/minify.js over every .js / .mjs / .cjs file under the given folders
 * and checks each result against independent oracles.
 *
 *   node scripts/check-corpus.js <dir>... [--exclude <dir name>]... [--json report.json] [--verbose] [--crlf]
 *
 *   For every file the original is first classified with V8 (script, CommonJS function body, or ES module).
 *   Files V8 rejects are reported separately and not counted. For the others:
 *     1. whitespace-only and mangled output must compile in the same mode as the original,
 *        and so must minify(minify(x));
 *     2. whitespace-only output must have the identical token sequence and statement starts (inspect());
 *     3. mangled output must resolve every identifier to the same declaration (and keep every global name);
 *     4. a mangled build of the minifier itself must produce byte-identical output (self-hosting check).
 *   "refused" counts files V8 accepts but the minifier cannot read (it throws instead of guessing).
 *   Folders named node_modules and .git are always skipped; --exclude skips more folder names before reading them.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

if (typeof vm.SourceTextModule !== 'function' && !process.env.CHECK_CORPUS_CHILD) {
    const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', __filename, ...process.argv.slice(2)],
        { stdio: 'inherit', env: Object.assign({}, process.env, { CHECK_CORPUS_CHILD: '1' }) });
    process.exit(r.status === null ? 1 : r.status);
}

const M = require('../browser/minify.js');

const args = process.argv.slice(2);
const roots = [], skip = new Set(['node_modules', '.git']);
let jsonOut = null, verbose = false, crlf = false;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude') skip.add(args[++i]);
    else if (args[i] === '--json') jsonOut = args[++i];
    else if (args[i] === '--verbose') verbose = true;
    else if (args[i] === '--crlf') crlf = true;   // check every file again with CRLF line endings
    else roots.push(args[i]);
}
if (!roots.length) { process.stderr.write('usage: check-corpus <dir>... [--exclude name]... [--json out] [--verbose]\n'); process.exit(2); }

function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
        if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name), out); }
        else if (e.isFile() && /\.(m|c)?js$/.test(e.name)) out.push(path.join(dir, e.name));
    }
}

function nearestType(file) {
    for (let d = path.dirname(file); ; d = path.dirname(d)) {
        const p = path.join(d, 'package.json');
        if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf8')).type || 'commonjs'; } catch (e) { return 'commonjs'; } }
        if (path.dirname(d) === d) return 'commonjs';
    }
}
function compiles(code, mode) {
    try {
        if (mode === 'script') new vm.Script(code);
        else if (mode === 'cjs') vm.compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname']);
        else new vm.SourceTextModule(code);
        return null;
    } catch (e) { return e.message; }
}
function classify(file, src) {
    const ext = path.extname(file);
    const order = ext === '.mjs' ? ['module'] : ext === '.cjs' ? ['cjs'] :
        nearestType(file) === 'module' ? ['module', 'script'] : ['script', 'cjs', 'module'];
    for (const m of order) if (!compiles(src, m)) return m;
    return null;
}

// Mangled build of the minifier, loaded like a browser script.
const selfSrc = fs.readFileSync(path.join(__dirname, '..', 'browser', 'minify.js'), 'utf8');
const selfMin = M.minify(selfSrc).code;
const ctx = { self: {} };
vm.runInNewContext(selfMin, ctx);
const M2 = ctx.self.VanillaMinify;

function sameTokens(a, b) {
    if (a.length !== b.length) return 'token count ' + a.length + ' -> ' + b.length;
    for (let i = 0; i < a.length; i++) {
        if (a[i].type !== b[i].type || a[i].text !== b[i].text) return 'token ' + i + ' ' + JSON.stringify(a[i]) + ' -> ' + JSON.stringify(b[i]);
    }
    return null;
}
function sameList(a, b, what) {
    if (a.length !== b.length) return what + ' count ' + a.length + ' -> ' + b.length;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return what + ' ' + i + ': ' + a[i] + ' -> ' + b[i];
    return null;
}
function sameOccurrences(a, b) {
    if (a.length !== b.length) return 'occurrence count ' + a.length + ' -> ' + b.length;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (x.binding !== y.binding) return 'occurrence ' + i + ' (' + x.name + ' -> ' + y.name + ') binding ' + x.binding + ' -> ' + y.binding;
        if ((x.binding === null || x.kept) && x.name !== y.name) return 'kept name changed ' + x.name + ' -> ' + y.name;
    }
    return null;
}

const files = [];
for (const r of roots) walk(path.resolve(r), files);
const report = { files: files.length, invalidOriginal: [], refused: [], failures: [], modes: {}, raw: 0, ws: 0, mangled: 0, skippedRename: [] };
for (const file of files) {
    let src = fs.readFileSync(file, 'utf8');
    if (crlf) src = src.split('\r\n').join('\n').split('\n').join('\r\n');
    const mode = classify(file, src);
    if (!mode) { report.invalidOriginal.push(file); continue; }
    report.modes[mode] = (report.modes[mode] || 0) + 1;
    let ws, mg;
    try {
        ws = M.minify(src, { mangle: false });
        mg = M.minify(src);
    } catch (e) {
        report.refused.push({ file, mode, error: e.message });
        continue;
    }
    const problems = [];
    let err;
    if ((err = compiles(ws.code, mode))) problems.push('whitespace output does not compile: ' + err);
    if ((err = compiles(mg.code, mode))) problems.push('mangled output does not compile: ' + err);
    try {
        const again = M.minify(mg.code);
        if ((err = compiles(again.code, mode))) problems.push('minify(minify(x)) does not compile: ' + err);
        const wsAgain = M.minify(ws.code, { mangle: false });
        if (wsAgain.code !== ws.code) problems.push('whitespace pass is not idempotent');
    } catch (e) { problems.push('cannot re-read output: ' + e.message); }
    try {
        const a = M.inspect(src), w = M.inspect(ws.code), g = M.inspect(mg.code);
        if ((err = sameTokens(a.tokens, w.tokens))) problems.push('whitespace tokens differ: ' + err);
        if ((err = sameList(a.statements, w.statements, 'statement start'))) problems.push('whitespace statements differ: ' + err);
        if (a.statements.length !== g.statements.length) problems.push('mangled statement count ' + a.statements.length + ' -> ' + g.statements.length);
        if ((err = sameOccurrences(a.occurrences, g.occurrences))) problems.push('mangled resolution differs: ' + err);
    } catch (e) { problems.push('inspect failed: ' + e.message); }
    try {
        if (M2.minify(src, { mangle: false }).code !== ws.code) problems.push('self-hosted minifier differs (whitespace)');
        if (M2.minify(src).code !== mg.code) problems.push('self-hosted minifier differs (mangled)');
    } catch (e) { problems.push('self-hosted minifier threw: ' + e.message); }
    if (mg.skipped) report.skippedRename.push({ file, reason: mg.skipped });
    if (problems.length) report.failures.push({ file, mode, problems });
    report.raw += Buffer.byteLength(src);
    report.ws += Buffer.byteLength(ws.code);
    report.mangled += Buffer.byteLength(mg.code);
    if (verbose) process.stdout.write((problems.length ? 'FAIL ' : 'ok   ') + file + '\n');
}

const checked = files.length - report.invalidOriginal.length;
const pct = (x) => (100 * x / report.raw).toFixed(1) + '%';
process.stdout.write([
    'files found:        ' + files.length,
    'V8 rejects original: ' + report.invalidOriginal.length + ' (not counted)',
    'checked:            ' + checked + ' ' + JSON.stringify(report.modes),
    'refused (throws):   ' + report.refused.length,
    'oracle failures:    ' + report.failures.length,
    'rename skipped:     ' + report.skippedRename.length + ' (eval / with / escapes)',
    'bytes raw:          ' + report.raw,
    'bytes whitespace:   ' + report.ws + ' (' + pct(report.ws) + ')',
    'bytes mangled:      ' + report.mangled + ' (' + pct(report.mangled) + ')',
    ''
].join('\n'));
for (const r of report.refused) process.stdout.write('REFUSED ' + r.file + ' [' + r.mode + ']: ' + r.error + '\n');
for (const f of report.failures) process.stdout.write('FAIL ' + f.file + ' [' + f.mode + ']:\n  ' + f.problems.join('\n  ') + '\n');
if (verbose) for (const f of report.invalidOriginal) process.stdout.write('INVALID ' + f + '\n');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
process.exit(report.failures.length ? 1 : 0);
