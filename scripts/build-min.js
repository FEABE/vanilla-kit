#!/usr/bin/env node
/**
 * scripts/build-min.js — writes dist/<name>.min.js for every browser module, using browser/minify.js.
 *
 *   node scripts/build-min.js          build
 *   node scripts/build-min.js --check  exit 1 if a dist file is missing or out of date (nothing is written)
 *
 * Input line endings are normalized to \n, so the output is byte-identical on every OS and from `git archive`.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { minify } = require('../browser/minify.js');

const ROOT = path.join(__dirname, '..');
const MODULES = ['qr', 'markdown', 'diff', 'color', 'minify'];

function version() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }

function build(name) {
    const src = fs.readFileSync(path.join(ROOT, 'browser', name + '.js'), 'utf8').replace(/\r\n?/g, '\n');
    const r = minify(src);
    if (r.skipped) throw new Error(name + '.js: names were not shortened (' + r.skipped + ')');
    return '/*! vanilla-kit ' + version() + ' | browser/' + name + '.js | MIT License | (c) 2026 FEABE */\n' + r.code + '\n';
}

if (require.main === module) {
    const check = process.argv.includes('--check');
    let stale = 0;
    fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
    for (const name of MODULES) {
        const out = path.join(ROOT, 'dist', name + '.min.js');
        const code = build(name);
        const now = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
        if (check) {
            if (now !== code) { stale++; process.stdout.write('out of date: dist/' + name + '.min.js\n'); }
            continue;
        }
        fs.writeFileSync(out, code);
        const raw = fs.statSync(path.join(ROOT, 'browser', name + '.js')).size;
        process.stdout.write('dist/' + name + '.min.js  ' + raw + ' -> ' + Buffer.byteLength(code) + ' bytes\n');
    }
    process.exit(stale ? 1 : 0);
}

module.exports = { build, MODULES };
