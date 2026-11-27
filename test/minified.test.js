'use strict';
/**
 * The minified builds must behave exactly like the source: the whole test suite runs again with VANILLA_KIT_MIN=1,
 * which loads browser modules from dist/*.min.js and Node modules minified in memory (test/helpers/subject.js).
 * Also checks that dist/ is up to date with the sources.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build, MODULES } = require('../scripts/build-min.js');

const ROOT = path.join(__dirname, '..');

test('dist/*.min.js is up to date and starts with a license line', function () {
    for (const name of MODULES) {
        const file = path.join(ROOT, 'dist', name + '.min.js');
        assert.ok(fs.existsSync(file), 'missing dist/' + name + '.min.js — run node scripts/build-min.js');
        const code = fs.readFileSync(file, 'utf8');
        assert.equal(code, build(name), 'dist/' + name + '.min.js is out of date — run node scripts/build-min.js');
        assert.match(code, /^\/\*! vanilla-kit \d+\.\d+\.\d+ \| browser\/[a-z]+\.js \| MIT License \| \(c\) 2026 FEABE \*\/\n/);
        assert.ok(!/\r/.test(code));
    }
});

test('the whole suite passes against the minified builds', { skip: process.env.VANILLA_KIT_MIN === '1' }, function () {
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f !== 'minified.test.js').map((f) => path.join(__dirname, f));
    const env = Object.assign({}, process.env, { VANILLA_KIT_MIN: '1' });
    delete env.NODE_TEST_CONTEXT;   // otherwise the child thinks it is nested inside this run and skips the files
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: ROOT, encoding: 'utf8', env, timeout: 300000 });
    const tail = (r.stdout || '').slice(-6000) + (r.stderr || '').slice(-2000);
    assert.equal(r.status, 0, tail);
    assert.match(r.stdout, /ℹ fail 0/, tail);
});
