#!/usr/bin/env python3
"""Write an issuer's own debt, bond prices and accounts into a model cut from the canonical one.

    python3 issuer_inputs.py <sized-model.xlsx> <data/issuers/<id>.json> <out.xlsx>

scripts/issuer_model.py gives an issuer the right number of project rows. This gives it the right
numbers everywhere else: the instruments it has actually issued, at the prices they trade, and the
accounts it has actually published - so that nothing of the issuer the model was cut from survives
into it.

It is strict about what it will guess. A coupon and a maturity are taken only from an instrument's
own name ("8.125% sukuk due 8 Jun 2027"); where a name does not carry them the row is still written
to the debt schedule but is left out of the priced bond table, and the omission is reported. A
covenant threshold is never invented: where the issuer file does not state one the cell is cleared
rather than left showing the previous issuer's test, which would be the most dangerous kind of
error this tool could make.
"""
import datetime as dt
import json
import re
import shutil
import sys
import zipfile
import os
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xlsxns
import issuer_horizons

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
ET.register_namespace('', NS)
Q = lambda t: f'{{{NS}}}{t}'
EPOCH = dt.date(1899, 12, 30)
AED_PER_USD = 3.6725

DEBT_ROWS = (6, 13)        # instrument rows on the Debt schedule
BOND_ROWS = (7, 10)        # priced instruments on the Bonds tab
FIN_COLS = ('B', 'C', 'D')  # the three reporting periods on Financials
FIN_LINES = {              # Financials row -> field in the issuer file
    5: 'revenue', 6: 'grossProfit', 7: 'ebitda', 8: 'netProfit', 9: 'totalAssets',
    10: 'cash', 11: 'escrow', 12: 'debt', 13: 'equity', 14: 'contractLiabilities',
    15: 'backlog', 16: 'sales', 17: 'cfo', 18: 'financeCost',
}

MONTHS = {m: i + 1 for i, m in enumerate(
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])}


def parse_instrument(b):
    """Coupon, maturity and kind, taken only from what the instrument's own name says."""
    name = b.get('name') or ''
    cp = re.search(r'(\d+(?:\.\d+)?)\s*%', name)
    md = re.search(r'due\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})', name)
    maturity = None
    if md:
        mon = MONTHS.get(md.group(2).lower())
        if mon:
            try:
                maturity = dt.date(int(md.group(3)), mon, int(md.group(1)))
            except ValueError:
                maturity = None
    low = name.lower()
    kind = 'Sukuk' if ('sukuk' in low or 'bond' in low or 'note' in low) else 'Bank'
    if 'payable' in low or 'land' in low:
        kind = 'Other'
    bid = ask = None
    m = re.match(r'\s*([\d.]+)\s*/\s*([\d.]+)', str(b.get('price') or ''))
    if m:
        bid, ask = float(m.group(1)), float(m.group(2))
    return {'name': name, 'isin': b.get('isin') or '', 'kind': kind,
            'usd': b.get('sizeUsdM'), 'coupon': float(cp.group(1)) / 100 if cp else None,
            'maturity': maturity, 'issued': b.get('issued') or '', 'listing': b.get('listing') or '—',
            'bid': bid, 'ask': ask, 'note': b.get('note') or '', 'ytm': b.get('ytm') or ''}


URL = re.compile(r'https?://[^\s")]+')


def retext(zin, blobs, roots, paths, canon, brand, notes, problems):
    """Replace the canonical issuer's name with this one's, and refuse to carry its words.

    Most of the workbook's prose is generic once the name is swapped - "Every X project on the DLD
    register" is true of any issuer. Two kinds of text are not: a link to the canonical issuer's
    investor-relations site, and a sentence written about something only that issuer did. Both are
    cleared rather than renamed, and each one is listed so it can be written properly. A workbook
    that quietly told a subscriber about the wrong company's bond claim would be worse than one with
    a gap in it.
    """
    def is_foreign(text):
        low = text.lower()
        if any(canon.lower() in u.lower() for u in URL.findall(text)):
            return True
        return len(text) > 110 and canon.lower() in low

    # Shared strings carry most of the prose.
    try:
        sst = xlsxns.parse(zin.read('xl/sharedStrings.xml'))
    except KeyError:
        sst = None
    foreign = set()
    if sst is not None:
        for i, si in enumerate(sst.findall(Q('si'))):
            whole = ''.join(t.text or '' for t in si.iter(Q('t')))
            if canon.lower() not in whole.lower():
                continue
            if is_foreign(whole):
                foreign.add(i)
                continue
            for t in si.iter(Q('t')):
                if t.text:
                    t.text = t.text.replace(canon, brand)
        blobs['xl/sharedStrings.xml'] = xlsxns.tostring(sst)

    for name, root in roots.items():
        for c in root.iter(Q('c')):
            # inline text
            is_el = c.find(Q('is'))
            if is_el is not None:
                whole = ''.join(t.text or '' for t in is_el.iter(Q('t')))
                if canon.lower() in whole.lower():
                    if is_foreign(whole):
                        for ch in list(c):
                            c.remove(ch)
                        c.attrib.pop('t', None)
                        notes.append(f'{name}!{c.get("r")}: cleared - written about {canon}')
                        continue
                    for t in is_el.iter(Q('t')):
                        if t.text:
                            t.text = t.text.replace(canon, brand)
            # a shared-string cell pointing at prose we would not carry over
            v = c.find(Q('v'))
            if c.get('t') == 's' and v is not None and v.text and int(v.text) in foreign:
                for ch in list(c):
                    c.remove(ch)
                c.attrib.pop('t', None)
                notes.append(f'{name}!{c.get("r")}: cleared - written about {canon}')
            # formulas carry text too (HYPERLINK, string literals)
            f = c.find(Q('f'))
            if f is not None and f.text and canon.lower() in f.text.lower():
                if is_foreign(f.text):
                    for ch in list(c):
                        c.remove(ch)
                    c.attrib.pop('t', None)
                    notes.append(f'{name}!{c.get("r")}: cleared - {canon} link or wording')
                else:
                    f.text = f.text.replace(canon, brand)


def sheet_paths(zf):
    wb = xlsxns.parse(zf.read('xl/workbook.xml'))
    rels = {r.get('Id'): r.get('Target') for r in xlsxns.parse(zf.read('xl/_rels/workbook.xml.rels'))}
    out = {}
    for sh in wb.find(Q('sheets')):
        t = rels[sh.get(f'{{{RNS}}}id')]
        out[sh.get('name')] = t if t.startswith('xl/') else 'xl/' + t.lstrip('/')
    return out


def cells(root):
    return {c.get('r'): c for c in root.iter(Q('c'))}


def put(cmap, ref, value, kind='n'):
    """Write a value into an existing cell, keeping its formatting. Formula cells are never touched."""
    c = cmap.get(ref)
    if c is None or c.find(Q('f')) is not None:
        return False
    for ch in list(c):
        c.remove(ch)
    c.attrib.pop('t', None)
    if value is None or value == '':
        return True
    if kind == 's':
        c.set('t', 'inlineStr')
        is_el = ET.SubElement(c, Q('is'))
        t = ET.SubElement(is_el, Q('t'))
        t.text = str(value)
        t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    else:
        v = ET.SubElement(c, Q('v'))
        v.text = str((value - EPOCH).days) if isinstance(value, dt.date) else repr(float(value))
    return True


def clear_row(root, row, first_col, last_col):
    """Empty a whole row, formulas included - an unused instrument line must compute nothing."""
    letters = []
    a = ord(first_col)
    while a <= ord(last_col):
        letters.append(chr(a))
        a += 1
    cmap = cells(root)
    for col in letters:
        c = cmap.get(f'{col}{row}')
        if c is None:
            continue
        for ch in list(c):
            c.remove(ch)
        c.attrib.pop('t', None)


def set_formula(cmap, ref, text):
    """Replace a cell's formula and drop its stored result. Used only where the canonical model's
    Cash flow sheet assumes Binghatti's debt shape (four sukuk in rows 32-35, eight dated lines)."""
    c = cmap.get(ref)
    if c is None:
        return False
    for ch in list(c):
        c.remove(ch)
    c.attrib.pop('t', None)
    f = ET.SubElement(c, Q('f'))
    f.text = text
    return True


def set_borrowing_cost(root, iss, notes):
    """D30 — the implied bank rate is built from BORROWING cost, not total finance cost.

    Cash flow B45 read Financials!D22, the reported finance cost. On an issuer whose finance cost
    covers more than the debt in the schedule — lease liabilities, joint ventures, capitalised
    interest, shareholder and related-party balances — the whole residual landed on the bank line
    and the implied rate stopped meaning anything: Emaar read 22.89% where its own note says the
    answer is 7.60%. Every issuer breaks the borrowing lines out of the note (Emaar 50% of reported
    finance cost, Arada 69%, DAMAC ~79%, Sobha 87%, Binghatti 92%), so the numerator is those lines
    and the sheet says what was left out. Where an issuer gave no split the reported figure stands
    and the note says so — there is no such issuer today.
    """
    fc = iss.get('financeCostOnBorrowings')
    cm = cells(root)
    if not fc or not fc.get('aedM'):
        put(cm, 'C45', 'This issuer\'s finance-cost note gives no split between borrowing cost and other '
                       'finance cost, so the reported total stands and the implied rate below is an '
                       'upper bound on the bank cost, not a measurement of it.', 's')
        notes.append('Cash flow B45: no borrowing-cost split on file — reported finance cost stands')
        return
    months = fc.get('periodMonths') or 12
    annual = float(fc['aedM']) * (12.0 / months)
    put(cm, 'A45', f"Finance cost on borrowings ({fc.get('periodEnd','')}, annualised)", 's')
    # B45 carried a formula (Financials!$D$22, the REPORTED total) and put() will not touch a
    # formula cell — the first attempt at this silently changed nothing. Drop the formula, then
    # write the figure, so the cell holds the borrowing-cost number and not a pointer to the
    # reported one. The reported total stays on the Financials sheet, where it belongs.
    c45 = cm.get('B45')
    if c45 is not None:
        for ch in list(c45):
            c45.remove(ch)
        c45.attrib.pop('t', None)
    put(cm, 'B45', round(annual, 3))
    put(cm, 'C45', f"D30. Reported finance cost for the period was AED {fc['reportedTotalAedM']:,.1f}m, of which "
                   f"AED {fc['aedM']:,.1f}m ({fc['sharePct']}%) is the borrowing cost this rate is built from. "
                   f"Excluded: {fc['excluded']}. Charging the whole reported figure to the bank line put "
                   f"Emaar at 22.9% and Arada at 17.6% against a quoted 6.58%.", 's')
    notes.append(f"Cash flow B45: borrowing cost AED {annual:,.1f}m annualised "
                 f"({fc['sharePct']}% of reported) — D30")


def generalise_cash_flow(root, notes):
    """The canonical Cash flow sheet is written for Binghatti's debt: rows 32-35 are its four sukuk
    and every one of the eight Debt rows carries a maturity. An issuer with three sukuk puts a
    bank line in row 35, and a bank line with no stated maturity puts a blank date into a month
    index. Both broke the derived workbooks (14 Sep 2026: every Dashboard and Cover figure on
    Sobha and Arada read #VALUE!): the sukuk-profit line summed a column that, through the bank
    rate, depended on itself, and the maturity table looked up month -1521.
    Three changes, each a no-op on the canonical shape:
      B46  reads coupons from the Debt sheet directly (blank for bank lines), over all eight rows;
      G32:G39  a line with no maturity date has no month index ("") — it pays interest to the
               horizon and never a principal;
      E94:G101  a line with no month index shows no cash test, and the totals ignore it."""
    cm = cells(root)
    set_formula(cm, 'B46', '-SUMPRODUCT(($B$32:$B$39="Sukuk")*$C$32:$C$39*Debt!$F$6:$F$13)')
    for i, r in enumerate(range(32, 40)):
        # The grid runs from month 1. A maturity inside the as-of month itself indexes to 0 and the
        # MATCH in the cash test (E94:G101) then found nothing: Emaar's 3.64% sukuk matures 15 Sep
        # 2026 against an as-of of 14 Sep 2026, and every cash test, the Dashboard headline and the
        # Break-even grid read #N/A. A maturity already inside the first grid month is tested in it.
        set_formula(cm, f'G{r}', f'IF(Debt!H{6 + i}="","",MAX(1,(YEAR(E{r})-YEAR($B$18))*12+MONTH(E{r})-MONTH($B$18)))')
    for r in range(94, 102):
        set_formula(cm, f'E{r}', f'IF($D{r}="","",INDEX($C$71:$BN$71,1,MATCH($D{r},$C$57:$BN$57,0))+INDEX($C$68:$BN$68,1,MATCH($D{r},$C$57:$BN$57,0)))')
        set_formula(cm, f'F{r}', f'IF(OR($E{r}="",$C{r}<=0),"",$E{r}/$C{r})')
        set_formula(cm, f'G{r}', f'IF($E{r}="","",MAX(0,$C{r}-$E{r}))')
    # B49 is the implied bank rate: interest paid / bank debt outstanding. An issuer whose schedule
    # carries no bank line (or a bank line with no size) divides nothing by nothing, so B49 reads ""
    # and B51 handed that empty string to every dated line's rate (D35), turning the whole sheet to
    # #VALUE!. Where there is no bank debt to imply a rate from, the quoted rate stands.
    set_formula(cm, 'B51', 'IF($B$22="Implied",IF($B$49="",$B$50,$B$49),$B$50)')
    # The implied rate is a residual and runs away where the reported finance cost covers more than
    # the debt listed here: Emaar 22.9% and Arada 17.6% against a quoted 6.58%. The arithmetic is
    # left alone — it overstates the outflow, which understates headroom — but the sheet says so.
    set_formula(cm, 'C51', issuer_horizons.IMPLIED_RATE_NOTE)
    notes.append('Cash flow: sukuk profit read from Debt!F6:F13; lines without a maturity date carry no '
                 'month index and no cash test (they pay interest to the horizon, never a principal); '
                 'the implied bank rate falls back to the quoted rate where there is no bank debt')


def guard_headroom(roots, notes):
    """The headroom measure (Dashboard section 1, the Break-even grid, Cash flow B117) is written on
    Binghatti's dates — 28 Feb 2027, 31 Dec 2027, 31 Dec 2028 — and divides by the debt due by
    each. An issuer with nothing due by 28 Feb 2027 (Sobha's first maturity is July 2028) divided by
    zero and every cell that read the grid showed #DIV/0!. Until the horizons are set per issuer
    (backlog), the grid reads blank where there is no debt to measure against, and the sheet says so."""
    be = roots.get('Break-even')
    if be is not None:
        n = 0
        for c in be.iter(Q('c')):
            f = c.find(Q('f'))
            if f is not None and f.text and '($B$28+_xlpm.rel)/$B$29)' in f.text:
                f.text = f.text.replace('($B$28+_xlpm.rel)/$B$29)', 'IF($B$29>0,($B$28+_xlpm.rel)/$B$29,""))')
                for v in c.findall(Q('v')):
                    c.remove(v)
                n += 1
        cm = cells(be)
        set_formula(cm, 'B10', 'IF($B$29>0,$C$36,"")')
        set_formula(cm, 'B49', 'IF(OR($C$36="",Dashboard!$F$17=""),"",$C$36-Dashboard!$F$17)')
        put(cm, 'A3', 'This grid measures headroom against the debt due by the first horizon named in row 10 — '
                      "this issuer's own first maturity, not a date carried over from the model it was cut "
                      'from. Where there is no debt due by then the grid is blank; the cash test on the Cash '
                      'flow sheet (section 6) is measured at each of its own maturities.', 's')
        notes.append(f'Break-even: {n} grid cells guarded against a zero debt-due denominator')
    dash = roots.get('Dashboard')
    if dash is not None:
        # the largest-projects list asks for the k-th largest of a block that may hold fewer than k
        # rows (Arada: five projects); a missing rank reads blank, not #NUM!
        n = 0
        for c in dash.iter(Q('c')):
            f = c.find(Q('f'))
            if f is not None and f.text and 'LARGE(Simulator!' in f.text and not f.text.startswith('IFERROR('):
                f.text = 'IFERROR(' + f.text + ',"")'
                for v in c.findall(Q('v')):
                    c.remove(v)
                n += 1
        if n:
            notes.append(f'Dashboard: {n} largest-project cells read blank past the issuer\'s project count')
    cf = roots.get('Cash flow')
    if cf is not None:
        set_formula(cells(cf), 'B117', 'IF(OR(Dashboard!$F$17="",\'Break-even\'!$C$36=""),"",Dashboard!$F$17-\'Break-even\'!$C$36)')


def apply(model, issuer_json, out_path, canon='Binghatti'):
    iss = json.load(open(issuer_json))
    items = [parse_instrument(b) for b in iss.get('bonds', [])]
    notes, problems = [], []

    zin = zipfile.ZipFile(model)
    paths = sheet_paths(zin)
    roots = {n: xlsxns.parse(zin.read(p)) for n, p in paths.items()}

    # ---- Debt: every instrument the issuer has ----
    lo, hi = DEBT_ROWS
    if len(items) > hi - lo + 1:
        problems.append(f'{len(items)} instruments but the debt schedule holds {hi - lo + 1} rows')
    root = roots['Debt']
    cm = cells(root)
    put(cm, 'B3', AED_PER_USD)
    for i, it in enumerate(items[:hi - lo + 1]):
        r = lo + i
        put(cm, f'A{r}', it['name'], 's')
        put(cm, f'B{r}', it['isin'], 's')
        put(cm, f'C{r}', it['kind'], 's')
        put(cm, f'D{r}', it['usd'])
        put(cm, f'F{r}', it['coupon'])
        put(cm, f'G{r}', it['issued'], 's')
        put(cm, f'H{r}', it['maturity'])
        put(cm, f'I{r}', it['listing'], 's')
        put(cm, f'K{r}', it['note'], 's')
        if it['maturity'] is None:
            notes.append(f"Debt row {r}: \"{it['name']}\" carries no maturity date in the issuer file, "
                         f'so it is in the schedule but not in the maturity wall')
    for r in range(lo + len(items), hi + 1):
        clear_row(root, r, 'A', 'K')

    # ---- Bonds: only instruments that can actually be priced ----
    priced = [it for it in items if it['coupon'] and it['maturity'] and it['bid']]
    lo, hi = BOND_ROWS
    root = roots['Bonds']
    cm = cells(root)
    put(cm, 'B3', dt.date.today())
    for i, it in enumerate(priced[:hi - lo + 1]):
        r = lo + i
        put(cm, f'A{r}', it['name'], 's')
        put(cm, f'B{r}', it['isin'], 's')
        put(cm, f'C{r}', it['coupon'])
        put(cm, f'D{r}', it['maturity'])
        put(cm, f'E{r}', it['bid'])
        put(cm, f'F{r}', it['ask'])
        put(cm, f'L{r}', f"Indicative, from the issuer file ({iss.get('asOf', '')})", 's')
    for r in range(lo + len(priced), hi + 1):
        clear_row(root, r, 'A', 'L')
    if len(priced) > hi - lo + 1:
        problems.append(f'{len(priced)} priced instruments but the Bonds tab holds {hi - lo + 1} rows')

    # ---- Financials: the issuer's own reported periods ----
    periods = iss.get('periods', [])[-len(FIN_COLS):]
    if len(periods) < len(FIN_COLS):
        problems.append(f'the issuer file has {len(periods)} reporting periods; the model expects {len(FIN_COLS)}')
    root = roots['Financials']
    cm = cells(root)
    for col, per in zip(FIN_COLS, periods):
        put(cm, f'{col}4', per.get('label'), 's')
        for row, field in FIN_LINES.items():
            put(cm, f'{col}{row}', per.get(field))
    put(cm, 'A2', iss.get('latestFinancials', ''), 's')
    # Debt due within 12 months is a disclosure, not something the model can derive.
    put(cm, f'{FIN_COLS[-1]}20', None)
    notes.append('Financials row 20 (debt due within 12 months) left blank — it is a disclosure, '
                 'not derivable; fill it from the accounts to make the liquidity ratio compute')

    # ---- Covenants: never inherited ----
    root = roots['Debt']
    cm = cells(root)
    for r in (29, 30, 31, 32):
        put(cm, f'B{r}', None)
        put(cm, f'E{r}', None)
        put(cm, f'F{r}', None)
    notes.append('Debt covenant thresholds cleared rather than inherited — enter this issuer\'s own '
                 'tests in Debt!B29:B32')
    put(cm, 'A15', f"Accounts: {iss.get('latestFinancials', '')}", 's')

    # ---- Ratings, filings and links: rebuilt from the issuer file, not inherited ----
    if 'Ratings & sources' in roots:
        root = roots['Ratings & sources']
        cm = cells(root)
        hist = iss.get('ratingsHistory', [])
        for i in range(4):                        # rows 5-8
            r = 5 + i
            h = hist[i] if i < len(hist) else None
            put(cm, f'A{r}', (h or {}).get('date', ''), 's')
            put(cm, f'B{r}', (h or {}).get('agency', ''), 's')
            put(cm, f'C{r}', (h or {}).get('action', ''), 's')
            put(cm, f'D{r}', (h or {}).get('why', ''), 's')
        if len(hist) > 4:
            notes.append(f'{len(hist)} rating actions on file; the tab shows the four most recent')
        put(cm, 'A10', 'Current: ' + (iss.get('header', {}).get('ratings') or ''), 's')

        srcs = iss.get('sources', [])
        for i in range(9):                        # rows 13-21
            r = 13 + i
            src = srcs[i] if i < len(srcs) else None
            put(cm, f'A{r}', (src or {}).get('date', ''), 's')
            cell = cm.get(f'B{r}')
            if cell is not None:
                for ch in list(cell):
                    cell.remove(ch)
                cell.attrib.pop('t', None)
                if src and src.get('url'):
                    f = ET.SubElement(cell, Q('f'))
                    ttl = str(src.get('title', '')).replace('"', "'")
                    f.text = f'HYPERLINK("{src["url"]}","{ttl}")'
        if len(srcs) > 9:
            notes.append(f'{len(srcs)} sources on file; the tab holds nine — the rest are on the website')

        brand_q = (iss.get('brand') or '').replace('"', '')
        for r, url in ((25, f'https://www.moodys.com/search?keyword={brand_q}'),
                       (26, f'https://www.fitchratings.com/search/?query={brand_q}')):
            cell = cm.get(f'B{r}')
            if cell is not None:
                for ch in list(cell):
                    cell.remove(ch)
                cell.attrib.pop('t', None)
                f = ET.SubElement(cell, Q('f'))
                f.text = f'HYPERLINK("{url}","{url}")'
        for i, g in enumerate(iss.get('gaps', [])[:6]):     # rows 33-38
            put(cm, f'A{33 + i}', '•  ' + str(g), 's')
        for r in range(33 + len(iss.get('gaps', [])[:6]), 39):
            put(cm, f'A{r}', None)

    # ---- Cash flow: the canonical sheet assumes Binghatti's debt shape ----
    if 'Cash flow' in roots:
        generalise_cash_flow(roots['Cash flow'], notes)
        set_borrowing_cost(roots['Cash flow'], iss, notes)   # D30 — after, so C45 is not overwritten
    guard_headroom(roots, notes)
    issuer_horizons.add_new_project_finance(roots, notes, cells, put, set_formula)

    # ---- Cover ----
    if 'Cover' in roots:
        cmc = cells(roots['Cover'])
        for ref, val in (('A1', f"{iss.get('brand', '')} — credit model"),
                         ('A2', iss.get('legalName', ''))):
            put(cmc, ref, val, 's')

    blobs = {}
    retext(zin, blobs, roots, paths, canon, iss.get('brand') or canon, notes, problems)

    # B37 — the headroom measure runs on THIS issuer's maturities, not the canonical issuer's.
    # After retext(), so the prose it rewrites is the prose this one sees.
    bs = iss.get('balanceSheetDate')
    issuer_horizons.set_horizons(
        zin, blobs, roots, items,
        dt.date.fromisoformat(iss['asOf']) if iss.get('asOf') else dt.date.today(),
        dt.date.fromisoformat(bs) if bs else None, notes, xlsxns, cells, put)
    issuer_horizons.clear_canon_facts(zin, blobs, roots, items, notes, xlsxns)

    if problems:
        print('REFUSED - nothing written:')
        for p in problems:
            print('  ' + p)
        return 1

    shutil.copyfile(model, out_path)
    for n, r in roots.items():
        blobs[paths[n]] = xlsxns.tostring(r)
    with zipfile.ZipFile(model) as src, zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            if item.filename == 'xl/calcChain.xml':
                continue
            blob = blobs.get(item.filename, src.read(item.filename))
            if item.filename == '[Content_Types].xml':
                blob = re.sub(rb'<Override[^>]*calcChain[^>]*/>', b'', blob)
            if item.filename == 'xl/_rels/workbook.xml.rels':
                blob = re.sub(rb'<Relationship[^>]*calcChain[^>]*/>', b'', blob)
            dst.writestr(item, blob)

    print(f'Issuer inputs written to {out_path}')
    print(f'  {len(items)} instruments on the debt schedule, {len(priced)} of them priced, '
          f'{len(periods)} reporting periods')
    for n in notes:
        print('  note: ' + n)
    return 0


if __name__ == '__main__':
    a = [x for x in sys.argv[1:] if not x.startswith('--')]
    canon = sys.argv[sys.argv.index('--from') + 1] if '--from' in sys.argv else 'Binghatti'
    sys.exit(apply(a[0], a[1], a[2], canon))
