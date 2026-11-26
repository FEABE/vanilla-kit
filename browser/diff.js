/**
 * diff.js — text diff (Myers O((N+M)D) shortest edit script). Zero dependencies, one file.
 * Part of vanilla-kit. MIT License.
 *
 *   The common prefix and suffix are trimmed first, which makes typical edits fast.
 *   - diffLines(a, b, { ignoreWhitespace, ignoreCase }) -> [{ type: 'equal'|'del'|'ins', text, other, a, b }]
 *       a, b are 1-based line numbers in the old / new text (null when the line does not exist on that side);
 *       for 'equal' lines `text` is the old line and `other` the new line (they differ only when an ignore option is on).
 *   - diffWords(a, b) -> [{ type, text }] — word / whitespace / symbol tokens within one line, for highlighting.
 *   - hunks(ops, context = 3) -> [{ start, end }] ranges of ops around changes (end exclusive), nearby ranges merged.
 *   - stats(ops) -> { added, removed, same }
 *   If the edit distance exceeds MAX_D (4000), the remaining middle part is reported as one delete + one insert
 *   block, so huge unrelated inputs cannot freeze the page. The result is then valid but no longer minimal.
 *
 * Works in the browser (window.VanillaDiff) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VanillaDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_D = 4000;

  // a, b: arrays of comparison keys. Returns [['equal'|'del'|'ins', ai, bi], ...] (0-based, -1 when absent).
  function myers(a, b) {
    var n = a.length, m = b.length;
    var start = 0;
    while (start < n && start < m && a[start] === b[start]) start++;
    var endA = n, endB = m;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    var ops = [];
    for (var s = 0; s < start; s++) ops.push(['equal', s, s]);

    var A = a.slice(start, endA), B = b.slice(start, endB);
    var N = A.length, M = B.length;
    var middle = [];
    if (N === 0) { for (var j = 0; j < M; j++) middle.push(['ins', -1, start + j]); }
    else if (M === 0) { for (var i = 0; i < N; i++) middle.push(['del', start + i, -1]); }
    else {
      var max = N + M, offset = max;
      var v = new Int32Array(2 * max + 2);
      var trace = [];
      var found = -1;
      for (var d = 0; d <= max && d <= MAX_D; d++) {
        trace.push(v.slice(offset - d, offset + d + 2));   // v[-d..d+1] before this round
        for (var k = -d; k <= d; k += 2) {
          var x;
          if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
          else x = v[offset + k - 1] + 1;
          var y = x - k;
          while (x < N && y < M && A[x] === B[y]) { x++; y++; }
          v[offset + k] = x;
          if (x >= N && y >= M) { found = d; break; }
        }
        if (found >= 0) break;
      }
      if (found < 0) {
        // too different: report the whole middle as delete + insert
        for (var i2 = 0; i2 < N; i2++) middle.push(['del', start + i2, -1]);
        for (var j2 = 0; j2 < M; j2++) middle.push(['ins', -1, start + j2]);
      } else {
        // backtrack
        var cx = N, cy = M;
        var rev = [];
        for (var dd = found; dd > 0; dd--) {
          var vp = trace[dd];            // state before round dd = result of round dd-1, indexed by (k + dd)
          var kk = cx - cy;
          var get = function (kq) { return vp[kq + dd]; };
          var prevK = (kk === -dd || (kk !== dd && get(kk - 1) < get(kk + 1))) ? kk + 1 : kk - 1;
          var prevX = get(prevK);
          var prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) { rev.push(['equal', start + cx - 1, start + cy - 1]); cx--; cy--; }
          if (cx === prevX) rev.push(['ins', -1, start + cy - 1]);
          else rev.push(['del', start + cx - 1, -1]);
          cx = prevX; cy = prevY;
        }
        while (cx > 0 && cy > 0) { rev.push(['equal', start + cx - 1, start + cy - 1]); cx--; cy--; }
        middle = rev.reverse();
      }
    }
    for (var q = 0; q < middle.length; q++) ops.push(middle[q]);
    for (var t = 0; t < n - endA; t++) ops.push(['equal', endA + t, endB + t]);
    return ops;
  }

  function splitLines(text) {
    var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (s === '') return [];
    var lines = s.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();   // a final newline does not start another line
    return lines;
  }

  function diffLines(aText, bText, opts) {
    opts = opts || {};
    var a = splitLines(aText), b = splitLines(bText);
    var key = function (line) {
      var k = line;
      if (opts.ignoreWhitespace) k = k.trim().replace(/\s+/g, ' ');
      if (opts.ignoreCase) k = k.toLowerCase();
      return k;
    };
    var raw = myers(a.map(key), b.map(key));
    return raw.map(function (o) {
      return { type: o[0], text: o[0] === 'ins' ? b[o[2]] : a[o[1]], other: o[0] === 'equal' ? b[o[2]] : undefined, a: o[1] >= 0 ? o[1] + 1 : null, b: o[2] >= 0 ? o[2] + 1 : null };
    });
  }

  // Tokens: a run of letters / digits, a run of whitespace, or a single symbol.
  function tokens(s) { return String(s == null ? '' : s).match(/[A-Za-z0-9_À-￿]+|\s+|[^\sA-Za-z0-9_]/g) || []; }

  function diffWords(aLine, bLine) {
    var a = tokens(aLine), b = tokens(bLine);
    var raw = myers(a, b);
    var out = [];
    raw.forEach(function (o) {
      var text = o[0] === 'ins' ? b[o[2]] : a[o[1]];
      var last = out[out.length - 1];
      if (last && last.type === o[0]) last.text += text;
      else out.push({ type: o[0], text: text });
    });
    return out;
  }

  // Ranges of ops with `context` unchanged lines around each change: [{ start, end }] (end exclusive).
  function hunks(ops, context) {
    context = context == null ? 3 : context;
    var ranges = [];
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].type === 'equal') continue;
      var s = Math.max(0, i - context);
      var j = i;
      while (j < ops.length && ops[j].type !== 'equal') j++;
      var e = Math.min(ops.length, j + context);
      var last = ranges[ranges.length - 1];
      if (last && s <= last.end) last.end = Math.max(last.end, e);
      else ranges.push({ start: s, end: e });
      i = j - 1;
    }
    return ranges;
  }

  function stats(ops) {
    var s = { added: 0, removed: 0, same: 0 };
    ops.forEach(function (o) { if (o.type === 'ins') s.added++; else if (o.type === 'del') s.removed++; else s.same++; });
    return s;
  }

  return { diffLines: diffLines, diffWords: diffWords, hunks: hunks, stats: stats, splitLines: splitLines, _myers: myers };
});
