/**
 * markdown.js — Markdown -> HTML converter that is safe by default. Zero dependencies, one file.
 * Part of vanilla-kit. MIT License.
 *
 *   toHtml(src, { targetBlank: true }) -> HTML string
 *
 *   Supported: headings (# and underline style), paragraphs, emphasis (* _), strong (** __), strikethrough (~~),
 *   inline code, fenced code (``` ~~~), indented code, block quotes, ordered / unordered / nested lists,
 *   task lists ([ ] [x]), links, images, horizontal rules, GFM tables (alignment :--- :---: ---:),
 *   autolinks (<https://...>, bare https://... and www....), hard line breaks (two trailing spaces or a backslash).
 *   It follows CommonMark closely but is not a complete CommonMark implementation.
 *
 *   Security model (the output is meant to be assigned to innerHTML):
 *   - Raw HTML in the source is never passed through: every character of text goes through esc() (& < > " ').
 *   - Tag and attribute names come only from fixed strings in this file; every attribute value is escaped.
 *   - Link URLs: http, https, mailto and relative URLs only. Image URLs: http, https and relative only.
 *     javascript:, vbscript:, data: (including data:image), file: and every other scheme are dropped and only
 *     the text is kept. Whitespace and control characters hidden inside the scheme are seen through.
 *   - Links get rel="noopener noreferrer". External links also get target="_blank" unless targetBlank is false.
 *   - Nesting depth and the bracket scan are bounded, so hostile input cannot blow the stack or run for long.
 *   - Remote images are allowed, so rendered content can make the viewer's browser load third-party URLs.
 *     If that matters, filter <img> or serve a Content-Security-Policy with a strict img-src.
 *
 * Works in the browser (window.VanillaMarkdown) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VanillaMarkdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_DEPTH = 40;          // nesting limit for quotes and lists (deeper input becomes plain paragraphs)
  var MAX_LINK_SCAN = 4000;    // how far to look for the ] that closes a [

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; }); }
  function repeat(ch, n) { var s = ''; while (n-- > 0) s += ch; return s; }

  var ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
  var UNI_PUNCT = /[\p{P}\p{S}]/u;
  function isWS(ch) { return ch === undefined || ch === '' || /\s/.test(ch); }
  function isPunct(ch) { return ch !== undefined && ch !== '' && (ASCII_PUNCT.test(ch) || UNI_PUNCT.test(ch)); }
  function unescapeBackslash(s) { return s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'); }

  // Per-call options (set by toHtml, read by linkHtml).
  var current = { targetBlank: true };

  // -- URL check --
  // Browsers strip tabs and newlines inside URLs and ignore leading / trailing spaces and control characters,
  // so the scheme is judged on a copy with every space and control character removed. A ':' before the first
  // '/', '?' or '#' means the URL has a scheme.
  function safeUrl(url, kind) {
    url = String(url);
    var clean = '';
    for (var i = 0; i < url.length; i++) {
      var code = url.charCodeAt(i);
      if (code > 0x20 && code !== 0x7f) clean += url.charAt(i);
    }
    var probe = clean.toLowerCase();
    var colon = probe.indexOf(':');
    if (colon >= 0) {
      var cut = probe.search(/[\/?#]/);
      if (cut < 0 || colon < cut) {
        var scheme = probe.slice(0, colon);
        var ok = kind === 'img' ? (scheme === 'http' || scheme === 'https')
          : (scheme === 'http' || scheme === 'https' || scheme === 'mailto');
        if (!ok) return null;
      }
    }
    // For output only control characters are removed; spaces become %20.
    var out = '';
    for (var j = 0; j < url.length; j++) {
      var c2 = url.charCodeAt(j);
      if (c2 < 0x20 || c2 === 0x7f) continue;
      out += c2 === 0x20 ? '%20' : url.charAt(j);
    }
    return out.trim();
  }

  // -- Inline --
  function parseLinkLike(src, i) {
    // src[i] === '['
    var n = src.length, depth = 0, j = i + 1, limit = Math.min(n, i + MAX_LINK_SCAN);
    for (; j < limit; j++) {
      var ch = src[j];
      if (ch === '\\') { j++; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') { if (depth === 0) break; depth--; }
    }
    if (j >= limit || src[j] !== ']') return null;
    var text = src.slice(i + 1, j);
    var k = j + 1;
    if (src[k] !== '(') return null;
    k++;
    while (k < n && /\s/.test(src[k])) k++;
    var dest = '', start;
    if (src[k] === '<') {
      start = k + 1; k = start;
      while (k < n && src[k] !== '>' && src[k] !== '\n' && src[k] !== '<') { if (src[k] === '\\') k++; k++; }
      if (src[k] !== '>') return null;
      dest = src.slice(start, k); k++;
    } else {
      start = k;
      var parens = 0;
      while (k < n) {
        var c = src[k];
        if (c === '\\' && k + 1 < n && ASCII_PUNCT.test(src[k + 1])) { k += 2; continue; }
        if (c.charCodeAt(0) <= 0x20) break;
        if (c === '(') parens++;
        else if (c === ')') { if (parens === 0) break; parens--; }
        k++;
      }
      if (parens !== 0) return null;
      dest = src.slice(start, k);
    }
    var hadSpace = false;
    while (k < n && /\s/.test(src[k])) { k++; hadSpace = true; }
    var title = null;
    if ((src[k] === '"' || src[k] === "'" || src[k] === '(') && (hadSpace || dest === '')) {
      var closer = src[k] === '(' ? ')' : src[k];
      var t0 = k + 1, t = t0;
      while (t < n && src[t] !== closer) { if (src[t] === '\\') t++; t++; }
      if (t >= n) return null;
      title = src.slice(t0, t);
      k = t + 1;
      while (k < n && /\s/.test(src[k])) k++;
    }
    if (src[k] !== ')') return null;
    return { text: text, dest: unescapeBackslash(dest), title: title == null ? null : unescapeBackslash(title), end: k + 1 };
  }

  var RE_BARE = /(?:https?:\/\/|www\.)[^\s<]+/iy;
  var RE_AUTO_URL = /<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^\s<>]*)>/y;
  var RE_AUTO_MAIL = /<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*)>/y;

  function trimBareUrl(u) {
    for (;;) {
      var last = u.charAt(u.length - 1);
      if ('?!.,:*_~\'";'.indexOf(last) >= 0) { u = u.slice(0, -1); continue; }
      if (last === ')') {
        var open = u.split('(').length - 1, close = u.split(')').length - 1;
        if (close > open) { u = u.slice(0, -1); continue; }
      }
      return u;
    }
  }

  function linkHtml(url, title, inner) {
    var safe = safeUrl(url, 'link');
    if (safe == null) return inner;   // dangerous URL: keep the text, drop the link
    var blank = current.targetBlank && safe.charAt(0) !== '#';
    return '<a href="' + esc(safe) + '"' + (title ? ' title="' + esc(title) + '"' : '') +
      ' rel="noopener noreferrer"' + (blank ? ' target="_blank"' : '') + '>' + inner + '</a>';
  }

  function inline(src, noLinks, depth) {
    depth = depth || 0;
    var nodes = [], buf = '';
    function flush() { if (buf) { nodes.push({ t: 'text', v: buf }); buf = ''; } }
    function html(h) { flush(); nodes.push({ t: 'html', v: h }); }
    var n = src.length, i = 0, r, m;
    while (i < n) {
      var c = src[i];
      if (c === '\\') {
        var nx = src[i + 1];
        if (nx === '\n') { buf = buf.replace(/ +$/, ''); html('<br>\n'); i += 2; continue; }
        if (nx !== undefined && ASCII_PUNCT.test(nx)) { buf += nx; i += 2; continue; }
        buf += c; i++; continue;
      }
      if (c === '`') {
        var k = 0; while (src[i + k] === '`') k++;
        var p = i + k, found = -1;
        while (p < n) {
          var q = src.indexOf('`', p);
          if (q < 0) break;
          var run = 0; while (src[q + run] === '`') run++;
          if (run === k) { found = q; break; }
          p = q + run;
        }
        if (found >= 0) {
          var code = src.slice(i + k, found).replace(/\n/g, ' ');
          if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
          html('<code>' + esc(code) + '</code>');
          i = found + k;
        } else { buf += repeat('`', k); i += k; }
        continue;
      }
      if (c === '*' || c === '_' || c === '~') {
        var len = 0; while (src[i + len] === c) len++;
        if (c === '~' && len > 2) { buf += repeat('~', len); i += len; continue; }
        var prev = i > 0 ? src[i - 1] : undefined, next = src[i + len];
        var left = !isWS(next) && (!isPunct(next) || isWS(prev) || isPunct(prev));
        var right = !isWS(prev) && (!isPunct(prev) || isWS(next) || isPunct(next));
        var canOpen = left, canClose = right;
        if (c === '_') { canOpen = left && (!right || isPunct(prev)); canClose = right && (!left || isPunct(next)); }
        flush();
        nodes.push({ t: 'delim', ch: c, n: len, orig: len, open: canOpen, close: canClose });
        i += len; continue;
      }
      if (c === '!' && src[i + 1] === '[' && depth < MAX_DEPTH) {
        r = parseLinkLike(src, i + 1);
        if (r) {
          // alt text: rendered inline (already escaped), then our own tags are removed
          var alt = inline(r.text, true, depth + 1).replace(/<[^>]*>/g, '');
          var img = safeUrl(r.dest, 'img');
          if (img == null) html(alt);
          else html('<img src="' + esc(img) + '" alt="' + alt + '"' + (r.title ? ' title="' + esc(r.title) + '"' : '') + ' loading="lazy">');
          i = r.end; continue;
        }
        buf += c; i++; continue;
      }
      if (c === '[' && !noLinks && depth < MAX_DEPTH) {
        r = parseLinkLike(src, i);
        if (r) { html(linkHtml(r.dest, r.title, inline(r.text, true, depth + 1))); i = r.end; continue; }
        buf += c; i++; continue;
      }
      if (c === '<') {
        RE_AUTO_URL.lastIndex = i;
        m = RE_AUTO_URL.exec(src);
        if (m && !noLinks) { html(linkHtml(m[1], null, esc(m[1]))); i += m[0].length; continue; }
        RE_AUTO_MAIL.lastIndex = i;
        m = RE_AUTO_MAIL.exec(src);
        if (m && !noLinks) { html(linkHtml('mailto:' + m[1], null, esc(m[1]))); i += m[0].length; continue; }
        buf += c; i++; continue;
      }
      if ((c === 'h' || c === 'H' || c === 'w' || c === 'W') && !noLinks && (i === 0 || /[\s*_~(]/.test(src[i - 1]))) {
        RE_BARE.lastIndex = i;
        m = RE_BARE.exec(src);
        if (m) {
          var u = trimBareUrl(m[0]);
          var minLen = /^www\./i.test(u) ? 5 : (/^https:/i.test(u) ? 9 : 8);
          if (u.length >= minLen && /[A-Za-z0-9]/.test(u.slice(minLen - 1))) {
            html(linkHtml(/^www\./i.test(u) ? 'http://' + u : u, null, esc(u)));
            i += u.length; continue;
          }
        }
        buf += c; i++; continue;
      }
      if (c === '\n') {
        var sp = / +$/.exec(buf);
        if (sp && sp[0].length >= 2) { buf = buf.slice(0, -sp[0].length); html('<br>\n'); }
        else { buf = buf.replace(/ +$/, '') + '\n'; }
        i++; continue;
      }
      buf += c; i++;
    }
    flush();
    processEmphasis(nodes);
    var out = '';
    for (var x = 0; x < nodes.length; x++) {
      var nd = nodes[x];
      out += nd.t === 'html' ? nd.v : nd.t === 'delim' ? esc(repeat(nd.ch, nd.n)) : esc(nd.v);
    }
    return out;
  }

  // A reduced version of CommonMark's emphasis matching (including the "multiple of 3" rule).
  function processEmphasis(nodes) {
    var bottom = {};
    for (var c = 0; c < nodes.length; c++) {
      var cl = nodes[c];
      if (cl.t !== 'delim' || !cl.close || cl.n === 0) continue;
      var key = cl.ch + (cl.open ? '1' : '0') + (cl.orig % 3);
      var lim = Object.prototype.hasOwnProperty.call(bottom, key) ? bottom[key] : -1;
      var o = -1;
      for (var k = c - 1; k > lim; k--) {
        var op = nodes[k];
        if (op.t !== 'delim' || op.n === 0 || op.ch !== cl.ch || !op.open) continue;
        if (cl.ch === '~') { if (op.n !== cl.n) continue; }
        else if ((op.close || cl.open) && (op.orig + cl.orig) % 3 === 0 && !(op.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
        o = k; break;
      }
      if (o < 0) { bottom[key] = c - 1; continue; }
      var opener = nodes[o];
      var use, tag;
      if (cl.ch === '~') { use = opener.n; tag = 'del'; }
      else { use = (opener.n >= 2 && cl.n >= 2) ? 2 : 1; tag = use === 2 ? 'strong' : 'em'; }
      opener.n -= use; cl.n -= use;
      for (var mid = o + 1; mid < c; mid++) {
        if (nodes[mid].t === 'delim') nodes[mid] = { t: 'text', v: repeat(nodes[mid].ch, nodes[mid].n) };
      }
      nodes.splice(c, 0, { t: 'html', v: '</' + tag + '>' });
      nodes.splice(o + 1, 0, { t: 'html', v: '<' + tag + '>' });
      c = c + 1;   // the closer is now at c+2; loop again so its remaining run can match once more
    }
  }

  // -- Blocks --
  var RE_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  var RE_ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
  var RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var RE_QUOTE = /^ {0,3}>/;
  var RE_LIST = /^( {0,3})([*+-]|\d{1,9}[.)])(?=[ \t]|$)( *)(.*)$/;
  var RE_SETEXT1 = /^ {0,3}=+[ \t]*$/;
  var RE_SETEXT2 = /^ {0,3}-+[ \t]*$/;

  function isBlank(l) { return /^[ \t]*$/.test(l); }
  function indentOf(l) { var k = 0; while (l.charAt(k) === ' ') k++; return k; }

  function expandTabs(line) {
    // Only tabs in the leading indentation become spaces (4-column tab stops).
    var out = '', col = 0, i = 0;
    for (; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === ' ') { out += ' '; col++; }
      else if (ch === '\t') { var w = 4 - (col % 4); out += repeat(' ', w); col += w; }
      else break;
    }
    return out + line.slice(i);
  }

  function fenceOpen(l) {
    var m = RE_FENCE.exec(l);
    if (!m) return null;
    if (m[2].charAt(0) === '`' && m[3].indexOf('`') >= 0) return null;
    return m;
  }

  function startsBlock(l) {
    if (fenceOpen(l) || RE_ATX.test(l) || RE_HR.test(l) || RE_QUOTE.test(l)) return true;
    var m = RE_LIST.exec(l);
    if (m && !isBlank(m[4])) {
      if (/^\d/.test(m[2])) return parseInt(m[2], 10) === 1;   // inside a paragraph only "1." starts a list
      return true;
    }
    return false;
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
    var cells = [], cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '\\' && i + 1 < s.length) { cur += ch + s.charAt(i + 1); i++; continue; }
      if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }
  var RE_DELIM_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  function isDelimRow(l) { return l !== undefined && l.indexOf('|') >= 0 && RE_DELIM_ROW.test(l); }
  function isTableStart(lines, i) {
    var l = lines[i];
    return l.indexOf('|') >= 0 && isDelimRow(lines[i + 1]) && splitRow(l).length === splitRow(lines[i + 1]).length;
  }

  function hasLooseBlank(item) {
    // A blank line followed by a block at the same depth makes the list loose (fenced code excluded).
    var inFence = null;
    for (var i = 0; i < item.length; i++) {
      var l = item[i];
      var f = RE_FENCE.exec(l);
      if (inFence) { if (f && f[2].charAt(0) === inFence.charAt(0) && f[2].length >= inFence.length && isBlank(f[3])) inFence = null; continue; }
      if (fenceOpen(l)) { inFence = fenceOpen(l)[2]; continue; }
      if (isBlank(l) && i > 0) {
        var j = i + 1; while (j < item.length && isBlank(item[j])) j++;
        if (j < item.length && indentOf(item[j]) === 0 && !RE_LIST.test(item[j])) return true;
      }
    }
    return false;
  }

  function parseList(lines, i, depth) {
    var n = lines.length;
    var first = RE_LIST.exec(lines[i]);
    var ordered = /^\d/.test(first[2]);
    var kind = ordered ? first[2].slice(-1) : first[2];
    var start = ordered ? parseInt(first[2], 10) : 1;
    var items = [], loose = false;
    while (i < n) {
      var m = RE_LIST.exec(lines[i]);
      if (!m || RE_HR.test(lines[i])) break;
      if (/^\d/.test(m[2]) !== ordered || (ordered ? m[2].slice(-1) : m[2]) !== kind) break;
      var ind = m[1].length, mk = m[2].length, sp = m[3].length, rest = m[4];
      var ci, firstLine;
      if (isBlank(rest)) { ci = ind + mk + 1; firstLine = ''; }
      else if (sp > 4) { ci = ind + mk + 1; firstLine = repeat(' ', sp - 1) + rest; }
      else { ci = ind + mk + sp; firstLine = rest; }
      var item = [firstLine], j = i + 1;
      while (j < n) {
        var l = lines[j];
        if (isBlank(l)) {
          if (item.length === 1 && firstLine === '') break;   // an empty item followed by a blank line ends it
          item.push(''); j++; continue;
        }
        if (indentOf(l) >= ci) { item.push(l.slice(ci)); j++; continue; }
        var prevBlank = item[item.length - 1] === '';
        if (!prevBlank && item[item.length - 1] !== undefined && !startsBlock(l) && !RE_LIST.test(l)) {
          item.push(l.replace(/^ +/, '')); j++; continue;   // lazy continuation line
        }
        break;
      }
      var trailing = 0;
      while (item.length > 1 && item[item.length - 1] === '') { item.pop(); trailing++; }
      if (hasLooseBlank(item)) loose = true;
      items.push(item);
      i = j;
      if (trailing > 0 && i < n) {
        var nm = RE_LIST.exec(lines[i]);
        if (nm && !RE_HR.test(lines[i]) && /^\d/.test(nm[2]) === ordered && (ordered ? nm[2].slice(-1) : nm[2]) === kind) loose = true;
      }
    }
    var anyTask = false;
    var lis = items.map(function (item) {
      var task = /^\[([ xX])\](?: +|$)(.*)$/.exec(item[0]);
      var box = '';
      if (task) {
        anyTask = true;
        box = '<input type="checkbox" disabled' + (task[1] === ' ' ? '' : ' checked') + '> ';
        item = [task[2]].concat(item.slice(1));
      }
      var inner = parseBlocks(item, !loose, depth + 1);
      if (!loose) return '<li' + (task ? ' class="task-list-item"' : '') + '>' + box + inner + '</li>';
      return '<li' + (task ? ' class="task-list-item"' : '') + '>' + box + (inner ? '\n' + inner + '\n' : '') + '</li>';
    });
    var tag = ordered ? 'ol' : 'ul';
    var open = '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + (anyTask ? ' class="contains-task-list"' : '') + '>';
    return { html: open + '\n' + lis.join('\n') + '\n</' + tag + '>', next: i };
  }

  function parseTable(lines, i) {
    var head = splitRow(lines[i]);
    var aligns = splitRow(lines[i + 1]).map(function (c) {
      var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    var cols = head.length;
    function cell(tag, text, k) {
      return '<' + tag + (aligns[k] ? ' align="' + aligns[k] + '"' : '') + '>' + inline(text, false, 0) + '</' + tag + '>';
    }
    var out = '<table>\n<thead>\n<tr>' + head.map(function (t, k) { return cell('th', t, k); }).join('') + '</tr>\n</thead>';
    var j = i + 2, rows = [];
    while (j < lines.length && !isBlank(lines[j]) && lines[j].indexOf('|') >= 0 && !startsBlock(lines[j])) {
      var cells = splitRow(lines[j]);
      var tds = [];
      for (var k = 0; k < cols; k++) tds.push(cell('td', cells[k] || '', k));
      rows.push('<tr>' + tds.join('') + '</tr>');
      j++;
    }
    if (rows.length) out += '\n<tbody>\n' + rows.join('\n') + '\n</tbody>';
    return { html: out + '\n</table>', next: j };
  }

  function parseBlocks(lines, tight, depth) {
    var out = [], i = 0, n = lines.length, m;
    while (i < n) {
      var line = lines[i];
      if (isBlank(line)) { i++; continue; }

      // fenced code
      if ((m = fenceOpen(line))) {
        var fence = m[2], pad = m[1].length;
        var info = m[3].trim().split(/\s+/)[0] || '';
        info = unescapeBackslash(info).replace(/[^A-Za-z0-9_+.#\-]/g, '');
        var body = [], j = i + 1;
        for (; j < n; j++) {
          var cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
          if (cm && cm[1].charAt(0) === fence.charAt(0) && cm[1].length >= fence.length) break;
          var bl = lines[j], strip = 0;
          while (strip < pad && bl.charAt(strip) === ' ') strip++;
          body.push(bl.slice(strip));
        }
        out.push('<pre><code' + (info ? ' class="language-' + esc(info) + '"' : '') + '>' +
          esc(body.join('\n') + (body.length ? '\n' : '')) + '</code></pre>');
        i = j + 1; continue;
      }

      // indented code (4 spaces)
      if (/^ {4}/.test(line)) {
        var code = [], k = i;
        while (k < n && (/^ {4}/.test(lines[k]) || isBlank(lines[k]))) { code.push(lines[k].slice(4)); k++; }
        while (code.length && isBlank(code[code.length - 1])) code.pop();
        out.push('<pre><code>' + esc(code.join('\n') + '\n') + '</code></pre>');
        i = k; continue;
      }

      // # heading
      if ((m = RE_ATX.exec(line))) {
        var level = m[1].length;
        var htext = m[2].replace(/(^|[ \t]+)#+[ \t]*$/, '').trim();
        out.push('<h' + level + '>' + inline(htext, false, 0) + '</h' + level + '>');
        i++; continue;
      }

      // horizontal rule
      if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

      // block quote
      if (RE_QUOTE.test(line) && depth < MAX_DEPTH) {
        var q = [];
        while (i < n) {
          var ql = lines[i];
          if (RE_QUOTE.test(ql)) { q.push(ql.replace(/^ {0,3}> ?/, '')); i++; continue; }
          if (!isBlank(ql) && q.length && !isBlank(q[q.length - 1]) && !startsBlock(ql)) { q.push(ql); i++; continue; }
          break;
        }
        var qi = parseBlocks(q, false, depth + 1);
        out.push('<blockquote>' + (qi ? '\n' + qi + '\n' : '') + '</blockquote>');
        continue;
      }

      // list
      if (RE_LIST.test(line) && depth < MAX_DEPTH) {
        var lst = parseList(lines, i, depth);
        out.push(lst.html);
        i = lst.next; continue;
      }

      // table
      if (isTableStart(lines, i)) {
        var tb = parseTable(lines, i);
        out.push(tb.html);
        i = tb.next; continue;
      }

      // paragraph (or an underline-style heading)
      var para = [line.replace(/^ +/, '')], p = i + 1, heading = 0;
      while (p < n) {
        var pl = lines[p];
        if (isBlank(pl)) break;
        if (RE_SETEXT1.test(pl)) { heading = 1; break; }
        if (RE_SETEXT2.test(pl)) { heading = 2; break; }
        if (startsBlock(pl) || isTableStart(lines, p)) break;
        para.push(pl.replace(/^ +/, ''));
        p++;
      }
      var text = para.join('\n').replace(/[ \t]+$/, '');
      if (heading) { out.push('<h' + heading + '>' + inline(text, false, 0) + '</h' + heading + '>'); i = p + 1; continue; }
      out.push(tight ? inline(text, false, 0) : '<p>' + inline(text, false, 0) + '</p>');
      i = p;
    }
    return out.join('\n');
  }

  function toHtml(src, opts) {
    opts = opts || {};
    current = { targetBlank: opts.targetBlank !== false };
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
    // NUL becomes U+FFFD (CommonMark rule)
    var repl = String.fromCharCode(0xfffd);
    lines = lines.map(function (l) { return l.indexOf(String.fromCharCode(0)) >= 0 ? l.split(String.fromCharCode(0)).join(repl) : l; });
    var html = parseBlocks(lines, false, 0);
    return html ? html + '\n' : '';
  }

  return {
    toHtml: toHtml,
    inline: function (s, opts) { current = { targetBlank: !opts || opts.targetBlank !== false }; return inline(String(s), false, 0); },
    escapeHtml: esc,
    safeUrl: safeUrl
  };
});
