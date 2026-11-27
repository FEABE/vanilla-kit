/**
 * minify.js — JavaScript minifier: drops comments and whitespace, shortens local names. Zero dependencies, one file.
 * Part of vanilla-kit. MIT License.
 *
 *   - minify(src, { mangle = true, keepLicense = true, keepFnames = false, keepClassnames = true })
 *       -> { code, renamed, bindings, skipped }
 *       keepLicense keeps /*! ... *\/ comments and comments containing @license or @preserve (and a #! line).
 *       mangle shortens names that are provably local (see below); mangle: false only removes comments and whitespace.
 *       Throws an Error with .line / .col when the input cannot be read (syntax error or unsupported syntax).
 *   - tokenize(src) -> [{ type, text }]  the token stream the minifier works on (after parser checks)
 *   - inspect(src)  -> { tokens, statements, occurrences }  structural fingerprint, used to verify the output
 *
 *   How it stays safe:
 *   - A tokenizer splits the source; a recursive-descent parser then reads the whole program. The parser decides
 *     whether a "/" is a regular expression or a division (re-reading the source when the tokenizer guessed wrong)
 *     and checks where every statement ends. If the program cannot be parsed, minify() throws instead of guessing.
 *   - Token text is never changed (except renamed identifiers). Whitespace is kept only where two tokens would
 *     merge (a + +b, a - -b, 1 .x, a / /re/), and a line break is removed only when it cannot affect automatic
 *     semicolon insertion.
 *   - Renaming never touches top-level (global or module) names, property names, labels, or exported names.
 *     It is skipped completely when the code uses direct eval or with, or has \u escapes in identifiers.
 *     Kept as-is: functions declared inside blocks (and same-named outer variables), class names (keepClassnames),
 *     catch parameters redeclared with var. A default parameter value never sees names declared in the body.
 *     Function names are shortened unless keepFnames is set — code that reads fn.name needs keepFnames.
 *   - Not supported (throws): JSX, TypeScript, decorators, HTML-like comments (<!-- and -->).
 *
 * Works in the browser (window.VanillaMinify) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VanillaMinify = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function setOf(s) { var o = Object.create(null); s.split(' ').forEach(function (w) { o[w] = 1; }); return o; }

  // ---------------------------------------------------------------- tokenizer

  // After these keywords an expression starts, so "/" begins a regular expression.
  var KW_BEFORE_EXPR = setOf('return typeof instanceof in of new delete void throw case do else yield await extends');
  // A line break after these words can change the meaning (restricted productions, contextual keywords): keep it.
  var KEEP_NL_AFTER = setOf('return throw break continue yield async get set static let await');
  var STMT_HEAD = setOf('if while for with');
  // Longest first.
  var PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
    '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
    '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@'];
  // A statement cannot end right after these, so a following line break can go.
  var NO_END_AFTER = setOf('{ ( [ , ; : ? ?. . ... => = == === != !== < > <= >= + - * / % ** & | ^ ! ~ && || ?? << >> >>> ' +
    '+= -= *= /= %= **= <<= >>= >>>= &= |= ^= &&= ||= ??=');
  // A statement cannot start with these, so a line break before them never ends a statement.
  var NO_START = setOf(') ] } , ; : ? ?. . => = == === != !== < > <= >= * % ** & | ^ && || ?? << >> >>> ' +
    '+= -= *= /= %= **= <<= >>= >>>= &= |= ^= &&= ||= ??=');

  function isIdStart(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c === '#' || c === '\\' || c > '\x7f'; }
  function isIdPart(c) { return isIdStart(c) || (c >= '0' && c <= '9'); }
  function isDigit(c) { return c >= '0' && c <= '9'; }
  var LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);   // line / paragraph separator
  var NBSP = String.fromCharCode(0xa0), BOM = String.fromCharCode(0xfeff);
  var NEWLINE_RE = new RegExp('[\\n\\r' + LS + PS + ']');
  function isNewline(c) { return c === '\n' || c === '\r' || c === LS || c === PS; }
  function isSpace(c) {
    return c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === NBSP || c === BOM || isNewline(c) ||
      (c > '\x7f' && /\s/.test(c));
  }

  function SyntaxErr(message, src, pos) {
    var before = src.slice(0, pos);
    var line = before.split('\n').length;
    var col = pos - before.lastIndexOf('\n');
    var e = new Error(message + ' (line ' + line + ', column ' + col + ')');
    e.line = line; e.col = col; e.pos = pos;
    return e;
  }

  function isProp(t) { return t && t.type === 'punct' && (t.text === '.' || t.text === '?.'); }

  // Heuristic: can "/" after the last token start a regular expression? The parser corrects the rare wrong guess.
  function regexAfter(out) {
    var t = out[out.length - 1];
    if (!t) return true;
    switch (t.type) {
      case 'num': case 'str': case 'tpl': case 'regex': return false;
      case 'tplHead': case 'tplMid': return true;
      case 'id': return !!KW_BEFORE_EXPR[t.text] && !isProp(out[out.length - 2]);
      case 'punct':
        if (t.text === ')' || t.text === '}') return !!t.re;
        return !(t.text === ']' || t.text === '++' || t.text === '--');
    }
    return true;
  }
  // Heuristic: is the "{" about to be read a block (true) or an object literal / expression (false)?
  function braceIsBlock(out, st, nl) {
    var t = out[out.length - 1];
    if (!t) return true;
    if (t.type === 'punct') {
      if (t.text === ')' || t.text === ';' || t.text === '}' || t.text === '=>' || t.text === '{') return true;
      if (t.text === ':') return !!(st && st.k === '{' && st.f);
      return false;
    }
    if (t.type === 'id') {
      if (isProp(out[out.length - 2])) return false;
      if (t.text === 'else' || t.text === 'do' || t.text === 'try' || t.text === 'finally' || t.text === 'static') return true;
      if (t.text === 'return' || t.text === 'yield') return nl;
    }
    return false;
  }

  /*
   * Reads tokens from src[i] to the end and appends them to out. The bracket stack st is a persistent linked list
   * ({ k: '(' | '{' | 'tpl', f, up }) so that any token can be re-read later from its own state.
   * Token: { type: 'id'|'num'|'str'|'tpl'|'tplHead'|'tplMid'|'regex'|'punct'|'eof', text, start, nlBefore, st,
   *          comments?: kept comments before the token, re?: (for ")" "}") a regex may follow }
   * force: 'regex' or 'div' decides the first token when it starts with "/".
   * A read error becomes a final { type: 'error' } token: the parser throws it only if it really gets there,
   * so a wrongly guessed "/" (whose regex or division reading ran into garbage) can still be re-read first.
   */
  function lexTail(src, i, out, st, nl, force, keepLicense, pending) {
    try {
      return lexRun(src, i, out, st, nl, force, keepLicense, pending);
    } catch (e) {
      if (e.pos === undefined) throw e;
      out.push({ type: 'error', text: '', start: e.pos, err: e, nlBefore: false, st: null });
      return out;
    }
  }
  function lexRun(src, i, out, st, nl, force, keepLicense, pending) {
    var n = src.length;
    var nlc = nl;            // line break since the last kept comment
    function push(type, text, start) {
      var t = { type: type, text: text, start: start, nlBefore: nl, st: st };
      if (pending) { pending[pending.length - 1].nlAfter = nlc; t.comments = pending; pending = null; }
      out.push(t);
      nl = nlc = false;
      force = null;
      return t;
    }
    function keepComment(text, line) {
      (pending = pending || []).push({ text: text, line: line, nlBefore: nlc, nlAfter: false });
      nlc = false;
    }
    function readTemplateChunk(start) {
      var j = start;
      while (j < n) {
        var c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '`') return { end: j + 1, open: false };
        if (c === '$' && src[j + 1] === '{') return { end: j + 2, open: true };
        j++;
      }
      throw SyntaxErr('Unterminated template literal', src, start - 1);
    }

    while (i < n) {
      var c = src[i];
      if (isSpace(c)) { if (isNewline(c)) nl = nlc = true; i++; continue; }

      if (c === '/' && src[i + 1] === '/') {
        var e1 = i + 2; while (e1 < n && !isNewline(src[e1])) e1++;
        var lineText = src.slice(i, e1);
        if (keepLicense && /@license|@preserve|^\/\/!/.test(lineText)) keepComment(lineText, true);
        i = e1; continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        var e2 = src.indexOf('*/', i + 2);
        if (e2 < 0) throw SyntaxErr('Unterminated comment', src, i);
        var block = src.slice(i, e2 + 2);
        var multi = NEWLINE_RE.test(block);
        if (keepLicense && /^\/\*!|@license|@preserve/.test(block)) keepComment(block, false);
        if (multi) nl = nlc = true;           // a comment with a line break counts as a line break (ASI)
        i = e2 + 2; continue;
      }
      if (c === '<' && src.startsWith('<!--', i)) throw SyntaxErr('HTML-like comment <!-- is not supported', src, i);
      if (c === '-' && src.startsWith('-->', i) && (nl || !out.length)) throw SyntaxErr('HTML-like comment --> is not supported', src, i);

      var start = i;
      if (c === '`') {
        var r = readTemplateChunk(i + 1);
        if (!r.open) { push('tpl', src.slice(i, r.end), start); i = r.end; continue; }
        push('tplHead', src.slice(i, r.end), start); st = { k: 'tpl', up: st }; i = r.end; continue;
      }
      if (c === '}' && st && st.k === 'tpl') {
        st = st.up;
        var r2 = readTemplateChunk(i + 1);
        if (!r2.open) { push('tpl', src.slice(i, r2.end), start).tail = true; i = r2.end; continue; }
        push('tplMid', src.slice(i, r2.end), start); st = { k: 'tpl', up: st }; i = r2.end; continue;
      }

      if (c === '"' || c === "'") {
        var j = i + 1;
        while (j < n && src[j] !== c) {
          if (src[j] === '\\') { j++; if (src[j] === '\r' && src[j + 1] === '\n') j++; }
          else if (src[j] === '\n' || src[j] === '\r') throw SyntaxErr('Unterminated string', src, i);
          j++;
        }
        if (j >= n) throw SyntaxErr('Unterminated string', src, i);
        push('str', src.slice(i, j + 1), start); i = j + 1; continue;
      }

      if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
        var k = i + 1;
        while (k < n) {
          var d = src[k];
          if (isIdPart(d) || d === '.') { k++; continue; }
          if ((d === '+' || d === '-') && /[eE]$/.test(src.slice(i, k)) && !/^0[xX]/.test(src.slice(i, k))) { k++; continue; }
          break;
        }
        push('num', src.slice(i, k), start); i = k; continue;
      }

      if (isIdStart(c)) {
        var m = i + 1;
        while (m < n && isIdPart(src[m])) m++;
        push('id', src.slice(i, m), start); i = m; continue;
      }

      if (c === '/' && (force === 'regex' || (force !== 'div' && regexAfter(out)))) {
        var q = i + 1, inClass = false;
        while (q < n) {
          var ch = src[q];
          if (isNewline(ch)) throw SyntaxErr('Unterminated regular expression', src, i);
          if (ch === '\\') { q += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          q++;
        }
        if (q >= n) throw SyntaxErr('Unterminated regular expression', src, i);
        q++;
        while (q < n && isIdPart(src[q])) q++;
        push('regex', src.slice(i, q), start); i = q; continue;
      }

      var p = null;
      for (var x = 0; x < PUNCT.length; x++) { if (src.startsWith(PUNCT[x], i)) { p = PUNCT[x]; break; } }
      if (!p) throw SyntaxErr('Unexpected character "' + c + '"', src, i);
      if (p === '?.' && isDigit(src[i + 2] || '')) p = '?';      // a?.5:1 is a ternary
      if (p === '(') {
        var pt = out[out.length - 1], pp = out[out.length - 2];
        var head = !!pt && pt.type === 'id' && !isProp(pp) &&
          (!!STMT_HEAD[pt.text] || (pt.text === 'await' && !!pp && pp.type === 'id' && pp.text === 'for'));
        push('punct', p, start);
        st = { k: '(', f: head, up: st };
      } else if (p === '{') {
        var blk = braceIsBlock(out, st, nl);
        push('punct', p, start);
        st = { k: '{', f: blk, up: st };
      } else if (p === ')' || p === '}') {
        var t = push('punct', p, start);
        if (st && st.k === (p === ')' ? '(' : '{')) { t.re = st.f; st = st.up; }
      } else push('punct', p, start);
      i += p.length;
    }
    if (st) {
      for (var s = st; s; s = s.up) if (s.k === 'tpl') throw SyntaxErr('Unterminated template literal', src, n);
    }
    push('eof', '', n);
    return out;
  }

  function lex(src, keepLicense) {
    var hashbang = '';
    var from = 0;
    if (src[0] === '#' && src[1] === '!') {
      from = src.length;
      for (var j = 0; j < src.length; j++) if (isNewline(src[j])) { from = j; break; }
      hashbang = src.slice(0, from);
    }
    return { src: src, keepLicense: keepLicense, hashbang: hashbang, toks: lexTail(src, from, [], null, false, null, keepLicense, null) };
  }
  // Re-reads the source from token k, deciding its "/" as forced.
  function relexAt(L, k, force) {
    var old = L.toks[k];
    L.toks.length = k;
    lexTail(L.src, old.start, L.toks, old.st, old.nlBefore, force, L.keepLicense, old.comments || null);
  }

  // ---------------------------------------------------------------- parser + scope analysis

  // Never chosen as new names.
  var RESERVED = setOf('break case catch class const continue debugger default delete do else enum export extends false finally for ' +
    'function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static ' +
    'implements interface package private protected public await arguments eval undefined NaN Infinity async of get set as from');
  // Reserved words that can never be a variable reference.
  var NOT_REF = setOf('break case catch class const continue debugger default delete do else enum export extends finally for ' +
    'function if import in instanceof new return switch throw try typeof var void while with');
  var BINARY = setOf('= += -= *= /= %= **= <<= >>= >>>= &= |= ^= &&= ||= ??= == != === !== < > <= >= + - * / % ** & | ^ && || ?? << >> >>>');
  var PREFIX = setOf('! ~ + - ++ --');
  var PREFIX_KW = setOf('typeof void delete await');

  var FIRST = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
  var REST = FIRST + '0123456789';
  // 0 -> a, 53 -> $, 54 -> aa, ...
  function nameAt(g) {
    var s = FIRST[g % FIRST.length];
    g = Math.floor(g / FIRST.length);
    while (g > 0) { g--; s += REST[g % REST.length]; g = Math.floor(g / REST.length); }
    return s;
  }

  function Scope(kind, parent) {
    this.kind = kind;            // 'root' | 'function' | 'block' | 'catch' | 'name'
    this.parent = parent;
    this.children = [];
    this.vars = new Map();       // name -> binding
    this.list = [];
    this.outside = new Set();    // bindings declared further out but used inside this scope
    this.free = new Set();       // names used inside this scope that are declared nowhere (globals)
  }

  var EOF_TOKEN = { type: 'eof', text: '' };

  /*
   * Parses the whole token stream (re-reading the source where a "/" was guessed wrong), records scopes,
   * declarations and references, marks the "}" that end statements and the ")" that end statement heads.
   * Throws a SyntaxErr when the program cannot be read.
   */
  function analyze(L, opts) {
    var toks = L.toks, pos = 0;
    var keepFnames = !!opts.keepFnames, keepClassnames = opts.keepClassnames !== false;
    var rootScope = new Scope('root', null), scope = rootScope;
    var refs = [], ends = [], blockFns = [], stmts = [], unsafe = null;
    var paramCtx = null;         // function scopes whose parameter list is being read (linked list)
    var match = [];

    function computeMatch() {
      match = new Array(toks.length);
      var stack = [];
      for (var i = 0; i < toks.length; i++) {
        var tk = toks[i];
        if (tk.type !== 'punct') continue;
        if (tk.text === '(' || tk.text === '[' || tk.text === '{') stack.push(i);
        else if (tk.text === ')' || tk.text === ']' || tk.text === '}') { if (stack.length) match[stack.pop()] = i; }
      }
    }
    computeMatch();
    function relex(force) { relexAt(L, pos, force); computeMatch(); }

    function peek(k) {
      var t = toks[pos + (k || 0)] || EOF_TOKEN;
      if (!k && t.type === 'error') throw t.err;     // the tokenizer could not read on from here
      return t;
    }
    function next() { var t = peek(); if (t.type !== 'eof') pos++; return t; }
    function is(t, text) { return t.type === 'punct' && t.text === text; }
    function isId(t, text) { return t.type === 'id' && t.text === text; }
    function fail(msg) {
      var t = peek();
      throw SyntaxErr(msg + (t.type === 'eof' ? ' at end of input' : ', found "' + t.text + '"'), L.src, t.type === 'eof' ? L.src.length : t.start);
    }
    function expect(text) { if (!is(peek(), text)) fail('Expected "' + text + '"'); return next(); }
    // Statement end: ";" or a place where automatic semicolon insertion applies.
    function semi() {
      var t = peek();
      if (is(t, ';')) { next(); return; }
      if (is(t, '}') || t.type === 'eof' || t.nlBefore) return;
      fail('Expected ";"');
    }

    function enter(kind) { var s = new Scope(kind, scope); scope.children.push(s); scope = s; return s; }
    function leave(s) { scope = s.parent; }
    function varScope(from) { var s = from || scope; while (s.kind !== 'function' && s.kind !== 'root') s = s.parent; return s; }

    // kind: 'param' | 'fn' | 'class' | undefined
    function declare(tok, target, shorthand, keep, kind) {
      if (tok.type !== 'id' || NOT_REF[tok.text] || tok.text[0] === '#') { pos--; fail('Expected a name'); }
      var b = target.vars.get(tok.text);
      if (!b) {
        b = { name: tok.text, scope: target, occ: [], keep: target.kind === 'root', isParam: false, newName: null, avoid: new Set() };
        target.vars.set(tok.text, b);
        target.list.push(b);
      }
      // "yield" / "await" as variable names: their uses are not always visible as references, so never rename them
      if (keep || tok.text === 'yield' || tok.text === 'await') b.keep = true;
      if (kind === 'param') b.isParam = true;
      b.occ.push({ tok: tok, shorthand: !!shorthand });
      for (var s = scope; s && s !== target; s = s.parent) {
        s.outside.add(b);
        // catch (e) { var e = 1 } — the initializer writes the catch parameter: keep both names
        if (s.kind === 'catch' && s.vars.has(tok.text)) { s.vars.get(tok.text).keep = true; b.keep = true; }
      }
      return b;
    }
    function ref(tok, shorthand) {
      if (tok.text === 'eval') unsafe = unsafe || 'eval';
      refs.push({ tok: tok, scope: scope, shorthand: !!shorthand, pc: paramCtx });
    }

    // ---- expressions
    function startsOperand(t) {
      if (t.type === 'eof') return false;
      if (t.type === 'punct') return t.text === '(' || t.text === '[' || t.text === '{' || !!PREFIX[t.text];
      if (t.type === 'id') return t.text !== 'in' && t.text !== 'instanceof' && t.text !== 'of';
      return t.type !== 'tplMid' && !(t.type === 'tpl' && t.tail);
    }
    function parseExpression(noIn) {
      parseAssign(noIn);
      while (is(peek(), ',')) { next(); parseAssign(noIn); }
    }
    // Precedence does not matter for name analysis: read "operand (operator operand)*".
    function parseAssign(noIn) {
      for (;;) {
        if (parseUnary()) return;          // an arrow function ends the expression
        var t = peek();
        if (t.type === 'regex') { relex('div'); t = peek(); }   // after an operand "/" is a division
        if (t.type === 'punct' && BINARY[t.text]) { next(); continue; }
        if (t.type === 'id' && (t.text === 'instanceof' || (t.text === 'in' && !noIn))) { next(); continue; }
        if (is(t, '?')) { next(); parseAssign(false); expect(':'); continue; }
        return;
      }
    }
    function parseUnary() {
      for (;;) {
        var t = peek();
        if (t.type === 'punct' && PREFIX[t.text]) { next(); continue; }
        if (t.type === 'id' && PREFIX_KW[t.text]) {
          if (t.text === 'await' && !startsOperand(peek(1))) break;   // "await" used as a plain name (scripts)
          next(); continue;
        }
        if (isId(t, 'yield')) {
          next();
          if (is(peek(), '*')) next();
          if (peek().nlBefore || !startsOperand(peek())) return false;
          continue;
        }
        break;
      }
      return parsePostfix();
    }
    function propName() {
      var t = next();
      if (t.type !== 'id') { pos--; fail('Expected a property name'); }
    }
    function parseArgs() {
      expect('(');
      while (!is(peek(), ')')) {
        if (is(peek(), '...')) next();
        parseAssign(false);
        if (!is(peek(), ')')) expect(',');
      }
      next();
    }
    function parsePostfix() {
      if (parsePrimary()) return true;
      for (;;) {
        var t = peek();
        if (is(t, '.')) { next(); propName(); continue; }
        if (is(t, '?.')) {
          next();
          if (is(peek(), '(')) parseArgs();
          else if (is(peek(), '[')) { next(); parseExpression(false); expect(']'); }
          else propName();
          continue;
        }
        if (is(t, '[')) { next(); parseExpression(false); expect(']'); continue; }
        if (is(t, '(')) { parseArgs(); continue; }
        if ((t.type === 'tpl' && !t.tail) || t.type === 'tplHead') { parseTemplate(); continue; }   // tagged template
        if ((is(t, '++') || is(t, '--')) && !t.nlBefore) { next(); continue; }
        return false;
      }
    }
    function parseTemplate() {
      var t = next();
      if (t.type === 'tpl') return;
      for (;;) {
        parseExpression(false);
        var u = next();
        if (u.type === 'tplMid') continue;
        if (u.type === 'tpl' && u.tail) return;
        pos--; fail('Unbalanced template literal');
      }
    }
    function isArrowParen(i) {
      var j = match[i];
      return j !== undefined && is(toks[j + 1] || EOF_TOKEN, '=>') && !(toks[j + 1] || EOF_TOKEN).nlBefore;
    }
    // Returns true when the operand was an arrow function (nothing may follow it in the same expression).
    function parsePrimary() {
      var t = peek();
      if (t.type === 'punct' && (t.text === '/' || t.text === '/=')) { relex('regex'); t = peek(); }   // operand position
      switch (t.type) {
        case 'num': case 'str': case 'regex': next(); return false;
        case 'tpl': if (t.tail) fail('Unbalanced template literal'); next(); return false;
        case 'tplHead': parseTemplate(); return false;
        case 'eof': fail('Expected an expression'); return false;
      }
      if (t.type === 'punct') {
        if (t.text === '(') {
          if (isArrowParen(pos)) { parseArrow(); return true; }
          next(); parseExpression(false); expect(')'); return false;
        }
        if (t.text === '[') { parseArray(); return false; }
        if (t.text === '{') { parseObject(); return false; }
        fail('Unexpected token');
      }
      if (t.type !== 'id') fail('Expected an expression');
      var w = t.text;
      if (w === 'function') { parseFunction(false); return false; }
      if (w === 'class') { parseClass(false); return false; }
      if (w === 'async' && !peek(1).nlBefore) {
        var u = peek(1);
        if (isId(u, 'function')) { next(); parseFunction(false); return false; }
        if (u.type === 'id' && !NOT_REF[u.text] && is(peek(2), '=>')) { next(); parseArrow(); return true; }
        if (is(u, '(') && isArrowParen(pos + 1)) { next(); parseArrow(); return true; }
      }
      if (w === 'new') {
        next();
        if (is(peek(), '.')) { next(); propName(); return false; }   // new.target
        parsePostfix();
        return false;
      }
      if (w === 'this' || w === 'super' || w === 'null' || w === 'true' || w === 'false') { next(); return false; }
      if (w === 'import') { next(); if (is(peek(), '.')) { next(); propName(); } return false; }   // import.meta, import()
      if (w[0] === '#') { next(); return false; }   // #x in obj
      if (NOT_REF[w]) fail('Unexpected keyword');
      if (is(peek(1), '=>') && !peek(1).nlBefore) { parseArrow(); return true; }
      next();
      ref(t, false);
      return false;
    }
    function parseArray() {
      expect('[');
      while (!is(peek(), ']')) {
        if (is(peek(), ',')) { next(); continue; }
        if (is(peek(), '...')) next();
        parseAssign(false);
        if (!is(peek(), ']')) expect(',');
      }
      next();
    }
    // Property key: returns the token for a name, string or number key, null for a computed [key].
    function parseKey() {
      var t = peek();
      if (is(t, '[')) { next(); parseExpression(false); expect(']'); return null; }
      if (t.type === 'id' || t.type === 'str' || t.type === 'num') return next();
      fail('Expected a property name');
    }
    function isKeyStart(u) { return u.type === 'id' || u.type === 'str' || u.type === 'num' || is(u, '[') || is(u, '*'); }
    function parseObject() {
      expect('{');
      while (!is(peek(), '}')) {
        if (is(peek(), '...')) { next(); parseAssign(false); }
        else {
          while (peek().type === 'id' && (peek().text === 'get' || peek().text === 'set' || peek().text === 'async') && isKeyStart(peek(1))) next();
          if (is(peek(), '*')) next();
          var key = parseKey();
          if (is(peek(), '(')) parseMethod();
          else if (is(peek(), ':')) { next(); parseAssign(false); }
          else {
            // shorthand { a } or, in a destructuring assignment, { a = 1 }
            if (!key || key.type !== 'id' || NOT_REF[key.text] || key.text[0] === '#') fail('Expected a property value');
            ref(key, true);
            if (is(peek(), '=')) { next(); parseAssign(false); }
          }
        }
        if (!is(peek(), '}')) expect(',');
      }
      next();
    }
    function parseParams(fs) {
      var saved = paramCtx;
      paramCtx = { s: fs, up: saved };
      expect('(');
      while (!is(peek(), ')')) {
        if (is(peek(), '...')) next();
        parseBinding(fs, false, 'param');
        if (is(peek(), '=')) { next(); parseAssign(false); }
        if (!is(peek(), ')')) expect(',');
      }
      next();
      paramCtx = saved;
    }
    function parseFunctionBody() {
      expect('{');
      while (!is(peek(), '}')) { if (peek().type === 'eof') fail('Unterminated function body'); parseStatement(); }
      return next();
    }
    function parseMethod() {
      var fs = enter('function');
      parseParams(fs);
      parseFunctionBody();
      leave(fs);
    }
    function parseArrow() {
      var fs = enter('function');
      if (is(peek(), '(')) parseParams(fs);
      else declare(next(), fs, false, false, 'param');
      expect('=>');
      if (is(peek(), '{')) parseFunctionBody();
      else parseAssign(false);
      leave(fs);
    }
    // At "function". Returns the closing "}".
    function parseFunction(isDecl) {
      next();
      if (is(peek(), '*')) next();
      var nameTok = null;
      if (peek().type === 'id') nameTok = next();
      var nameScope = null;
      if (isDecl && nameTok) {
        if (scope.kind === 'function' || scope.kind === 'root') declare(nameTok, scope, false, keepFnames, 'fn');
        else blockFns.push(declare(nameTok, scope, false, true, 'fn'));   // block-level function: keep its name
      } else if (nameTok) {
        nameScope = enter('name');
        declare(nameTok, nameScope, false, keepFnames, 'fn');
      }
      var fs = enter('function');
      parseParams(fs);
      var close = parseFunctionBody();
      leave(fs);
      if (nameScope) leave(nameScope);
      return close;
    }
    function parseClass(isDecl) {
      next();
      var nameTok = null, cs = null;
      if (peek().type === 'id' && !isId(peek(), 'extends')) nameTok = next();
      if (nameTok && isDecl) declare(nameTok, scope, false, keepClassnames || (scope.kind !== 'function' && scope.kind !== 'root'), 'class');
      else if (nameTok) { cs = enter('name'); declare(nameTok, cs, false, keepClassnames, 'class'); }
      if (isId(peek(), 'extends')) { next(); parseUnary(); }
      expect('{');
      while (!is(peek(), '}')) {
        if (peek().type === 'eof') fail('Unterminated class body');
        if (is(peek(), ';')) { next(); continue; }
        parseClassMember();
      }
      var close = next();
      if (cs) leave(cs);
      return close;
    }
    function parseClassMember() {
      if (isId(peek(), 'static')) {
        if (is(peek(1), '{')) {   // static { } block
          next();
          var sb = enter('function');
          parseFunctionBody();
          leave(sb);
          return;
        }
        if (isKeyStart(peek(1)) && !peek(1).nlBefore) next();
      }
      while (peek().type === 'id' && (peek().text === 'get' || peek().text === 'set' || peek().text === 'async' || peek().text === 'accessor') &&
        isKeyStart(peek(1)) && !peek(1).nlBefore) next();
      if (is(peek(), '*')) next();
      parseKey();
      if (is(peek(), '(')) { parseMethod(); return; }
      if (is(peek(), '=')) {   // field initializer
        next();
        var fs = enter('function');
        parseAssign(false);
        leave(fs);
      }
      semi();
    }

    // ---- statements
    function parseBinding(target, keep, kind) {
      var t = peek();
      if (is(t, '[')) {
        next();
        while (!is(peek(), ']')) {
          if (is(peek(), ',')) { next(); continue; }
          if (is(peek(), '...')) next();
          parseBinding(target, keep, kind);
          if (is(peek(), '=')) { next(); parseAssign(false); }
          if (!is(peek(), ']')) expect(',');
        }
        next();
        return;
      }
      if (is(t, '{')) {
        next();
        while (!is(peek(), '}')) {
          if (is(peek(), '...')) { next(); parseBinding(target, keep, kind); }
          else {
            var key = parseKey();
            if (is(peek(), ':')) { next(); parseBinding(target, keep, kind); }
            else {
              if (!key || key.type !== 'id') fail('Expected a name in the pattern');
              declare(key, target, true, keep, kind);
            }
            if (is(peek(), '=')) { next(); parseAssign(false); }
          }
          if (!is(peek(), '}')) expect(',');
        }
        next();
        return;
      }
      if (t.type === 'id') { next(); declare(t, target, false, keep, kind); return; }
      fail('Expected a name');
    }
    function parseDeclarations(kind, noIn) {
      var target = kind === 'var' ? varScope() : scope;
      for (;;) {
        parseBinding(target, false);
        if (is(peek(), '=')) { next(); parseAssign(noIn); }
        if (!is(peek(), ',')) return;
        next();
      }
    }
    function letDecl(u) { return (u.type === 'id' && u.text !== 'in' && u.text !== 'of' && u.text !== 'instanceof') || is(u, '[') || is(u, '{'); }
    function parenExpr() { expect('('); parseExpression(false); return expect(')'); }
    function parseBlock(kind) {
      var s = enter(kind || 'block');
      expect('{');
      while (!is(peek(), '}')) { if (peek().type === 'eof') fail('Unterminated block'); parseStatement(); }
      var close = next();
      leave(s);
      return close;
    }
    // Body of if / else / loops / labels: its own block scope, so a function declared there keeps its name.
    function parseSub() { var s = enter('block'); parseStatement(); leave(s); }
    function parseFor() {
      next();
      if (isId(peek(), 'await')) next();
      var fsc = enter('block');
      expect('(');
      var t = peek();
      if (is(t, ';')) { /* empty init */ }
      else if (isId(t, 'var') || isId(t, 'const') || (isId(t, 'let') && letDecl(peek(1)))) { next(); parseDeclarations(t.text, true); }
      else parseExpression(true);
      if (isId(peek(), 'of')) { next(); parseAssign(false); }
      else if (isId(peek(), 'in')) { next(); parseExpression(false); }
      else {
        expect(';');
        if (!is(peek(), ';')) parseExpression(false);
        expect(';');
        if (!is(peek(), ')')) parseExpression(false);
      }
      expect(')').headEnd = true;
      parseSub();
      leave(fsc);
    }
    function attributes() {
      if ((isId(peek(), 'with') || isId(peek(), 'assert')) && !peek().nlBefore && is(peek(1), '{')) { next(); parseObject(); }
    }
    function expectStr() { if (peek().type !== 'str') fail('Expected a module name'); next(); }
    function parseImport() {
      next();
      if (peek().type === 'str') { next(); attributes(); semi(); return; }
      if (peek().type === 'id' && !(isId(peek(), 'from') && peek(1).type === 'str')) {
        declare(next(), rootScope, false, true);
        if (is(peek(), ',')) next();
      }
      if (is(peek(), '*')) { next(); if (!isId(peek(), 'as')) fail('Expected "as"'); next(); declare(next(), rootScope, false, true); }
      else if (is(peek(), '{')) {
        next();
        while (!is(peek(), '}')) {
          var a = next();
          if (isId(peek(), 'as')) { next(); a = next(); }
          declare(a, rootScope, false, true);
          if (!is(peek(), '}')) expect(',');
        }
        next();
      }
      if (!isId(peek(), 'from')) fail('Expected "from"');
      next(); expectStr();
      attributes();
      semi();
    }
    function parseExport() {
      next();
      var t = peek();
      if (isId(t, 'default')) {
        next();
        var u = peek();
        if (isId(u, 'function')) { ends.push(parseFunction(true)); return; }
        if (isId(u, 'async') && isId(peek(1), 'function') && !peek(1).nlBefore) { next(); ends.push(parseFunction(true)); return; }
        if (isId(u, 'class')) { ends.push(parseClass(true)); return; }
        parseAssign(false); semi(); return;
      }
      if (is(t, '*')) {
        next();
        if (isId(peek(), 'as')) { next(); next(); }
        if (!isId(peek(), 'from')) fail('Expected "from"');
        next(); expectStr();
        attributes(); semi(); return;
      }
      if (is(t, '{')) {
        next();
        var locals = [];
        while (!is(peek(), '}')) {
          locals.push(next());
          if (isId(peek(), 'as')) { next(); next(); }
          if (!is(peek(), '}')) expect(',');
        }
        next();
        if (isId(peek(), 'from')) { next(); expectStr(); attributes(); }
        else locals.forEach(function (a) { if (a.type === 'id') ref(a, false); });
        semi();
        return;
      }
      parseStatement();   // export var / let / const / function / class
    }
    function parseStatement() {
      stmts.push(pos);
      var t = peek();
      if (is(t, '{')) { ends.push(parseBlock()); return; }
      if (is(t, ';')) { next(); return; }
      if (t.type === 'id') {
        var u = peek(1);
        switch (t.text) {
          case 'var': case 'const': next(); parseDeclarations(t.text, false); semi(); return;
          case 'let': if (letDecl(u)) { next(); parseDeclarations('let', false); semi(); return; } break;
          case 'function': ends.push(parseFunction(true)); return;
          case 'async': if (isId(u, 'function') && !u.nlBefore) { next(); ends.push(parseFunction(true)); return; } break;
          case 'class': ends.push(parseClass(true)); return;
          case 'if':
            next(); parenExpr().headEnd = true; parseSub();
            if (isId(peek(), 'else')) { next(); parseSub(); }
            return;
          case 'for': parseFor(); return;
          case 'while': next(); parenExpr().headEnd = true; parseSub(); return;
          case 'do':
            next(); parseSub();
            if (!isId(peek(), 'while')) fail('Expected "while" after do');
            next(); parenExpr();
            if (is(peek(), ';')) next();     // a semicolon is always optional after do-while
            return;
          case 'return':
            next();
            if (!(peek().type === 'eof' || is(peek(), ';') || is(peek(), '}') || peek().nlBefore)) parseExpression(false);
            semi(); return;
          case 'throw': next(); parseExpression(false); semi(); return;
          case 'break': case 'continue':
            next();
            if (peek().type === 'id' && !peek().nlBefore && !NOT_REF[peek().text]) next();   // label
            semi(); return;
          case 'try':
            next(); ends.push(parseBlock());
            if (isId(peek(), 'catch')) {
              next();
              var cs = enter('catch');
              if (is(peek(), '(')) { next(); parseBinding(cs, false); expect(')'); }
              // the body shares the parameter's scope: catch (e) { let e } is an error, so names must not collide
              expect('{');
              while (!is(peek(), '}')) { if (peek().type === 'eof') fail('Unterminated block'); parseStatement(); }
              ends.push(next());
              leave(cs);
            }
            if (isId(peek(), 'finally')) { next(); ends.push(parseBlock()); }
            return;
          case 'switch':
            next(); parenExpr();
            var ss = enter('block');
            expect('{');
            while (!is(peek(), '}')) {
              if (peek().type === 'eof') fail('Unterminated switch');
              if (isId(peek(), 'case')) { next(); parseExpression(false); expect(':'); }
              else if (isId(peek(), 'default') && is(peek(1), ':')) { next(); next(); }
              else parseStatement();
            }
            ends.push(next());
            leave(ss);
            return;
          case 'with': unsafe = unsafe || 'with'; next(); parenExpr().headEnd = true; parseSub(); return;
          case 'debugger': next(); semi(); return;
          case 'import': if (!is(u, '(') && !is(u, '.')) { parseImport(); return; } break;
          case 'export': parseExport(); return;
        }
        if (is(u, ':') && !NOT_REF[t.text]) { next(); next(); parseSub(); return; }   // label
      }
      parseExpression(false);
      semi();
    }

    // ---- run
    while (peek().type !== 'eof') parseStatement();
    ends.forEach(function (t) { if (t && t.type === 'punct' && t.text === '}') t.stmtEnd = true; });

    // Link references to declarations (after the whole program: var and function are hoisted).
    function inParams(pc, s) { for (; pc; pc = pc.up) if (pc.s === s) return true; return false; }
    refs.forEach(function (r) {
      var name = r.tok.text, s = r.scope, b = null;
      for (var x = s; x; x = x.parent) {
        var c = x.vars.get(name);
        // a default parameter value cannot see names declared in the body of its own function
        if (c && !(x.kind === 'function' && !c.isParam && r.pc && inParams(r.pc, x))) { b = c; break; }
      }
      if (b) {
        b.occ.push({ tok: r.tok, shorthand: r.shorthand });
        for (; s !== b.scope; s = s.parent) s.outside.add(b);
      } else {
        r.tok.free = true;
        for (; s; s = s.parent) s.free.add(name);
      }
    });
    // Annex B: a function declared in a block also writes a same-named variable of the enclosing function.
    blockFns.forEach(function (bf) {
      var stop = varScope(bf.scope);
      for (var x = bf.scope.parent; x; x = x.parent) {
        var c = x.vars.get(bf.name);
        if (c) c.keep = true;
        if (x === stop) break;
      }
    });

    var all = [];
    (function walk(s) { all.push(s); s.children.forEach(walk); })(rootScope);
    return { root: rootScope, scopes: all, stmts: stmts, unsafe: unsafe };
  }

  // Chooses short names, outer scopes first, and rewrites the identifier tokens.
  function rename(L, A) {
    var toks = L.toks;
    if (A.unsafe) return { renamed: 0, bindings: 0, skipped: A.unsafe };
    for (var q = 0; q < toks.length; q++) if (toks[q].type === 'id' && toks[q].text.indexOf('\\') >= 0) return { renamed: 0, bindings: 0, skipped: 'escape' };

    // An outer binding used inside a scope that keeps a name must not take that name.
    A.scopes.forEach(function (s) {
      var kept = s.list.filter(function (b) { return b.keep; });
      if (!kept.length) return;
      s.outside.forEach(function (v) { kept.forEach(function (k) { v.avoid.add(k.name); }); });
    });
    var renamed = 0, total = 0;
    A.scopes.forEach(function (s) {
      if (s.kind === 'root') return;
      var used = new Set();
      s.free.forEach(function (nm) { used.add(nm); });
      s.outside.forEach(function (v) { used.add(v.newName || v.name); });
      s.list.forEach(function (b) { if (b.keep) used.add(b.name); });
      var todo = s.list.filter(function (b) { return !b.keep; });
      todo.sort(function (a, b) { return b.occ.length - a.occ.length; });
      todo.forEach(function (b) {
        var cand;
        for (var g = 0; ; g++) {
          cand = nameAt(g);
          if (!RESERVED[cand] && !used.has(cand) && !b.avoid.has(cand)) break;
        }
        if (b.name.length <= cand.length && !used.has(b.name) && !b.avoid.has(b.name)) cand = b.name;
        b.newName = cand;
        used.add(cand);
        total++;
        if (cand !== b.name) renamed++;
      });
    });
    A.scopes.forEach(function (s) {
      s.list.forEach(function (b) {
        if (!b.newName || b.newName === b.name) return;
        b.occ.forEach(function (o) { o.tok.text = o.shorthand ? b.name + ':' + b.newName : b.newName; });
      });
    });
    return { renamed: renamed, bindings: total, skipped: null };
  }

  // ---------------------------------------------------------------- output

  function lastChar(t) { return t.text[t.text.length - 1]; }
  // Would the two tokens read differently when written next to each other?
  function needsSpace(a, b) {
    var ac = lastChar(a), bc = b.text[0];
    if (isIdPart(ac) && isIdPart(bc)) return true;                               // a b, 1 in, /x/g in
    if (a.type === 'num' && isIdPart(bc)) return true;                           // 1. in
    if (a.type === 'num' && bc === '.' && /^[\d_]+$/.test(a.text)) return true;  // 1 .toString()
    if ((ac === '+' && bc === '+') || (ac === '-' && bc === '-')) return true;    // a + +b, a - --b
    if (ac === '/' && (bc === '/' || bc === '*')) return true;                    // a / /re/
    if (ac === '<' && bc === '!') return true;                                    // <!--
    if (a.text === '--' && bc === '>') return true;                               // -->
    return false;
  }
  // Can the line break between the two tokens go without changing automatic semicolon insertion?
  function newlineRemovable(a, b) {
    if (a.type === 'id' && KEEP_NL_AFTER[a.text]) return false;
    if (a.type === 'punct' && (a.text === '++' || a.text === '--')) return false;
    if (b.type === 'punct' && (b.text === '++' || b.text === '--')) return false;
    if (a.stmtEnd || a.headEnd) return true;
    if (a.type === 'punct' && NO_END_AFTER[a.text]) return true;
    if (b.type === 'punct' && NO_START[b.text]) return true;
    if (b.type === 'tplMid' || (b.type === 'tpl' && b.tail)) return true;
    if (a.type === 'tplHead' || a.type === 'tplMid') return true;
    return false;
  }

  function emit(L) {
    var toks = L.toks;
    var out = L.hashbang ? L.hashbang + '\n' : '';
    var prev = null;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      var gapNl = false, gapComment = false;
      if (t.comments) {
        t.comments.forEach(function (c) {
          if (out.length && out[out.length - 1] !== '\n') {
            if (c.nlBefore) { out += '\n'; gapNl = true; } else out += ' ';
          }
          out += c.text;
          gapComment = true;
          if (NEWLINE_RE.test(c.text)) gapNl = true;
          if (c.line || c.nlAfter) { out += '\n'; gapNl = true; }
        });
      }
      if (t.type === 'eof') break;
      if (prev) {
        if (t.nlBefore && !gapNl && !newlineRemovable(prev, t)) out += '\n';
        else if (!gapComment && !(gapNl) && needsSpace(prev, t)) out += ' ';
      }
      out += t.text;
      prev = t;
    }
    return out.replace(/\n+$/, '');
  }

  function prepare(src, opts) {
    var L = lex(String(src), opts.keepLicense !== false);
    var A = analyze(L, opts);
    return { L: L, A: A };
  }

  /**
   * @param {string} src
   * @param {{ mangle?: boolean, keepLicense?: boolean, keepFnames?: boolean, keepClassnames?: boolean }} [options]
   * @returns {{ code: string, renamed: number, bindings: number, skipped: string|null }}
   */
  function minify(src, options) {
    var opts = options || {};
    var P = prepare(src, opts);
    var info = opts.mangle === false ? { renamed: 0, bindings: 0, skipped: null } : rename(P.L, P.A);
    return { code: emit(P.L), renamed: info.renamed, bindings: info.bindings, skipped: info.skipped };
  }

  function tokenize(src) {
    var P = prepare(src, { keepLicense: false });
    return P.L.toks.filter(function (t) { return t.type !== 'eof'; }).map(function (t) { return { type: t.type, text: t.text }; });
  }

  /*
   * Structural fingerprint: tokens, the token index where each statement starts, and for every identifier
   * occurrence the binding it resolves to (numbered by first appearance) or null for a global name.
   * Minifying must keep statements and occurrences identical (tokens too when names are not shortened).
   */
  function inspect(src) {
    var P = prepare(src, { keepLicense: false });
    var toks = P.L.toks;
    var index = new Map();
    toks.forEach(function (t, i) { index.set(t, i); });
    var occ = [];
    P.A.scopes.forEach(function (s) {
      s.list.forEach(function (b) { b.occ.forEach(function (o) { occ.push({ i: index.get(o.tok), b: b, name: o.tok.text }); }); });
    });
    toks.forEach(function (t, i) { if (t.free) occ.push({ i: i, b: null, name: t.text }); });
    occ.sort(function (x, y) { return x.i - y.i; });
    var ids = new Map();
    return {
      tokens: toks.filter(function (t) { return t.type !== 'eof'; }).map(function (t) { return { type: t.type, text: t.text }; }),
      statements: P.A.stmts.slice(),
      occurrences: occ.map(function (o) {
        if (!o.b) return { name: o.name, binding: null };
        if (!ids.has(o.b)) ids.set(o.b, ids.size);
        return { name: o.name, binding: ids.get(o.b), kept: o.b.keep };
      })
    };
  }

  return { minify: minify, tokenize: tokenize, inspect: inspect, nameAt: nameAt };
});
