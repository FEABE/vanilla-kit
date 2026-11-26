'use strict';
/**
 * Test-only ZIP reader. Walks the central directory, cross-checks every local header against it,
 * inflates (method 8) or copies (method 0) the data and verifies sizes and CRC-32 with node:zlib's
 * own crc32 when available (an implementation independent from node/zip.js).
 * Returns [{ name, method, flags, crc, compressedSize, size, dosTime, dosDate, externalAttrs, data }].
 */
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

function readZip(buf) {
    // end of central directory: last 22 bytes when there is no comment
    const eocd = buf.length - 22;
    assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end of central directory signature');
    const count = buf.readUInt16LE(eocd + 10);
    assert.equal(buf.readUInt16LE(eocd + 8), count);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    assert.equal(cdOffset + cdSize, eocd, 'central directory ends where the EOCD starts');
    const out = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
        const e = {
            flags: buf.readUInt16LE(p + 8),
            method: buf.readUInt16LE(p + 10),
            dosTime: buf.readUInt16LE(p + 12),
            dosDate: buf.readUInt16LE(p + 14),
            crc: buf.readUInt32LE(p + 16),
            compressedSize: buf.readUInt32LE(p + 20),
            size: buf.readUInt32LE(p + 24),
            externalAttrs: buf.readUInt32LE(p + 38)
        };
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        e.name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        p += 46 + nameLen + extraLen + commentLen;

        // local header must agree with the central header
        assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
        assert.equal(buf.readUInt16LE(localOffset + 6), e.flags);
        assert.equal(buf.readUInt16LE(localOffset + 8), e.method);
        assert.equal(buf.readUInt32LE(localOffset + 14), e.crc);
        assert.equal(buf.readUInt32LE(localOffset + 18), e.compressedSize);
        assert.equal(buf.readUInt32LE(localOffset + 22), e.size);
        const lnameLen = buf.readUInt16LE(localOffset + 26);
        const lextraLen = buf.readUInt16LE(localOffset + 28);
        assert.equal(buf.slice(localOffset + 30, localOffset + 30 + lnameLen).toString('utf8'), e.name);
        const start = localOffset + 30 + lnameLen + lextraLen;
        const body = buf.slice(start, start + e.compressedSize);
        if (e.method === 0) e.data = Buffer.from(body);
        else if (e.method === 8) e.data = zlib.inflateRawSync(body);
        else throw new Error('unexpected method ' + e.method);
        assert.equal(e.data.length, e.size, 'uncompressed size of ' + e.name);
        if (typeof zlib.crc32 === 'function') assert.equal(zlib.crc32(e.data) >>> 0, e.crc, 'CRC-32 of ' + e.name);
        out.push(e);
    }
    assert.equal(p, cdOffset + cdSize);
    return out;
}

module.exports = { readZip };
