#!/usr/bin/env python3
"""Strip cached values from every formula cell of a workbook.

A workbook cut from the canonical model keeps the canonical issuer's numbers as the cached
value of every formula cell. Excel recalculates on open (fullCalcOnLoad=1) and shows the right
figures; anything that reads the file without recalculating — a preview pane, openpyxl,
LibreOffice's converter, a colleague's script — shows Binghatti's numbers on Sobha's sheet.
Removing the cached values makes every reader either compute the cell or show it blank;
no reader can show the wrong issuer's figure.

Usage: python3 scripts/strip_cached.py in.xlsx out.xlsx
Exit 0 and prints the number of cached values removed per sheet.
"""
import re, sys, zipfile

# A formula cell is <c ...><f ...>...</f><v>...</v></c> or <c ...><f .../><v>...</v></c>.
# Drop the <v>…</v> that follows an <f> element; leave <is> (inline strings) and value-only cells alone.
PAT = re.compile(r'(<f(?:\s[^>]*)?(?:/>|>.*?</f>))\s*<v>[^<]*</v>', re.S)
# Cached string results carry t="str" on the cell; without a value the type must go too, or Excel
# reads an empty string cell as a formula error.
TSTR = re.compile(r'(<c\b[^>]*?)\s+t="str"([^>]*>\s*<f)', re.S)

def strip(src, dst):
    zin = zipfile.ZipFile(src)
    zout = zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED)
    report = {}
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename.startswith('xl/worksheets/sheet') and item.filename.endswith('.xml'):
            text = data.decode('utf-8')
            text, n = PAT.subn(r'\1', text)
            text, _ = TSTR.subn(r'\1\2', text)
            if n: report[item.filename] = n
            data = text.encode('utf-8')
        elif item.filename == 'xl/workbook.xml':
            text = data.decode('utf-8')
            if 'fullCalcOnLoad="1"' not in text:
                text = re.sub(r'<calcPr\b([^/>]*)/>', r'<calcPr\1 fullCalcOnLoad="1"/>', text) if '<calcPr' in text \
                    else text.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>')
            data = text.encode('utf-8')
        zout.writestr(item, data)
    zout.close()
    return report

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    rep = strip(src, dst)
    for k, v in sorted(rep.items()): print(f'  {k}: {v} cached values removed')
    print(f'strip_cached: {sum(rep.values())} cached values removed from {len(rep)} sheets')
