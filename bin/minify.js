#!/usr/bin/env node
/**
 * bin/minify.js — command line for browser/minify.js. Zero dependencies.
 * Part of vanilla-kit. MIT License.
 *
 *   node bin/minify.js <in.js> [-o out.js] [--no-mangle] [--keep-fnames] [--no-keep-classnames] [--no-license]
 *       [--banner "text"]
 *
 *   Writes to stdout unless -o is given (writing with -o avoids shells that re-encode redirected output).
 *   Line endings of the input are normalized to \n first, so the result is the same on every OS.
 *   --banner prepends one comment line, e.g. --banner "x.js 1.0 | MIT License" -> /*! x.js 1.0 | MIT License *\/
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { minify } = require(path.join(__dirname, '..', 'browser', 'minify.js'));

function usage(msg) {
    if (msg) process.stderr.write(msg + '\n');
    process.stderr.write('usage: minify <in.js> [-o out.js] [--no-mangle] [--keep-fnames] [--no-keep-classnames] [--no-license] [--banner text]\n');
    process.exit(2);
}

const args = process.argv.slice(2);
let input = null, output = null, banner = null;
const opts = { mangle: true, keepLicense: true, keepFnames: false, keepClassnames: true };
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') { output = args[++i]; if (!output) usage('-o needs a file name'); }
    else if (a === '--no-mangle') opts.mangle = false;
    else if (a === '--keep-fnames') opts.keepFnames = true;
    else if (a === '--no-keep-classnames') opts.keepClassnames = false;
    else if (a === '--no-license') opts.keepLicense = false;
    else if (a === '--banner') { banner = args[++i]; if (banner == null) usage('--banner needs text'); }
    else if (a === '-h' || a === '--help') usage();
    else if (a[0] === '-' && a !== '-') usage('unknown option ' + a);
    else if (input === null) input = a;
    else usage('only one input file');
}
if (input === null) usage();

let src = input === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(input, 'utf8');
if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);   // byte order mark
src = src.replace(/\r\n?/g, '\n');
let result;
try {
    result = minify(src, opts);
} catch (e) {
    process.stderr.write((input === '-' ? 'stdin' : input) + ': ' + e.message + '\n');
    process.exit(1);
}
if (banner !== null && /\*\//.test(banner)) usage('--banner must not contain */');
let code = result.code;
if (banner !== null) {
    // keep a #! line first
    const m = /^#![^\n]*\n/.exec(code);
    code = m ? m[0] + '/*! ' + banner + ' */\n' + code.slice(m[0].length) : '/*! ' + banner + ' */\n' + code;
}
code += '\n';
if (output) fs.writeFileSync(output, code);
else process.stdout.write(code);
if (result.skipped) process.stderr.write('note: names were not shortened (' + result.skipped + ')\n');
