# Changelog

## 0.2.1 — 2026-11-27

- `dist/*.min.js` banners now carry the copyright line:
  `/*! vanilla-kit 0.2.1 | browser/<name>.js | MIT License | (c) 2026 FEABE */`. No code changes.

## 0.2.0 — 2026-11-27

- `browser/minify.js`: JavaScript minifier (tokenizer + parser, conservative renaming), CLI `bin/minify.js`.
- `dist/*.min.js`: minified builds of the browser modules (`scripts/build-min.js`); the test suite runs against them too.
- `scripts/check-corpus.js`: corpus checker with token / statement / binding oracles.

## 0.1.0 — 2026-11-26

- qr, markdown, diff, color (browser); zip, smtp, docx, websocket (Node).
