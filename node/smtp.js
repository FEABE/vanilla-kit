'use strict';
/**
 * smtp.js — small SMTP client for sending plain-text mail. Zero dependencies (node:net, node:tls, node:crypto),
 * one file, CommonJS. Part of vanilla-kit. MIT License.
 *
 *   const { sendMail } = require('./smtp.js');
 *   await sendMail(
 *     { host: 'smtp.example.com', port: 465, user: 'me@example.com', pass: process.env.SMTP_PASS },
 *     { from: 'Me <me@example.com>', to: ['you@example.org'], subject: 'Hi', text: 'Hello' }
 *   ); // -> { accepted: ['you@example.org'], response: '250 ...' }
 *
 * Connection options (nothing has a default host or credentials — you must pass them):
 *   host                 required.
 *   port                 default 465.
 *   secure               true  = TLS from the first byte (implicit TLS, "SMTPS", usually port 465).
 *                        false = connect in plaintext and upgrade with STARTTLS (usually port 587 or 25).
 *                        unset = implicit TLS when port is 465, STARTTLS otherwise.
 *   user, pass           optional. AUTH PLAIN when the server offers it, else AUTH LOGIN.
 *   rejectUnauthorized   default true (verify the server certificate). ca, servername, minVersion are passed
 *                        to tls.connect (minVersion defaults to 'TLSv1.2').
 *   allowPlain           default false. Without it the client refuses to continue when a non-implicit-TLS server
 *                        does not offer STARTTLS, so mail is never sent in cleartext by accident.
 *   allowPlainAuth       default false. Even with allowPlain, credentials are never sent over an unencrypted
 *                        connection unless this is also true (meant for local test servers only).
 *   timeoutMs            per-command timeout, default 15000.
 *   clientName           name sent with EHLO, default 'localhost' (letters, digits, '.', '-' or an [IPv4] literal).
 *
 * Message: { from, to, cc?, bcc?, replyTo?, subject?, text? }
 *   from / to / cc / bcc / replyTo take 'addr@example.com' or 'Display Name <addr@example.com>' (to, cc, bcc may be
 *   arrays or comma-separated strings). Bcc recipients get the mail but are not written into the headers.
 *   Addresses must be plain ASCII (no SMTPUTF8); anything else — including CR, LF, NUL, '<', '>' or spaces inside
 *   the address — throws before a connection is made, so header and SMTP command injection is not possible.
 *   CR / LF in the subject are replaced by spaces. Non-ASCII subjects and display names use RFC 2047 encoded words.
 *   The body is sent as text/plain; charset=utf-8 in base64. If any recipient is refused the whole send fails
 *   before DATA, so nobody gets a partial delivery.
 *
 * Errors carry `err.transcript` (the SMTP dialogue with credentials masked) for debugging.
 */
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const MAX_RESPONSE_BYTES = 64 * 1024;

const ADDR_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function fail(message) { const e = new Error('smtp: ' + message); e.code = 'SMTP_INVALID'; return e; }

/** 'Name <a@b>' or 'a@b' -> { name, address }. Throws on anything unsafe. */
function parseAddress(value) {
	const s = String(value == null ? '' : value);
	if (/[\r\n\0]/.test(s)) throw fail('line break or NUL in address: ' + JSON.stringify(s));
	const trimmed = s.trim();
	let name = '';
	let address = trimmed;
	const m = /^(.*?)\s*<([^<>]*)>$/.exec(trimmed);
	if (m) {
		name = m[1].trim();
		address = m[2].trim();
		if (name.length >= 2 && name.charAt(0) === '"' && name.charAt(name.length - 1) === '"') {
			name = name.slice(1, -1).replace(/\\(.)/g, '$1');
		}
	}
	if (!ADDR_RE.test(address) || address.length > 254) throw fail('invalid address: ' + JSON.stringify(s));
	return { name: name, address: address };
}

function addressList(v) {
	if (v == null || v === '') return [];
	const items = Array.isArray(v) ? v : String(v).split(',');
	return items.map(function (x) { return String(x).trim(); }).filter(Boolean).map(parseAddress);
}

// RFC 2047 encoded words (base64), each at most 75 characters, never splitting a UTF-8 sequence.
function encodedWords(s) {
	const words = [];
	let chunk = '';
	for (const ch of s) {
		if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
		chunk += ch;
	}
	if (chunk) words.push(chunk);
	return words.map(function (w) { return '=?UTF-8?B?' + Buffer.from(w, 'utf8').toString('base64') + '?='; }).join('\r\n ');
}

function headerText(s) {
	s = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\0/g, '').trim();
	return /^[\x20-\x7e]*$/.test(s) && s.length <= 900 ? s : encodedWords(s);
}

function formatAddress(a) {
	if (!a.name) return a.address;
	let name;
	if (/^[\x20-\x7e]*$/.test(a.name)) {
		name = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~ -]*$/.test(a.name) ? a.name : '"' + a.name.replace(/(["\\])/g, '\\$1') + '"';
	} else {
		name = encodedWords(a.name);
	}
	return name + ' <' + a.address + '>';
}

function wrap76(b64) { return b64.replace(/(.{76})/g, '$1\r\n'); }

// A leading '.' on a line becomes '..' (RFC 5321 4.5.2).
function dotStuff(text) { return String(text).replace(/(^|\r\n)\./g, '$1..'); }

/** Validates the message and returns { from, to, cc, bcc, replyTo } as parsed address objects. */
function normalizeMessage(msg) {
	msg = msg || {};
	const from = parseAddress(msg.from);
	const out = { from: from, to: addressList(msg.to), cc: addressList(msg.cc), bcc: addressList(msg.bcc), replyTo: addressList(msg.replyTo) };
	if (!out.to.length && !out.cc.length && !out.bcc.length) throw fail('at least one recipient (to, cc or bcc) is required');
	return out;
}

/** RFC 5322 message with CRLF line ends (before dot-stuffing). Bcc is not written. */
function buildMessage(msg, now) {
	const m = normalizeMessage(msg);
	const headers = ['From: ' + formatAddress(m.from)];
	if (m.to.length) headers.push('To: ' + m.to.map(formatAddress).join(',\r\n '));
	if (m.cc.length) headers.push('Cc: ' + m.cc.map(formatAddress).join(',\r\n '));
	if (m.replyTo.length) headers.push('Reply-To: ' + m.replyTo.map(formatAddress).join(',\r\n '));
	headers.push(
		'Subject: ' + headerText(msg.subject),
		'Date: ' + new Date(now == null ? Date.now() : now).toUTCString().replace('GMT', '+0000'),
		'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@' + m.from.address.split('@')[1] + '>',
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: base64'
	);
	const body = wrap76(Buffer.from(String(msg.text == null ? '' : msg.text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'));
	return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

/**
 * Response reader: "250-..." continues, "250 ..." is the last line of a reply.
 */
function createReader() {
	let buf = '';
	let lines = [];
	let bytes = 0;
	const waiting = [];
	const ready = [];
	let failedWith = null;
	function pump() {
		while (waiting.length && (ready.length || failedWith)) {
			const w = waiting.shift();
			if (ready.length) w.resolve(ready.shift()); else w.reject(failedWith);
		}
	}
	return {
		feed: function (chunk) {
			buf += chunk.toString('utf8');
			bytes += chunk.length;
			if (bytes > MAX_RESPONSE_BYTES) { failedWith = failedWith || new Error('smtp: server reply too large'); pump(); return; }
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i).replace(/\r$/, '');
				buf = buf.slice(i + 1);
				lines.push(line);
				if (/^\d{3}(?: |$)/.test(line)) {
					ready.push({ code: Number(line.slice(0, 3)), lines: lines.map(function (l) { return l.slice(4); }), text: lines.join('\n') });
					lines = [];
					bytes = buf.length;
				} else if (!/^\d{3}-/.test(line)) {
					lines = [];   // malformed line: dropped
				}
			}
			pump();
		},
		fail: function (e) { failedWith = failedWith || e; pump(); },
		next: function () { return new Promise(function (resolve, reject) { waiting.push({ resolve: resolve, reject: reject }); pump(); }); },
		pending: function () { return buf.length > 0 || ready.length > 0; }
	};
}

function sendMail(config, msg) {
	return new Promise(function (resolve, reject) {
		config = config || {};
		let m;
		try {
			if (!config.host || typeof config.host !== 'string') throw fail('host is required');
			m = normalizeMessage(msg);
			if (config.user != null && /\0/.test(String(config.user) + String(config.pass == null ? '' : config.pass))) throw fail('NUL in credentials');
		} catch (e) { reject(e); return; }

		const port = config.port == null ? 465 : Number(config.port);
		if (!(port > 0 && port < 65536 && port % 1 === 0)) { reject(fail('invalid port')); return; }
		const implicitTls = config.secure === true || (config.secure !== false && port === 465);
		const timeoutMs = Number(config.timeoutMs) || 15000;
		const clientName = config.clientName == null ? 'localhost' : String(config.clientName);
		if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[\d{1,3}(?:\.\d{1,3}){3}\])$/.test(clientName)) {
			reject(fail('invalid clientName')); return;
		}
		const tlsOpts = {
			host: config.host,
			servername: config.servername || (net.isIP(config.host) ? undefined : config.host),
			rejectUnauthorized: config.rejectUnauthorized !== false,
			minVersion: config.minVersion || 'TLSv1.2'
		};
		if (config.ca) tlsOpts.ca = config.ca;
		const recipients = m.to.concat(m.cc, m.bcc).map(function (a) { return a.address; });

		let socket;
		let reader = createReader();
		let encrypted = implicitTls;
		let done = false;
		const transcript = [];
		function finish(err, value) {
			if (done) return;
			done = true;
			try { if (socket) socket.destroy(); } catch (_) { /* ignore */ }
			if (err) { err.transcript = transcript; reject(err); } else resolve(value);
		}
		function attach(s) {
			socket = s;
			s.setTimeout(timeoutMs, function () { const e = new Error('smtp: timeout'); reader.fail(e); finish(e); });
			s.on('data', function (c) { reader.feed(c); });
			s.on('error', function (e) { reader.fail(e); finish(e); });
			s.on('close', function () { reader.fail(new Error('smtp: connection closed')); });
		}
		function send(line, secret) {
			transcript.push('> ' + (secret ? '***' : line));
			socket.write(line + '\r\n');
		}
		async function expect(codes, what) {
			const r = await reader.next();
			transcript.push('< ' + r.text);
			if (codes.indexOf(r.code) < 0) {
				const e = new Error('smtp: ' + what + ' failed: ' + r.text.slice(0, 200));
				e.code = 'SMTP_REPLY';
				e.replyCode = r.code;
				throw e;
			}
			return r;
		}
		async function ehlo() {
			send('EHLO ' + clientName);
			const r = await expect([250], 'EHLO');
			return r.lines.map(function (l) { return l.toUpperCase(); });
		}
		async function run() {
			await expect([220], 'greeting');
			let caps = await ehlo();
			if (!implicitTls) {
				if (caps.indexOf('STARTTLS') >= 0) {
					send('STARTTLS');
					await expect([220], 'STARTTLS');
					// Anything already buffered was sent before the TLS handshake and could be injected by a
					// man in the middle (the classic STARTTLS command-injection problem): refuse.
					if (reader.pending()) throw new Error('smtp: data received after STARTTLS before TLS (possible injection)');
					const plain = socket;
					plain.removeAllListeners('data');
					plain.removeAllListeners('timeout');
					plain.setTimeout(0);
					reader = createReader();
					await new Promise(function (ok, bad) {
						const t = tls.connect(Object.assign({ socket: plain }, tlsOpts), ok);
						t.once('error', bad);
						attach(t);
					});
					encrypted = true;
					caps = await ehlo();   // capabilities must be re-read after the upgrade
				} else if (!config.allowPlain) {
					throw new Error('smtp: server does not offer STARTTLS (refusing plaintext; set allowPlain to override)');
				}
			}
			if (config.user != null && config.user !== '') {
				if (!encrypted && !config.allowPlainAuth) {
					throw new Error('smtp: refusing to send credentials over an unencrypted connection (set allowPlainAuth to override)');
				}
				const auth = caps.filter(function (c) { return c.indexOf('AUTH ') === 0 || c.indexOf('AUTH=') === 0; }).join(' ');
				if (/\bPLAIN\b/.test(auth)) {
					send('AUTH PLAIN ' + Buffer.from('\0' + config.user + '\0' + (config.pass == null ? '' : config.pass), 'utf8').toString('base64'), true);
					await expect([235], 'AUTH PLAIN');
				} else if (/\bLOGIN\b/.test(auth)) {
					send('AUTH LOGIN');
					await expect([334], 'AUTH LOGIN');
					send(Buffer.from(String(config.user), 'utf8').toString('base64'), true);
					await expect([334], 'AUTH LOGIN user');
					send(Buffer.from(String(config.pass == null ? '' : config.pass), 'utf8').toString('base64'), true);
					await expect([235], 'AUTH LOGIN pass');
				} else {
					throw new Error('smtp: server offers no supported AUTH mechanism (PLAIN or LOGIN)');
				}
			}
			send('MAIL FROM:<' + m.from.address + '>');
			await expect([250], 'MAIL FROM');
			const accepted = [];
			for (const rcpt of recipients) {
				send('RCPT TO:<' + rcpt + '>');
				await expect([250, 251], 'RCPT TO <' + rcpt + '>');
				accepted.push(rcpt);
			}
			send('DATA');
			await expect([354], 'DATA');
			const data = dotStuff(buildMessage(msg));
			transcript.push('> [message ' + data.length + ' bytes]');
			socket.write(data + '.\r\n');
			const r = await expect([250], 'message');
			send('QUIT');
			try { await expect([221], 'QUIT'); } catch (_) { /* already accepted */ }
			return { accepted: accepted, response: r.text };
		}

		try {
			if (implicitTls) attach(tls.connect(Object.assign({ port: port }, tlsOpts)));
			else attach(net.connect({ host: config.host, port: port }));
		} catch (e) { finish(e); return; }
		run().then(function (v) { finish(null, v); }, function (e) { finish(e); });
	});
}

module.exports = { sendMail, buildMessage, parseAddress, dotStuff };
