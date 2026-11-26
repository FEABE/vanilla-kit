# vanilla-kit

Small JavaScript modules with **zero dependencies**, each **one hand-written file**.
No bundler, no npm packages, no minifier, no third-party code anywhere.

**Copy one file into your project and it works.** Every module has its own tests and its own section below.

[한국어 README](README.ko.md)

| Module | Env | Size (raw / gzip) | One-line usage |
| --- | --- | --- | --- |
| [`browser/qr.js`](#qrjs) | browser + Node | 19.5 KB / 6.6 KB | `VanillaQR.toSvg(VanillaQR.encode('https://example.com'))` |
| [`browser/markdown.js`](#markdownjs) | browser + Node | 24.0 KB / 7.8 KB | `el.innerHTML = VanillaMarkdown.toHtml(src)` (XSS-safe by default) |
| [`browser/diff.js`](#diffjs) | browser + Node | 6.6 KB / 2.7 KB | `VanillaDiff.diffLines(oldText, newText)` |
| [`browser/color.js`](#colorjs) | browser + Node | 8.3 KB / 3.3 KB | `VanillaColor.contrast(VanillaColor.parse('#777'), VanillaColor.parse('#fff'))` |
| [`node/zip.js`](#zipjs) | Node | 8.1 KB / 3.0 KB | `zip([{ name: 'a.txt', data: 'hi' }])` → `Buffer` |
| [`node/smtp.js`](#smtpjs) | Node | 13.9 KB / 5.2 KB | `await sendMail({ host, port, user, pass }, { from, to, subject, text })` |
| [`node/docx.js`](#docxjs) | Node | 11.8 KB / 4.2 KB | `docx({ title, body: [{ heading: 1, text: 'Hi' }, 'Paragraph'] })` → `Buffer` |
| [`node/websocket.js`](#websocketjs) | Node | 20.9 KB / 6.8 KB | `createServer({ server, path: '/ws' }).on('connection', c => c.on('message', ...))` |

Sizes are of the unminified source, comments included.

A demo page for the browser modules lives in [`examples/demo/`](examples/demo/). Run `node examples/serve.js` and
open `http://127.0.0.1:8080/examples/demo/` — the server sends
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'` and everything still works.

## Conventions

- **Browser modules** (`browser/`) are plain scripts with a tiny UMD wrapper: loaded with `<script src>` they define a
  global (`window.VanillaQR`, `window.VanillaMarkdown`, ...); in Node or a CommonJS bundler `require()` returns the same
  object. They use no DOM APIs, so they also run in workers and on the server. They work under a strict
  Content-Security-Policy (`script-src 'self'`): no `eval`, no inline styles, no network access.
- **Node modules** (`node/`) are CommonJS (`require`) and use only Node built-ins (`node:zlib`, `node:net`, `node:tls`,
  `node:crypto`). In an ES-module project, rename the copied file to `.cjs` and `import zip from './zip.cjs'`
  (Node exposes `module.exports` as the default export), or use `createRequire` from `node:module`.
- **Tests**: `node --test` (Node 18+; the WebSocket and some OS-level checks use newer Node or OS tools and skip
  themselves when those are missing). Nothing needs to be installed.
- **License**: MIT. Copying a single file is fine — the header comment says where it came from.

---

## qr.js

QR code encoder (ISO/IEC 18004 Model 2) that outputs a module matrix and an SVG.

- Numeric, alphanumeric and byte (UTF-8) modes — the smallest single mode that fits the text is chosen.
- Versions 1–40 chosen automatically, error-correction levels L / M / Q / H.
- Reed–Solomon over GF(256), block interleaving, all 8 masks scored with the standard penalty rules.

```html
<script src="qr.js"></script>
<script>
  const qr = VanillaQR.encode('https://example.com', { ecl: 'M' });
  document.querySelector('#out').innerHTML = VanillaQR.toSvg(qr, { border: 4, dark: '#111111' });
</script>
```

```js
const QR = require('./qr.js');
const qr = QR.encode('HELLO WORLD', { ecl: 'Q' });
qr.version; qr.size; qr.modules[y][x]; // true = dark
```

`encode(text, opts)` options: `ecl` (`'L'|'M'|'Q'|'H'`, default `'M'`), `minVersion` / `maxVersion` (1–40), `mask`
(0–7, default: best by penalty), `mode` (`'numeric'|'alphanumeric'|'byte'`; throws if the text does not fit it).
Throws an error with `code: 'TOO_LONG'` when the data does not fit. Returns
`{ version, size, ecl, mask, mode, modules, isFunction, dataCodewords, codewords, byteLength, penalty }`.

`toSvg(qr, opts)`: `border` (quiet zone in modules, default 4), `dark` / `light` (hex colours only — anything else
falls back to black/white, so the value cannot break out of the attribute), `pixelSize` (width/height attributes).

Not supported: Kanji mode, mixed-mode segments, ECI, Micro QR, structured append. Decoding is not included.

**Tests**: the standard "HELLO WORLD 1-M" codewords, format/version bit tables, capacity tables, and a small
independent decoder in the test that re-reads every version 1–40 at every EC level, checks Reed–Solomon syndromes
and recovers the original text.

## markdown.js

Markdown → HTML that is **safe to assign to `innerHTML` by default**.

```js
el.innerHTML = VanillaMarkdown.toHtml('# Hi\n\nSome *markdown* with a [link](https://example.com).');
VanillaMarkdown.toHtml(src, { targetBlank: false }); // no target="_blank" on links
```

Supported: ATX and setext headings, paragraphs, emphasis / strong / strikethrough, inline and fenced / indented code,
block quotes, nested ordered / unordered lists, task lists, links, images, horizontal rules, GFM tables with alignment,
autolinks (`<https://…>`, bare `https://…` and `www.…`), hard line breaks. It follows CommonMark closely but is not a
complete CommonMark implementation (no reference-style links, no HTML blocks — by design, see below).

Security model:

- **Raw HTML is never passed through.** Every character of source text is escaped (`& < > " '`). There is no option
  to allow HTML.
- Tag and attribute names come only from fixed strings in the module; every attribute value is escaped.
- **Link URLs** must be `http:`, `https:`, `mailto:` or relative. **Image URLs** must be `http:`, `https:` or relative.
  Everything else — `javascript:`, `vbscript:`, `file:`, and **all `data:` URLs including `data:image/…`** — is dropped
  and only the text / alt text is kept. Whitespace and control characters hidden inside a scheme
  (`java\tscript:`, `\x01javascript:`) are seen through.
- Links get `rel="noopener noreferrer"`.
- Nesting depth and bracket scanning are bounded, so hostile input cannot overflow the stack or run for long.
- Remote images are allowed. Rendered content can therefore make a viewer's browser fetch third-party URLs (tracking
  pixels). If that matters, add a CSP with a strict `img-src`, or post-filter `<img>`.

`safeUrl(url, 'link'|'img')` and `escapeHtml(s)` are exported too.

**Tests**: syntax known-answers, a list of classic XSS payloads, quote-breaking attempts in URLs/titles/alt text,
a seeded fuzz of 3000 random documents built from attack fragments (every output is checked to contain only
allowed tags/attributes and safe URL schemes), and pathological-input timing.

## diff.js

Line and word diff using Myers' O((N+M)·D) algorithm, with common prefix/suffix trimming.

```js
const ops = VanillaDiff.diffLines(oldText, newText, { ignoreWhitespace: false, ignoreCase: false });
// [{ type: 'equal'|'del'|'ins', text, other, a: oldLineNo|null, b: newLineNo|null }, ...]
VanillaDiff.hunks(ops, 3);   // [{ start, end }] ranges of ops with 3 lines of context, close ranges merged
VanillaDiff.stats(ops);      // { added, removed, same }
VanillaDiff.diffWords('price * 2;', 'price * 3;'); // [{ type, text }] tokens within one line
```

Line numbers are 1-based. CRLF / CR are normalised, a trailing newline does not count as an extra line.
If the edit distance exceeds 4000 the middle part is reported as one delete block plus one insert block — still a
correct diff, just not minimal — so huge unrelated inputs cannot freeze a page.

**Tests**: 300 random pairs are rebuilt from the result and the number of equal lines is compared with an
independent LCS computation (i.e. the script is minimal); 20,000-line input timing; the fallback path.

## color.js

Colour parsing / conversion and WCAG 2.x contrast.

```js
const C = VanillaColor;
const fg = C.parse('rgb(119 119 119)'), bg = C.parse('#fff');
C.contrast(fg, bg);                    // 4.478...
C.formatRatio(C.contrast(fg, bg));     // "4.47" (truncated, never rounded up across a threshold)
C.grade(4.48);                         // { normalAA: false, normalAAA: false, largeAA: true, largeAAA: false, ui: true }
C.toHex(C.suggest(fg, bg, 4.5, 'fg').color); // "#767676" — nearest passing colour, same hue/saturation
```

`parse` accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (the `#` is optional), `rgb()/rgba()` with commas or spaces and
`/ alpha`, percentages, `hsl()/hsla()` with `deg`/`turn`/`rad`/`grad`, and a short list of basic colour names
(not the full CSS list). Returns `{ r, g, b, a }` or `null`. Also: `toRgbString`, `toHslString`, `rgbToHsl`,
`hslToRgb`, `luminance`, `over` (alpha compositing). A translucent foreground is composited over the background before
measuring contrast; a translucent background is assumed to sit on white.

**Tests**: parsing of every syntax plus invalid inputs, 300 conversion round trips, known contrast ratios
(21:1, 4.48, 4.54, 7.0, ...), grade thresholds, suggestion behaviour.

## zip.js

ZIP archive writer (Node). Deflate via `node:zlib` when it helps, otherwise stored.

```js
const { zip } = require('./zip.js');
const buf = zip([
  { name: 'readme.txt', data: 'Hello' },
  { name: 'images/logo.png', data: pngBuffer, compress: false },
  { name: 'empty/' }                    // trailing "/" = directory entry
], { date: new Date(2026, 0, 1) });    // fixed date -> byte-identical output
require('node:fs').writeFileSync('out.zip', buf);
```

- Entry `data`: `Buffer`, `Uint8Array` or string (UTF-8). Options: `compress` (default `true`; deflate is used only
  when it makes the entry smaller), `level` (0–9), `date` (MS-DOS local time, 2-second resolution, clamped to
  1980–2107). Per-entry `date` / `compress` override.
- Names are always written as UTF-8 (general-purpose bit 11).
- **Entry names are validated; unsafe names throw** — empty, absolute (`/x`), drive letters (`C:x`), backslashes,
  `.` / `..` / empty segments, control characters, duplicates — so an archive made from untrusted names cannot
  carry a path-traversal ("zip slip") entry.
- Limits (no ZIP64): 65535 entries, 4 GiB − 1 per entry and per archive; beyond that a `RangeError` is thrown instead
  of writing a corrupt file. No encryption, no comments, no reading.
- `crc32(data)` is exported (IEEE CRC-32).

**Tests**: CRC-32 known answers (`"123456789"` → `0xCBF43926`) and agreement with `zlib.crc32`; an independent test
reader that cross-checks local and central headers, inflates and verifies CRC; name validation; limits; and, when
available on the machine, extraction with the OS's own tools (Windows `tar.exe`/bsdtar and PowerShell
`Expand-Archive`, or `unzip -t` elsewhere) with byte-for-byte comparison.

## smtp.js

SMTP client for plain-text mail (Node, `node:net` + `node:tls`).

```js
const { sendMail } = require('./smtp.js');
const result = await sendMail(
  { host: 'smtp.example.com', port: 465, user: 'me@example.com', pass: process.env.SMTP_PASS },
  { from: 'Me <me@example.com>', to: ['you@example.org'], cc: [], bcc: [], subject: 'Hello', text: 'Body' }
);
// { accepted: ['you@example.org'], response: '250 2.0.0 queued ...' }
```

There is **no default host and no default credentials** — everything comes from the caller.

TLS behaviour:

| Setting | What happens |
| --- | --- |
| `secure: true`, or port 465 with `secure` unset | TLS from the first byte (implicit TLS / SMTPS). |
| any other port (`secure` unset or `false`) | Plain connection, then **STARTTLS is required**. Capabilities are re-read after the upgrade. |
| server does not offer STARTTLS | **Refused** unless `allowPlain: true`. |
| `allowPlain: true` and `user` set | **Still refused** — credentials are never sent over an unencrypted connection unless `allowPlainAuth: true` too (meant for local test servers). |
| data arrives between `220` and the TLS handshake | Session aborted (STARTTLS command-injection defence). |

Certificates are verified by default (`rejectUnauthorized: true`, `minVersion: 'TLSv1.2'`); pass `ca` for a private CA.
Other options: `servername`, `timeoutMs` (per command, default 15000), `clientName` (EHLO name).

Message safety:

- Addresses (`from`, `to`, `cc`, `bcc`, `replyTo`) accept `addr@domain` or `Display Name <addr@domain>`; to/cc/bcc
  may be arrays or comma-separated strings (use an array if a display name contains a comma). **Anything
  malformed — CR, LF, NUL, spaces or angle brackets inside the address, non-ASCII addresses — throws before a
  connection is opened**, so neither header injection nor SMTP command injection (`a@b>\r\nRCPT TO:…`) is possible.
- CR/LF in the subject are replaced by spaces. Non-ASCII subjects and display names use RFC 2047 encoded words
  (folded to ≤ 75 characters).
- Bcc recipients receive the mail but never appear in the headers.
- The body is `text/plain; charset=utf-8`, base64. If any recipient is refused, the send fails before `DATA`.
- Errors carry `err.transcript` (the dialogue, with credentials masked) and, for server replies, `err.replyCode`.

AUTH: `PLAIN` if offered, else `LOGIN`; otherwise an error. Not supported: HTML / attachments (MIME multipart),
SMTPUTF8, pipelining, OAuth2, connection reuse.

**Tests** run against a fake SMTP server inside the test file (no real mail): AUTH PLAIN / LOGIN, masking in
transcripts, cc/bcc handling, refused recipients, injection attempts in addresses and subject, STARTTLS refusal,
the plain-AUTH guard, implicit TLS and STARTTLS with a throwaway self-signed certificate (created with `openssl`
if available, otherwise those tests are skipped), untrusted certificates, and the STARTTLS injection case.

## docx.js

Minimal Word document writer (Node). Headings, paragraphs and formatted runs — enough for generated reports.
The small ZIP writer it needs is included in the same file, so it stays a one-file copy.

```js
const { docx } = require('./docx.js');
const buf = docx({
  title: 'Weekly report',               // document property
  creator: 'Reporting job',             // document property (optional)
  body: [
    { heading: 1, text: 'Weekly report' },
    'A plain paragraph.\nA line break inside it.',
    { text: ['Mixed ', { text: 'bold', bold: true }, ' and ', { text: 'italic', italic: true }, ' runs.'] },
    { text: 'Centered', align: 'center' },
    { pageBreak: true },
    { heading: 2, text: 'Details' }
  ]
}, { date: new Date('2026-01-01T00:00:00Z') });
require('node:fs').writeFileSync('report.docx', buf);
```

- Block: a string, `{ text, heading?: 1|2|3, title?: true, align?: 'left'|'center'|'right'|'both' }` or `{ pageBreak: true }`.
  `text` is a string or an array of runs; a run is a string or `{ text, bold, italic, underline, strike, code }`.
- `\n` becomes a line break, `\t` a tab. Everything is XML-escaped, and characters XML 1.0 cannot contain (control
  characters, lone surrogates, U+FFFE/U+FFFF) are removed, so any input string produces a valid file.
- Headings use Word's built-in Title / Heading 1–3 styles (defined in `styles.xml`), so they show up in the
  navigation pane and table of contents.
- The package contains only `[Content_Types].xml`, `_rels/.rels`, `docProps/core.xml`, `word/document.xml`,
  `word/styles.xml` and `word/_rels/document.xml.rels`. **No external relationships, images or fields** — opening
  the file never makes Word fetch anything.
- Not supported: images, tables, lists, headers/footers, comments, reading .docx.

**Tests**: the package is unzipped by the independent test reader (CRC checked), every part is checked by a strict
well-formedness checker and — on Windows — by the .NET XML parser; content types and relationships must resolve
to existing parts; text with markup-breaking input survives intact; invalid characters are removed. The sample
document was also opened in Microsoft Word during development (2 pages, built-in heading styles applied).

## websocket.js

WebSocket server (RFC 6455) that attaches to Node's `http`/`https` server. Per-instance state — create as many as you like.

```js
const http = require('node:http');
const { createServer } = require('./websocket.js');
const server = http.createServer(app).listen(8080);
const wss = createServer({ server, path: '/ws', allowedOrigins: ['https://example.com'] });
wss.on('connection', (client, req) => {
  client.on('message', (data, isBinary) => client.send(isBinary ? data : 'echo: ' + data));
  client.on('close', (code, reason) => {});
});
wss.broadcast('hello everyone');
```

Options (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `server` | — | http(s) server to attach to. Without it, call `wss.handleUpgrade(req, socket, head)` yourself. |
| `path` | any | Only this pathname is accepted (query ignored). Other paths are left to other `upgrade` listeners, or get 404. |
| `allowedOrigins` | not checked | Exact `Origin` values. Set this for browser-facing servers (cross-site WebSocket hijacking); missing/unknown Origin → 403. |
| `verify(req)` | — | Return / resolve `false` to refuse with 403 (e.g. check a session cookie). |
| `selectProtocol(list, req)` | — | Choose one of the client's subprotocols. |
| `maxClients` | 0 (unlimited) | Further upgrades get 503. |
| `maxMessageBytes` | 1 MiB | Per frame (checked from the declared length before the body arrives) and per reassembled message → close 1009. |
| `maxBufferedBytes` | 1 MiB | Slow reader protection: when more would be queued, `send()` returns false and the client is closed with 1013. 0 = off. |
| `heartbeatMs` | 30000 | Ping interval; a client silent since the previous ping is disconnected. 0 = off. |
| `closeTimeoutMs` | 5000 | Socket is destroyed if the peer does not answer our close frame in time. |

Server: `connection` (client, req) and `error` (err, client) events — exceptions thrown by your listeners are
reported there (or printed with `console.error` if nobody listens) and do not take the connection or process down.
`.clients` (Set), `.broadcast(data, except?)`, `.handleUpgrade()`, `.close(code?, reason?)`.

Client: `message` (data, isBinary) — a string for text, a `Buffer` for binary — plus `ping`, `pong`, `close`
(code, reason). `.send(data)` (string → text frame; Buffer / Uint8Array / ArrayBuffer → binary), `.ping()`,
`.close(code = 1000, reason)`, `.terminate()`, `.id`, `.protocol`, `.remoteAddress`, `.readyState`, `.bufferedAmount`.

Protocol handling: handshake validation (GET, `Upgrade`/`Connection` headers, 16-byte base64 key, version 13 →
400 / 426), bytes sent together with the upgrade request are processed, client frames must be masked, RSV bits must
be 0, fragmentation with interleaved control frames, invalid control frames / opcodes / continuation → 1002, invalid
UTF-8 in text or close reasons → 1007, close codes validated and echoed. Not supported: permessage-deflate, and there
is no client — use the global `WebSocket` (Node 22+, browsers).

**Tests**: Node's built-in `WebSocket` client (text/binary round trip, clean close both ways, subprotocols,
broadcast; skipped on Node without it) and raw frames written by the test: handshake rules (including the RFC 6455
accept-key example), origin / verify / maxClients, early data in the upgrade request, fragmentation, 100 frames in
one TCP write, every 1002 / 1007 / 1009 case, declared 2^40-byte frames refused without waiting, ping/pong, close echo,
listener exceptions, backpressure and heartbeat.

---

## Running the tests

```sh
node --test
```

## License

[MIT](LICENSE) © 2026 FEABE
