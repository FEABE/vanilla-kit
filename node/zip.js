'use strict';
/**
 * zip.js — minimal ZIP archive writer for Node. Zero dependencies (node:zlib only), one file, CommonJS.
 * Part of vanilla-kit. MIT License.
 *
 *   const { zip, crc32 } = require('./zip.js');
 *   const buf = zip([
 *     { name: 'hello.txt', data: 'Hello' },                       // string -> UTF-8
 *     { name: 'img/logo.png', data: pngBuffer, compress: false }, // Buffer / Uint8Array
 *     { name: 'empty-dir/' }                                      // trailing '/' = directory entry
 *   ], { date: new Date(2026, 0, 1) });
 *
 *   zip(entries, options?) -> Buffer
 *     entry:   { name, data?, date?, compress? }
 *     options: { compress: true, level: 6, date: new Date() }
 *       compress  deflate (method 8) when it makes the entry smaller, otherwise store (method 0).
 *                 false = always store. Per-entry `compress` overrides the option.
 *       level     zlib deflate level 0-9.
 *       date      modification time written for entries without their own `date` (MS-DOS local time,
 *                 2-second resolution, clamped to 1980-2107). Pass a fixed date for reproducible output.
 *   crc32(data) -> unsigned 32-bit CRC (IEEE 802.3, the one ZIP uses)
 *
 *   Entry names are always written as UTF-8 (general-purpose flag bit 11). They are validated and the call throws
 *   on anything that could escape the extraction directory or confuse an extractor:
 *     empty names, absolute paths ('/x'), drive letters ('C:x'), backslashes, '.' or '..' segments,
 *     empty segments ('a//b'), control characters, and duplicate names.
 *   Limits (no ZIP64): at most 65535 entries and 4 GiB - 1 per entry / archive; larger input throws RangeError.
 *   Not supported: encryption, ZIP64, comments, reading archives.
 */
const zlib = require('node:zlib');

let CRC_TABLE = null;
function crc32(data) {
	if (!CRC_TABLE) {
		CRC_TABLE = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
			CRC_TABLE[n] = c >>> 0;
		}
	}
	const buf = toBuffer(data);
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

function toBuffer(data) {
	if (data == null) return Buffer.alloc(0);
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (typeof data === 'string') return Buffer.from(data, 'utf8');
	throw new TypeError('zip: entry data must be a Buffer, Uint8Array or string');
}

// MS-DOS date/time fields (local time). Years outside 1980-2107 cannot be represented and are clamped.
function dosDateTime(d) {
	let year = d.getFullYear();
	if (year < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };   // 1980-01-01 00:00
	if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
	return {
		time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
		date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
	};
}

/** Throws unless `name` is a safe relative path. Returns true for directory entries (trailing '/'). */
function checkName(name) {
	if (typeof name !== 'string' || name === '') throw new TypeError('zip: entry name must be a non-empty string');
	if (/[\x00-\x1f\x7f]/.test(name)) throw new Error('zip: control character in entry name: ' + JSON.stringify(name));
	if (name.indexOf('\\') >= 0) throw new Error('zip: backslash in entry name (use "/"): ' + JSON.stringify(name));
	if (name.charAt(0) === '/') throw new Error('zip: absolute entry name: ' + JSON.stringify(name));
	if (/^[A-Za-z]:/.test(name)) throw new Error('zip: drive letter in entry name: ' + JSON.stringify(name));
	const isDir = name.charAt(name.length - 1) === '/';
	const parts = (isDir ? name.slice(0, -1) : name).split('/');
	for (const part of parts) {
		if (part === '' || part === '.' || part === '..') throw new Error('zip: invalid path segment in entry name: ' + JSON.stringify(name));
	}
	return isDir;
}

const MAX_U32 = 0xFFFFFFFF;

function zip(entries, options) {
	options = options || {};
	if (!Array.isArray(entries)) throw new TypeError('zip: entries must be an array');
	if (entries.length > 0xFFFF) throw new RangeError('zip: more than 65535 entries needs ZIP64, which is not supported');
	const level = options.level == null ? 6 : options.level;
	const defaultDate = options.date instanceof Date ? options.date : new Date();
	const seen = new Set();
	const chunks = [];
	const centrals = [];
	let offset = 0;

	for (const e of entries) {
		if (!e || typeof e !== 'object') throw new TypeError('zip: each entry must be an object');
		const isDir = checkName(e.name);
		if (seen.has(e.name)) throw new Error('zip: duplicate entry name: ' + JSON.stringify(e.name));
		seen.add(e.name);
		const name = Buffer.from(e.name, 'utf8');
		if (name.length > 0xFFFF) throw new RangeError('zip: entry name too long');
		const data = toBuffer(e.data);
		if (isDir && data.length) throw new Error('zip: directory entry cannot have data: ' + JSON.stringify(e.name));
		if (data.length > MAX_U32) throw new RangeError('zip: entry larger than 4 GiB needs ZIP64, which is not supported');

		let method = 0;
		let body = data;
		const wantCompress = e.compress != null ? e.compress !== false : options.compress !== false;
		if (wantCompress && data.length > 0) {
			const deflated = zlib.deflateRawSync(data, { level: level });
			if (deflated.length < data.length) { method = 8; body = deflated; }
		}
		const crc = crc32(data);
		const dt = dosDateTime(e.date instanceof Date ? e.date : defaultDate);
		const flags = 0x0800;    // bit 11: names are UTF-8

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);          // version needed to extract: 2.0
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(dt.time, 10);
		local.writeUInt16LE(dt.date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);          // extra field length
		chunks.push(local, name, body);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x0314, 4);    // made by: Unix (3), spec 2.0
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(dt.time, 12);
		central.writeUInt16LE(dt.date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);        // extra
		central.writeUInt16LE(0, 32);        // comment
		central.writeUInt16LE(0, 34);        // disk number
		central.writeUInt16LE(0, 36);        // internal attributes
		// external attributes: Unix mode in the high 16 bits (+ MS-DOS directory bit for directories)
		central.writeUInt32LE(isDir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + body.length;
		if (offset > MAX_U32) throw new RangeError('zip: archive larger than 4 GiB needs ZIP64, which is not supported');
	}

	const centralBuf = Buffer.concat(centrals);
	if (offset + centralBuf.length > MAX_U32) throw new RangeError('zip: archive larger than 4 GiB needs ZIP64, which is not supported');
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);                 // this disk
	end.writeUInt16LE(0, 6);                 // disk with the central directory
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);                // comment length
	return Buffer.concat(chunks.concat([centralBuf, end]));
}

module.exports = { zip, crc32, checkName };
