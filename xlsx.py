"""Minimal .xlsx writer built on the standard library.

An .xlsx file is a zip of XML parts. Writing them directly keeps the project
dependency-free while still producing a real workbook - formatted headers,
frozen panes, column widths, currency formats and bold totals - rather than a
CSV that Excel merely tolerates.

    sheet = Sheet("Sales", title="Sales Report", subtitle="01 Aug - 31 Aug")
    sheet.columns = [Column("Customer", 30), Column("Amount", 16, "money")]
    sheet.rows = [["Al-Madina Store", 15400]]
    sheet.totals = ["Total", 15400]
    write([sheet])  -> bytes
"""

import io
import zipfile
from xml.sax.saxutils import escape

# Style indexes defined in STYLES below
S_DEFAULT, S_TITLE, S_SUBTITLE, S_HEADER, S_MONEY, S_NUMBER, \
    S_TOTAL_TEXT, S_TOTAL_MONEY, S_TOTAL_NUMBER = range(9)

_TYPE_STYLE = {"text": S_DEFAULT, "money": S_MONEY, "number": S_NUMBER}
_TOTAL_STYLE = {"text": S_TOTAL_TEXT, "money": S_TOTAL_MONEY, "number": S_TOTAL_NUMBER}


class Column:
    def __init__(self, label, width=18, kind="text"):
        self.label = label
        self.width = width
        self.kind = kind


class Sheet:
    def __init__(self, name, title="", subtitle=""):
        self.name = name[:31]           # Excel's sheet-name limit
        self.title = title
        self.subtitle = subtitle
        self.columns = []
        self.rows = []
        self.totals = None


def col_letter(index):
    """0 -> A, 25 -> Z, 26 -> AA"""
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _cell(ref, value, style):
    if value is None or value == "":
        return f'<c r="{ref}" s="{style}"/>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}" s="{style}"><v>{value}</v></c>'
    return (f'<c r="{ref}" s="{style}" t="inlineStr">'
            f'<is><t xml:space="preserve">{escape(str(value))}</t></is></c>')


def _sheet_xml(sheet):
    widths = "".join(
        f'<col min="{i+1}" max="{i+1}" width="{c.width}" customWidth="1"/>'
        for i, c in enumerate(sheet.columns))

    body, row_no = [], 1

    def add(cells):
        nonlocal row_no
        body.append(f'<row r="{row_no}">' + "".join(cells) + "</row>")
        row_no += 1

    if sheet.title:
        add([_cell(f"A{row_no}", sheet.title, S_TITLE)])
    if sheet.subtitle:
        add([_cell(f"A{row_no}", sheet.subtitle, S_SUBTITLE)])
    if sheet.title or sheet.subtitle:
        add([])

    header_row = row_no
    add([_cell(f"{col_letter(i)}{row_no}", c.label, S_HEADER)
         for i, c in enumerate(sheet.columns)])

    for record in sheet.rows:
        add([_cell(f"{col_letter(i)}{row_no}", value,
                   _TYPE_STYLE.get(sheet.columns[i].kind, S_DEFAULT)
                   if i < len(sheet.columns) else S_DEFAULT)
             for i, value in enumerate(record)])

    if sheet.totals:
        add([_cell(f"{col_letter(i)}{row_no}", value,
                   _TOTAL_STYLE.get(sheet.columns[i].kind, S_TOTAL_TEXT)
                   if i < len(sheet.columns) else S_TOTAL_TEXT)
             for i, value in enumerate(sheet.totals)])

    # Freeze everything above the first data row so headers stay visible
    freeze = (f'<sheetViews><sheetView workbookViewId="0">'
              f'<pane ySplit="{header_row}" topLeftCell="A{header_row + 1}" '
              f'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>')
    last = f"{col_letter(max(0, len(sheet.columns) - 1))}{row_no - 1}"

    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'{freeze}<cols>{widths}</cols>'
            f'<sheetData>{"".join(body)}</sheetData>'
            f'<autoFilter ref="A{header_row}:{last}"/>'
            '</worksheet>')


STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
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
</styleSheet>'''

REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006"


def write(sheets):
    """Build the workbook and return it as bytes."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as book:
        overrides = "".join(
            f'<Override PartName="/xl/worksheets/sheet{i+1}.xml" '
            f'ContentType="application/vnd.openxmlformats-officedocument.'
            f'spreadsheetml.worksheet+xml"/>' for i in range(len(sheets)))
        book.writestr("[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.spreadsheetml.styles+xml"/>'
            f'{overrides}</Types>')

        book.writestr("_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{REL_NS}/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')

        tabs = "".join(
            f'<sheet name="{escape(s.name)}" sheetId="{i+1}" r:id="rId{i+1}"/>'
            for i, s in enumerate(sheets))
        book.writestr("xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            f'xmlns:r="{REL_NS}"><sheets>{tabs}</sheets></workbook>')

        links = "".join(
            f'<Relationship Id="rId{i+1}" Type="{REL_NS}/worksheet" '
            f'Target="worksheets/sheet{i+1}.xml"/>' for i in range(len(sheets)))
        book.writestr("xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'{links}<Relationship Id="rId{len(sheets)+1}" Type="{REL_NS}/styles" '
            'Target="styles.xml"/></Relationships>')

        book.writestr("xl/styles.xml", STYLES)
        for i, sheet in enumerate(sheets):
            book.writestr(f"xl/worksheets/sheet{i+1}.xml", _sheet_xml(sheet))

    return buffer.getvalue()
