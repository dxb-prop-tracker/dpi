#!/usr/bin/env python3
"""Add (or replace) a "Next quarter" sheet in an issuer credit workbook.

    python3 forecast_sheet.py <workbook.xlsx> <issuer-forecast.json> <out.xlsx>

The website already carries this. Putting it in the workbook matters because a credit fund works in
the spreadsheet, and a forecast it cannot set against the escrow release on the next tab is half a
tool. The sheet is written as values, not formulas, for one reason: the seasonal factors and the
damped trend come from eight years of the whole Dubai series, which is not in the workbook and
would be absurd to carry there. The method, the factors and the two cases are all printed on the
sheet so the arithmetic can be checked by hand.

It appends a new worksheet part and registers it in the three places Excel needs - the content
types, the workbook relationships and the sheet list - reusing style ids already in the workbook so
it does not look like a bolt-on. Existing sheets, charts and formulas are untouched.
"""
import json
import re
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
SHEET_NAME = 'Next quarter'
S_TITLE, S_HDR, S_TEXT, S_NUM = '339', '133', '135', '136'   # style ids already in the workbook
COLS = 'ABCDEFG'


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


class Sheet:
    """A tiny row builder. Text is written inline so no shared-string table has to be touched."""

    def __init__(self):
        self.rows = []

    def add(self, r, cells):
        out = []
        for i, (val, style) in enumerate(cells):
            if val is None or val == '':
                continue
            ref = f'{COLS[i]}{r}'
            if isinstance(val, (int, float)):
                out.append(f'<c r="{ref}" s="{style}"><v>{val:.10g}</v></c>')
            else:
                out.append(f'<c r="{ref}" s="{style}" t="inlineStr">'
                           f'<is><t xml:space="preserve">{esc(val)}</t></is></c>')
        if out:
            self.rows.append(f'<row r="{r}">' + ''.join(out) + '</row>')

    def xml(self, last_row):
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                f'<worksheet xmlns="{NS}" xmlns:r="{RNS}">'
                f'<dimension ref="A1:G{last_row}"/><sheetViews><sheetView workbookViewId="0">'
                '<pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/>'
                '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>'
                '<cols><col min="1" max="1" width="34" customWidth="1"/>'
                '<col min="2" max="7" width="15" customWidth="1"/></cols>'
                '<sheetData>' + ''.join(self.rows) + '</sheetData>'
                '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
                '</worksheet>').encode('utf-8')


def build_rows(fc):
    s = Sheet()
    brand = fc.get('brand') or fc.get('issuer')
    T, H, X, N = S_TITLE, S_HDR, S_TEXT, S_NUM
    s.add(1, [(f'{brand} — next quarter, if nothing new is launched', T)])
    s.add(2, [('On this basis the only units that can sell are the ones already in the register and '
               'still unsold. Sales through ' + str(fc.get('throughMonth')) +
               '; part-months are excluded, because a month counted halfway reads as a collapse.', X)])
    s.add(3, [('Two cases are shown and neither is a forecast. FLAT holds the last three seasonally '
               'adjusted months. TREND continues the slope through the last twelve, damped so each '
               'month carries ' + str(fc.get('issuerForecast', {}).get('units', {}).get('damping', 0.85)) +
               ' of the previous slope rather than compounding. The gap between them is the honest '
               'width of the uncertainty.', X)])

    r = 5
    ltm = fc.get('lastTwelveMonths') or {}
    s.add(r, [('Recorded, last 12 months', H), ('Units', H), ('Value AED m', H)]); r += 1
    s.add(r, [('Sales', X), (ltm.get('units'), N), (round(ltm.get('valueAedM', 0)), N)]); r += 2

    iq = (fc.get('issuerForecast') or {})
    if not iq:
        s.add(r, [(fc.get('why', 'Too little history to put a trend through.'), X)])
        return s, r

    s.add(r, [('Trend, per month', H), ('Units', H), ('Value', H), ('', H), ('Dubai market', H),
              ('Units', H), ('Value', H)]); r += 1
    m = fc.get('market', {})
    s.add(r, [('Compound change per month, %', X),
              (round(iq['units']['momentumPctPerMonth'], 2), N),
              (round(iq['valueAedM']['momentumPctPerMonth'], 2), N), ('', X), ('', X),
              (round(m.get('units', {}).get('momentumPctPerMonth', 0), 2), N),
              (round(m.get('valueAedM', {}).get('momentumPctPerMonth', 0), 2), N)]); r += 2

    s.add(r, [('By calendar quarter', H), ('Months', H), ('Units — flat', H), ('Units — trend', H),
              ('Value AED m — flat', H), ('Value AED m — trend', H)]); r += 1
    vq = {q['quarter']: q for q in iq['valueAedM']['quarters']}
    for q in iq['units']['quarters']:
        v = vq.get(q['quarter'], {})
        label = q['quarter'] + ('  (partial)' if q['months'] < 3 else '')
        s.add(r, [(label, X), (q['months'], N), (round(q['flat']), N), (round(q['momentum']), N),
                  (round(v.get('flat', 0)), N), (round(v.get('momentum', 0)), N)]); r += 1
    r += 1

    s.add(r, [('Month', H), ('Units recorded', H), ('Units — flat', H), ('Units — trend', H),
              ('Value AED m recorded', H), ('Seasonal factor', H)]); r += 1
    sf = fc.get('seasonalFactors', {})
    for h in (fc.get('history') or [])[-9:]:
        mm = str(int(h['month'][5:7]))
        s.add(r, [(h['month'], X), (h['units'], N), ('', N), ('', N),
                  (round(h['valueAedM']), N), (round(sf.get(mm, 1), 3), N)]); r += 1
    vm = {x['month']: x for x in iq['valueAedM']['months']}
    for mo in iq['units']['months']:
        mm = str(int(mo['month'][5:7]))
        s.add(r, [(mo['month'] + '  forecast', X), ('', N), (round(mo['flat']), N),
                  (round(mo['momentum']), N), ('', N), (round(sf.get(mm, 1), 3), N)]); r += 1
    r += 1
    s.add(r, [('Method', H)]); r += 1
    s.add(r, [(fc.get('method', ''), X)]); r += 1
    s.add(r, [('Seasonality in Dubai is real but mild — roughly 0.88 in April to 1.11 in October — '
               'so it corrects the trend rather than driving it. Neither case assumes a new launch.', X)])
    return s, r


def apply(workbook, forecast_json, out_path):
    fc = json.load(open(forecast_json))
    zin = zipfile.ZipFile(workbook)

    wb = zin.read('xl/workbook.xml').decode('utf-8')
    rels = zin.read('xl/_rels/workbook.xml.rels').decode('utf-8')
    ct = zin.read('[Content_Types].xml').decode('utf-8')

    existing = re.search(r'<sheet name="' + SHEET_NAME + r'"[^/]*r:id="(rId\d+)"', wb)
    if existing:                      # replace the sheet we wrote last time
        rid = existing.group(1)
        target = re.search(r'<Relationship Id="' + rid + r'"[^/]*Target="([^"]+)"', rels).group(1)
        part = 'xl/' + target.lstrip('/')
    else:
        used = {int(x) for x in re.findall(r'Id="rId(\d+)"', rels)}
        rid = f'rId{max(used) + 1}'
        nums = {int(x) for x in re.findall(r'worksheets/sheet(\d+)\.xml', ' '.join(zin.namelist()))}
        part = f'xl/worksheets/sheet{max(nums) + 1}.xml'
        ids = {int(x) for x in re.findall(r'sheetId="(\d+)"', wb)}
        rels = rels.replace('</Relationships>',
                            f'<Relationship Id="{rid}" Type="{RNS}/worksheet" '
                            f'Target="{part[3:]}"/></Relationships>')
        wb = wb.replace('</sheets>', f'<sheet name="{SHEET_NAME}" sheetId="{max(ids) + 1}" '
                                     f'r:id="{rid}"/></sheets>')
        ct = ct.replace('</Types>', f'<Override PartName="/{part}" ContentType="application/vnd.'
                                    'openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')

    sheet, last = build_rows(fc)
    blob = sheet.xml(last)

    with zipfile.ZipFile(workbook) as src, zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            if item.filename == part:
                continue
            if item.filename == 'xl/calcChain.xml':
                continue                      # stale after a sheet is added; Excel rebuilds it
            data = src.read(item.filename)
            if item.filename == 'xl/workbook.xml':
                data = wb.encode('utf-8')
            elif item.filename == 'xl/_rels/workbook.xml.rels':
                # the chain's relationship must go with the part, or the file references a ghost
                data = re.sub(r'<Relationship[^>]*calcChain[^>]*/>', '', rels).encode('utf-8')
            elif item.filename == '[Content_Types].xml':
                data = re.sub(r'<Override[^>]*calcChain[^>]*/>', '', ct).encode('utf-8')
            dst.writestr(item, data)
        dst.writestr(part, blob)

    print(f'"{SHEET_NAME}" sheet {"replaced" if existing else "added"} in {out_path}'
          f' ({last} rows, through {fc.get("throughMonth")})')
    return 0


if __name__ == '__main__':
    a = sys.argv[1:]
    sys.exit(apply(a[0], a[1], a[2]))
