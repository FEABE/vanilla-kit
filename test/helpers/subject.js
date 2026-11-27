'use strict';
/**
 * Loads a module under test.
 *   Default: the readable source (require).
 *   VANILLA_KIT_MIN=1: the minified build — browser modules from dist/<name>.min.js (exactly the shipped files),
 *   Node modules minified in memory with browser/minify.js. test/minified.test.js runs the whole suite this way.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..', '..');
const MINIFIED = process.env.VANILLA_KIT_MIN === '1';
const cache = new Map();

function subject(rel) {
    const file = path.join(ROOT, rel);
    if (!MINIFIED) return require(file);
    if (cache.has(rel)) return cache.get(rel);
    let code, filename;
    if (rel.startsWith('browser/')) {
        filename = path.join(ROOT, 'dist', path.basename(rel, '.js') + '.min.js');
        code = fs.readFileSync(filename, 'utf8');
    } else {
        const { minify } = require(path.join(ROOT, 'browser', 'minify.js'));
        filename = file.replace(/\.js$/, '.min.js');
        code = minify(fs.readFileSync(file, 'utf8')).code;
    }
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(code, filename);
    cache.set(rel, m.exports);
    return m.exports;
}
subject.minified = MINIFIED;
module.exports = subject;
