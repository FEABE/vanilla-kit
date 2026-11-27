'use strict';
/**
 * node/smtp.js — SMTP client against a fake SMTP server written in this test (no real mail is sent).
 * The TLS tests (implicit TLS and STARTTLS) need a self-signed certificate; they create one with the `openssl`
 * command line tool and are skipped when it is not installed.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Smtp = require('./helpers/subject.js')('node/smtp.js');

// -- Fake SMTP server ---------------------------------------------------------------------------------
function fakeSmtp(opt) {
    opt = opt || {};
    const got = { lines: [], messages: [], auth: [], connections: 0 };
    function session(sock) {
        got.connections++;
        let buf = '';
        let inData = false;
        let data = '';
        let authStep = null;
        let authUser = '';
        const write = function (s) { sock.write(s + '\r\n'); };
        write('220 fake.smtp ESMTP ready');
        function onLine(line) {
            got.lines.push(line);
            if (inData) {
                if (line === '.') { inData = false; got.messages.push(data); data = ''; write('250 2.0.0 queued as FAKE1'); return; }
                data += line + '\r\n';
                return;
            }
            if (authStep === 'user') { authUser = Buffer.from(line, 'base64').toString(); authStep = 'pass'; write('334 UGFzc3dvcmQ6'); return; }
            if (authStep === 'pass') { got.auth.push({ mech: 'LOGIN', user: authUser, pass: Buffer.from(line, 'base64').toString() }); authStep = null; write('235 2.7.0 ok'); return; }
            const cmd = line.split(' ')[0].toUpperCase();
            if (cmd === 'EHLO') {
                const caps = ['250-fake.smtp'];
                if (opt.starttls && !(sock instanceof tls.TLSSocket)) caps.push('250-STARTTLS');
                caps.push(opt.authMechs === '' ? '250 SIZE 1000000' : '250 AUTH ' + (opt.authMechs || 'PLAIN LOGIN'));
                sock.write(caps.join('\r\n') + '\r\n');
            } else if (cmd === 'STARTTLS') {
                // opt.inject: a man in the middle appends a plaintext reply right after "220 go ahead"
                sock.write('220 2.0.0 go ahead\r\n' + (opt.inject ? '250 injected\r\n' : ''));
                if (opt.inject) return;
                sock.removeAllListeners('data');
                const secure = new tls.TLSSocket(sock, { isServer: true, key: opt.key, cert: opt.cert });
                secure.on('error', function () {});
                attach(secure);
                sock = secure;
            } else if (cmd === 'AUTH') {
                const parts = line.split(' ');
                if (parts[1].toUpperCase() === 'PLAIN') {
                    const dec = Buffer.from(parts[2] || '', 'base64').toString().split('\0');
                    got.auth.push({ mech: 'PLAIN', user: dec[1], pass: dec[2] });
                    write(dec[2] === 'wrong' ? '535 5.7.8 bad credentials' : '235 2.7.0 ok');
                } else { authStep = 'user'; write('334 VXNlcm5hbWU6'); }
            } else if (cmd === 'MAIL') write('250 ok');
            else if (cmd === 'RCPT') write(opt.rejectRcpt && line.indexOf(opt.rejectRcpt) >= 0 ? '550 5.1.1 no such user' : '250 ok');
            else if (cmd === 'DATA') { inData = true; write('354 end with .'); }
            else if (cmd === 'QUIT') { write('221 bye'); sock.end(); }
            else write('502 unknown');
        }
        function attach(s) {
            s.on('data', function (c) {
                buf += c.toString('utf8');
                let i;
                while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); }
            });
            s.on('error', function () {});
        }
        attach(sock);
    }
    const server = opt.implicit ? tls.createServer({ key: opt.key, cert: opt.cert }, session) : net.createServer(session);
    servers.push(server);
    return new Promise(function (resolve) {
        server.listen(0, '127.0.0.1', function () { resolve({ server: server, port: server.address().port, got: got }); });
    });
}

const servers = [];
after(function () { servers.forEach(function (s) { s.close(); }); });

function decodeBody(raw) {
    const parts = raw.split('\r\n\r\n');
    return { headers: parts[0], text: Buffer.from(parts.slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

const PLAIN_LOCAL = { host: '127.0.0.1', allowPlain: true, allowPlainAuth: true };

test('plaintext test server: AUTH PLAIN, several recipients, UTF-8 subject, base64 body, dot-stuffing', async function () {
    const s = await fakeSmtp({});
    const r = await Smtp.sendMail(Object.assign({ port: s.port, user: 'me@example.com', pass: 'app-pass' }, PLAIN_LOCAL),
        { from: 'Sender Name <me@example.com>', to: 'a@example.com, b@example.com', subject: 'Café ✓ report', text: 'first line\n.line starting with a dot\nend' });
    assert.deepEqual(r.accepted, ['a@example.com', 'b@example.com']);
    assert.deepEqual(s.got.auth, [{ mech: 'PLAIN', user: 'me@example.com', pass: 'app-pass' }]);
    assert.ok(s.got.lines.indexOf('MAIL FROM:<me@example.com>') >= 0);
    assert.ok(s.got.lines.indexOf('RCPT TO:<b@example.com>') >= 0);
    const msg = decodeBody(s.got.messages[0]);
    assert.match(msg.headers, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(msg.headers, /^From: Sender Name <me@example\.com>$/m);
    assert.match(msg.headers, /^Message-ID: <[0-9a-f]+@example\.com>/m);
    assert.equal(msg.text, 'first line\r\n.line starting with a dot\r\nend');
    const subject = /^Subject: (.*(?:\r\n .*)*)/m.exec(msg.headers)[1].split('\r\n ').map(function (w) {
        return Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)[1], 'base64').toString('utf8');
    }).join('');
    assert.equal(subject, 'Café ✓ report');
});

test('AUTH LOGIN when only LOGIN is offered; failed authentication is an error', async function () {
    const s = await fakeSmtp({ authMechs: 'LOGIN' });
    await Smtp.sendMail(Object.assign({ port: s.port, user: 'u', pass: 'p' }, PLAIN_LOCAL), { from: 'me@example.com', to: 'a@example.com', subject: 's', text: 'hi' });
    assert.deepEqual(s.got.auth, [{ mech: 'LOGIN', user: 'u', pass: 'p' }]);
    const s2 = await fakeSmtp({});
    await assert.rejects(Smtp.sendMail(Object.assign({ port: s2.port, user: 'u', pass: 'wrong' }, PLAIN_LOCAL),
        { from: 'me@example.com', to: 'a@example.com', subject: 's', text: 't' }), function (e) {
        assert.match(e.message, /AUTH PLAIN failed/);
        assert.equal(e.replyCode, 535);
        assert.ok(e.transcript.some(function (l) { return l === '> ***'; }), 'credentials are masked in the transcript');
        assert.ok(!e.transcript.join('\n').includes(Buffer.from('\0u\0wrong').toString('base64')));
        return true;
    });
    const s3 = await fakeSmtp({ authMechs: '' });
    await assert.rejects(Smtp.sendMail(Object.assign({ port: s3.port, user: 'u', pass: 'p' }, PLAIN_LOCAL),
        { from: 'me@example.com', to: 'a@example.com' }), /no supported AUTH mechanism/);
});

test('cc and bcc: everyone gets RCPT TO, bcc never appears in the headers', async function () {
    const s = await fakeSmtp({});
    const r = await Smtp.sendMail(Object.assign({ port: s.port }, PLAIN_LOCAL),
        { from: 'me@example.com', to: ['a@example.com'], cc: 'c@example.com', bcc: ['hidden@example.com'], replyTo: 'r@example.com', subject: 's', text: 't' });
    assert.deepEqual(r.accepted, ['a@example.com', 'c@example.com', 'hidden@example.com']);
    assert.ok(s.got.lines.indexOf('RCPT TO:<hidden@example.com>') >= 0);
    const headers = decodeBody(s.got.messages[0]).headers;
    assert.match(headers, /^Cc: c@example\.com$/m);
    assert.match(headers, /^Reply-To: r@example\.com$/m);
    assert.doesNotMatch(headers, /hidden@/);
    assert.doesNotMatch(headers, /^Bcc:/mi);
});

test('a refused recipient fails the send before DATA', async function () {
    const s = await fakeSmtp({ rejectRcpt: 'nobody@' });
    await assert.rejects(Smtp.sendMail(Object.assign({ port: s.port }, PLAIN_LOCAL),
        { from: 'me@example.com', to: ['a@example.com', 'nobody@example.com'], subject: 's', text: 't' }), /RCPT TO <nobody@example\.com> failed/);
    assert.equal(s.got.messages.length, 0);
    assert.equal(s.got.lines.indexOf('DATA'), -1);
});

test('header injection: CR/LF in the subject is flattened, in addresses it is refused before connecting', async function () {
    const s = await fakeSmtp({});
    await Smtp.sendMail(Object.assign({ port: s.port }, PLAIN_LOCAL), { from: 'me@example.com', to: 'a@example.com', subject: 'x\r\nBcc: evil@example.com', text: 'hi' });
    assert.doesNotMatch(s.got.messages[0], /^Bcc:/m);
    assert.match(s.got.messages[0], /^Subject: x Bcc: evil@example\.com$/m);

    const bad = [
        'a@example.com\r\nRCPT TO:<evil@example.com>',
        'a@example.com>\r\nDATA',
        'a@example.com> SIZE=1',
        'Name <a@example.com>\nBcc: evil@example.com',
        'a@exa mple.com',
        'a@example.com\0',
        '<a@example.com',
        'no-at-sign',
        'a@b@c.com',
        'üser@example.com'
    ];
    const before = s.got.connections;
    for (const addr of bad) {
        await assert.rejects(Smtp.sendMail(Object.assign({ port: s.port }, PLAIN_LOCAL), { from: 'me@example.com', to: addr, subject: 's', text: 't' }), /smtp: /, JSON.stringify(addr));
        await assert.rejects(Smtp.sendMail(Object.assign({ port: s.port }, PLAIN_LOCAL), { from: addr, to: 'a@example.com', subject: 's', text: 't' }), /smtp: /, JSON.stringify(addr));
    }
    assert.equal(s.got.connections, before, 'no connection is opened for an invalid message');
    assert.equal(Smtp.dotStuff('a\r\n.b\r\n..c'), 'a\r\n..b\r\n...c');
});

test('display names: quoted when needed, encoded when non-ASCII, never able to add headers', function () {
    const raw = Smtp.buildMessage({ from: '"Doe, Jane" <jane@example.com>', to: ['Jürgen <j@example.com>', 'Plain Name <p@example.com>'], subject: 'x' }, 0);
    assert.match(raw, /^From: "Doe, Jane" <jane@example\.com>$/m);
    assert.match(raw, /^To: =\?UTF-8\?B\?[A-Za-z0-9+\/=]+\?= <j@example\.com>,\r\n Plain Name <p@example\.com>$/m);
    assert.match(raw, /^Date: Thu, 01 Jan 1970 00:00:00 \+0000$/m);
    const parsed = Smtp.parseAddress('  Name <a@example.com>  ');
    assert.deepEqual(parsed, { name: 'Name', address: 'a@example.com' });
    // a long subject is folded into encoded words of at most 75 characters each
    const long = Smtp.buildMessage({ from: 'a@example.com', to: 'b@example.com', subject: 'é'.repeat(200) });
    const subjectBlock = /^Subject: (.*(?:\r\n .*)*)/m.exec(long)[1];
    for (const w of subjectBlock.split('\r\n ')) assert.ok(w.length <= 75, w);
});

test('missing or invalid configuration is rejected without connecting', async function () {
    await assert.rejects(Smtp.sendMail({}, { from: 'a@example.com', to: 'b@example.com' }), /host is required/);
    await assert.rejects(Smtp.sendMail({ host: '127.0.0.1' }, { to: 'b@example.com' }), /invalid address/);
    await assert.rejects(Smtp.sendMail({ host: '127.0.0.1' }, { from: 'a@example.com' }), /recipient/);
    await assert.rejects(Smtp.sendMail({ host: '127.0.0.1', port: 70000 }, { from: 'a@example.com', to: 'b@example.com' }), /invalid port/);
    await assert.rejects(Smtp.sendMail({ host: '127.0.0.1', port: 25, clientName: 'x\r\nMAIL FROM:<e@x.y>' }, { from: 'a@example.com', to: 'b@example.com' }), /invalid clientName/);
});

test('no STARTTLS offered: plaintext is refused by default and nothing is sent', async function () {
    const s = await fakeSmtp({});
    await assert.rejects(Smtp.sendMail({ host: '127.0.0.1', port: s.port }, { from: 'me@example.com', to: 'a@example.com', subject: 's', text: 't' }), /does not offer STARTTLS/);
    assert.equal(s.got.messages.length, 0);
    assert.equal(s.got.lines.filter(function (l) { return /^MAIL/.test(l); }).length, 0);
});

test('allowPlain alone never sends credentials in cleartext', async function () {
    const s = await fakeSmtp({});
    await assert.rejects(Smtp.sendMail({ host: '127.0.0.1', port: s.port, allowPlain: true, user: 'u', pass: 'secret' },
        { from: 'me@example.com', to: 'a@example.com', subject: 's', text: 't' }), /refusing to send credentials over an unencrypted connection/);
    assert.equal(s.got.lines.filter(function (l) { return /^AUTH/i.test(l); }).length, 0, 'no AUTH line reached the server');
    assert.deepEqual(s.got.auth, []);
    // without credentials, allowPlain sends (e.g. a local relay)
    const r = await Smtp.sendMail({ host: '127.0.0.1', port: s.port, allowPlain: true }, { from: 'me@example.com', to: 'a@example.com', subject: 's', text: 't' });
    assert.deepEqual(r.accepted, ['a@example.com']);
});

// -- TLS (needs openssl to make a throwaway self-signed certificate) -------------------------------------
function makeCert() {
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkit-smtp-'));
        const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
        const out = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
        fs.rmSync(dir, { recursive: true, force: true });
        return out;
    } catch (_) { return null; }
}
const CERT = makeCert();
const NO_CERT = !CERT && 'openssl not available';

test('implicit TLS (like port 465), certificate verified against a given CA', { skip: NO_CERT }, async function () {
    const s = await fakeSmtp({ implicit: true, key: CERT.key, cert: CERT.cert });
    const r = await Smtp.sendMail({ host: '127.0.0.1', port: s.port, secure: true, ca: CERT.cert, user: 'u', pass: 'p' },
        { from: 'me@example.com', to: 'a@example.com', subject: 's', text: 'tls body' });
    assert.deepEqual(r.accepted, ['a@example.com']);
    assert.equal(decodeBody(s.got.messages[0]).text, 'tls body');
    assert.equal(s.got.auth.length, 1);
});

test('implicit TLS: an untrusted certificate is refused by default', { skip: NO_CERT }, async function () {
    const s = await fakeSmtp({ implicit: true, key: CERT.key, cert: CERT.cert });
    await assert.rejects(Smtp.sendMail({ host: '127.0.0.1', port: s.port, secure: true, user: 'u', pass: 'p' },
        { from: 'me@example.com', to: 'a@example.com', subject: 's', text: 't' }), /self[- ]signed|certificate/i);
    assert.deepEqual(s.got.auth, []);
});

test('STARTTLS (like port 587): upgrade, re-EHLO, authenticate, send', { skip: NO_CERT }, async function () {
    const s = await fakeSmtp({ starttls: true, key: CERT.key, cert: CERT.cert });
    const r = await Smtp.sendMail({ host: '127.0.0.1', port: s.port, ca: CERT.cert, user: 'u', pass: 'p' },
        { from: 'me@example.com', to: 'a@example.com', subject: 's', text: 'upgraded' });
    assert.deepEqual(r.accepted, ['a@example.com']);
    assert.ok(s.got.lines.indexOf('STARTTLS') >= 0);
    assert.equal(s.got.lines.filter(function (l) { return /^EHLO/.test(l); }).length, 2, 'EHLO again after the upgrade');
    assert.ok(s.got.lines.indexOf('STARTTLS') < s.got.lines.findIndex(function (l) { return /^AUTH/.test(l); }), 'AUTH only after STARTTLS');
    assert.equal(decodeBody(s.got.messages[0]).text, 'upgraded');
});

test('STARTTLS: plaintext injected after "220 go ahead" aborts the session', async function () {
    const s = await fakeSmtp({ starttls: true, inject: true });
    await assert.rejects(Smtp.sendMail({ host: '127.0.0.1', port: s.port, user: 'u', pass: 'p' },
        { from: 'me@example.com', to: 'a@example.com', subject: 's', text: 't' }), /possible injection/);
    assert.deepEqual(s.got.auth, []);
});
