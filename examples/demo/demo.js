/* Demo wiring for the browser modules. Everything here runs under script-src 'self' / style-src 'self'. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  // -- QR --------------------------------------------------------------------------------------------------
  function renderQr() {
    var text = $('qr-text').value;
    try {
      var qr = VanillaQR.encode(text, { ecl: $('qr-ecl').value });
      // toSvg only ever emits fixed markup plus validated hex colours, so innerHTML is safe here
      $('qr-out').innerHTML = VanillaQR.toSvg(qr, { border: 4 }).replace(/^<\?xml[^>]*>\s*/, '');
      $('qr-info').textContent = 'version ' + qr.version + ' (' + qr.size + 'x' + qr.size + '), ' + qr.mode + ' mode, mask ' + qr.mask + ', ' + qr.byteLength + ' characters/bytes';
    } catch (e) {
      $('qr-out').textContent = '';
      $('qr-info').textContent = e.message;
    }
  }
  $('qr-text').addEventListener('input', renderQr);
  $('qr-ecl').addEventListener('change', renderQr);

  // -- Markdown --------------------------------------------------------------------------------------------
  $('md-src').value = [
    '# Hello *markdown*',
    '',
    'A [safe link](https://example.com), a [bad link](javascript:alert(1)) and raw <b onclick="alert(1)">HTML</b>.',
    '',
    '- [x] task lists',
    '- `inline code` and ~~strikethrough~~',
    '',
    '| left | right |',
    '| :--- | ----: |',
    '| a | 1 |',
    '',
    '> quoted',
    '',
    '```js',
    'const html = VanillaMarkdown.toHtml(src);',
    '```'
  ].join('\n');
  function renderMd() { $('md-out').innerHTML = VanillaMarkdown.toHtml($('md-src').value); }
  $('md-src').addEventListener('input', renderMd);

  // -- Diff ------------------------------------------------------------------------------------------------
  $('diff-a').value = 'one\ntwo\nthree\nfour\n';
  $('diff-b').value = 'one\n2\nthree\nfour\nfive\n';
  function renderDiff() {
    var out = $('diff-out');
    out.textContent = '';
    var ops = VanillaDiff.diffLines($('diff-a').value, $('diff-b').value);
    ops.forEach(function (o) {
      var line = document.createElement('span');
      line.className = o.type === 'ins' ? 'ins' : o.type === 'del' ? 'del' : 'eq';
      line.textContent = (o.type === 'ins' ? '+ ' : o.type === 'del' ? '- ' : '  ') + o.text;
      out.appendChild(line);
    });
    var s = VanillaDiff.stats(ops);
    var summary = document.createElement('span');
    summary.className = 'eq';
    summary.textContent = '\n' + s.added + ' added, ' + s.removed + ' removed, ' + s.same + ' unchanged';
    out.appendChild(summary);
  }
  $('diff-a').addEventListener('input', renderDiff);
  $('diff-b').addEventListener('input', renderDiff);

  // -- Colour ----------------------------------------------------------------------------------------------
  function renderColor() {
    var out = $('color-out');
    out.textContent = '';
    var fg = VanillaColor.parse($('color-fg').value), bg = VanillaColor.parse($('color-bg').value);
    if (!fg || !bg) { out.textContent = 'Could not read one of the colours.'; return; }
    var ratio = VanillaColor.contrast(fg, bg);
    var g = VanillaColor.grade(ratio);
    var swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.textContent = 'Sample text';
    swatch.style.color = VanillaColor.toRgbString(fg);          // CSSOM, allowed under style-src 'self'
    swatch.style.backgroundColor = VanillaColor.toRgbString(bg);
    out.appendChild(swatch);
    out.appendChild(document.createTextNode(' ' + VanillaColor.formatRatio(ratio) + ':1  normal text AA ' + (g.normalAA ? 'pass' : 'fail') + ', AAA ' + (g.normalAAA ? 'pass' : 'fail')));
    if (!g.normalAA) {
      var s = VanillaColor.suggest(fg, bg, 4.5, 'fg');
      if (s) out.appendChild(document.createTextNode('  -> nearest passing text colour ' + VanillaColor.toHex(s.color)));
    }
  }
  $('color-fg').addEventListener('input', renderColor);
  $('color-bg').addEventListener('input', renderColor);

  renderQr();
  renderMd();
  renderDiff();
  renderColor();
})();
