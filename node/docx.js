'use strict';
/**
 * docx.js — minimal Word (.docx, Office Open XML) document writer for Node. Zero dependencies, one file
 * (the small ZIP writer it needs is included below), CommonJS. Part of vanilla-kit. MIT License.
 *
 *   const { docx } = require('./docx.js');
 *   const buf = docx({
 *     title: 'Report',                       // document property (and nothing else; add a heading yourself)
 *     creator: 'Team',                       // optional document property
 *     body: [
 *       { heading: 1, text: 'Report' },      // heading levels 1-3 use Word's built-in Heading styles
 *       'A plain paragraph.\nA line break inside it.',
 *       { text: ['Mixed ', { text: 'bold', bold: true }, ', ', { text: 'italic', italic: true }, ' and ',
 *                { text: 'underlined', underline: true }, ' runs.'] },
 *       { text: 'Centered', align: 'center' },
 *       { pageBreak: true },
 *       { text: 'Second page' }
 *     ]
 *   }, { date: new Date('2026-01-01T00:00:00Z') });
 *   require('node:fs').writeFileSync('report.docx', buf);
 *
 *   Block: a string (one paragraph) or
 *     { text, heading?: 1|2|3, title?: true, align?: 'left'|'center'|'right'|'both' } | { pageBreak: true }
 *   text: a string or an array of runs; a run is a string or { text, bold?, italic?, underline?, strike?, code? }.
 *   In text, '\n' becomes a line break and '\t' a tab. Characters that XML 1.0 cannot contain (most control
 *   characters, lone surrogates, U+FFFE/U+FFFF) are removed; everything is XML-escaped.
 *   options.date — created/modified timestamp and ZIP entry time; fix it for byte-identical output.
 *
 *   The package holds: [Content_Types].xml, _rels/.rels, docProps/core.xml, word/document.xml,
 *   word/styles.xml, word/_rels/document.xml.rels. No images, tables, lists, headers/footers or external
 *   references — nothing in the file makes Word fetch anything.
 */

// -- Minimal store-only ZIP writer (fixed, trusted entry names only) --------------------------------------
let CRC_TABLE = null;
function crc32(buf) {
	if (!CRC_TABLE) {
		CRC_TABLE = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
			CRC_TABLE[n] = c >>> 0;
		}
	}
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

function storeZip(files, date) {
	const y = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
	const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
	const dosDate = ((y - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
	const chunks = [];
	const centrals = [];
	let offset = 0;
	for (const f of files) {
		const name = Buffer.from(f.name, 'utf8');
		const data = Buffer.from(f.data, 'utf8');
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);      // UTF-8 names
		local.writeUInt16LE(0, 8);           // stored
		local.writeUInt16LE(dosTime, 10);
		local.writeUInt16LE(dosDate, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, name, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x0314, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(dosTime, 12);
		central.writeUInt16LE(dosDate, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += 30 + name.length + data.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat(chunks.concat([cd, end]));
}

// -- XML ------------------------------------------------------------------------------------------------
// Removes code points XML 1.0 does not allow (keeps tab, LF, CR), including lone surrogates.
function cleanXmlText(s) {
	s = String(s == null ? '' : s);
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xD800 && c <= 0xDBFF) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xDC00 && d <= 0xDFFF) { out += s.charAt(i) + s.charAt(i + 1); i++; }
			continue;                                  // a high surrogate without its pair is dropped
		}
		if (c >= 0xDC00 && c <= 0xDFFF) continue;     // lone low surrogate
		if ((c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) || c === 0xFFFE || c === 0xFFFF) continue;
		out += s.charAt(i);
	}
	return out;
}
function esc(s) {
	return cleanXmlText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function runXml(run) {
	if (typeof run === 'string') run = { text: run };
	if (!run || typeof run !== 'object') throw new TypeError('docx: a run must be a string or an object');
	let props = '';
	if (run.bold) props += '<w:b/>';
	if (run.italic) props += '<w:i/>';
	if (run.strike) props += '<w:strike/>';
	if (run.underline) props += '<w:u w:val="single"/>';
	if (run.code) props += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';
	const rPr = props ? '<w:rPr>' + props + '</w:rPr>' : '';
	// split on line breaks and tabs, each piece in its own element
	const parts = cleanXmlText(String(run.text == null ? '' : run.text).replace(/\r\n?/g, '\n')).split(/(\n|\t)/);
	let inner = '';
	for (const p of parts) {
		if (p === '\n') inner += '<w:br/>';
		else if (p === '\t') inner += '<w:tab/>';
		else if (p !== '') inner += '<w:t xml:space="preserve">' + esc(p) + '</w:t>';
	}
	return '<w:r>' + rPr + inner + '</w:r>';
}

const ALIGN = { left: 'left', center: 'center', right: 'right', both: 'both', justify: 'both' };

function blockXml(block) {
	if (typeof block === 'string') block = { text: block };
	if (!block || typeof block !== 'object') throw new TypeError('docx: a body block must be a string or an object');
	if (block.pageBreak) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
	let pPr = '';
	if (block.title) pPr += '<w:pStyle w:val="Title"/>';
	else if (block.heading != null) {
		const level = Number(block.heading);
		if (!(level === 1 || level === 2 || level === 3)) throw new RangeError('docx: heading must be 1, 2 or 3');
		pPr += '<w:pStyle w:val="Heading' + level + '"/>';
	}
	if (block.align != null) {
		if (!Object.prototype.hasOwnProperty.call(ALIGN, block.align)) throw new RangeError('docx: align must be left, center, right or both');
		pPr += '<w:jc w:val="' + ALIGN[block.align] + '"/>';
	}
	const runs = Array.isArray(block.text) ? block.text : [block.text == null ? '' : block.text];
	return '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + runs.map(runXml).join('') + '</w:p>';
}

function heading(styleId, name, size, level, extra) {
	return '<w:style w:type="paragraph" w:styleId="' + styleId + '"><w:name w:val="' + name + '"/>'
		+ '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>'
		+ '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/>' + (level != null ? '<w:outlineLvl w:val="' + level + '"/>' : '') + '</w:pPr>'
		+ '<w:rPr>' + (extra || '<w:b/>') + '<w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/></w:rPr></w:style>';
}

const STYLES_XML = XML_HEAD
	+ '<w:styles xmlns:w="' + NS_W + '">'
	+ '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>'
	+ '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>'
	+ '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
	+ '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
	+ heading('Title', 'Title', 56, null, '')
	+ heading('Heading1', 'heading 1', 32, 0)
	+ heading('Heading2', 'heading 2', 26, 1)
	+ heading('Heading3', 'heading 3', 24, 2)
	+ '</w:styles>';

function docx(doc, options) {
	doc = doc || {};
	options = options || {};
	const date = options.date instanceof Date ? options.date : new Date();
	if (isNaN(date.getTime())) throw new RangeError('docx: invalid date');
	const when = date.toISOString().replace(/\.\d+Z$/, 'Z');
	const body = doc.body == null ? [] : doc.body;
	if (!Array.isArray(body)) throw new TypeError('docx: body must be an array');
	const paragraphs = body.map(blockXml).join('');

	const files = [
		{ name: '[Content_Types].xml', data: XML_HEAD
			+ '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
			+ '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
			+ '<Default Extension="xml" ContentType="application/xml"/>'
			+ '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
			+ '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
			+ '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
			+ '</Types>' },
		{ name: '_rels/.rels', data: XML_HEAD
			+ '<Relationships xmlns="' + NS_PKG_REL + '">'
			+ '<Relationship Id="rId1" Type="' + NS_R + '/officeDocument" Target="word/document.xml"/>'
			+ '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
			+ '</Relationships>' },
		{ name: 'docProps/core.xml', data: XML_HEAD
			+ '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" '
			+ 'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
			+ (doc.title != null ? '<dc:title>' + esc(doc.title) + '</dc:title>' : '')
			+ (doc.creator != null ? '<dc:creator>' + esc(doc.creator) + '</dc:creator>' : '')
			+ '<dcterms:created xsi:type="dcterms:W3CDTF">' + when + '</dcterms:created>'
			+ '<dcterms:modified xsi:type="dcterms:W3CDTF">' + when + '</dcterms:modified>'
			+ '</cp:coreProperties>' },
		{ name: 'word/_rels/document.xml.rels', data: XML_HEAD
			+ '<Relationships xmlns="' + NS_PKG_REL + '">'
			+ '<Relationship Id="rId1" Type="' + NS_R + '/styles" Target="styles.xml"/>'
			+ '</Relationships>' },
		{ name: 'word/styles.xml', data: STYLES_XML },
		{ name: 'word/document.xml', data: XML_HEAD
			+ '<w:document xmlns:w="' + NS_W + '" xmlns:r="' + NS_R + '"><w:body>'
			+ paragraphs
			+ '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
			+ '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
			+ '</w:body></w:document>' }
	];
	return storeZip(files, date);
}

module.exports = { docx, escapeXml: esc };
