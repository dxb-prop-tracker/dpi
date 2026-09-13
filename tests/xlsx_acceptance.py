#!/usr/bin/env python3
"""Will Excel open this workbook? The checks that catch what LibreOffice and openpyxl let through.

    python3 tests/xlsx_acceptance.py file.xlsx [file2.xlsx ...]

Each check below corresponds to a way a generated workbook has actually failed to open in Excel.
LibreOffice opened every one of them. openpyxl loaded every one of them. Excel refused every one of
them. So this is the test that stands in for Excel when Excel is not on the machine, and it is run
on every workbook before it is published. A new way of breaking a file gets a new check here.
"""
import re, sys, zipfile
import xml.etree.ElementTree as ET

SS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RNS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def check(path):
    problems = []
    z = zipfile.ZipFile(path)
    names = set(z.namelist())

    # 0. every XML part parses
    for n in names:
        if n.endswith('.xml') or n.endswith('.rels'):
            try:
                ET.fromstring(z.read(n))
            except ET.ParseError as e:
                problems.append(f'{n}: malformed XML ({e})')
    if problems:
        return problems

    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    ct = z.read('[Content_Types].xml').decode('utf-8')

    # 1. every sheet's part exists, has a content type, and its rels point at real parts
    sheets = {}
    for s in wb.find(SS + 'sheets'):
        t = rels.get(s.get(RNS + 'id'))
        p = t if (t or '').startswith('xl/') else 'xl/' + (t or '').lstrip('/')
        sheets[s.get('name')] = p
        if p not in names:
            problems.append(f'sheet "{s.get("name")}" points at missing part {p}')
        if f'PartName="/{p}"' not in ct:
            problems.append(f'{p} has no content-type override')
    for pn in re.findall(r'PartName="([^"]+)"', ct):
        if pn.lstrip('/') not in names:
            problems.append(f'content-type override for missing part {pn}')
    for i, t in rels.items():
        p = t if t.startswith('xl/') else 'xl/' + t.lstrip('/')
        if p not in names and t.lstrip('/') not in names:
            problems.append(f'workbook relationship {i} -> {t} points at a missing part')

    # 2. every prefix named in mc:Ignorable is declared on that root. THE bug that took three rounds.
    for n in [p for p in names if p.startswith('xl/worksheets/sheet') or p == 'xl/workbook.xml']:
        raw = z.read(n).decode('utf-8', 'replace')
        root = re.search(r'<(?:\w+:)?(?:worksheet|workbook)\b[^>]*>', raw)
        if not root:
            problems.append(f'{n}: no root tag found'); continue
        tag = root.group(0)
        declared = set(re.findall(r'xmlns:([\w.\-]+)=', tag))
        ign = re.search(r'mc:Ignorable="([^"]*)"', tag)
        if ign:
            for pfx in ign.group(1).split():
                if pfx not in declared:
                    problems.append(f'{n}: mc:Ignorable names "{pfx}" but it is not declared on the root')
        # 2b. the default SpreadsheetML namespace must be the default, not prefixed
        if re.match(r'<\w+:(worksheet|workbook)', tag):
            problems.append(f'{n}: root element carries a namespace prefix — Excel expects the default namespace')

    # 3. cell comments and their VML shapes point at rows that exist, and agree in number
    for name, p in sheets.items():
        rp = p.replace('worksheets/', 'worksheets/_rels/') + '.rels'
        if rp not in names:
            continue
        srels = list(ET.fromstring(z.read(rp)))
        cm = [r.get('Target') for r in srels if 'comments' in (r.get('Target') or '')]
        vm = [r.get('Target') for r in srels if (r.get('Target') or '').endswith('.vml')]
        rows = [int(r.get('r')) for r in ET.fromstring(z.read(p)).find(SS + 'sheetData').findall(SS + 'row')]
        mx = max(rows) if rows else 0
        nc = nv = None
        if cm:
            refs = [c.get('ref') for c in ET.fromstring(z.read('xl/' + cm[0].replace('../', ''))).iter(SS + 'comment')]
            nc = len(refs)
            bad = [r for r in refs if r and int(re.search(r'\d+', r).group(0)) > mx]
            if bad:
                problems.append(f'{name}: {len(bad)} comments anchored beyond the last row ({mx}): {bad[:4]}')
        if vm:
            raw = z.read('xl/' + vm[0].replace('../', '')).decode('utf-8', 'replace')
            vr = [int(x) + 1 for x in re.findall(r'<x:Row>(\d+)</x:Row>', raw)]
            nv = len(vr)
            bad = [r for r in vr if r > mx]
            if bad:
                problems.append(f'{name}: {len(bad)} comment shapes beyond the last row: {bad[:4]}')
        if nc is not None and nv is not None and nc != nv:
            problems.append(f'{name}: {nc} comments but {nv} comment shapes — the two halves disagree')

    # 4. shared formulas: every follower has a master, and every master has text
    for name, p in sheets.items():
        root = ET.fromstring(z.read(p))
        masters, followers = set(), []
        for c in root.iter(SS + 'c'):
            f = c.find(SS + 'f')
            if f is None or f.get('t') != 'shared':
                continue
            si = f.get('si')
            if f.text:
                masters.add(si)
            else:
                followers.append((c.get('r'), si))
        orphans = [r for r, si in followers if si not in masters]
        if orphans:
            problems.append(f'{name}: {len(orphans)} shared-formula cells whose master is gone: {orphans[:4]}')

    # 5. rows ascending and unique; cells ascending within a row and belonging to their row
    def colnum(ref):
        n = 0
        for ch in re.match(r'[A-Z]+', ref).group(0):
            n = n * 26 + ord(ch) - 64
        return n
    for name, p in sheets.items():
        sd = ET.fromstring(z.read(p)).find(SS + 'sheetData')
        rows = [int(r.get('r')) for r in sd.findall(SS + 'row')]
        if rows != sorted(rows) or len(rows) != len(set(rows)):
            problems.append(f'{name}: rows out of order or duplicated')
        for r in sd.findall(SS + 'row'):
            refs = [c.get('r') for c in r.findall(SS + 'c') if c.get('r')]
            cn = [colnum(x) for x in refs]
            if cn != sorted(cn) or len(cn) != len(set(cn)):
                problems.append(f'{name}: cells out of order or duplicated in row {r.get("r")}'); break
            if any(int(re.search(r'\d+', x).group(0)) != int(r.get('r')) for x in refs):
                problems.append(f'{name}: a cell in row {r.get("r")} carries a different row number'); break

    # 6. a calcChain, if present, names only cells that exist
    if 'xl/calcChain.xml' in names:
        cells = {}
        for name, p in sheets.items():
            cells[name] = {c.get('r') for c in ET.fromstring(z.read(p)).iter(SS + 'c')}
        # calcChain's i attribute is the sheetId, not the position in the tab strip
        by_id = {s.get('sheetId'): s.get('name') for s in wb.find(SS + 'sheets')}
        bad = 0
        cur = None
        for c in ET.fromstring(z.read('xl/calcChain.xml')):
            if c.get('i'):                      # i is carried forward when omitted
                cur = by_id.get(c.get('i'))
            if cur and c.get('r') not in cells.get(cur, set()):
                bad += 1
        if bad:
            problems.append(f'calcChain names {bad} cells that do not exist')

    # 7. defined names reference sheets that exist
    dn = wb.find(SS + 'definedNames')
    if dn is not None:
        for d in dn:
            m = re.match(r"'?([^'!]+)'?!", d.text or '')
            if m and m.group(1) not in sheets:
                problems.append(f'defined name {d.get("name")} refers to missing sheet "{m.group(1)}"')
    return problems


if __name__ == '__main__':
    rc = 0
    for path in sys.argv[1:]:
        probs = check(path)
        print(f'{path}: {"PASS" if not probs else "FAIL"}')
        for p in probs:
            print('   ', p)
        rc |= 1 if probs else 0
    sys.exit(rc)
