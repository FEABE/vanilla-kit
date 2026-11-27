'use strict';
/**
 * browser/markdown.js — Markdown -> HTML.
 * Checks the basic syntax output, and that raw HTML and dangerous URLs never get through (XSS),
 * including a seeded random fuzz of attack fragments.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./helpers/subject.js')('browser/markdown.js');

const md = (s, o) => M.toHtml(s, o).trim();

// Checks that the HTML contains nothing but the tags and attributes this module produces.
const ALLOWED_TAGS = /^(h[1-6]|p|em|strong|del|code|pre|blockquote|ul|ol|li|input|a|img|hr|br|table|thead|tbody|tr|th|td)$/;
const ALLOWED_ATTRS = /^(href|src|alt|title|rel|target|class|start|align|type|disabled|checked|loading)$/;
function assertSafe(html) {
    // every '<' in the output must start one of our tags
    const stray = html.replace(/<\/?[A-Za-z0-9]+(?:\s+[a-z\-]+(?:="[^"<>]*")?)*\s*>/g, '');
    assert.equal(stray.indexOf('<'), -1, 'stray "<" in output: ' + html);
    const tagRe = /<\/?([A-Za-z0-9]+)([^>]*)>/g;
    let m;
    while ((m = tagRe.exec(html))) {
        assert.match(m[1], ALLOWED_TAGS, 'tag not allowed: ' + m[0]);
        // attributes: only name="value", and the value contains no " < >
        const rest = m[2].replace(/\s+([a-z\-]+)="([^"<>]*)"/g, function (all, name, value) {
            assert.match(name, ALLOWED_ATTRS, 'attribute not allowed: ' + m[0]);
            if (name === 'href' || name === 'src') {
                // decode entities and strip whitespace / control characters like a browser does, then look at the scheme
                const decoded = value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
                const probe = decoded.replace(/[\x00-\x20\x7f]/g, '').toLowerCase();
                assert.doesNotMatch(probe, /^(javascript|vbscript|data|file):/, 'dangerous URL: ' + m[0]);
                const scheme = /^([a-z][a-z0-9+.\-]*):/.exec(probe);
                if (scheme) assert.match(scheme[1], /^(https?|mailto)$/, 'unexpected scheme: ' + m[0]);
            }
            return '';
        }).replace(/\s+(disabled|checked)(?=\s|$)/g, '');
        assert.equal(rest.trim(), '', 'odd attribute shape: ' + m[0]);
    }
}

test('headings, paragraphs, horizontal rules', function () {
    assert.equal(md('# One\n## Two ##\n###### Six'), '<h1>One</h1>\n<h2>Two</h2>\n<h6>Six</h6>');
    assert.equal(md('Title\n===\n\nSub\n---'), '<h1>Title</h1>\n<h2>Sub</h2>');
    assert.equal(md('line one\nline two\n\nnew paragraph'), '<p>line one\nline two</p>\n<p>new paragraph</p>');
    assert.equal(md('a\n\n---\n\n* * *'), '<p>a</p>\n<hr>\n<hr>');
    assert.equal(md('#hashtag'), '<p>#hashtag</p>');
});

test('emphasis, strong, strikethrough, inline code, line breaks', function () {
    assert.equal(md('*a* _b_ **c** __d__ ~~e~~'), '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong> <del>e</del></p>');
    assert.equal(md('***both***'), '<p><em><strong>both</strong></em></p>');
    assert.equal(md('**bold *with italic* end**'), '<p><strong>bold <em>with italic</em> end</strong></p>');
    assert.equal(md('snake_case_name and 2*3*4'), '<p>snake_case_name and 2<em>3</em>4</p>');
    assert.equal(md('`a < b` and ``x ` y``'), '<p><code>a &lt; b</code> and <code>x ` y</code></p>');
    assert.equal(md('`**not bold**`'), '<p><code>**not bold**</code></p>');
    assert.equal(md('\\*stars\\* kept'), '<p>*stars* kept</p>');
    assert.equal(md('line  \nbreak\\\ntwo'), '<p>line<br>\nbreak<br>\ntwo</p>');
    assert.equal(md('unpaired *star'), '<p>unpaired *star</p>');
});

test('fenced and indented code', function () {
    assert.equal(md('```js\nconst a = 1 < 2;\n\n// <b>\n```'), '<pre><code class="language-js">const a = 1 &lt; 2;\n\n// &lt;b&gt;\n</code></pre>');
    assert.equal(md('~~~\n**as is**\n~~~'), '<pre><code>**as is**\n</code></pre>');
    assert.equal(md('    code\n      more'), '<pre><code>code\n  more\n</code></pre>');
    // trying to break out of the class attribute through the info string
    const h = md('```js" onmouseover="alert(1)\nx\n```');
    assertSafe(h);
    assert.match(h, /^<pre><code class="language-js">/);
});

test('block quotes', function () {
    assert.equal(md('> quote\n> second line\n>\n> new paragraph'), '<blockquote>\n<p>quote\nsecond line</p>\n<p>new paragraph</p>\n</blockquote>');
    assert.equal(md('> outer\n>> inner'), '<blockquote>\n<p>outer</p>\n<blockquote>\n<p>inner</p>\n</blockquote>\n</blockquote>');
    assert.equal(md('> lazy\ncontinuation'), '<blockquote>\n<p>lazy\ncontinuation</p>\n</blockquote>');
});

test('lists: unordered, ordered, nested, loose', function () {
    assert.equal(md('- a\n- b\n- c'), '<ul>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n</ul>');
    assert.equal(md('3. three\n4. four'), '<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>');
    assert.equal(md('- a\n  - b\n    - c\n- d'),
        '<ul>\n<li>a\n<ul>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n</ul></li>\n<li>d</li>\n</ul>');
    assert.equal(md('1. one\n   - inner\n2. two'), '<ol>\n<li>one\n<ul>\n<li>inner</li>\n</ul></li>\n<li>two</li>\n</ol>');
    assert.equal(md('- a\n\n- b'), '<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>');
    // a different bullet starts a new list
    assert.equal(md('- a\n+ b'), '<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>');
    // "2." in the middle of a paragraph is not a list
    assert.equal(md('In 2024\n2. this is a paragraph'), '<p>In 2024\n2. this is a paragraph</p>');
    // code block inside a list item
    assert.equal(md('- code:\n\n  ```\n  x\n  ```'), '<ul>\n<li>\n<p>code:</p>\n<pre><code>x\n</code></pre>\n</li>\n</ul>');
});

test('task lists', function () {
    assert.equal(md('- [ ] todo\n- [x] done'),
        '<ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" disabled> todo</li>\n<li class="task-list-item"><input type="checkbox" disabled checked> done</li>\n</ul>');
});

test('links, images, autolinks', function () {
    assert.equal(md('[home](https://example.com "Title")'), '<p><a href="https://example.com" title="Title" rel="noopener noreferrer" target="_blank">home</a></p>');
    assert.equal(md('[rel](/docs/a.md) [anchor](#top)'), '<p><a href="/docs/a.md" rel="noopener noreferrer" target="_blank">rel</a> <a href="#top" rel="noopener noreferrer">anchor</a></p>');
    assert.equal(md('[**bold** link](https://a.b/c_(d))'), '<p><a href="https://a.b/c_(d)" rel="noopener noreferrer" target="_blank"><strong>bold</strong> link</a></p>');
    assert.equal(md('![a *cat* photo](cat.png)'), '<p><img src="cat.png" alt="a cat photo" loading="lazy"></p>');
    assert.equal(md('<https://example.com/a?b=1&c=2>'), '<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">https://example.com/a?b=1&amp;c=2</a></p>');
    assert.equal(md('<me@example.com>'), '<p><a href="mailto:me@example.com" rel="noopener noreferrer" target="_blank">me@example.com</a></p>');
    assert.equal(md('see https://example.com/x. and (www.example.com)'),
        '<p>see <a href="https://example.com/x" rel="noopener noreferrer" target="_blank">https://example.com/x</a>. and (<a href="http://www.example.com" rel="noopener noreferrer" target="_blank">www.example.com</a>)</p>');
    assert.equal(md('[mail](mailto:a@b.c)'), '<p><a href="mailto:a@b.c" rel="noopener noreferrer" target="_blank">mail</a></p>');
    assert.equal(md('[not a link] (x)'), '<p>[not a link] (x)</p>');
});

test('option targetBlank: false leaves target off', function () {
    assert.equal(md('[x](https://a.b)', { targetBlank: false }), '<p><a href="https://a.b" rel="noopener noreferrer">x</a></p>');
    // the option does not leak into the next call
    assert.match(md('[x](https://a.b)'), /target="_blank"/);
});

test('tables: alignment, escaped |, padding of short rows', function () {
    assert.equal(md('| Name | Value | Note |\n| :--- | ---: | :-: |\n| a | 1 | `x\\|y` |\n| b |'),
        '<table>\n<thead>\n<tr><th align="left">Name</th><th align="right">Value</th><th align="center">Note</th></tr>\n</thead>\n<tbody>\n' +
        '<tr><td align="left">a</td><td align="right">1</td><td align="center"><code>x\\|y</code></td></tr>\n' +
        '<tr><td align="left">b</td><td align="right"></td><td align="center"></td></tr>\n</tbody>\n</table>');
    assert.equal(md('a | b\n--|--\n1 | 2 \\| 3'), '<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td><td>2 | 3</td></tr>\n</tbody>\n</table>');
    // different cell counts: not a table
    assert.equal(md('a | b\n--|--|--'), '<p>a | b\n--|--|--</p>');
});

test('XSS: raw HTML always becomes text', function () {
    const cases = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '<a href="javascript:alert(1)">x</a>',
        '<svg/onload=alert(1)>',
        '<iframe src="https://evil.example"></iframe>',
        '- <b onclick="x()">list</b>\n> <style>body{}</style>',
        '| <script> | b |\n|---|---|\n| <img src=x onerror=1> | c |',
        '# <script>alert(1)</script>',
        '`</code><script>alert(1)</script>`',
        '<!-- comment --> &lt;already escaped&gt;'
    ];
    for (const c of cases) assertSafe(M.toHtml(c));
    assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    assert.equal(md('&amp; "double" \'single\''), '<p>&amp;amp; &quot;double&quot; &#39;single&#39;</p>');
});

test('XSS: dangerous link URLs are dropped, the text is kept', function () {
    const bad = [
        '[x](javascript:alert(1))',
        '[x](JaVaScRiPt:alert(1))',
        '[x](  javascript:alert(1))',
        '[x](<java script:alert(1)>)',
        '[x](java\tscript:alert(1))',
        '[x](javascript\\:alert(1))',
        '[x](vbscript:msgbox(1))',
        '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
        '[x](file:///etc/passwd)',
        '<javascript:alert(1)>',
        '<data:text/html,<script>alert(1)</script>>',
        '[x](' + String.fromCharCode(1) + 'javascript:alert(1))',
        '[x](javascript' + String.fromCharCode(0x0b) + ':alert(1))'
    ];
    for (const c of bad) {
        const h = M.toHtml(c);
        assertSafe(h);
        assert.doesNotMatch(h, /<a /, 'no link may be produced: ' + c);
    }
    assert.equal(md('[x](javascript:alert(1))'), '<p>x</p>');
    // An entity-encoded colon is not decoded, so this stays a relative URL; the & is escaped so it never becomes ':'.
    const ent = md('[x](javascript&#58;alert(1))');
    assert.match(ent, /href="javascript&amp;#58;alert\(1\)"/);
});

test('XSS: dangerous image URLs (data:, javascript:, mailto:) keep only the alt text', function () {
    assert.equal(md('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)'), '<p>x</p>');
    assert.equal(md('![x](data:image/png;base64,iVBORw0KGgo=)'), '<p>x</p>');
    assert.equal(md('![x](javascript:alert(1))'), '<p>x</p>');
    assert.equal(md('![x](mailto:a@b.c)'), '<p>x</p>');
    assert.equal(md('![<b>](data:x)'), '<p>&lt;b&gt;</p>');
    assertSafe(M.toHtml('![x" onerror="alert(1)](https://a.b/i.png)'));
});

test('XSS: quotes trying to break out of URL and title attributes', function () {
    const h1 = md('[x](https://a.b/"onmouseover="alert(1))');
    assertSafe(h1);
    assert.equal(h1, '<p><a href="https://a.b/&quot;onmouseover=&quot;alert(1)" rel="noopener noreferrer" target="_blank">x</a></p>');
    const h2 = md('[x](https://a.b "t\\" onmouseover=\\"alert(1)")');
    assertSafe(h2);
    assert.match(h2, /title="t&quot; onmouseover=&quot;alert\(1\)"/);
    assertSafe(md("[x](https://a.b 'it&#39;s \"q\"')"));
    const h4 = md('![a"b\'c<d>](https://a.b/i.png "x\'y\\"z")');
    assertSafe(h4);
    assert.equal(h4, '<p><img src="https://a.b/i.png" alt="a&quot;b&#39;c&lt;d&gt;" title="x&#39;y&quot;z" loading="lazy"></p>');
    assertSafe(md('<https://a.b/"onmouseover="x>'));
    assertSafe(md('https://a.b/"><script>alert(1)</script>'));
});

test('XSS fuzz: 3000 random documents built from attack fragments are always safe', function () {
    const FRAGMENTS = [
        '<script>', '</script>', '<img src=x onerror=alert(1)>', '"', "'", '<', '>', '&', '&#58;', '&lt;',
        'javascript:', 'JAVASCRIPT:', 'java\tscript:', 'vbscript:', 'data:text/html,', 'data:image/png,', 'file:',
        '[', ']', '(', ')', '![', '](', '<', 'https://a.b/', 'www.x.y', 'mailto:', '\\', '`', '``', '```', '~~~',
        '*', '**', '_', '__', '~~', '#', '> ', '- ', '1. ', '| ', ' |', '---', '\n', '\n\n', '    ', '\t',
        ' onmouseover=', '=', ' "t"', 'x', 'alert(1)', '\u0000', '\u000b', ' ', '﻿'
    ];
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * n); };
    for (let round = 0; round < 3000; round++) {
        let doc = '';
        const len = 1 + rnd(40);
        for (let i = 0; i < len; i++) doc += FRAGMENTS[rnd(FRAGMENTS.length)];
        const h = M.toHtml(doc);
        try { assertSafe(h); } catch (e) { e.message += '\ninput: ' + JSON.stringify(doc); throw e; }
    }
});

test('deep nesting and long input do not hang', function () {
    const deep = '>'.repeat(5000) + ' x';
    assertSafe(M.toHtml(deep));
    const lists = Array.from({ length: 300 }, (_, i) => ' '.repeat(i * 2) + '- ' + i).join('\n');
    assertSafe(M.toHtml(lists));
    const t0 = Date.now();
    M.toHtml('*a '.repeat(20000) + '[x'.repeat(5000) + '_b '.repeat(20000));
    M.toHtml('![['.repeat(3000));
    assert.ok(Date.now() - t0 < 3000, 'too slow');
});

test('safeUrl directly', function () {
    assert.equal(M.safeUrl('https://a.b/c d', 'link'), 'https://a.b/c%20d');
    assert.equal(M.safeUrl('./x:y', 'link'), './x:y');
    assert.equal(M.safeUrl('x:y', 'link'), null);
    assert.equal(M.safeUrl('?q=javascript:1', 'link'), '?q=javascript:1');
    assert.equal(M.safeUrl('mailto:a@b.c', 'img'), null);
    assert.equal(M.safeUrl('HTTPS://A.B', 'img'), 'HTTPS://A.B');
    assert.equal(M.escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});
