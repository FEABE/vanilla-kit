'use strict';
/**
 * websocket.js — WebSocket server (RFC 6455) for Node's http / https servers. Zero dependencies (node:crypto,
 * node:events), one file, CommonJS. Part of vanilla-kit. MIT License.
 *
 *   const http = require('node:http');
 *   const { createServer } = require('./websocket.js');
 *   const server = http.createServer(app).listen(8080);
 *   const wss = createServer({ server, path: '/ws', allowedOrigins: ['https://example.com'] });
 *   wss.on('connection', function (client, req) {
 *     client.on('message', function (data, isBinary) {   // string for text frames, Buffer for binary
 *       client.send(isBinary ? data : 'echo: ' + data);  // string -> text frame, Buffer/Uint8Array -> binary
 *     });
 *     client.on('close', function (code, reason) {});
 *   });
 *   wss.broadcast('hello everyone');
 *
 * createServer(options) -> WebSocketServer (an EventEmitter)
 *   server            http(s).Server to attach to (listens for 'upgrade'). Leave it out and call
 *                     wss.handleUpgrade(req, socket, head) yourself for custom routing.
 *   path              only upgrades for this pathname are accepted (query string ignored). Requests for other
 *                     paths are left to other 'upgrade' listeners, or answered with 404 if there are none.
 *   allowedOrigins    array of exact Origin values (e.g. 'https://example.com'). When set, requests whose Origin is
 *                     missing or not listed get 403. Browsers always send Origin, so set this for browser-facing
 *                     servers to stop cross-site WebSocket hijacking. Default: not checked.
 *   verify(req)       optional; return (or resolve to) false to answer 403 — e.g. to check a session cookie.
 *   selectProtocol(protocols, req)  optional; pick one of the client's Sec-WebSocket-Protocol values (or return
 *                     nothing for none).
 *   maxClients        0 = unlimited (default). Beyond it new upgrades get 503.
 *   maxMessageBytes   default 1 MiB. Applies to single frames (checked from the declared length, before the body
 *                     arrives) and to reassembled fragmented messages. Larger -> close 1009.
 *   maxBufferedBytes  default 1 MiB, 0 = unlimited. If a client reads too slowly and more than this is waiting in
 *                     its socket buffer, send() returns false and the connection is closed with 1013.
 *   heartbeatMs       default 30000, 0 = off. A ping is sent at this interval; a client that has not answered (or
 *                     sent anything) since the previous ping is disconnected.
 *   closeTimeoutMs    default 5000. After we send a close frame, the socket is destroyed if the peer does not
 *                     answer within this time.
 *
 * WebSocketServer: events 'connection' (client, req), 'error' (err, client) for exceptions thrown by your
 *   listeners (when there is no 'error' listener they are printed with console.error and the connection stays up).
 *   .clients (Set), .broadcast(data, except?), .handleUpgrade(req, socket, head), .close(code?, reason?)
 * Client: events 'message' (data, isBinary), 'ping' (buf), 'pong' (buf), 'close' (code, reason).
 *   .send(data) -> boolean, .ping(data?), .close(code = 1000, reason = ''), .terminate(),
 *   .id, .protocol, .remoteAddress, .readyState ('open' | 'closing' | 'closed'), .bufferedAmount
 *
 * Protocol handling: handshake validation (GET, Upgrade / Connection headers, 16-byte base64 key, version 13 —
 * otherwise 400 / 426), masking required from clients, reserved bits must be 0 (no extensions are negotiated),
 * unknown opcodes, fragmented or oversized (> 125 bytes) control frames and continuation errors close with 1002,
 * invalid UTF-8 in text messages or close reasons closes with 1007, close codes are validated and echoed.
 * Not supported: permessage-deflate, a client implementation (use the global WebSocket in Node 22+ or a browser).
 */
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA };
const STATUS_TEXT = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required', 503: 'Service Unavailable' };

function acceptKey(key) { return crypto.createHash('sha1').update(key + GUID).digest('base64'); }

// Close codes a peer may send (RFC 6455 7.4 and the IANA registry); 1004-1006 and 1015 must never be on the wire.
function validCloseCode(code) {
	return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

let utf8Decoder = null;
function decodeUtf8(buf) {
	if (!utf8Decoder) utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	try { return utf8Decoder.decode(buf); } catch (_) { return null; }
}

function toPayload(data) {
	if (Buffer.isBuffer(data)) return { buf: data, binary: true };
	if (data instanceof ArrayBuffer) return { buf: Buffer.from(data), binary: true };
	if (ArrayBuffer.isView(data)) return { buf: Buffer.from(data.buffer, data.byteOffset, data.byteLength), binary: true };
	return { buf: Buffer.from(String(data == null ? '' : data), 'utf8'), binary: false };
}

/** Server -> client frame (never masked), FIN set. */
function encodeFrame(opcode, payload) {
	const len = payload.length;
	let header;
	if (len < 126) {
		header = Buffer.from([0x80 | opcode, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode; header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode; header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

/**
 * Decodes one frame from the start of `buf`.
 * Returns null when more bytes are needed, { error, code } for a frame that must not be accepted,
 * or { fin, rsv, opcode, masked, payload, length } (payload already unmasked).
 * A declared length above maxPayload is rejected immediately, without waiting for the body.
 */
function decodeFrame(buf, maxPayload) {
	if (buf.length < 2) return null;
	const b0 = buf[0], b1 = buf[1];
	let len = b1 & 0x7f;
	let offset = 2;
	if (len === 126) {
		if (buf.length < 4) return null;
		len = buf.readUInt16BE(2);
		offset = 4;
	} else if (len === 127) {
		if (buf.length < 10) return null;
		const big = buf.readBigUInt64BE(2);
		if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { error: 'message too large', code: 1009 };
		len = Number(big);
		offset = 10;
	}
	if (maxPayload > 0 && len > maxPayload) return { error: 'message too large', code: 1009 };
	const masked = (b1 & 0x80) !== 0;
	if (masked) offset += 4;
	if (buf.length < offset + len) return null;
	const payload = Buffer.from(buf.subarray(offset, offset + len));   // copy: we unmask in place
	if (masked) {
		const mask = buf.subarray(offset - 4, offset);
		for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
	}
	return { fin: (b0 & 0x80) !== 0, rsv: (b0 & 0x70) !== 0, opcode: b0 & 0x0f, masked: masked, payload: payload, length: offset + len };
}

function rejectHandshake(socket, status, extraHeaders) {
	const text = STATUS_TEXT[status] || 'Error';
	try {
		socket.end(['HTTP/1.1 ' + status + ' ' + text].concat(extraHeaders || [], [
			'Connection: close',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Length: ' + Buffer.byteLength(text),
			'', text
		]).join('\r\n'));
	} catch (_) { /* ignore */ }
	setTimeout(function () { try { socket.destroy(); } catch (_) { /* ignore */ } }, 1000).unref();
}

function headerTokens(value) {
	return String(value || '').split(',').map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean);
}

class WebSocketClient extends EventEmitter {
	constructor(wss, socket, req, protocol) {
		super();
		this.id = crypto.randomBytes(8).toString('hex');
		this.protocol = protocol || '';
		this.remoteAddress = String(socket.remoteAddress || '');
		this.readyState = 'open';
		this._wss = wss;
		this._socket = socket;
		this._buffer = Buffer.alloc(0);
		this._fragments = null;     // { opcode, chunks, bytes } while a fragmented message is being assembled
		this._alive = true;
		this._closeTimer = null;
		this._closeCode = 1006;
		this._closeReason = '';
		this._closedEmitted = false;
	}

	get bufferedAmount() { return this._socket ? Number(this._socket.writableLength || 0) : 0; }

	_write(frame) {
		const s = this._socket;
		if (!s || s.destroyed || s.writable === false) return false;
		const limit = this._wss.options.maxBufferedBytes;
		if (limit > 0 && this.bufferedAmount + frame.length > limit) {
			this._fail(1013, 'backpressure');
			return false;
		}
		s.write(frame);
		return true;
	}

	send(data) {
		if (this.readyState !== 'open') return false;
		const p = toPayload(data);
		return this._write(encodeFrame(p.binary ? OP.BINARY : OP.TEXT, p.buf));
	}

	ping(data) {
		if (this.readyState !== 'open') return false;
		const p = toPayload(data == null ? Buffer.alloc(0) : data).buf;
		if (p.length > 125) throw new RangeError('websocket: ping payload must be at most 125 bytes');
		return this._write(encodeFrame(OP.PING, p));
	}

	close(code, reason) {
		if (this.readyState !== 'open') return;
		code = code == null ? 1000 : code;
		if (!(code === 1000 || (code >= 3000 && code <= 4999) || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014))) {
			throw new RangeError('websocket: invalid close code ' + code);
		}
		const r = Buffer.from(String(reason == null ? '' : reason), 'utf8');
		if (r.length > 123) throw new RangeError('websocket: close reason must be at most 123 bytes');
		this._sendClose(code, r);
	}

	terminate() {
		this.readyState = 'closed';
		try { this._socket.destroy(); } catch (_) { /* ignore */ }
	}

	_sendClose(code, reasonBuf) {
		this.readyState = 'closing';
		this._closeCode = code;
		this._closeReason = reasonBuf.toString('utf8');
		const payload = Buffer.alloc(2 + reasonBuf.length);
		payload.writeUInt16BE(code, 0);
		reasonBuf.copy(payload, 2);
		try { this._socket.write(encodeFrame(OP.CLOSE, payload)); } catch (_) { /* ignore */ }
		const self = this;
		this._closeTimer = setTimeout(function () { self.terminate(); }, this._wss.options.closeTimeoutMs);
		if (this._closeTimer.unref) this._closeTimer.unref();
	}

	// Protocol error or policy violation: send a close frame with the reason, stop reading, end the connection.
	_fail(code, reason) {
		if (this.readyState === 'closed') return;
		if (this.readyState === 'open') this._sendClose(code, Buffer.from(reason, 'utf8'));
		this.readyState = 'closing';
		this._buffer = Buffer.alloc(0);
		this._fragments = null;
		try { this._socket.end(); } catch (_) { /* ignore */ }
	}

	_emitSafe(event) {
		const args = Array.prototype.slice.call(arguments);
		try {
			this.emit.apply(this, args);
		} catch (err) {
			// one listener's exception must not take the connection (or the process) down
			if (this._wss.listenerCount('error') > 0) this._wss.emit('error', err, this);
			else console.error('websocket: listener for "' + event + '" threw:', err);
		}
	}

	_onData(chunk) {
		if (this.readyState === 'closed') return;
		this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
		const max = this._wss.options.maxMessageBytes;
		while (this._buffer.length > 0 && this.readyState !== 'closed') {
			const frame = decodeFrame(this._buffer, max);
			if (!frame) break;
			if (frame.error) { this._fail(frame.code, frame.error); return; }
			this._buffer = this._buffer.subarray(frame.length);
			this._alive = true;
			if (!this._handleFrame(frame)) return;
		}
		// whatever is left is one incomplete frame, bounded by the declared-length check above
		if (this._buffer.length > max + 14) this._fail(1009, 'message too large');
	}

	// Returns false when the connection was closed and no more frames should be read.
	_handleFrame(frame) {
		// RFC 6455 5.1: frames from a client must be masked. 5.2: no extension was negotiated, so RSV must be 0.
		if (!frame.masked) { this._fail(1002, 'client frames must be masked'); return false; }
		if (frame.rsv) { this._fail(1002, 'reserved bits set'); return false; }

		if (frame.opcode >= 0x8) {
			// control frames: never fragmented, at most 125 bytes, may arrive between the fragments of a message
			if (!frame.fin || frame.payload.length > 125) { this._fail(1002, 'invalid control frame'); return false; }
			if (frame.opcode === OP.CLOSE) return this._onClose(frame.payload);
			if (frame.opcode === OP.PING) {
				if (this.readyState === 'open') this._write(encodeFrame(OP.PONG, frame.payload));
				this._emitSafe('ping', frame.payload);
				return true;
			}
			if (frame.opcode === OP.PONG) { this._emitSafe('pong', frame.payload); return true; }
			this._fail(1002, 'unknown opcode');
			return false;
		}

		if (this.readyState !== 'open') return true;   // closing: data frames are ignored
		if (frame.opcode === OP.CONT) {
			if (!this._fragments) { this._fail(1002, 'unexpected continuation frame'); return false; }
			this._fragments.chunks.push(frame.payload);
			this._fragments.bytes += frame.payload.length;
		} else if (frame.opcode === OP.TEXT || frame.opcode === OP.BINARY) {
			if (this._fragments) { this._fail(1002, 'expected continuation frame'); return false; }
			this._fragments = { opcode: frame.opcode, chunks: [frame.payload], bytes: frame.payload.length };
		} else {
			this._fail(1002, 'unknown opcode');
			return false;
		}
		if (this._fragments.bytes > this._wss.options.maxMessageBytes) { this._fail(1009, 'message too large'); return false; }
		if (!frame.fin) return true;

		const f = this._fragments;
		this._fragments = null;
		const whole = f.chunks.length === 1 ? f.chunks[0] : Buffer.concat(f.chunks, f.bytes);
		if (f.opcode === OP.TEXT) {
			const text = decodeUtf8(whole);
			if (text === null) { this._fail(1007, 'invalid utf-8'); return false; }   // RFC 6455 5.6
			this._emitSafe('message', text, false);
		} else {
			this._emitSafe('message', whole, true);
		}
		return true;
	}

	_onClose(payload) {
		let code = 1005, reason = '';
		if (payload.length === 1) { this._fail(1002, 'invalid close frame'); return false; }
		if (payload.length >= 2) {
			code = payload.readUInt16BE(0);
			if (!validCloseCode(code)) { this._fail(1002, 'invalid close code'); return false; }
			reason = decodeUtf8(payload.subarray(2));
			if (reason === null) { this._fail(1007, 'invalid utf-8 in close reason'); return false; }
		}
		if (this.readyState === 'open') {
			// answer with the same status code; without an answer the peer reports an abnormal closure (1006)
			const echo = Buffer.alloc(code === 1005 ? 0 : 2);
			if (code !== 1005) echo.writeUInt16BE(code, 0);
			try { this._socket.write(encodeFrame(OP.CLOSE, echo)); } catch (_) { /* ignore */ }
			this._closeCode = code;
			this._closeReason = reason;
		}
		this.readyState = 'closing';
		try { this._socket.end(); } catch (_) { /* ignore */ }
		return false;
	}

	_onSocketClosed() {
		if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
		this.readyState = 'closed';
		this._wss.clients.delete(this);
		if (this._closedEmitted) return;
		this._closedEmitted = true;
		this._emitSafe('close', this._closeCode, this._closeReason);
	}
}

class WebSocketServer extends EventEmitter {
	constructor(options) {
		super();
		options = options || {};
		const num = function (v, d) { return v == null ? d : Math.max(0, Number(v) || 0); };
		this.options = {
			path: options.path == null ? null : String(options.path),
			allowedOrigins: Array.isArray(options.allowedOrigins) ? options.allowedOrigins.map(String) : null,
			verify: typeof options.verify === 'function' ? options.verify : null,
			selectProtocol: typeof options.selectProtocol === 'function' ? options.selectProtocol : null,
			maxClients: num(options.maxClients, 0),
			maxMessageBytes: num(options.maxMessageBytes, 1024 * 1024) || 1024 * 1024,
			maxBufferedBytes: num(options.maxBufferedBytes, 1024 * 1024),
			heartbeatMs: num(options.heartbeatMs, 30000),
			closeTimeoutMs: num(options.closeTimeoutMs, 5000) || 5000
		};
		this.clients = new Set();
		this._server = options.server || null;
		this._heartbeat = null;
		const self = this;
		if (this._server) {
			this._onUpgrade = function (req, socket, head) {
				if (self.options.path != null && pathnameOf(req.url) !== self.options.path) {
					// not ours: leave it to another 'upgrade' listener if there is one
					if (self._server.listenerCount('upgrade') <= 1) rejectHandshake(socket, 404);
					return;
				}
				self.handleUpgrade(req, socket, head);
			};
			this._server.on('upgrade', this._onUpgrade);
		}
		if (this.options.heartbeatMs > 0) {
			this._heartbeat = setInterval(function () { self._beat(); }, this.options.heartbeatMs);
			if (this._heartbeat.unref) this._heartbeat.unref();
		}
	}

	_beat() {
		for (const client of this.clients) {
			if (client.readyState !== 'open') continue;
			if (!client._alive) { client._fail(1001, 'heartbeat timeout'); client.terminate(); continue; }
			client._alive = false;
			client.ping();
		}
	}

	handleUpgrade(req, socket, head) {
		const self = this;
		const h = req.headers || {};
		socket.on('error', function () { /* handled through 'close' */ });
		if (req.method !== 'GET' || !headerTokens(h.upgrade).includes('websocket') || !headerTokens(h.connection).includes('upgrade')) {
			return rejectHandshake(socket, 400);
		}
		const key = String(h['sec-websocket-key'] || '');
		// RFC 6455 4.2.1: the key is 16 random bytes in base64, the version is 13
		if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return rejectHandshake(socket, 400);
		if (String(h['sec-websocket-version'] || '').trim() !== '13') return rejectHandshake(socket, 426, ['Sec-WebSocket-Version: 13']);
		if (this.options.allowedOrigins) {
			const origin = String(h.origin || '');
			if (!origin || this.options.allowedOrigins.indexOf(origin) < 0) return rejectHandshake(socket, 403);
		}
		if (this.options.maxClients > 0 && this.clients.size >= this.options.maxClients) return rejectHandshake(socket, 503);

		const finish = function (allowed) {
			if (!allowed) return rejectHandshake(socket, 403);
			if (socket.destroyed) return;
			let protocol = '';
			const offered = String(h['sec-websocket-protocol'] || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
			if (offered.length && self.options.selectProtocol) {
				const chosen = self.options.selectProtocol(offered, req);
				if (chosen != null && offered.indexOf(String(chosen)) >= 0) protocol = String(chosen);
			}
			self._accept(req, socket, head, key, protocol);
		};
		if (!this.options.verify) return finish(true);
		let result;
		try { result = this.options.verify(req); } catch (_) { return rejectHandshake(socket, 403); }
		if (result && typeof result.then === 'function') {
			result.then(function (ok) { finish(ok !== false); }, function () { rejectHandshake(socket, 403); });
		} else {
			finish(result !== false);
		}
	}

	_accept(req, socket, head, key, protocol) {
		const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + acceptKey(key)];
		if (protocol) lines.push('Sec-WebSocket-Protocol: ' + protocol);
		socket.write(lines.join('\r\n') + '\r\n\r\n');
		socket.setNoDelay(true);
		socket.setTimeout(0);
		const client = new WebSocketClient(this, socket, req, protocol);
		this.clients.add(client);
		socket.on('data', function (chunk) { client._onData(chunk); });
		socket.on('close', function () { client._onSocketClosed(); });
		socket.on('end', function () { try { socket.end(); } catch (_) { /* ignore */ } });
		this.emit('connection', client, req);
		// bytes that arrived together with the upgrade request belong to the WebSocket stream
		if (head && head.length) client._onData(Buffer.from(head));
	}

	broadcast(data, except) {
		const p = toPayload(data);
		const frame = encodeFrame(p.binary ? OP.BINARY : OP.TEXT, p.buf);
		let sent = 0;
		for (const client of this.clients) {
			if (client === except || client.readyState !== 'open') continue;
			if (client._write(frame)) sent++;
		}
		return sent;
	}

	close(code, reason) {
		if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
		if (this._server && this._onUpgrade) { this._server.removeListener('upgrade', this._onUpgrade); this._onUpgrade = null; }
		for (const client of this.clients) {
			if (client.readyState === 'open') client.close(code == null ? 1001 : code, reason == null ? 'server shutting down' : reason);
		}
	}
}

function pathnameOf(url) {
	const s = String(url || '/');
	const q = s.search(/[?#]/);
	return q < 0 ? s : s.slice(0, q);
}

function createServer(options) { return new WebSocketServer(options); }

module.exports = { createServer, WebSocketServer, acceptKey, decodeFrame, encodeFrame };
