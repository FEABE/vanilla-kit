/**
 * qr.js — QR code encoder (ISO/IEC 18004, Model 2). Zero dependencies, one file.
 * Part of vanilla-kit. MIT License.
 *
 *   - Modes: numeric, alphanumeric or byte (UTF-8). The smallest single mode that fits the whole text is chosen.
 *   - Versions 1-40 chosen automatically, error-correction levels L / M / Q / H.
 *   - Reed-Solomon over GF(256) (primitive polynomial 0x11D), block splitting and interleaving.
 *   - All 8 masks are rendered and the one with the lowest penalty score wins.
 *   - Format information (BCH 15,5) and version information (BCH 18,6).
 *
 *   encode(text, { ecl: 'M', mask: -1, minVersion: 1, maxVersion: 40, mode })
 *     -> { version, size, ecl, mask, mode, modules: [[bool]], isFunction, dataCodewords, codewords, byteLength, penalty }
 *   toSvg(qr, { border: 4, dark: '#000000', light: '#ffffff', pixelSize }) -> SVG string
 *
 * Works in the browser (window.VanillaQR) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VanillaQR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // -- Tables: EC codewords per block / number of EC blocks (index = version, 0 unused) --
  var ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  };
  var NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  };
  var ECL_FORMAT = { L: 1, M: 0, Q: 3, H: 2 };   // the 2 bits stored in the format information
  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  // -- GF(256) --
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // Generator polynomial with roots a^0 ... a^(degree-1); the leading coefficient 1 is omitted (degree coefficients).
  var divisorCache = {};
  function rsDivisor(degree) {
    if (divisorCache[degree]) return divisorCache[degree];
    var result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    var r = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], r);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      r = gfMul(r, 2);
    }
    divisorCache[degree] = result;
    return result;
  }
  // The `degree` EC codewords to append after `data`.
  function rsEncode(data, degree) {
    var div = rsDivisor(degree);
    var rem = new Array(degree).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem.shift();
      rem.push(0);
      for (var j = 0; j < degree; j++) rem[j] ^= gfMul(div[j], factor);
    }
    return rem;
  }

  // -- Sizes --
  function sizeOf(ver) { return ver * 4 + 17; }
  // Number of data modules once function patterns are removed (remainder bits included).
  function rawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2;
      result -= (25 * na - 10) * na - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function totalCodewords(ver) { return Math.floor(rawDataModules(ver) / 8); }
  function dataCodewordCount(ver, ecl) { return totalCodewords(ver) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver]; }

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    var na = Math.floor(ver / 7) + 2;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
    var out = [6];
    for (var pos = sizeOf(ver) - 7; out.length < na; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  // -- Format / version information --
  function formatBits(ecl, mask) {
    var data = (ECL_FORMAT[ecl] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  function versionBits(ver) {
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    return (ver << 12) | rem;
  }
  function bitStr(n, len) { var s = n.toString(2); while (s.length < len) s = '0' + s; return s; }

  // -- String -> bytes (UTF-8; lone surrogates become U+FFFD) --
  function utf8(text) {
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) {
        var d = text.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
        else c = 0xFFFD;
      } else if (c >= 0xD800 && c <= 0xDFFF) c = 0xFFFD;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  // -- Data segment --
  var MODES = {
    numeric: { indicator: 1, countBits: [10, 12, 14] },
    alphanumeric: { indicator: 2, countBits: [9, 11, 13] },
    byte: { indicator: 4, countBits: [8, 16, 16] }
  };
  function countBits(mode, ver) { return MODES[mode].countBits[ver <= 9 ? 0 : ver <= 26 ? 1 : 2]; }

  function isAlnum(text) {
    for (var i = 0; i < text.length; i++) if (ALNUM.indexOf(text.charAt(i)) < 0) return false;
    return true;
  }
  function pickMode(text) {
    if (/^[0-9]*$/.test(text)) return 'numeric';
    return isAlnum(text) ? 'alphanumeric' : 'byte';
  }

  // Data bits, without the mode indicator and character count.
  function segmentBits(text, mode) {
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    var count;
    if (mode === 'numeric') {
      count = text.length;
      for (var i = 0; i < text.length; i += 3) {
        var chunk = text.substr(i, 3);
        put(parseInt(chunk, 10), chunk.length * 3 + 1);
      }
    } else if (mode === 'alphanumeric') {
      count = text.length;
      for (var j = 0; j + 1 < text.length; j += 2) put(ALNUM.indexOf(text.charAt(j)) * 45 + ALNUM.indexOf(text.charAt(j + 1)), 11);
      if (text.length % 2) put(ALNUM.indexOf(text.charAt(text.length - 1)), 6);
    } else {
      var bytes = utf8(text);
      count = bytes.length;
      for (var k = 0; k < bytes.length; k++) put(bytes[k], 8);
    }
    return { bits: bits, count: count };
  }

  // -- Codewords --
  function buildDataCodewords(seg, mode, ver, ecl) {
    var capacityBits = dataCodewordCount(ver, ecl) * 8;
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(MODES[mode].indicator, 4);
    put(seg.count, countBits(mode, ver));
    for (var i = 0; i < seg.bits.length; i++) bits.push(seg.bits[i]);
    put(0, Math.min(4, capacityBits - bits.length));       // terminator
    put(0, (8 - bits.length % 8) % 8);                     // byte alignment
    var out = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var t = 0; t < 8; t++) v = (v << 1) | bits[b + t];
      out.push(v);
    }
    for (var pad = 0xEC; out.length < capacityBits / 8; pad ^= 0xEC ^ 0x11) out.push(pad);
    return out;
  }

  // Split into blocks, append EC codewords, interleave.
  function addEccAndInterleave(data, ver, ecl) {
    var numBlocks = NUM_BLOCKS[ecl][ver], eccLen = ECC_PER_BLOCK[ecl][ver];
    var raw = totalCodewords(ver);
    var numShort = numBlocks - raw % numBlocks;
    var shortLen = Math.floor(raw / numBlocks);
    var blocks = [];
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      var ecc = rsEncode(dat, eccLen);
      if (i < numShort) dat.push(0);  // placeholder so all blocks line up (skipped below)
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (var c = 0; c < blocks[0].length; c++) {
      for (var j = 0; j < blocks.length; j++) {
        if (c !== shortLen - eccLen || j >= numShort) result.push(blocks[j][c]);
      }
    }
    return result;
  }

  // -- Matrix --
  function makeGrid(n, v) { var g = []; for (var y = 0; y < n; y++) g.push(new Array(n).fill(v)); return g; }

  // Draw function patterns (finders, timing, alignment, format/version areas).
  // The format information is rewritten once the mask is known.
  function drawFunctionPatterns(ver, ecl) {
    var n = sizeOf(ver);
    var m = makeGrid(n, false), fn = makeGrid(n, false);
    function set(x, y, dark) { m[y][x] = dark; fn[y][x] = true; }
    for (var i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        var d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
    var al = alignmentPositions(ver), na = al.length;
    for (var a = 0; a < na; a++) for (var b = 0; b < na; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === na - 1) || (a === na - 1 && b === 0)) continue;
      for (var ddy = -2; ddy <= 2; ddy++) for (var ddx = -2; ddx <= 2; ddx++) {
        set(al[a] + ddx, al[b] + ddy, Math.max(Math.abs(ddx), Math.abs(ddy)) !== 1);
      }
    }
    drawFormat(m, fn, ecl, 0);
    if (ver >= 7) {
      var vb = versionBits(ver);
      for (var t = 0; t < 18; t++) {
        var bit = ((vb >>> t) & 1) === 1;
        var p = n - 11 + t % 3, q = Math.floor(t / 3);
        set(p, q, bit); set(q, p, bit);
      }
    }
    return { modules: m, isFunction: fn, size: n };
  }

  function drawFormat(m, fn, ecl, mask) {
    var n = m.length, bits = formatBits(ecl, mask);
    function set(x, y, dark) { m[y][x] = dark; fn[y][x] = true; }
    function bit(i) { return ((bits >>> i) & 1) === 1; }
    // first copy (top-left)
    for (var i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (var j = 9; j < 15; j++) set(14 - j, 8, bit(j));
    // second copy (top-right and bottom-left)
    for (var k = 0; k < 8; k++) set(n - 1 - k, 8, bit(k));
    for (var l = 8; l < 15; l++) set(8, n - 15 + l, bit(l));
    set(8, n - 8, true);   // the always-dark module
  }

  // Place codewords in the zig-zag order (leftover remainder bits stay light).
  function drawCodewords(m, fn, cw) {
    var n = m.length, i = 0, total = cw.length * 8;
    for (var right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < n; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? n - 1 - vert : vert;
          if (!fn[y][x] && i < total) {
            m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  function maskFn(mask) {
    switch (mask) {
      case 0: return function (x, y) { return (x + y) % 2 === 0; };
      case 1: return function (x, y) { return y % 2 === 0; };
      case 2: return function (x, y) { return x % 3 === 0; };
      case 3: return function (x, y) { return (x + y) % 3 === 0; };
      case 4: return function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; };
      case 5: return function (x, y) { return x * y % 2 + x * y % 3 === 0; };
      case 6: return function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; };
      case 7: return function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; };
    }
    throw new RangeError('qr: mask must be an integer 0-7');
  }
  function applyMask(m, fn, mask) {
    var f = maskFn(mask), n = m.length;
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (!fn[y][x] && f(x, y)) m[y][x] = !m[y][x];
  }

  // -- Penalty score (N1=3, N2=3, N3=40, N4=10) --
  var FINDER_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  var FINDER_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  function penalty(m) {
    var n = m.length, score = 0, dark = 0;
    function line(get) {
      var s = 0, run = 1;
      for (var i = 1; i <= n; i++) {
        if (i < n && get(i) === get(i - 1)) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      // 1:1:3:1:1 plus 4 light modules (the area outside the symbol counts as light)
      for (var st = -4; st + 11 <= n + 4; st++) {
        var okA = true, okB = true;
        for (var k = 0; k < 11 && (okA || okB); k++) {
          var p = st + k, v = (p >= 0 && p < n && get(p)) ? 1 : 0;
          if (v !== FINDER_A[k]) okA = false;
          if (v !== FINDER_B[k]) okB = false;
        }
        if (okA) s += 40;
        if (okB) s += 40;
      }
      return s;
    }
    for (var y = 0; y < n; y++) {
      (function (row) { score += line(function (i) { return row[i]; }); })(m[y]);
      for (var x = 0; x < n; x++) if (m[y][x]) dark++;
    }
    for (var cx = 0; cx < n; cx++) {
      (function (col) { score += line(function (i) { return m[i][col]; }); })(cx);
    }
    for (var by = 0; by + 1 < n; by++) for (var bx = 0; bx + 1 < n; bx++) {
      var c = m[by][bx];
      if (c === m[by][bx + 1] && c === m[by + 1][bx] && c === m[by + 1][bx + 1]) score += 3;
    }
    var pct = dark * 100 / (n * n);
    score += 10 * Math.floor(Math.abs(pct - 50) / 5);
    return score;
  }

  function cloneGrid(g) { return g.map(function (r) { return r.slice(); }); }

  function intOption(value, name, lo, hi, fallback) {
    if (value == null) return fallback;
    if (typeof value !== 'number' || value % 1 !== 0 || value < lo || value > hi) {
      throw new RangeError('qr: ' + name + ' must be an integer ' + lo + '-' + hi);
    }
    return value;
  }

  // -- Public API --
  function encode(text, opts) {
    opts = opts || {};
    text = String(text == null ? '' : text);
    var ecl = String(opts.ecl || 'M').toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(ECC_PER_BLOCK, ecl)) throw new RangeError('qr: ecl must be one of L, M, Q, H');
    var minV = intOption(opts.minVersion, 'minVersion', 1, 40, 1);
    var maxV = intOption(opts.maxVersion, 'maxVersion', 1, 40, 40);
    if (minV > maxV) throw new RangeError('qr: minVersion is greater than maxVersion');
    var mask = intOption(opts.mask == null || opts.mask === -1 ? null : opts.mask, 'mask', 0, 7, -1);
    var mode = opts.mode || pickMode(text);
    if (!Object.prototype.hasOwnProperty.call(MODES, mode)) throw new RangeError('qr: mode must be numeric, alphanumeric or byte');
    if (mode === 'numeric' && !/^[0-9]*$/.test(text)) throw new RangeError('qr: text does not fit numeric mode');
    if (mode === 'alphanumeric' && !isAlnum(text)) throw new RangeError('qr: text does not fit alphanumeric mode');
    var seg = segmentBits(text, mode);
    var ver = -1;
    for (var v = minV; v <= maxV; v++) {
      var cb = countBits(mode, v);
      if (seg.count >= (1 << cb)) continue;
      var need = 4 + cb + seg.bits.length;
      if (need <= dataCodewordCount(v, ecl) * 8) { ver = v; break; }
    }
    if (ver < 0) {
      var err = new Error('qr: data too long for the allowed versions; lower the error-correction level or shorten the text');
      err.code = 'TOO_LONG';
      throw err;
    }
    var data = buildDataCodewords(seg, mode, ver, ecl);
    var all = addEccAndInterleave(data, ver, ecl);
    var base = drawFunctionPatterns(ver, ecl);
    drawCodewords(base.modules, base.isFunction, all);

    var best = null, bestMask = -1, bestScore = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      if (mask >= 0 && mk !== mask) continue;
      var g = cloneGrid(base.modules), fn = cloneGrid(base.isFunction);
      applyMask(g, fn, mk);
      drawFormat(g, fn, ecl, mk);
      var sc = mask >= 0 ? 0 : penalty(g);
      if (sc < bestScore) { bestScore = sc; best = g; bestMask = mk; }
    }
    return {
      version: ver, size: base.size, ecl: ecl, mask: bestMask, mode: mode,
      modules: best, isFunction: base.isFunction,
      dataCodewords: data, codewords: all, byteLength: seg.count, penalty: mask >= 0 ? null : bestScore
    };
  }

  // Only plain hex colours are accepted, so the value can never break out of the attribute.
  function safeColor(c, fallback) { return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(c)) ? String(c) : fallback; }

  // Dark modules are merged into horizontal runs, one rectangle sub-path per run.
  function toSvg(qr, opts) {
    opts = opts || {};
    var border = Math.max(0, Math.min(20, opts.border == null ? 4 : opts.border | 0));
    var dark = safeColor(opts.dark, '#000000'), light = safeColor(opts.light, '#ffffff');
    var n = qr.size, full = n + border * 2, d = [];
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (!qr.modules[y][x]) continue;
        var s = x;
        while (x + 1 < n && qr.modules[y][x + 1]) x++;
        d.push('M' + (s + border) + ',' + (y + border) + 'h' + (x - s + 1) + 'v1h-' + (x - s + 1) + 'z');
      }
    }
    var px = opts.pixelSize ? ' width="' + Math.max(1, opts.pixelSize | 0) + '" height="' + Math.max(1, opts.pixelSize | 0) + '"' : '';
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + full + ' ' + full + '"' + px + ' shape-rendering="crispEdges">\n' +
      '<rect width="100%" height="100%" fill="' + light + '"/>\n' +
      '<path fill="' + dark + '" d="' + d.join('') + '"/>\n</svg>\n';
  }

  return {
    encode: encode,
    toSvg: toSvg,
    formatBits: formatBits,
    versionBits: versionBits,
    bitString: bitStr,
    alignmentPositions: alignmentPositions,
    dataCodewordCount: dataCodewordCount,
    totalCodewords: totalCodewords,
    numBlocks: function (ver, ecl) { return NUM_BLOCKS[ecl][ver]; },
    eccPerBlock: function (ver, ecl) { return ECC_PER_BLOCK[ecl][ver]; },
    rsEncode: rsEncode,
    utf8: utf8,
    pickMode: pickMode,
    _penalty: penalty
  };
});
