'use strict';
/**
 * node/websocket.js — WebSocket server (RFC 6455).
 * Checked with Node's built-in WebSocket client (Node 22+; skipped when missing) and with raw frames written
 * by this test, so protocol errors can be produced on purpose.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const WS = require('../node/websocket.js');

const servers = [];
after(function () { for (const s of servers) { s.wss.close(); s.http.closeAllConnections && s.http.closeAllConnections(); s.http.close(); } });

// An http server with a WebSocket server on /ws that echoes messages and records what it received.
function start(options) {
    return new Promise(function (resolve) {
        const server = http.createServer(function (req, res) { res.end('plain http'); });
        const wss = WS.createServer(Object.assign({ server: server, path: '/ws', heartbeatMs: 0, maxMessageBytes: 4096 }, options || {}));
        const ctx = { http: server, wss: wss, received: [], errors: [], closes: [] };
        wss.on('error', function (err) { ctx.errors.push(err.message); });
        wss.on('connection', function (client) {
            client.on('message', function (data, isBinary) {
                ctx.received.push({ message: isBinary ? data.toString('hex') : data, binary: isBinary });
                if (data === 'throw') throw new Error('listener exploded');
                client.send(isBinary ? data : 'echo:' + data);
            });
            client.on('close', function (code, reason) { ctx.closes.push([code, reason]); });
        });
        servers.push(ctx);
        server.listen(0, '127.0.0.1', function () { ctx.port = server.address().port; resolve(ctx); });
    });
}

// -- raw frames -----------------------------------------------------------------------------------------
function frame(opcode, payload, options) {
    options = options || {};
    payload = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const first = (options.fin === false ? 0 : 0x80) | (options.rsv1 ? 0x40 : 0) | opcode;
    const masked = options.masked !== false;
    let header;
    if (options.declaredLength != null) {
        header = Buffer.alloc(10);
        header[0] = first;
        header[1] = (masked ? 0x80 : 0) | 127;
        header.writeBigUInt64BE(BigInt(options.declaredLength), 2);
    } else if (payload.length < 126) {
        header = Buffer.from([first, (masked ? 0x80 : 0) | payload.length]);
    } else {
        header = Buffer.alloc(4);
        header[0] = first;
        header[1] = (masked ? 0x80 : 0) | 126;
        header.writeUInt16BE(payload.length, 2);
    }
    if (!masked) return Buffer.concat([header, payload]);
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    return Buffer.concat([header, mask, body]);
}

// Handshake, then write `frames`; collect server frames until the socket closes (or waitMs passes).
// options.together: send the frames in the same write as the upgrade request.
// options.answerPings: reply to pings with pongs.
function rawSession(port, frames, options) {
    options = options || {};
    return new Promise(function (resolve) {
        const socket = net.connect(port, '127.0.0.1');
        let buffer = Buffer.alloc(0);
        let upgraded = false;
        const result = { status: 0, frames: [], closed: false, handshake: '' };
        function finish() { if (!result.done) { result.done = true; socket.destroy(); resolve(result); } }
        socket.on('connect', function () {
            const headers = Object.assign({
                Host: '127.0.0.1', Upgrade: 'websocket', Connection: 'Upgrade',
                'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
            }, options.headers || {});
            const lines = [(options.method || 'GET') + ' ' + (options.path || '/ws') + ' HTTP/1.1'];
            Object.keys(headers).forEach(function (name) { if (headers[name] != null) lines.push(name + ': ' + headers[name]); });
            const request = Buffer.from(lines.concat(['', '']).join('\r\n'));
            if (options.together) socket.write(Buffer.concat([request].concat(frames || [])));
            else socket.write(request);
        });
        socket.on('data', function (chunk) {
            buffer = Buffer.concat([buffer, chunk]);
            if (!upgraded) {
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) return;
                result.handshake = buffer.slice(0, end).toString('latin1');
                result.status = Number(/^HTTP\/1\.1 (\d{3})/.exec(result.handshake)[1]);
                buffer = buffer.slice(end + 4);
                if (result.status !== 101) return;
                upgraded = true;
                if (!options.together) for (const f of frames || []) socket.write(f);
            }
            while (buffer.length >= 2) {
                let length = buffer[1] & 0x7f;
                let offset = 2;
                if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
                else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
                if (buffer.length < offset + length) break;
                const payload = buffer.slice(offset, offset + length);
                const opcode = buffer[0] & 0x0f;
                result.frames.push({ opcode, masked: (buffer[1] & 0x80) !== 0, payload, text: payload.toString('utf8'), code: opcode === 8 && payload.length >= 2 ? payload.readUInt16BE(0) : 0 });
                if (opcode === 9 && options.answerPings) socket.write(frame(0xA, payload));
                buffer = buffer.slice(offset + length);
            }
        });
        socket.on('close', function () { result.closed = true; finish(); });
        socket.on('error', function () { finish(); });
        setTimeout(finish, options.waitMs || 600).unref();
    });
}

function closeCode(session) {
    const close = session.frames.find(function (f) { return f.opcode === 8; });
    return close ? close.code : 0;
}

// -- Node's built-in client ---------------------------------------------------------------------------------

test('built-in WebSocket client: text and binary round trip, clean close', async function (t) {
    if (typeof WebSocket !== 'function') return t.skip('this Node has no global WebSocket');
    const s = await start();
    const ws = new WebSocket('ws://127.0.0.1:' + s.port + '/ws');
    ws.binaryType = 'arraybuffer';
    const messages = [];
    const closed = new Promise(function (resolve) { ws.addEventListener('close', resolve); });
    await new Promise(function (resolve, reject) { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    ws.addEventListener('message', function (event) { messages.push(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('hex')); });

    ws.send('hello é✓');
    ws.send(new Uint8Array([1, 2, 3, 255]));
    ws.send('x'.repeat(3000));
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
    assert.deepEqual(messages, ['echo:hello é✓', '010203ff', 'echo:' + 'x'.repeat(3000)]);

    ws.close(1000, 'done');
    const event = await closed;
    assert.equal(event.code, 1000, 'the close frame is answered with a close frame');
    assert.equal(event.wasClean, true);
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
    assert.deepEqual(s.closes, [[1000, 'done']]);
    assert.equal(s.wss.clients.size, 0);
});

test('built-in client: server-initiated close, subprotocol selection, broadcast', async function (t) {
    if (typeof WebSocket !== 'function') return t.skip('this Node has no global WebSocket');
    const s = await start({ selectProtocol: function (list) { return list.includes('chat.v2') ? 'chat.v2' : null; } });
    const a = new WebSocket('ws://127.0.0.1:' + s.port + '/ws', ['chat.v1', 'chat.v2']);
    const b = new WebSocket('ws://127.0.0.1:' + s.port + '/ws');
    await Promise.all([a, b].map(function (ws) { return new Promise(function (r) { ws.addEventListener('open', r); }); }));
    assert.equal(a.protocol, 'chat.v2');
    assert.equal(b.protocol, '');
    const got = [];
    a.addEventListener('message', function (e) { got.push('a:' + e.data); });
    b.addEventListener('message', function (e) { got.push('b:' + e.data); });
    assert.equal(s.wss.broadcast('news'), 2);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.deepEqual(got.sort(), ['a:news', 'b:news']);
    const closed = Promise.all([a, b].map(function (ws) { return new Promise(function (r) { ws.addEventListener('close', r); }); }));
    s.wss.close(4000, 'bye');
    const events = await closed;
    assert.deepEqual(events.map(function (e) { return [e.code, e.reason, e.wasClean]; }), [[4000, 'bye', true], [4000, 'bye', true]]);
});

// -- handshake -------------------------------------------------------------------------------------------

test('handshake: accept key, version and key validation, method and headers', async function () {
    const s = await start();
    const key = crypto.randomBytes(16).toString('base64');
    const ok = await rawSession(s.port, [], { headers: { 'Sec-WebSocket-Key': key }, waitMs: 200 });
    assert.equal(ok.status, 101);
    const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    assert.ok(ok.handshake.includes('Sec-WebSocket-Accept: ' + expected));
    assert.equal(WS.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');   // RFC 6455 section 1.3 example

    const oldVersion = await rawSession(s.port, [], { headers: { 'Sec-WebSocket-Version': '8' } });
    assert.equal(oldVersion.status, 426);
    assert.match(oldVersion.handshake, /Sec-WebSocket-Version: 13/i);
    assert.equal((await rawSession(s.port, [], { headers: { 'Sec-WebSocket-Key': 'not-a-key' } })).status, 400);
    assert.equal((await rawSession(s.port, [], { method: 'POST' })).status, 400);
    assert.equal((await rawSession(s.port, [], { headers: { Upgrade: 'h2c' } })).status, 400);
    // without "Connection: Upgrade" Node treats it as a normal request; it must not become a WebSocket
    assert.notEqual((await rawSession(s.port, [], { headers: { Connection: 'keep-alive' } })).status, 101);
    // other paths are refused when nobody else handles upgrades; the query string is ignored
    assert.equal((await rawSession(s.port, [], { path: '/other' })).status, 404);
    assert.equal((await rawSession(s.port, [], { path: '/ws?token=x', waitMs: 200 })).status, 101);
});

test('handshake: allowedOrigins, verify (sync and async), maxClients', async function () {
    const s = await start({ allowedOrigins: ['https://app.example'] });
    assert.equal((await rawSession(s.port, [], { headers: { Origin: 'https://app.example' }, waitMs: 200 })).status, 101);
    assert.equal((await rawSession(s.port, [], { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await rawSession(s.port, [])).status, 403, 'missing Origin is refused when origins are configured');

    const v = await start({ verify: function (req) { return /session=ok/.test(req.headers.cookie || ''); } });
    assert.equal((await rawSession(v.port, [], { headers: { Cookie: 'session=ok' }, waitMs: 200 })).status, 101);
    assert.equal((await rawSession(v.port, [], { headers: { Cookie: 'session=bad' } })).status, 403);
    const va = await start({ verify: function (req) { return new Promise(function (r) { setTimeout(function () { r(req.headers.cookie === 'k=1'); }, 20); }); } });
    assert.equal((await rawSession(va.port, [], { headers: { Cookie: 'k=1' }, waitMs: 200 })).status, 101);
    assert.equal((await rawSession(va.port, [], { headers: { Cookie: 'k=2' } })).status, 403);
    const vt = await start({ verify: function () { throw new Error('boom'); } });
    assert.equal((await rawSession(vt.port, [])).status, 403);

    const m = await start({ maxClients: 1 });
    const first = rawSession(m.port, [], { waitMs: 400 });
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal((await rawSession(m.port, [])).status, 503);
    assert.equal((await first).status, 101);
});

test('bytes sent together with the upgrade request are not lost', async function () {
    const s = await start();
    const session = await rawSession(s.port, [frame(0x1, 'early')], { together: true, waitMs: 300 });
    assert.equal(session.status, 101);
    assert.deepEqual(session.frames.map(function (f) { return f.text; }), ['echo:early']);
});

// -- frames ----------------------------------------------------------------------------------------------

test('fragmented messages are reassembled; control frames may come in between', async function () {
    const s = await start();
    const session = await rawSession(s.port, [
        frame(0x1, 'Hel', { fin: false }),
        frame(0x9, 'ping-between'),
        frame(0x0, 'lo ', { fin: false }),
        frame(0x0, 'World')
    ], { waitMs: 300 });
    assert.deepEqual(s.received, [{ message: 'Hello World', binary: false }]);
    assert.deepEqual(session.frames.map(function (f) { return [f.opcode, f.text]; }), [[0xA, 'ping-between'], [0x1, 'echo:Hello World']]);

    // the reassembled size is limited too (limit 4096)
    const tooBig = await rawSession(s.port, [frame(0x1, 'a'.repeat(3000), { fin: false }), frame(0x0, 'b'.repeat(3000))]);
    assert.equal(closeCode(tooBig), 1009);
});

test('many small frames in one TCP write are all delivered (no false "too large")', async function () {
    const s = await start();
    const frames = [];
    for (let i = 0; i < 100; i++) frames.push(frame(0x1, String(i).padStart(3, '0') + 'x'.repeat(97)));
    const session = await rawSession(s.port, [Buffer.concat(frames)], { waitMs: 500 });
    assert.equal(closeCode(session), 0);
    assert.equal(s.received.length, 100);
    assert.equal(session.frames.length, 100);
    assert.equal(session.frames[99].text, 'echo:099' + 'x'.repeat(97));
});

test('protocol violations close with 1002 and are not delivered', async function () {
    const s = await start();
    const cases = {
        'unmasked frame': [frame(0x1, 'plain', { masked: false })],
        'reserved bit (RSV1)': [frame(0x1, 'compressed?', { rsv1: true })],
        'continuation without a start': [frame(0x0, 'orphan')],
        'new data frame while assembling': [frame(0x1, 'a', { fin: false }), frame(0x1, 'b')],
        'control frame over 125 bytes': [frame(0x9, 'p'.repeat(126))],
        'fragmented control frame': [frame(0x9, 'p', { fin: false })],
        'unknown data opcode': [frame(0x3, 'x')],
        'unknown control opcode': [frame(0xB, 'x')],
        'close frame with a 1-byte payload': [frame(0x8, Buffer.from([3]))],
        'close code 1005 on the wire': [frame(0x8, Buffer.from([0x03, 0xED]))],
        'close code 999': [frame(0x8, Buffer.from([0x03, 0xE7]))]
    };
    for (const name of Object.keys(cases)) {
        s.received.length = 0;
        const session = await rawSession(s.port, cases[name]);
        assert.equal(closeCode(session), 1002, name);
        assert.equal(session.closed, true, name + ': connection is closed');
        assert.deepEqual(s.received, [], name + ': nothing reaches the listener');
    }
});

test('invalid UTF-8 closes with 1007; an oversized declared length closes with 1009 without waiting', async function () {
    const s = await start();
    assert.equal(closeCode(await rawSession(s.port, [frame(0x1, Buffer.from([0xff, 0xfe, 0xfd]))])), 1007);
    assert.equal(closeCode(await rawSession(s.port, [frame(0x1, Buffer.from([0xe2, 0x82]), { fin: false }), frame(0x0, Buffer.from([0x41]))])), 1007, 'split code point');
    const badReason = Buffer.concat([Buffer.from([0x03, 0xE8]), Buffer.from([0xc3, 0x28])]);
    assert.equal(closeCode(await rawSession(s.port, [frame(0x8, badReason)])), 1007);

    const started = Date.now();
    const huge = await rawSession(s.port, [frame(0x2, Buffer.alloc(0), { declaredLength: 2 ** 40 })], { waitMs: 1500 });
    assert.equal(closeCode(huge), 1009);
    assert.ok(Date.now() - started < 1000, 'does not wait for the body');
    assert.equal(closeCode(await rawSession(s.port, [frame(0x2, Buffer.alloc(0), { declaredLength: 2 ** 63 })], { waitMs: 800 })), 1009);
});

test('ping gets a pong with the same payload; server frames are never masked; close is echoed', async function () {
    const s = await start();
    const session = await rawSession(s.port, [frame(0x9, 'are-you-there'), frame(0x1, 'hi'), frame(0x8, Buffer.concat([Buffer.from([0x0F, 0xA0]), Buffer.from('later')]))]);
    assert.deepEqual(session.frames.map(function (f) { return [f.opcode, f.text, f.masked]; }).slice(0, 2),
        [[0xA, 'are-you-there', false], [0x1, 'echo:hi', false]]);
    assert.equal(closeCode(session), 4000);
    assert.equal(session.closed, true);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.deepEqual(s.closes[s.closes.length - 1], [4000, 'later']);
});

test('a peer that sends close but keeps TCP open is dropped after closeTimeoutMs (no leaked client slot)', async function () {
    const s = await start({ closeTimeoutMs: 150, maxClients: 1 });
    const socket = net.connect({ port: s.port, host: '127.0.0.1', allowHalfOpen: true });   // ignores the server's FIN
    let serverClient = null;
    s.wss.once('connection', function (c) { serverClient = c; });
    socket.on('error', function () {});
    await new Promise(function (resolve) {
        socket.on('connect', function () {
            socket.write(['GET /ws HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
                'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
        });
        socket.once('data', function () { socket.write(frame(0x8, Buffer.from([0x03, 0xE8]))); resolve(); });
    });
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(s.wss.clients.size, 1, 'still closing');
    await new Promise(function (r) { setTimeout(r, 300); });
    assert.equal(s.wss.clients.size, 0, 'slot released');
    assert.equal(serverClient.readyState, 'closed');
    assert.equal(serverClient._socket.destroyed, true, 'server destroyed its socket');
    socket.destroy();
    assert.equal((await rawSession(s.port, [], { waitMs: 200 })).status, 101, 'a new client fits again');
});

test('an exception in a message listener is reported and the connection stays up', async function () {
    const s = await start();
    const session = await rawSession(s.port, [frame(0x1, 'throw'), frame(0x1, 'after')], { waitMs: 300 });
    assert.deepEqual(session.frames.map(function (f) { return f.text; }), ['echo:after']);
    assert.deepEqual(s.errors, ['listener exploded']);
});

test('backpressure: a send that would exceed maxBufferedBytes closes with 1013', async function () {
    const s = await start({ maxBufferedBytes: 1000 });
    let sendResult = null;
    s.wss.once('connection', function (client) { setTimeout(function () { sendResult = client.send('z'.repeat(5000)); }, 20); });
    const session = await rawSession(s.port, [], { waitMs: 400 });
    assert.equal(sendResult, false);
    assert.equal(closeCode(session), 1013);
});

test('heartbeat: a silent client is disconnected, a responsive one stays', async function () {
    const s = await start({ heartbeatMs: 80 });
    const silent = rawSession(s.port, [], { waitMs: 600 });
    const alive = rawSession(s.port, [], { waitMs: 600, answerPings: true });
    const [a, b] = await Promise.all([silent, alive]);
    assert.ok(a.frames.some(function (f) { return f.opcode === 9; }), 'pings are sent');
    assert.equal(closeCode(a), 1001);
    assert.equal(a.closed, true);
    assert.equal(closeCode(b), 0);
    assert.ok(b.frames.filter(function (f) { return f.opcode === 9; }).length >= 3);
});

test('frame codec: encode / decode round trip at the 125 / 126 / 65535 / 65536 boundaries', function () {
    for (const n of [0, 1, 125, 126, 65535, 65536, 70000]) {
        const payload = Buffer.alloc(n, 7);
        const enc = WS.encodeFrame(0x2, payload);
        const dec = WS.decodeFrame(enc, 0);
        assert.equal(dec.length, enc.length, String(n));
        assert.equal(dec.opcode, 2);
        assert.equal(dec.fin, true);
        assert.equal(dec.masked, false);
        assert.deepEqual(dec.payload, payload);
        assert.equal(WS.decodeFrame(enc.subarray(0, enc.length - 1), 0), null, 'incomplete frame -> null');
    }
    const masked = frame(0x1, 'masked text');
    assert.equal(WS.decodeFrame(masked, 0).payload.toString(), 'masked text');
    assert.deepEqual(WS.decodeFrame(WS.encodeFrame(0x2, Buffer.alloc(200)), 100), { error: 'message too large', code: 1009 });
});
