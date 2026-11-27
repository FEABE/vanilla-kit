'use strict';
/**
 * browser/minify.js — the main check is behavioral: run the original and the minified code and compare what they print.
 * Every tricky construct runs in both modes (whitespace only and mangled), sloppy and strict where both are valid.
 * Names are only shortened inside functions, so code that should be shortened is wrapped in one.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const Min = require('./helpers/subject.js')('browser/minify.js');
const { minify, inspect, tokenize } = Min;

const ROOT = path.join(__dirname, '..');
const LS = String.fromCharCode(0x2028);

async function run(code) {
    const logs = [];
    const sandbox = { out: (v) => logs.push(typeof v === 'string' ? v : JSON.stringify(v)), Promise, setTimeout };
    vm.runInNewContext(code, sandbox, { timeout: 2000 });
    await new Promise((r) => setImmediate(r));
    return logs;
}
// Both modes must print the same as the original, and the output must keep the original's structure.
async function same(src, note) {
    const want = await run(src);
    const ws = minify(src, { mangle: false });
    const mg = minify(src);
    assert.deepEqual(await run(ws.code), want, (note || '') + '\n--- whitespace ---\n' + ws.code);
    assert.deepEqual(await run(mg.code), want, (note || '') + '\n--- mangled ---\n' + mg.code);
    const a = inspect(src);
    assert.deepEqual(inspect(ws.code).tokens, a.tokens, (note || '') + ' tokens');
    assert.deepEqual(inspect(ws.code).statements, a.statements, (note || '') + ' statements');
    assert.deepEqual(inspect(mg.code).occurrences.map((o) => o.binding), a.occurrences.map((o) => o.binding), (note || '') + ' bindings');
    return { ws: ws.code, mg: mg.code, info: mg };
}
const wrap = (body) => '(function () {\n' + body + '\n})();';
const strict = (body) => '(function () {\n"use strict";\n' + body + '\n})();';
async function both(body, note) { await same(wrap(body), (note || '') + ' [sloppy]'); return same(strict(body), (note || '') + ' [strict]'); }

// ---------------------------------------------------------------- whitespace and comments

test('comments and indentation go, behavior stays', async function () {
    const src = [
        '// total',
        'function total(items, rate) {',
        '    /* loop */',
        '    var sum = 0;',
        '    for (var i = 0; i < items.length; i++) {',
        '        sum += items[i].price * items[i].qty;',
        '    }',
        '    return Math.round(sum * (1 - rate));',
        '}',
        'out(total([{ price: 1000, qty: 2 }, { price: 350, qty: 3 }], 0.1));'
    ].join('\n');
    const r = await same(src);
    assert.ok(r.ws.length < src.length * 0.8, r.ws);
    assert.doesNotMatch(r.ws, /total\b.*loop/);
});

test('automatic semicolon insertion is preserved', async function () {
    await same('var a = 1\nvar b = 2\nout(a + b)\nlet c = a\n++b\nout([a, b, c])');
    await same('function f() {\n  return\n  42\n}\nout(String(f()))', 'return + newline');
    await same('var x = 5\nvar y = x\n-1\nout(y)', 'next line starting with -');
    await same('var s = "a"\nvar t = s\n;[1, 2].forEach(function (v) { out(v) })');
    await same('var i = 0\ni++\nout(i)\nvar j = 3\n--j\nout(j)');
    await same('const o = { a: 1 }\nconst p = o\n.a\nout(p)');
    await same('var f = function () { return 1 }\n(function () { out("called with iife") })', 'function expression then ( on next line is a call');
    await same('var g = () => {}\n/x/.test("x") && out("regex statement")', 'arrow then regex on next line: ASI');
    await same('var a = 8, b = 2, g = 2\nvar r = a\n/b/g\nout(r)', 'a newline / b / g is a division');
    await same('function* gen() { var v = yield\n1; out(String(v)) } var it = gen(); it.next(); it.next(5)', 'yield + newline');
    await same('var n = 0; while (n < 3) { n++; if (n < 2) continue\nout(n) }', 'continue + newline');
    await same('var m = 0; outer: while (m < 3) { m++; for (;;) { if (m > 1) break\nm; break } out(m) }', 'break + newline');
    await same('do out("once"); while (false) out("after do-while without semicolon")');
    await same('if (true)\n  out("if body on next line")\nelse\n  out("no")');
    await same('var x = 1\nif (x) {\n}\n(function () { out("block then paren") })()');
    await same('class A { a = 1\n b = 2\n static c\n ["d"] = 4 }\nout(Object.keys(new A()))', 'class fields with ASI');
    await same('var lineSep = 1' + LS + 'out(lineSep)', 'U+2028 between statements is a line break');
});

test('strings, regular expressions and templates are left untouched', async function () {
    await same('var u = "http://example.com/*x*/  a"; out(u)');
    await same("var q = 'it\\'s // fine'; out(q)");
    await same('var r = /\\/\\/[a-z]+ \\/*/g; out("//abc /*".replace(r, "X"))');
    await same('var re = /[/]+/; out(re.test("a/b"))', '/ inside a character class');
    await same('var n = 10, m = 2, k = n / m / 1; out(k)', 'division is not a regex');
    await same('var name = "v"; out(`hi  ${ name  +  `nested ${ 1 + 1 }` }  // not comment`)');
    await same('out(`a\n  b`)', 'line break inside a template');
    await same('var o = { t: `x${ { a: 1 }.a }y` }; out(o.t)', 'object literal braces inside ${ }');
    await same('out(`${ /}/.source }`)', 'regex with } inside ${ }');
    await same('var s = "a\\\r\nb"; out(s)', 'CRLF line continuation inside a string');
    await same('var s = "a' + LS + 'b"; out(s.length)', 'U+2028 inside a string');
});

test('regex or division: decided by the parser, not guessed', async function () {
    await same('var s = "  "; if (true) / +/.test(s) && out("regex after if (...)")');
    await same('var s = "\'"; if (true) /\'/.test(s) && out("quote inside regex after if (...)")');
    await same('while (false) {}\n/ +/.test(" ") && out("regex after a block")');
    await same('function f() {}\n/ +/.test(" ") && out("regex after a function declaration")');
    await same('class K {}\n/ +/.test(" ") && out("regex after a class declaration")');
    await same('var o = { return: 8, typeof: 4 }; out(o.return / 2 / o.typeof)', 'keyword-named properties divide');
    await same('out({ valueOf() { return 6 } } / 2)', 'object literal then division');
    await same('var a = [4]; out(a[0] / 2); out((8) / 2 / 1)');
    await same('var i = 4; i++ / 2; out(i++ / 2)');
    await same('function* g() { yield /a+/.source } out(g().next().value)');
    await same('var x = 4 / /2/.source.length; out(x)');
    await same('out(typeof /x/); out(!/x/.test("y")); out([/a/, /b/g].length)');
    await same('switch (1) { case 1: /x/.test("x") && out("regex after case :") }');
    await same('var t = true ? /a/ : /b/; out(t.source)');
});

test('tokens that would merge keep a space', async function () {
    await same('var a = 1, b = 2; out(a + +b); out(a - -b); out(a - --b); out(b); out(a+ ++b)');
    await same('out(1 .toString()); out(1.5.toFixed(1)); out(.5 + 1); out(1_000 .toFixed(1)); out(1..toString())');
    await same('out(typeof "x"); out(void 0 === undefined); var o = {}; out("a" in o); out(o instanceof Object)');
    await same('function* g() { yield 1; yield* [2, 3] } out([...g()])');
    await same('async function f() { return await Promise.resolve(1) } f().then(out); out(0)');
    await same('var x = 3; out(x-- > 2); out(x)', '-- followed by >');
    await same('var y = 1; out(y < !--y)', '< followed by !--');
    await same('out(true?.5:1); out(false ? .5 : 2)');
});

test('kept license comments: verbatim, without new line breaks', async function () {
    const src = '#!/usr/bin/env node\n/*! keep me | MIT */\n// drop me\n/** @license Apache-2.0 */\nout(1)';
    const kept = minify(src).code;
    assert.match(kept, /^#!\/usr\/bin\/env node\n/);
    assert.match(kept, /\/\*! keep me \| MIT \*\//);
    assert.match(kept, /@license Apache-2.0/);
    assert.doesNotMatch(kept, /drop me/);
    const dropped = minify(src, { keepLicense: false }).code;
    assert.doesNotMatch(dropped, /keep me|@license/);
    // a kept comment in the middle of a statement must not add a line break (return + newline returns undefined)
    await same(wrap('function f() { return /*! inline */ 1 } out(f())'));
    await same(wrap('var a = 1 + //! line comment keeps its own line break\n 2; out(a)'));
    await same(wrap('var b = 3 /*! between */ / /*! more */ 1; out(b)'));
    assert.equal(minify('var x = 1 /*! a */ + /*! b */ 2').code, 'var x=1 /*! a */+ /*! b */2');
});

test('modern syntax: classes, private names, optional chaining, logical assignment, BigInt', async function () {
    await same([
        'class Counter { #n = 0; static of(v) { const c = new Counter(); c.#n = v; return c } inc() { this.#n++; return this } get value() { return this.#n } static has(o) { return #n in o } }',
        'out(Counter.of(2).inc().inc().value); out(Counter.has(new Counter()))',
        'const { a = 1, ...rest } = { b: 2, c: 3 }; out([a, rest])',
        'const o = { p: { q: null } }; out(o?.p?.q ?? "none"); out(o.x?.y)',
        'const big = 2n ** 64n; out(big.toString())',
        'let z = null; z ??= 5; z ||= 6; z &&= 7; out(z)',
        'const add = (x, y = 2) => x + y; out(add(1))',
        'label: for (const v of [1, 2, 3]) { if (v === 2) continue label; out(v) }',
        'class S { static #count = 1; static { S.ready = S.#count } } out(S.ready)'
    ].join('\n'));
});

test('unreadable input throws with a position instead of guessing', function () {
    assert.throws(() => minify('var a = 1;\nvar s = "abc\n'), /line 2/);
    assert.throws(() => minify('/* never closed'), /comment/);
    assert.throws(() => minify('var t = `abc ${ 1 + 2'), /template/);
    assert.throws(() => minify('var x = 1 <!-- html comment'), /HTML-like/);
    assert.throws(() => minify('x = 1\n--> html comment'), /HTML-like/);
    assert.throws(() => minify('@decorator class X {}'), /Unexpected/);
    assert.throws(() => minify('var el = <div />;'), Error);
    assert.throws(() => minify('a b'), /Expected ";"/);
    assert.throws(() => minify('if (x) {'), /Unterminated block/);
});

// ---------------------------------------------------------------- mangling

test('local names get short, globals and properties stay', async function () {
    const r = await same(wrap([
        'function total(itemsList, discountRate) {',
        '  var runningSum = 0;',
        '  for (var index = 0; index < itemsList.length; index++) runningSum += itemsList[index].price * itemsList[index].qty;',
        '  return Math.round(runningSum * (1 - discountRate));',
        '}',
        'out(total([{ price: 1000, qty: 2 }, { price: 350, qty: 3 }], 0.1));'
    ].join('\n')));
    assert.ok(r.info.renamed >= 4, JSON.stringify(r.info));
    assert.doesNotMatch(r.mg, /runningSum|itemsList|discountRate/);
    assert.match(r.mg, /\.price/);
    const top = await same('var topLevel = 1; function helper(value) { return value + topLevel } out(helper(2)); out(typeof Math.max)');
    assert.match(top.mg, /var topLevel=1/);
    assert.match(top.mg, /function helper\(/);
});

test('shadowing: a new name never hides an outer name or a global', async function () {
    await both([
        'var alpha = 1, beta = 2;',
        'function inner(gamma) { var delta = gamma + alpha; return function (eps) { return delta + eps + beta + Math.abs(-1) } }',
        'out(inner(10)(100));',
        'var shadow = "outer"; { let shadow = "inner"; out(shadow) } out(shadow);',
        'function usesGlobal() { var local = 5; return local + (typeof a === "undefined" ? 0 : a) + (typeof b === "undefined" ? 0 : b) }',
        'out(usesGlobal());'
    ].join('\n'));
    await same('var a = 100, b = 200;\n' + wrap('function f(longName, otherName) { return longName + otherName + a + b } out(f(1, 2));'));
});

test('hoisting, block scopes, catch, labels, switch', async function () {
    await both([
        'function hoist() { out(typeof later); return later(); function later() { return "ok" } }',
        'out(hoist());',
        'function useVarBefore() { out(String(counter)); var counter = 3; return counter }',
        'out(useVarBefore());',
        'function blocks() { var res = []; for (let k = 0; k < 3; k++) { const sq = k * k; res.push(() => sq) } return res.map((fn) => fn()) }',
        'out(blocks());',
        'function tc() { try { throw new Error("boom") } catch (errObj) { return errObj.message } }',
        'out(tc());',
        'function tcNoParam() { try { JSON.parse("{") } catch { return "bad" } }',
        'out(tcNoParam());',
        'function catchLet() { try { throw 1 } catch (first) { const second = first + 1; let third = second + 1; return [first, second, third] } }',
        'out(catchLet());',
        'function labels() { var hits = 0; outer: for (var i = 0; i < 3; i++) { for (var j = 0; j < 3; j++) { if (j === 1) continue outer; hits++ } } return hits }',
        'out(labels());',
        'function labelLikeVar() { var outer = 1; outer: { if (outer) break outer; outer = 2 } return outer }',
        'out(labelLikeVar());',
        'function inBlock() { var r; if (true) { var deep = 7; r = deep } return r + deep }',
        'out(inBlock());',
        'function sw(v) { switch (v) { case 1: { let inner = "one"; return inner } default: let other = "many"; return other } }',
        'out([sw(1), sw(2)]);'
    ].join('\n'));
});

test('destructuring and shorthand properties keep their property names', async function () {
    await both([
        'function pick(source) { const { name, age = 30, nested: { deep }, ...others } = source; return { name, age, deep, others } }',
        'out(pick({ name: "kim", nested: { deep: 1 }, x: 1, y: 2 }));',
        'function arr([first, , third = 9, ...tail]) { return [first, third, tail] }',
        'out(arr([1, 2, undefined, 4, 5]));',
        'function swap() { let left = 1, right = 2; [left, right] = [right, left]; return { left, right } }',
        'out(swap());',
        'function assignPattern() { let width, height; ({ width, height = 5 } = { width: 3 }); return [width, height] }',
        'out(assignPattern());',
        'function params({ title, size = 1 } = {}, ...restArgs) { return title + size + restArgs.length }',
        'out(params({ title: "t" }, 1, 2));',
        'function forOf() { var acc = []; for (const [key, { val }] of [["a", { val: 1 }]]) acc.push(key + val); return acc }',
        'out(forOf());'
    ].join('\n'));
});

test('function and class names, getters, static blocks, arrows, arguments, new.target', async function () {
    await both([
        'var fact = function factorial(num) { return num <= 1 ? 1 : num * factorial(num - 1) };',
        'out(fact(5));',
        'class Account { #balance = 0; static count = 0; constructor(owner) { this.owner = owner; Account.count++ }',
        '  deposit(amount) { this.#balance += amount; return this } get balance() { return this.#balance }',
        '  static { Account.ready = true } static make(owner) { return new Account(owner) } }',
        'out(Account.make("lee").deposit(5).deposit(7).balance); out(Account.count); out(Account.ready);',
        'const Named = class Inner { who() { return typeof Inner } }; out(new Named().who());',
        'const obj = { value: 2, get double() { return this.value * 2 }, set double(v) { this.value = v / 2 }, async run() { return 1 }, *gen() { yield 1 }, [`k${1}`]: 3, get: 5, set() { return 6 } };',
        'obj.double = 10; out(obj.value); out(obj.k1); out([...obj.gen()]); out(obj.get + obj.set());',
        'const curry = (aa) => (bb) => (cc) => aa + bb + cc; out(curry(1)(2)(3));',
        'const asyncArrow = async (val) => val * 2; asyncArrow(4).then(out);',
        'const single = async val => val; single(1).then(out);',
        'function argsLen(first, second) { return arguments.length + first } out(argsLen(1, 2, 3));',
        'function newTarget() { return new.target === undefined } out(newTarget());',
        'function arrowArgs(one) { return (() => arguments[0] + one)() } out(arrowArgs(4));'
    ].join('\n'));
    // sloppy-mode mapped arguments follow the parameter, whatever its name
    await same(wrap('function mapped(longParam) { arguments[0] = 9; return longParam } out(mapped(1));'));
});

test('templates, tagged templates, optional chaining, ??, regex', async function () {
    await both([
        'function tpl(user, count) { return `${user.name}: ${count > 1 ? `${count} items` : "1 item"} ${`x${user?.missing ?? "none"}`}` }',
        'out(tpl({ name: "kim" }, 3));',
        'function tag(strings, ...vals) { return strings.raw.join("|") + vals.join(",") } function useTag(first) { return tag`a${first}b\\n${first + 1}` }',
        'out(useTag(1));',
        'function rx(text) { var pattern = /a+/g; return text.replace(pattern, "-") } out(rx("caaab"));',
        'function opt(o) { return [o?.a?.b, o?.["c"], o.fn?.(), o.fn2?.()] } out(opt({ a: { b: 1 }, c: 2, fn: () => 3 }));'
    ].join('\n'));
});

test('a default parameter value never sees names declared in the body', async function () {
    await same('var outerName = "outer";\n' + wrap('function f(a = outerName) { var outerName = "body"; return a + "/" + outerName } out(f());'));
    await same('var x = "outer";\n' + wrap('function g(cb = () => x) { var x = "body"; return cb() + "/" + x } out(g());'));
    await same('var x = "outer";\n' + strict('function h(p = x) { let y = x; return p + y } out(h());'));
    await same('var helper = () => "outer";\n' + wrap('function k(v = helper()) { function helper() { return "inner" } return v + "/" + helper() } out(k());'));
});

test('catch parameter redeclared with var keeps working', async function () {
    await same(wrap('function f() { try { throw "thrown" } catch (err) { var err = "assigned"; out(err) } return typeof err } out(f());'));
});

test('Annex B: a block function and a same-named var stay linked (sloppy)', async function () {
    await same(wrap('function f() { var later; { function later() { return "fn" } } return typeof later } out(f());'));
    await same(wrap('function g() { { function blockFn() { return 1 } } return typeof blockFn } out(g());'));
    await same(strict('function h() { { function blockFn() { return 1 } } return typeof blockFn } out(h());'));
    await same(wrap('function k(flag) { if (flag) function cond() { return "c" } return typeof cond } out(k(true)); out(k(false));'));
});

test('fn.name and constructor.name: class names kept by default, function names with keepFnames', async function () {
    const src = wrap('class Widget {} function namedHelper() {} out(new Widget().constructor.name); out(namedHelper.name);');
    const want = await run(src);
    assert.deepEqual(await run(minify(src, { keepFnames: true }).code), want);
    const def = await run(minify(src).code);
    assert.equal(def[0], 'Widget');
    assert.notEqual(def[1], 'namedHelper');
    const allShort = await run(minify(src, { keepClassnames: false }).code);
    assert.notEqual(allShort[0], 'Widget');
});

test('eval, with and escaped identifiers turn renaming off', function () {
    const r1 = minify('(function () { var secret = 1; out(eval("secret")) })()');
    assert.equal(r1.skipped, 'eval');
    assert.match(r1.code, /secret/);
    const r2 = minify('(function () { var o = { p: 1 }; var keep = 2; with (o) { out(p + keep) } })()');
    assert.equal(r2.skipped, 'with');
    const r3 = minify('(function () { var \\u0061bc = 1; var longer = abc; return longer })()');
    assert.equal(r3.skipped, 'escape');
});

test('identifiers that look like keywords', async function () {
    await same('var let = 1; var yield = 2; var async = 3; var of = 4; var get = 5; out(let + yield + async + of + get)', 'sloppy-only names');
    await same(wrap('var async = function (x) { return x }; out(async(3)); var obj = { async: 1, await: 2 }; out(obj.async + obj.await)'));
    await same(wrap('function await2() { var await = 5; return await } out(await2())'));
});

test('new names avoid reserved words', function () {
    const names = [];
    for (let g = 0; g < 4000; g++) names.push(Min.nameAt(g));
    assert.equal(new Set(names).size, names.length);
    // a scope with many bindings must never produce "do", "if", "in", "for", "let", "new", "try", "var"
    const decl = names.slice(0, 3000).map((n, i) => 'var v' + i + ' = ' + i + ';').join('');
    const code = minify(wrap(decl + 'out(v2999)')).code;
    assert.doesNotThrow(() => new vm.Script(code));
});

test('module syntax: import, export, import.meta, top-level await', function () {
    const src = [
        'import def, { a as b, c } from "./x.js";',
        'import * as ns from "./y.js";',
        'export const answer = 42;',
        'export function helper(longArgument) { return longArgument + b + c + def + ns.z }',
        'export { answer as default2 };',
        'export * from "./z.js";',
        'const url = import.meta.url;',
        'await Promise.resolve(url);'
    ].join('\n');
    const r = minify(src);
    assert.match(r.code, /export function helper\(a\)\{return a\+b\+c\+def\+ns\.z;?\}/);
    assert.match(r.code, /import def,\{a as b,c\}from"\.\/x\.js"/);
    assert.equal(minify(r.code).code, r.code);
});

test('tokenize and inspect describe the code the minifier saw', function () {
    const t = tokenize('if (x) /a b/.test(y)');
    assert.deepEqual(t.map((k) => k.type), ['id', 'punct', 'id', 'punct', 'regex', 'punct', 'id', 'punct', 'id', 'punct']);
    const i = inspect('function f(a) { return a + b }');
    assert.deepEqual(i.statements, [0, 6]);
    assert.deepEqual(i.occurrences.map((o) => [o.name, o.binding]), [['f', 0], ['a', 1], ['a', 1], ['b', null]]);
});

// ---------------------------------------------------------------- self checks on real code

test('every module in this repo: whitespace output has identical tokens, mangled output resolves identically', function () {
    const files = ['browser', 'node', 'bin', 'scripts', 'test', 'test/helpers', 'examples', 'examples/demo']
        .flatMap((d) => fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d)).filter((f) => /\.js$/.test(f)).map((f) => path.join(ROOT, d, f)) : []);
    assert.ok(files.length >= 15, files.length);
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        const ws = minify(src, { mangle: false }).code;
        const mg = minify(src).code;
        const a = inspect(src);
        const w = inspect(ws), g = inspect(mg);
        assert.deepEqual(w.tokens, a.tokens, file);
        assert.deepEqual(w.statements, a.statements, file);
        assert.deepEqual(g.occurrences.map((o) => o.binding), a.occurrences.map((o) => o.binding), file);
        assert.doesNotThrow(() => vm.compileFunction(mg, ['exports', 'require', 'module', '__filename', '__dirname']), file);
        assert.ok(mg.length < src.length * 0.9, path.basename(file) + ' ' + mg.length + '/' + src.length);
    }
});

test('self-hosting: the minified minifier gives byte-identical output', function () {
    const src = fs.readFileSync(path.join(ROOT, 'browser', 'minify.js'), 'utf8');
    const once = minify(src).code;
    const ctx = { self: {} };
    vm.runInNewContext(once, ctx);
    const M2 = ctx.self.VanillaMinify;
    for (const f of ['minify', 'markdown', 'qr', 'diff', 'color']) {
        const s = fs.readFileSync(path.join(ROOT, 'browser', f + '.js'), 'utf8');
        assert.equal(M2.minify(s).code, minify(s).code, f);
        assert.equal(M2.minify(s, { mangle: false }).code, minify(s, { mangle: false }).code, f);
    }
    assert.equal(M2.minify(src).code, once);
});
