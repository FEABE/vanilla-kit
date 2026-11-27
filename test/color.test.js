'use strict';
/**
 * browser/color.js — colour parsing / conversion and WCAG 2.x contrast ratio.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('./helpers/subject.js')('browser/color.js');

const rgb = (s) => { const c = C.parse(s); return c && [c.r, c.g, c.b, c.a]; };

test('parse: hex, rgb(), hsl(), names', function () {
    assert.deepEqual(rgb('#fff'), [255, 255, 255, 1]);
    assert.deepEqual(rgb('777'), [119, 119, 119, 1]);
    assert.deepEqual(rgb('#4EC9B0'), [78, 201, 176, 1]);
    assert.deepEqual(rgb('#ff000080'), [255, 0, 0, 0.502]);
    assert.deepEqual(rgb('#f008'), [255, 0, 0, 0.533]);
    assert.deepEqual(rgb('rgb(10, 20, 30)'), [10, 20, 30, 1]);
    assert.deepEqual(rgb('rgba(10,20,30,0.5)'), [10, 20, 30, 0.5]);
    assert.deepEqual(rgb('rgb(10 20 30 / 50%)'), [10, 20, 30, 0.5]);
    assert.deepEqual(rgb('rgb(100%, 0%, 50%)'), [255, 0, 128, 1]);
    assert.deepEqual(rgb('hsl(0, 100%, 50%)'), [255, 0, 0, 1]);
    assert.deepEqual(rgb('hsl(120deg 100% 25%)'), [0, 128, 0, 1]);
    assert.deepEqual(rgb('hsl(0.5turn, 100%, 50%)'), [0, 255, 255, 1]);
    assert.deepEqual(rgb('hsla(240, 100%, 50%, .25)'), [0, 0, 255, 0.25]);
    assert.deepEqual(rgb('  White '), [255, 255, 255, 1]);
    ['', 'nope', '#ggg', '#12345', 'rgb(1,2)', 'rgb(1 2 3 4)', 'hsl(x, 1%, 2%)', 'rgb(1,2,3', 'url(x)', '"><script>', 'constructor', '__proto__']
        .forEach((s) => assert.equal(C.parse(s), null, s));
});

test('conversion round trips', function () {
    assert.equal(C.toHex(C.parse('rgb(78, 201, 176)')), '#4ec9b0');
    assert.equal(C.toRgbString(C.parse('#4ec9b0')), 'rgb(78, 201, 176)');
    assert.equal(C.toHslString(C.parse('#ff0000')), 'hsl(0, 100%, 50%)');
    assert.equal(C.toHslString(C.parse('#808080')), 'hsl(0, 0%, 50.2%)');
    assert.equal(C.toHex(C.parse('#ff000080')), '#ff000080');
    assert.equal(C.toRgbString(C.parse('rgba(1,2,3,.5)')), 'rgb(1 2 3 / 0.5)');
    for (let i = 0; i < 300; i++) {
        const c = { r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 53) % 256, a: 1 };
        const back = C.parse(C.toHslString(c));
        assert.ok(Math.abs(back.r - c.r) <= 1 && Math.abs(back.g - c.g) <= 1 && Math.abs(back.b - c.b) <= 1, JSON.stringify(c));
        assert.deepEqual(C.parse(C.toHex(c)), c);
    }
});

test('contrast ratio: known values', function () {
    const r = (a, b) => C.contrast(C.parse(a), C.parse(b));
    assert.equal(r('#000', '#fff'), 21);
    assert.equal(r('#fff', '#000'), 21);
    assert.equal(r('#abcdef', '#abcdef'), 1);
    assert.ok(Math.abs(r('#777', '#fff') - 4.48) < 0.01);
    assert.ok(Math.abs(r('#767676', '#fff') - 4.54) < 0.01);
    assert.ok(Math.abs(r('#595959', '#fff') - 7.0) < 0.01);
    assert.ok(Math.abs(r('#ff0000', '#fff') - 4.0) < 0.01);
    assert.ok(Math.abs(r('#0000ff', '#fff') - 8.59) < 0.01);
    assert.equal(C.formatRatio(r('#777', '#fff')), '4.47');      // 4.478... is truncated, not rounded up to 4.48
    assert.equal(C.formatRatio(21), '21.00');
});

test('a translucent foreground is composited over the background', function () {
    // 50% black over white is close to #808080
    const half = C.contrast(C.parse('rgba(0,0,0,0.5)'), C.parse('#fff'));
    const grey = C.contrast(C.parse('#808080'), C.parse('#fff'));
    assert.ok(Math.abs(half - grey) < 0.05);
    assert.equal(C.contrast(C.parse('transparent'), C.parse('#fff')), 1);
});

test('grade thresholds', function () {
    assert.deepEqual(C.grade(21), { normalAA: true, normalAAA: true, largeAA: true, largeAAA: true, ui: true });
    assert.deepEqual(C.grade(4.48), { normalAA: false, normalAAA: false, largeAA: true, largeAAA: false, ui: true });
    assert.deepEqual(C.grade(4.5), { normalAA: true, normalAAA: false, largeAA: true, largeAAA: true, ui: true });
    assert.deepEqual(C.grade(2.99), { normalAA: false, normalAAA: false, largeAA: false, largeAAA: false, ui: false });
});

test('suggest the nearest passing colour', function () {
    const fg = C.parse('#777'), bg = C.parse('#fff');
    const s = C.suggest(fg, bg, 4.5, 'fg');
    assert.ok(s.ratio >= 4.5);
    assert.equal(C.toHex(s.color), '#767676');     // just one step darker
    const s7 = C.suggest(fg, bg, 7, 'fg');
    assert.ok(s7.ratio >= 7 && C.luminance(s7.color) < C.luminance(fg));
    // changing the background instead
    const sb = C.suggest(C.parse('#4ec9b0'), C.parse('#ffffff'), 4.5, 'bg');
    assert.ok(sb.ratio >= 4.5);
    assert.ok(C.contrast(C.parse('#4ec9b0'), sb.color) >= 4.5);
    // already passing: returned unchanged
    assert.equal(C.suggest(C.parse('#000'), bg, 4.5, 'fg').same, true);
    // 7:1 on a #777 background is impossible for any foreground
    assert.equal(C.suggest(C.parse('#888'), C.parse('#777'), 7, 'fg'), null);
    // hue is kept
    const red = C.suggest(C.parse('#ff6666'), bg, 4.5, 'fg');
    const h = C.rgbToHsl(red.color);
    assert.ok(Math.abs(h.h - 0) < 2 || Math.abs(h.h - 360) < 2);
});
