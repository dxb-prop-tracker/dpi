#!/usr/bin/env python3
"""Cut an issuer-sized copy of the canonical credit model.

    python3 issuer_model.py <canonical.xlsx> <issuer-register.csv> <issuer-handover.csv> <out.xlsx>

The model was built around Binghatti, whose register has 32 live projects, 68 projects in total and
8 towers on the handover watch. Every other issuer has different counts. This resizes the three data
blocks to the counts the issuer actually has - adding rows by cloning the last row of the block so
the new rows carry the same formulas, or removing rows from the end - and then repoints every
reference in the workbook, on any sheet, at the block's new extent.

What it does NOT change is the model: not one calculation, not one output, not one chart. A Sobha
workbook and a Binghatti workbook compute the same things in the same cells on the same tabs; only
the number of project rows underneath differs. That is the point - a credit fund comparing two
issuers is comparing like with like.

It works on the XML directly because openpyxl discards charts and drawings on a round-trip.
"""
import csv, copy, os, re, shutil, sys, zipfile
import os
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xlsxns
from openpyxl.formula.translate import Translator

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
ET.register_namespace('', NS)
Q = lambda t: f'{{{NS}}}{t}'

# sheet -> (first data row, last data row in the canonical model)
BLOCKS = {'Simulator': (8, 39), 'Projects': (5, 72), 'Handover check': (6, 13)}
CELL = re.compile(r'^([A-Z]{1,3})(\d+)$')


def sheet_paths(zf):
    wb = xlsxns.parse(zf.read('xl/workbook.xml'))
    rels = {r.get('Id'): r.get('Target') for r in xlsxns.parse(zf.read('xl/_rels/workbook.xml.rels'))}
    out = {}
    for sh in wb.find(Q('sheets')):
        t = rels[sh.get(f'{{{RNS}}}id')]
        out[sh.get('name')] = t if t.startswith('xl/') else 'xl/' + t.lstrip('/')
    return out


def row_map(last, new_last, delta):
    """Where each row ends up, in Excel's own terms.

    Growing the block means inserting rows *inside* it - the new rows take positions from the old
    last row onward and the old last row moves down - which is what makes a range written $8:$39
    expand to $8:$49 rather than stay put. Shrinking deletes the tail, and a reference into a
    deleted row contracts onto the block's new last row.
    """
    lo = min(last, new_last)

    def move(r):
        if r <= lo - 1:
            return r
        if r >= last:
            return r + delta
        return new_last
    return move


def remap_local(text, move):
    """Rewrite same-sheet references (those with no Sheet! prefix) through the row map."""
    pat = re.compile(r'(?<![A-Za-z0-9_!$.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])')
    return pat.sub(lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}{move(int(m.group(4)))}', text)


def remap_sheet(text, sheet, move, quoted):
    """Rewrite references that name `sheet` explicitly, wherever in the workbook they appear.

    Both ends of a range matter: only the first cell carries the Sheet! prefix, so the tail after
    the colon has to be picked up in the same match or a range would be left half-repointed.
    """
    name = f"'{sheet}'" if quoted else sheet
    pat = re.compile(re.escape(name) + r'!(\$?[A-Z]{1,3}\$?)(\d+)(?::(\$?[A-Z]{1,3}\$?)(\d+))?')

    def sub(m):
        out = f'{name}!{m.group(1)}{move(int(m.group(2)))}'
        if m.group(3):
            out += f':{m.group(3)}{move(int(m.group(4)))}'
        return out
    return pat.sub(sub, text)


def place_row(row_el, move):
    """Move a row to its mapped position and repoint its own references."""
    old = int(row_el.get('r'))
    row_el.set('r', str(move(old)))
    for c in row_el.findall(Q('c')):
        m = CELL.match(c.get('r') or '')
        if not m:
            continue
        c.set('r', f'{m.group(1)}{move(int(m.group(2)))}')
        f = c.find(Q('f'))
        if f is not None and f.text:
            f.text = remap_local(f.text, move)
            v = c.find(Q('v'))      # a cached answer from the old geometry would be a lie
            if v is not None:
                c.remove(v)
    return row_el


def clone_block_rows(src_row, first_pos, count, home):
    """Copy the block's last row into the rows that now sit above it, shifting it relatively."""
    out = []
    for k in range(count):
        pos = first_pos + k
        row = copy.deepcopy(src_row)
        row.set('r', str(pos))
        for c in row.findall(Q('c')):
            m = CELL.match(c.get('r') or '')
            if not m:
                continue
            col = m.group(1)
            c.set('r', f'{col}{pos}')
            f = c.find(Q('f'))
            if f is not None and f.text:
                try:
                    f.text = Translator('=' + f.text, f'{col}{home}').translate_formula(f'{col}{pos}')[1:]
                except Exception:
                    pass
            v = c.find(Q('v'))
            if v is not None:
                c.remove(v)
        out.append(row)
    return out


def expand_shared(root):
    """Turn shared formulas into ordinary ones before any row moves.

    Excel stores a repeated formula once, on a master cell, with the other cells carrying only an
    index back to it. Move or delete the master and every follower loses its formula, which is what
    makes Excel offer to repair the file. Writing each follower out in full first removes the
    dependency entirely, at the cost of a slightly larger file.
    """
    masters = {}
    for c in root.iter(Q('c')):
        f = c.find(Q('f'))
        if f is not None and f.get('t') == 'shared' and f.text and f.get('si') is not None:
            masters[f.get('si')] = (c.get('r'), f.text)
    for c in root.iter(Q('c')):
        f = c.find(Q('f'))
        if f is None or f.get('t') != 'shared':
            continue
        si = f.get('si')
        home = masters.get(si)
        if home is None:
            continue
        if not f.text:
            try:
                f.text = Translator('=' + home[1], home[0]).translate_formula(c.get('r'))[1:]
            except Exception:
                f.text = home[1]
        for a in ('t', 'si', 'ref'):
            f.attrib.pop(a, None)


def remap_f_refs(root, move):
    """An array formula declares the range it spills over; that range has to move with the rows."""
    for c in root.iter(Q('c')):
        f = c.find(Q('f'))
        if f is not None and f.get('ref'):
            f.set('ref', bump_range(f.get('ref'), move))


def seed_anchors(root, first, keys):
    """Write the issuer's own project keys down the block's first column.

    The resized sheet still carries the keys of the model it was cut from. Until they are replaced
    the refresher has nothing it recognises, and would rightly refuse to write a single figure.
    """
    rows = {int(r.get('r')): r for r in root.find(Q('sheetData')).findall(Q('row'))}
    for i, key in enumerate(keys):
        r = first + i
        row_el = rows.get(r)
        if row_el is None:
            continue
        c = cell_of(row_el, f'A{r}')
        if c is None:
            continue
        for child in list(c):
            c.remove(child)
        c.attrib.pop('t', None)
        c.set('t', 'inlineStr')
        is_el = ET.SubElement(c, Q('is'))
        t_el = ET.SubElement(is_el, Q('t'))
        t_el.text = str(key)
        t_el.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')


def cell_of(row_el, ref):
    for c in row_el.findall(Q('c')):
        if c.get('r') == ref:
            return c
    return None


def resize_sheet(root, first, last, want):
    """Grow or shrink the block to `want` rows; returns (new_last, delta)."""
    have = last - first + 1
    delta = want - have
    if delta == 0:
        return last, 0
    new_last = first + want - 1
    move = row_map(last, new_last, delta)
    data = root.find(Q('sheetData'))
    rows = {int(r.get('r')): r for r in data.findall(Q('row'))}
    for r in list(data):
        data.remove(r)

    dropped = set(range(new_last + 1, last + 1)) if delta < 0 else set()
    placed = []
    for r in sorted(rows):
        if r in dropped:
            continue
        placed.append(place_row(rows[r], move))
    if delta > 0:                        # the old last row is now at new_last; refill what it left
        home = new_last
        src = next(x for x in placed if int(x.get('r')) == home)
        placed += clone_block_rows(src, last, delta, home)

    for r in sorted(placed, key=lambda x: int(x.get('r'))):
        data.append(r)
    return new_last, delta


VNS = 'urn:schemas-microsoft-com:vml'
XNS = 'urn:schemas-microsoft-com:office:excel'


def fix_comments(zin, blobs, sheet_path, move, dropped, notes, sheet_name):
    """Move a sheet's cell comments with its rows, and drop the ones whose row is gone.

    This is the defect that made the first derived workbooks unopenable. Comments live in their own
    part and anchor to a cell address; the resize moved the rows underneath them and left comments
    pointing at cells that no longer existed. Excel refuses such a file outright - LibreOffice opens
    it without complaint, which is why it passed testing and failed on the first real download.

    A comment has two halves that must agree: the text in xl/comments<n>.xml, and a legacy VML shape
    in xl/drawings/vmlDrawing<n>.vml that positions the little yellow box. Both are remapped here,
    and a comment on a deleted row is removed from both rather than left half-present.
    """
    rels_path = sheet_path.replace('worksheets/', 'worksheets/_rels/') + '.rels'
    try:
        rels = xlsxns.parse(zin.read(rels_path))
    except KeyError:
        return
    targets = {}
    for r in rels:
        t = r.get('Target') or ''
        if 'comments' in t:
            targets['comments'] = 'xl/' + t.replace('../', '')
        elif t.endswith('.vml'):
            targets['vml'] = 'xl/' + t.replace('../', '')
    if 'comments' not in targets:
        return

    gone, moved = set(), 0
    root = xlsxns.parse(zin.read(targets['comments']))
    clist = root.find(Q('commentList'))
    if clist is not None:
        for c in list(clist):
            ref = c.get('ref') or ''
            m = CELL.match(ref)
            if not m:
                continue
            row = int(m.group(2))
            if row in dropped:
                gone.add(row)
                clist.remove(c)
                continue
            new = move(row)
            if new != row:
                c.set('ref', f'{m.group(1)}{new}')
                moved += 1
        blobs[targets['comments']] = xlsxns.tostring(root)

    # The VML half. Shapes carry a 0-based <x:Row> and an 8-number Anchor whose 3rd and 7th
    # entries are rows, also 0-based.
    if 'vml' in targets:
        try:
            raw = zin.read(targets['vml']).decode('utf-8', 'replace')
        except KeyError:
            raw = None
        if raw:
            out, pos = [], 0
            for m in re.finditer(r'<v:shape[ >\r\n].*?</v:shape>', raw, re.S):
                shape = m.group(0)
                rm = re.search(r'<x:Row>(\d+)</x:Row>', shape)
                if not rm:
                    continue
                row0 = int(rm.group(1))
                out.append((m.start(), m.end(), shape, row0 + 1))
            if out:
                buf, last = [], 0
                for a, b, shape, row in out:
                    buf.append(raw[last:a])
                    last = b
                    if row in dropped:
                        continue                      # shape for a comment that no longer exists
                    new = move(row)
                    if new != row:
                        shape = re.sub(r'<x:Row>\d+</x:Row>', f'<x:Row>{new - 1}</x:Row>', shape)
                        def anchor(mm):
                            parts = [x.strip() for x in mm.group(1).split(',')]
                            if len(parts) == 8:
                                for i in (2, 6):
                                    try:
                                        parts[i] = str(move(int(parts[i]) + 1) - 1)
                                    except ValueError:
                                        pass
                            return '<x:Anchor>' + ', '.join(parts) + '</x:Anchor>'
                        shape = re.sub(r'<x:Anchor>([^<]*)</x:Anchor>', anchor, shape)
                    buf.append(shape)
                buf.append(raw[last:])
                blobs[targets['vml']] = ''.join(buf).encode('utf-8')
    if gone or moved:
        notes.append(f'{sheet_name}: {moved} cell comments moved with their rows, '
                     f'{len(gone)} dropped with the rows they were attached to')


def build(canonical, register_csv, handover_csv, out_path):
    reg = list(csv.DictReader(open(register_csv, newline='', encoding='utf-8')))
    hand = list(csv.DictReader(open(handover_csv, newline='', encoding='utf-8'))) if os.path.exists(handover_csv) else []
    # The anchor in each block's first column: project number on the two register tabs, project name
    # on the handover watch, in the order the published data gives them.
    keys = {'Simulator': [r['project_number'] for r in reg if r.get('is_live') == '1'],
            'Projects': [r['project_number'] for r in reg],
            'Handover check': [r.get('project') or r.get('project_number') for r in hand]}
    # An issuer with nothing inside the handover window is a normal state, not a refusal: the watch
    # keeps one row that says so (Arada, 14 Sep 2026, once Jouri Hills carried a current reading).
    if not keys['Handover check']:
        keys['Handover check'] = ['no project inside the handover window at this register read']
    want = {k: len(v) for k, v in keys.items()}
    for s, n in want.items():
        if n < 1:
            print(f'REFUSED - the issuer has no rows for {s}; the model has nothing to show there')
            return 1

    zin = zipfile.ZipFile(canonical)
    paths = sheet_paths(zin)
    comment_blobs = {}
    notes = []
    roots = {name: xlsxns.parse(zin.read(p)) for name, p in paths.items()}
    for root in roots.values():
        expand_shared(root)
    moves = {}
    for sheet, (first, last) in BLOCKS.items():
        if sheet not in roots:
            print(f'REFUSED - {sheet} is not in the canonical model')
            return 1
        new_last, delta = resize_sheet(roots[sheet], first, last, want[sheet])
        mv = row_map(last, new_last, delta)
        moves[sheet] = (last, delta, first, new_last, mv)
        dropped = set(range(new_last + 1, last + 1)) if delta < 0 else set()
        fix_comments(zin, comment_blobs, paths[sheet], mv, dropped, notes, sheet)
        remap_f_refs(roots[sheet], row_map(last, new_last, delta))
        seed_anchors(roots[sheet], first, keys[sheet])

    # Repoint every formula on every sheet, plus this sheet's own extent markers.
    for name, root in roots.items():
        for c in root.iter(Q('c')):
            f = c.find(Q('f'))
            if f is None or not f.text:
                continue
            for sheet, (last, delta, _f, _n, mv) in moves.items():
                if delta and sheet != name:      # the sheet's own rows were repointed as they moved
                    f.text = remap_sheet(f.text, sheet, mv, ' ' in sheet)
        if name in moves:
            last, delta, first, new_last, mv = moves[name]
            for tag, attr in (('mergeCells', None), ('autoFilter', 'ref'), ('dimension', 'ref')):
                for el in root.iter(Q(tag)):
                    if tag == 'mergeCells':
                        for mc in el.findall(Q('mergeCell')):
                            mc.set('ref', bump_range(mc.get('ref'), mv))
                    elif el.get(attr):
                        el.set(attr, bump_range(el.get(attr), mv))

    wbroot = xlsxns.parse(zin.read('xl/workbook.xml'))
    dn = wbroot.find(Q('definedNames'))
    if dn is not None:
        for d in dn:
            if d.text:
                for sheet, (last, delta, _f, _n, mv) in moves.items():
                    if delta:
                        d.text = remap_sheet(d.text, sheet, mv, ' ' in sheet)

    blobs = dict(comment_blobs)
    for name, root in roots.items():
        blobs[paths[name]] = xlsxns.tostring(root)
    txt = xlsxns.tostring(wbroot).decode('utf-8')
    txt = re.sub(r'<calcPr[^/>]*/>', '<calcPr calcId="0" fullCalcOnLoad="1"/>', txt)
    if '<calcPr' not in txt:
        txt = txt.replace('</workbook>', '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>')
    blobs['xl/workbook.xml'] = txt.encode('utf-8')

    # The calculation chain lists every formula cell by address. After rows move it names cells that
    # are no longer there, and Excel offers to repair the file. Excel rebuilds the chain on open, so
    # the safe thing is to leave it out along with the two places that point at it.
    with zipfile.ZipFile(canonical) as src, zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            if item.filename == 'xl/calcChain.xml':
                continue
            blob = blobs.get(item.filename, src.read(item.filename))
            if item.filename == '[Content_Types].xml':
                blob = re.sub(rb'<Override[^>]*calcChain[^>]*/>', b'', blob)
            if item.filename == 'xl/_rels/workbook.xml.rels':
                blob = re.sub(rb'<Relationship[^>]*calcChain[^>]*/>', b'', blob)
            dst.writestr(item, blob)

    print(f'Built {out_path}')
    for n in notes:
        print('  ' + n)
    for sheet, (last, delta, first, new_last, _m) in moves.items():
        print(f'  {sheet:16} rows {first}-{new_last}  ({want[sheet]} rows, {delta:+d} vs the canonical model)')
    return 0


def bump_range(ref, move):
    def one(a):
        m = re.match(r'(\$?[A-Z]{1,3}\$?)(\d+)$', a)
        return a if not m else f'{m.group(1)}{move(int(m.group(2)))}'
    return ':'.join(one(p) for p in ref.split(':'))


if __name__ == '__main__':
    a = sys.argv[1:]
    sys.exit(build(a[0], a[1], a[2], a[3]))
