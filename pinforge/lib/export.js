// lib/export.js
// Turns finished pins into CSV, JSON or Excel (.xlsx) files.
// The .xlsx writer is built in (a tiny ZIP + XML writer) so we don't need any
// external library — Manifest V3 doesn't allow loading code from the internet.

import { joinMediaUrl } from './validate.js';

/** Column sets. "pinterest" follows Pinterest's bulk-create CSV template. */
export const EXPORT_PRESETS = {
  full: [
    ['File name', (p) => p.fileName],
    ['Title', (p) => p.title],
    ['Description', (p) => p.description],
    ['Primary keyword', (p) => p.primaryKeyword],
    ['Keywords', (p) => (p.keywords || []).join(', ')],
    ['Alt text', (p) => p.altText],
    ['Board', (p) => p.board],
    ['Link', (p) => p.link],
    ['Media URL', (p) => p.mediaUrl],
    ['Image summary', (p) => p.imageSummary],
  ],
  pinterest: [
    ['Title', (p) => p.title],
    ['Media URL', (p) => p.mediaUrl],
    ['Pinterest board', (p) => p.board],
    ['Thumbnail', () => ''],
    ['Description', (p) => p.description],
    ['Link', (p) => p.link],
    ['Publish date', () => ''],
    ['Keywords', (p) => (p.keywords || []).join(', ')],
  ],
};

/**
 * Prepare the plain objects that get exported.
 * @param items     stored items
 * @param getLink   function(item) -> final link (handles "same link for all" mode)
 * @param settings  for mediaBaseUrl
 */
export function toPins(items, getLink, settings = {}) {
  return items
    .filter((it) => it.status === 'done')
    .map((it) => ({
      fileName: it.fileName,
      title: it.title || '',
      description: it.description || '',
      primaryKeyword: it.primaryKeyword || '',
      keywords: it.keywords || [],
      altText: it.altText || '',
      board: it.board || '',
      link: getLink(it) || '',
      mediaUrl: joinMediaUrl(settings.mediaBaseUrl, it.fileName),
      imageSummary: it.imageSummary || '',
    }));
}

export function toTable(pins, preset = 'full') {
  const cols = EXPORT_PRESETS[preset] || EXPORT_PRESETS.full;
  return {
    headers: cols.map((c) => c[0]),
    rows: pins.map((p) => cols.map((c) => String(c[1](p) ?? ''))),
  };
}

// ---------- CSV ----------

/** Stops spreadsheet apps from running cells like "=HYPERLINK(...)" as formulas. */
function guardFormula(v) {
  return /^[=+@\t\r]/.test(v) ? "'" + v : v;
}

function csvCell(v) {
  const s = guardFormula(String(v ?? ''));
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCSV({ headers, rows }, { bom = true } = {}) {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(','));
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

// ---------- JSON ----------

export function toJSON(pins) {
  return JSON.stringify({ generator: 'PinForge', exportedAt: new Date().toISOString(), count: pins.length, pins }, null, 2);
}

// ---------- XLSX (minimal writer) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build an uncompressed ("stored") ZIP from [{name, data: Uint8Array}]. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // invalid in XML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function toXLSX({ headers, rows }, sheetName = 'Pins') {
  const enc = new TextEncoder();
  const widths = headers.map((h, i) =>
    Math.min(60, Math.max(10, h.length + 2, ...rows.map((r) => Math.min(60, (r[i] || '').length + 2)))),
  );

  const cell = (v, r, c, style) =>
    `<c r="${colName(c)}${r}" t="inlineStr"${style ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
  const rowXml = (vals, r, style) => `<row r="${r}">${vals.map((v, c) => cell(v, r, c, style)).join('')}</row>`;

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' +
    '<sheetData>' + rowXml(headers, 1, true) + rows.map((r, i) => rowXml(r, i + 2, false)).join('') + '</sheetData>' +
    '</worksheet>';

  const files = [
    {
      name: '[Content_Types].xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xmlEscape(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/styles.xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    },
    { name: 'xl/worksheets/sheet1.xml', xml: sheet },
  ];

  return zipStore(files.map((f) => ({ name: f.name, data: enc.encode(f.xml) })));
}

/** File name like "pinforge-pins-2026-10-07-1530.csv". */
export function exportFileName(ext, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `pinforge-pins-${stamp}.${ext}`;
}
