/**
 * color.js — colour parsing / conversion and WCAG 2.x contrast. Zero dependencies, one file.
 * Part of vanilla-kit. MIT License.
 *
 *   - parse(text) -> { r, g, b, a } (r/g/b 0-255 integers, a 0-1) or null
 *       #rgb #rgba #rrggbb #rrggbbaa (the # is optional), rgb()/rgba() (commas, spaces, percentages),
 *       hsl()/hsla() (deg, turn, rad, grad) and a short list of basic colour names (see NAMES).
 *   - toHex / toRgbString / toHslString, rgbToHsl / hslToRgb
 *   - luminance(c) — WCAG 2.x relative luminance
 *   - contrast(fg, bg) — contrast ratio 1..21. A translucent foreground is composited over the background first;
 *     a translucent background is assumed to sit on white.
 *   - grade(ratio) -> { normalAA, normalAAA, largeAA, largeAAA, ui }
 *   - suggest(fg, bg, target, which) — keeps hue and saturation, changes only lightness, and returns the nearest
 *     colour that reaches `target` ({ color, ratio, l }), or null if none can.
 *   - formatRatio(ratio) — truncates (not rounds) to 2 decimals, so 4.497 never displays as a passing "4.50".
 *
 * Works in the browser (window.VanillaColor) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VanillaColor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NAMES = {
    black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080',
    silver: 'c0c0c0', navy: '000080', orange: 'ffa500', purple: '800080', teal: '008080', maroon: '800000', olive: '808000',
    lime: '00ff00', aqua: '00ffff', cyan: '00ffff', fuchsia: 'ff00ff', magenta: 'ff00ff', pink: 'ffc0cb', brown: 'a52a2a',
    transparent: '00000000'
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function hexToRgb(h) {
    if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    var n = parseInt(h.slice(0, 6), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: h.length === 8 ? Math.round(parseInt(h.slice(6), 16) / 255 * 1000) / 1000 : 1 };
  }

  // "50%" -> 0.5 * scale, "128" -> 128
  function num(token, scale) {
    var m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(token);
    if (!m) return NaN;
    var v = parseFloat(m[1]);
    return m[2] ? v / 100 * scale : v;
  }
  function alpha(token) {
    if (token == null) return 1;
    var v = num(token, 1);
    return isNaN(v) ? NaN : clamp(v, 0, 1);
  }
  function hue(token) {
    var m = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)?$/i.exec(token);
    if (!m) return NaN;
    var v = parseFloat(m[1]), u = (m[2] || 'deg').toLowerCase();
    if (u === 'turn') v *= 360; else if (u === 'rad') v = v * 180 / Math.PI; else if (u === 'grad') v *= 0.9;
    return ((v % 360) + 360) % 360;
  }

  function parse(text) {
    var s = String(text == null ? '' : text).trim().toLowerCase();
    if (!s) return null;
    if (Object.prototype.hasOwnProperty.call(NAMES, s)) return hexToRgb(NAMES[s]);
    var hm = /^#?([0-9a-f]{3,8})$/.exec(s);
    if (hm) return hexToRgb(hm[1]);
    var fm = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(s);
    if (!fm) return null;
    // both the comma form "1, 2, 3, 0.5" and the space form "1 2 3 / 0.5"
    var body = fm[2].trim(), parts, a = null;
    if (body.indexOf(',') >= 0) {
      parts = body.split(/\s*,\s*/);
      if (parts.length === 4) a = parts.pop();
    } else {
      var sl = body.split(/\s*\/\s*/);
      if (sl.length > 2) return null;
      parts = sl[0].split(/\s+/);
      if (sl.length === 2) a = sl[1];
    }
    if (parts.length !== 3) return null;
    var al = alpha(a);
    if (isNaN(al)) return null;
    if (fm[1].charAt(0) === 'r') {
      var rgb = parts.map(function (p) { return num(p, 255); });
      if (rgb.some(isNaN)) return null;
      return { r: Math.round(clamp(rgb[0], 0, 255)), g: Math.round(clamp(rgb[1], 0, 255)), b: Math.round(clamp(rgb[2], 0, 255)), a: al };
    }
    var h = hue(parts[0]), sa = num(parts[1], 100), li = num(parts[2], 100);
    if (isNaN(h) || isNaN(sa) || isNaN(li)) return null;
    var c = hslToRgb(h, clamp(sa, 0, 100), clamp(li, 0, 100));
    c.a = al;
    return c;
  }

  // h: 0-360, s and l: 0-100 -> integer rgb
  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a: 1 };
  }
  function rgbToHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0, s = 0, l = (max + min) / 2;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return { h: h, s: s * 100, l: l * 100 };
  }

  function hex2(n) { return Math.round(n).toString(16).padStart(2, '0'); }
  function toHex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a != null && c.a < 1 ? hex2(c.a * 255) : ''); }
  function trim(n, d) { return String(Number(n.toFixed(d))); }
  function toRgbString(c) { return c.a != null && c.a < 1 ? 'rgb(' + c.r + ' ' + c.g + ' ' + c.b + ' / ' + trim(c.a, 3) + ')' : 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')'; }
  function toHslString(c) {
    var h = rgbToHsl(c);
    var core = trim(h.h, 1) + ', ' + trim(h.s, 1) + '%, ' + trim(h.l, 1) + '%';
    return c.a != null && c.a < 1 ? 'hsl(' + core.replace(/, /g, ' ') + ' / ' + trim(c.a, 3) + ')' : 'hsl(' + core + ')';
  }

  // Composite a translucent colour over the colour beneath it.
  function over(top, under) {
    var a = top.a == null ? 1 : top.a;
    if (a >= 1) return { r: top.r, g: top.g, b: top.b, a: 1 };
    return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
  }
  var WHITE = { r: 255, g: 255, b: 255, a: 1 };

  function channel(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function luminance(c) { return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b); }

  // A translucent background is treated as sitting on white; the foreground is composited over that background.
  function contrast(fg, bg) {
    var b = over(bg, WHITE), f = over(fg, b);
    var l1 = luminance(f), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function grade(ratio) {
    return { normalAA: ratio >= 4.5, normalAAA: ratio >= 7, largeAA: ratio >= 3, largeAAA: ratio >= 4.5, ui: ratio >= 3 };
  }

  function formatRatio(ratio) { return (Math.floor(ratio * 100 + 1e-9) / 100).toFixed(2); }

  // which: 'fg' changes the foreground, 'bg' the background. Lightness is widened by 0.1% steps up and down
  // and the first colour that passes is returned.
  function suggest(fg, bg, target, which) {
    var moving = which === 'bg' ? bg : fg;
    var hsl = rgbToHsl(moving);
    var best = null;
    function test(l) {
      if (l < 0 || l > 100) return null;
      var c = hslToRgb(hsl.h, hsl.s, l);
      c.a = moving.a == null ? 1 : moving.a;
      var r = which === 'bg' ? contrast(fg, c) : contrast(c, bg);
      return r >= target ? { color: c, ratio: r, l: l } : null;
    }
    if (contrast(fg, bg) >= target) return { color: moving, ratio: contrast(fg, bg), l: hsl.l, same: true };
    for (var i = 1; i <= 1000; i++) {
      var d = i / 10;
      var up = test(hsl.l + d), down = test(hsl.l - d);
      if (up || down) {
        if (up && down) best = up.ratio >= down.ratio ? up : down;
        else best = up || down;
        break;
      }
    }
    return best;
  }

  return {
    parse: parse, toHex: toHex, toRgbString: toRgbString, toHslString: toHslString, rgbToHsl: rgbToHsl, hslToRgb: hslToRgb,
    luminance: luminance, contrast: contrast, grade: grade, suggest: suggest, formatRatio: formatRatio, over: over
  };
});
