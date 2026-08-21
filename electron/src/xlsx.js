// Minimal .xlsx writer. Ported from xlsx.py.
//
// An .xlsx file is a zip of XML parts. Writing them directly keeps the program
// free of dependencies while still producing a real workbook - formatted
// headers, frozen panes, column widths, currency formats and bold totals -
// rather than a CSV that Excel merely tolerates.

import { deflateRawSync, crc32 } from "node:zlib";

// Style indexes defined in STYLES below
const S_DEFAULT = 0, S_TITLE = 1, S_SUBTITLE = 2, S_HEADER = 3, S_MONEY = 4,
  S_NUMBER = 5, S_TOTAL_TEXT = 6, S_TOTAL_MONEY = 7, S_TOTAL_NUMBER = 8;

const TYPE_STYLE = { text: S_DEFAULT, money: S_MONEY, number: S_NUMBER };
const TOTAL_STYLE = { text: S_TOTAL_TEXT, money: S_TOTAL_MONEY, number: S_TOTAL_NUMBER };

export class Column {
  constructor(label, width = 18, kind = "text") {
    this.label = label;
    this.width = width;
    this.kind = kind;
  }
}

export class Sheet {
  constructor(name, title = "", subtitle = "") {
    this.name = name.slice(0, 31);      // Excel's sheet-name limit
    this.title = title;
    this.subtitle = subtitle;
    this.columns = [];
    this.rows = [];
    this.totals = null;
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // control characters are not legal in XML and Excel refuses the file
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/** 0 -> A, 25 -> Z, 26 -> AA */
export function colLetter(index) {
  let letters = "";
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cell(ref, value, style) {
  if (value === null || value === undefined || value === "") {
    return `<c r="${ref}" s="${style}"/>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" s="${style}" t="inlineStr">` +
    `<is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(sheet) {
  const widths = sheet.columns.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join("");

  const body = [];
  let rowNo = 1;
  const add = (cells) => {
    body.push(`<row r="${rowNo}">${cells.join("")}</row>`);
    rowNo += 1;
  };

  if (sheet.title) add([cell(`A${rowNo}`, sheet.title, S_TITLE)]);
  if (sheet.subtitle) add([cell(`A${rowNo}`, sheet.subtitle, S_SUBTITLE)]);
  if (sheet.title || sheet.subtitle) add([]);

  const headerRow = rowNo;
  add(sheet.columns.map((c, i) => cell(`${colLetter(i)}${rowNo}`, c.label, S_HEADER)));

  for (const record of sheet.rows) {
    const at = rowNo;
    add(record.map((value, i) => cell(`${colLetter(i)}${at}`, value,
      i < sheet.columns.length
        ? (TYPE_STYLE[sheet.columns[i].kind] ?? S_DEFAULT)
        : S_DEFAULT)));
  }

  if (sheet.totals) {
    const at = rowNo;
    add(sheet.totals.map((value, i) => cell(`${colLetter(i)}${at}`, value,
      i < sheet.columns.length
        ? (TOTAL_STYLE[sheet.columns[i].kind] ?? S_TOTAL_TEXT)
        : S_TOTAL_TEXT)));
  }

  // Freeze everything above the first data row so headers stay visible
  const freeze = '<sheetViews><sheetView workbookViewId="0">' +
    `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" ` +
    'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  const last = `${colLetter(Math.max(0, sheet.columns.length - 1))}${rowNo - 1}`;

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `${freeze}<cols>${widths}</cols>` +
    `<sheetData>${body.join("")}</sheetData>` +
    `<autoFilter ref="A${headerRow}:${last}"/>` +
    "</worksheet>";
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="5">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="15"/><color rgb="FFC1121F"/><name val="Calibri"/></font>
  <font><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFC1121F"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
  <border><left/><right/><top/><bottom/><diagonal/></border>
  <border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
  <border><left/><right/><top style="thin"><color rgb="FF808080"/></top>
          <bottom style="double"><color rgb="FF808080"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
  <xf numFmtId="0"   fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0"   fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="0"   fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="0"   fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  <xf numFmtId="0"   fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
  <xf numFmtId="0"   fontId="4" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
  <xf numFmtId="164" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
  <xf numFmtId="0"   fontId="4" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// ----------------------------------------------------------------- zip parts
//
// Python's zipfile is not available here, so the container is assembled by
// hand. It is a well-specified format and only the deflate case is needed.

function zipDate(when) {
  const time = ((when.getHours() << 11) | (when.getMinutes() << 5)
    | Math.floor(when.getSeconds() / 2)) & 0xffff;
  const date = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5)
    | when.getDate()) & 0xffff;
  return { time, date };
}

function buildZip(files) {
  const when = new Date();
  const { time, date } = zipDate(when);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, contents] of files) {
    const raw = Buffer.from(contents, "utf8");
    const packed = deflateRawSync(raw);
    const sum = crc32(raw) >>> 0;
    const nameBytes = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // local file header
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(8, 8);               // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);              // no extra field
    chunks.push(local, nameBytes, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);      // central directory header
    entry.writeUInt16LE(20, 4);              // version made by
    entry.writeUInt16LE(20, 6);              // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30);              // extra
    entry.writeUInt16LE(0, 32);              // comment
    entry.writeUInt16LE(0, 34);              // disk number
    entry.writeUInt16LE(0, 36);              // internal attributes
    entry.writeUInt32LE(0, 38);              // external attributes
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + packed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);          // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, directory, end]);
}

/** Build the workbook and return it as a Buffer. */
export function write(sheets) {
  const overrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
    'ContentType="application/vnd.openxmlformats-officedocument.' +
    'spreadsheetml.worksheet+xml"/>').join("");

  const tabs = sheets.map((s, i) =>
    `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");

  const links = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" ` +
    `Target="worksheets/sheet${i + 1}.xml"/>`).join("");

  const files = [
    ["[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-' +
      'officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-' +
      'officedocument.spreadsheetml.styles+xml"/>' + overrides + "</Types>"],
    ["_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
      "</Relationships>"],
    ["xl/workbook.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      `xmlns:r="${REL_NS}"><sheets>${tabs}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      links + `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" ` +
      'Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", STYLES],
    ...sheets.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)]),
  ];

  return buildZip(files);
}
