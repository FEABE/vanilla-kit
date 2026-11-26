'use strict';
/**
 * Tiny static file server for the examples (zero dependencies). Serves the repository root on 127.0.0.1 only,
 * with a strict Content-Security-Policy so the demo proves the browser modules need nothing more.
 *
 *   node examples/serve.js [port]      then open http://127.0.0.1:8080/examples/demo/
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 8080;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

http.createServer(function (req, res) {
	let pathname;
	try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { res.writeHead(400); res.end(); return; }
	if (pathname.endsWith('/')) pathname += 'index.html';
	const file = path.resolve(ROOT, '.' + pathname);
	const type = TYPES[path.extname(file)];
	// only files inside the repository, only known types, no dot-files (.git etc.)
	if (!type || (file !== ROOT && !file.startsWith(ROOT + path.sep)) || /[\\/]\./.test(path.relative(ROOT, file))) {
		res.writeHead(404); res.end('not found'); return;
	}
	fs.readFile(file, function (err, data) {
		if (err) { res.writeHead(404); res.end('not found'); return; }
		res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
		res.end(data);
	});
}).listen(PORT, '127.0.0.1', function () {
	console.log('http://127.0.0.1:' + PORT + '/examples/demo/');
});
