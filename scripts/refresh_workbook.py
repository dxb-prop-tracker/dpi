#!/usr/bin/env python3
"""Refresh an issuer credit workbook from the published register data, without opening Excel.

    python3 refresh_workbook.py <template.xlsx> <issuer-register.csv> <out.xlsx> [--meta meta.json]

Why it edits the XML directly rather than using openpyxl: the workbook carries charts and drawings,
and openpyxl silently drops those on a round-trip. This rewrites only the cells that hold register
data, leaving every formula, format, chart and sheet exactly as the modeller left them.

It is deliberately strict. Each row is matched to the register by the anchor in its first column -
project number on Simulator and Projects, project name on Handover check - and if an anchor is
missing from the register, or the number of live projects has changed, it refuses to write and says
why. A model whose rows have quietly slipped out of alignment is worse than one that is a day old.
"""
import csv, re, shutil, sys, zipfile, datetime as dt, json, os
import os
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xlsxns

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
ET.register_namespace('', NS)
Q = lambda t: f'{{{NS}}}{t}'
EPOCH = dt.date(1899, 12, 30)

# sheet -> (first data row, anchor column, {excel column: csv field})
# The block's last row is not written down: an issuer-sized model has as many project rows as that
# issuer has projects, so the extent is read from the sheet itself (see block_end).
LAYOUT = {
    'Simulator': (8, 'A', {'B': 'project', 'C': 'status_title', 'D': 'last_read', 'E': 'units',
                           'F': 'sold_units', 'G': 'avg_ticket_aed', 'H': 'certified_pct', 'I': 'registered_completion'}),
    'Projects': (5, 'A', {'B': 'project', 'C': 'area', 'D': 'status_title', 'E': 'certified_pct',
                          'F': 'registered_completion', 'G': 'first_seen_completion', 'H': 'last_read',
                          'I': 'units', 'J': 'offplan_sales_all', 'K': 'offplan_value_aed_m', 'L': 'all_sales',
                          'M': 'sales_12m', 'N': 'value_12m_aed_m', 'O': 'sales_prior_12m', 'P': 'sales_90d',
                          'Q': 'avg_psm_12m', 'R': 'mortgages_12m', 'S': 'resales_24m', 'T': 'resales_at_loss',
                          'U': 'avg_resale_change_pct', 'V': 'avg_hold_days', 'W': 'escrow_agent',
                          'X': 'first_sale', 'Y': 'last_sale', 'Z': 'project_start'}),
    'Handover check': (6, 'A', {'B': 'units', 'C': 'sold_units', 'D': 'contracted_aed_m', 'E': 'certified_pct',
                                'F': 'registered_completion', 'G': 'status', 'H': 'ready_sales_since_bs',
                                'I': 'mortgages_since_bs'}),
}

def serial(s):
    if not s: return None
    try: return (dt.date.fromisoformat(str(s)[:10]) - EPOCH).days
    except ValueError: return None

def num(s):
    if s in (None, ''): return None
    try: return float(s)
    except ValueError: return None

def load_register(path):
    with open(path, newline='', encoding='utf-8') as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        r['status_title'] = (r.get('status') or '').replace('_', ' ').title()
        for src, dst in (('offplan_value_aed', 'offplan_value_aed_m'), ('value_12m_aed', 'value_12m_aed_m')):
            v = num(r.get(src)); r[dst] = round(v / 1e6, 6) if v is not None else None
        sold, tick = num(r.get('sold_units')), num(r.get('avg_ticket_aed'))
        r['contracted_aed_m'] = round(sold * tick / 1e6) if sold and tick else 0
    return rows

DATE_FIELDS = {'last_read', 'registered_completion', 'first_seen_completion', 'first_sale', 'last_sale', 'project_start'}
TEXT_FIELDS = {'project', 'area', 'status', 'status_title', 'escrow_agent'}

def shared_strings(zf):
    try: root = xlsxns.parse(zf.read('xl/sharedStrings.xml'))
    except KeyError: return []
    return [''.join(t.text or '' for t in si.iter(Q('t'))) for si in root.findall(Q('si'))]

def sheet_paths(zf):
    """Map sheet name -> path of its XML inside the archive."""
    wb = xlsxns.parse(zf.read('xl/workbook.xml'))
    rels = xlsxns.parse(zf.read('xl/_rels/workbook.xml.rels'))
    rid = {r.get('Id'): r.get('Target') for r in rels}
    out = {}
    for sh in wb.find(Q('sheets')):
        t = rid[sh.get(f'{{{RNS}}}id')]
        out[sh.get('name')] = 'xl/' + t.lstrip('/').replace('worksheets/', 'worksheets/', 1) if not t.startswith('xl/') else t
    return out

def anchor_text(row_el, ref, sst):
    """The key in a row's first column, whether it is inline, a number, or a shared string."""
    a = cell_of(row_el, ref)
    if a is None:
        return None
    v, is_el = a.find(Q('v')), a.find(Q('is'))
    if a.get('t') == 's' and v is not None and v.text:
        i = int(v.text)
        return sst[i].strip() if i < len(sst) else None
    if v is not None and v.text:
        return v.text.strip()
    if is_el is not None:
        return ''.join(t.text or '' for t in is_el.iter(Q('t'))).strip()
    return None


def block_end(data, first_row, anchor_col, sst):
    """Walk down from the first data row while the anchor column still names a project.

    The block ends at the first empty anchor or at a total line, which is how a 22-project model and
    a 68-project model can be refreshed by the same code without either being told its own size.
    """
    rows = {int(r.get('r')): r for r in data.findall(Q('row'))}
    last = first_row - 1
    r = first_row
    while r in rows:
        key = anchor_text(rows[r], f'{anchor_col}{r}', sst)
        if not key or key.lower().startswith('total'):
            break
        last = r
        r += 1
    return last


def cell_of(row_el, ref):
    for c in row_el.findall(Q('c')):
        if c.get('r') == ref: return c
    return None

def set_cell(c, value, is_text):
    """Write a value into an existing cell, keeping its style and dropping any stale cached result."""
    for child in list(c): c.remove(child)
    c.attrib.pop('t', None)
    if value is None or value == '':
        return
    if is_text:
        c.set('t', 'inlineStr')
        is_el = ET.SubElement(c, Q('is')); t_el = ET.SubElement(is_el, Q('t'))
        t_el.text = str(value)
        t_el.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    else:
        v = ET.SubElement(c, Q('v')); v.text = repr(float(value)) if isinstance(value, float) else str(value)

def refresh(template, csv_path, out_path, meta_path=None, force=False):
    reg = load_register(csv_path)
    by_number = {r['project_number']: r for r in reg}
    by_name = {r['project']: r for r in reg}
    live = [r for r in reg if r.get('is_live') == '1']
    meta = json.load(open(meta_path)) if meta_path and os.path.exists(meta_path) else {}

    shutil.copyfile(template, out_path)
    zin = zipfile.ZipFile(template)
    paths = sheet_paths(zin)
    problems, notes, changed, touched = [], [], 0, {}

    sst = shared_strings(zin)
    for sheet, (first_row, anchor_col, mapping) in LAYOUT.items():
        if sheet not in paths:
            problems.append(f'{sheet}: sheet not found in the workbook'); continue
        root = xlsxns.parse(zin.read(paths[sheet]))
        data = root.find(Q('sheetData'))
        last_row = block_end(data, first_row, anchor_col, sst)
        if last_row < first_row:
            problems.append(f'{sheet}: no data rows found under row {first_row}'); continue
        n_rows = 0
        for row_el in data.findall(Q('row')):
            r = int(row_el.get('r'))
            if r < first_row or r > last_row: continue
            a = cell_of(row_el, f'{anchor_col}{r}')
            if a is None: continue
            key = None
            v = a.find(Q('v')); is_el = a.find(Q('is'))
            if a.get('t') == 's' and v is not None and v.text:          # shared-string reference
                idx = int(v.text)
                key = sst[idx].strip() if idx < len(sst) else None
            elif v is not None and v.text: key = v.text.strip()
            elif is_el is not None: key = ''.join(t.text or '' for t in is_el.iter(Q('t'))).strip()
            if not key: continue
            rec = by_number.get(key) or by_name.get(key)
            if rec is None:                      # tolerate a shortened project name, but only if it is unambiguous
                near = [x for x in reg if x['project'].startswith(key)]
                if len(near) == 1:
                    rec = near[0]
                    notes.append(f'{sheet} row {r}: matched "{key}" to "{rec["project"]}"')
            if rec is None:
                if key not in ('Total', 'Total, all live projects'):
                    problems.append(f'{sheet} row {r}: "{key}" is no longer in the register')
                continue
            n_rows += 1
            for col, field in mapping.items():
                c = cell_of(row_el, f'{col}{r}')
                if c is None: continue
                if c.find(Q('f')) is not None: continue      # never overwrite a formula
                raw = rec.get(field)
                if field in DATE_FIELDS: set_cell(c, serial(raw), False)
                elif field in TEXT_FIELDS: set_cell(c, raw or '', True)
                else: set_cell(c, num(raw) if not isinstance(raw, (int, float)) else raw, False)
                changed += 1
        touched[sheet] = n_rows
        touched[sheet + '_xml'] = xlsxns.tostring(root)

    sim_rows = touched.get('Simulator', 0)
    if sim_rows != len(live):
        problems.append(f'the register now has {len(live)} live projects but the Simulator models {sim_rows} '
                        f'- rebuild the issuer model from the canonical template (scripts/issuer_model.py) '
                        f'so the block is resized before the data is written')
    if problems and not force:
        print('REFUSED - nothing written:'); [print('  ' + p) for p in problems]
        for n in notes: print('  note: ' + n)
        os.remove(out_path); return 1

    # rewrite the archive with the edited sheets, and make Excel recalculate everything on open
    with zipfile.ZipFile(template) as src, zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            blob = src.read(item.filename)
            for sheet in LAYOUT:
                if sheet in paths and item.filename == paths[sheet] and (sheet + '_xml') in touched:
                    blob = touched[sheet + '_xml']
            if item.filename == 'xl/workbook.xml':
                txt = blob.decode('utf-8')
                txt = re.sub(r'<calcPr[^/>]*/>', '<calcPr calcId="0" fullCalcOnLoad="1"/>', txt)
                if '<calcPr' not in txt: txt = txt.replace('</workbook>', '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>')
                blob = txt.encode('utf-8')
            dst.writestr(item, blob)

    print(f'Refreshed {out_path}')
    print(f'  {changed:,} cells updated across ' + ', '.join(f'{k} ({v} rows)' for k, v in touched.items() if not k.endswith('_xml')))
    if meta: print(f"  register read {meta.get('registerLastRead')}, transactions to {meta.get('transactionsLastRead')}, "
                   f"{meta.get('liveProjects')} live projects, AED {meta.get('liveContractedAedM'):,} m contracted")
    for n in notes: print('  note: ' + n)
    for p in problems: print('  WARNING: ' + p)
    return 0

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    mp = None
    if '--meta' in sys.argv: mp = sys.argv[sys.argv.index('--meta') + 1]
    sys.exit(refresh(args[0], args[1], args[2], mp, force='--force' in sys.argv))
