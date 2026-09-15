#!/usr/bin/env python3
"""B37 — the headroom horizons, per issuer, and the new-project-finance input.

The canonical model was written for Binghatti, whose first sukuk matures 28 February 2027. Those
three dates — 28 Feb 2027, 31 Dec 2027, 31 Dec 2028 — are baked into the Dashboard's debt-due sums,
the Break-even grid, the Cash flow cash test and every label that names them. On any other issuer
they measure headroom against a date that issuer has no debt on: Sobha's first maturity is July
2028, so the February 2027 grid divided by a zero denominator and read #DIV/0! everywhere.
`guard_headroom()` stopped the error showing. It did not make the measure right. This does.

Called from scripts/issuer_inputs.py. Nothing here writes a figure: it rewrites dates and the words
that name them, and adds one input that defaults to zero.
"""
import datetime as dt
import re
import xml.etree.ElementTree as ET

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
Q = lambda t: f'{{{NS}}}{t}'

#: the canonical issuer's three horizons, and twelve months from its accounts date
CANON_H = (dt.date(2027, 2, 28), dt.date(2027, 12, 31), dt.date(2028, 12, 31))
CANON_BS = dt.date(2026, 6, 30)
CANON_12M = dt.date(2027, 6, 30)

MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December']


def horizons_for(items, asof):
    """The three dates the headroom measure runs on, from the issuer's OWN instruments.

    h1 is the first instrument to mature on or after the register read — the date a credit desk is
    actually watching. h2 and h3 are the two year-ends after it, which is exactly what the canonical
    model does for Binghatti (28 Feb 2027, then 31 Dec 2027 and 31 Dec 2028) and therefore leaves
    that workbook byte-for-byte unchanged.
    """
    dated = sorted(i['maturity'] for i in items if i.get('maturity') and i['maturity'] >= asof)
    if not dated:
        return None
    h1 = dated[0]
    h2 = dt.date(h1.year, 12, 31)
    if h2 <= h1:
        h2 = dt.date(h1.year + 1, 12, 31)
    return h1, h2, dt.date(h2.year + 1, 12, 31)


def word(d, fmt):
    """The workbook's own date wordings, so a replacement reads like the text it replaces."""
    m = MONTHS[d.month - 1]
    return {'full': f'{d.day} {m} {d.year}',           # 28 February 2027
            'long': f'{d.day} {m[:3]} {d.year}',       # 28 Feb 2027
            'MONTH': f'{m.upper()} {d.year}',          # FEBRUARY 2027
            'month': f'{m} {d.year}',                  # February 2027
            'short': f'{m[:3]} {d.year}',              # Feb 2027
            'tiny': f'{m[:3]}-{str(d.year)[2:]}',      # Feb-27
            'year': str(d.year)}[fmt]


def _plan(hz, bs_date):
    """(formula DATE() swaps, prose swaps longest-first, the twelve-month date)."""
    dates = {f'DATE({a.year},{a.month},{a.day})': f'DATE({b.year},{b.month},{b.day})'
             for a, b in zip(CANON_H, hz) if a != b}
    twelve = None
    if bs_date is not None:
        twelve = dt.date(bs_date.year + 1, bs_date.month, bs_date.day)
        if twelve != CANON_12M:
            dates[f'DATE({CANON_12M.year},{CANON_12M.month},{CANON_12M.day})'] = \
                f'DATE({twelve.year},{twelve.month},{twelve.day})'
    text = []
    # 'full' first and longest: the workbook writes "the 28 February 2027 maturity" in places, and
    # a rule that only knew "February 2027" rewrote the month and left the canonical DAY in front
    # of it — Emaar's Break-even sheet read "the 28 September 2026 maturity" for a 15 September one.
    for fmt in ('full', 'long', 'MONTH', 'month', 'short', 'tiny'):
        for a, b in zip(CANON_H, hz):
            if word(a, fmt) != word(b, fmt):
                text.append((word(a, fmt), word(b, fmt)))
    if twelve is not None and twelve != CANON_12M:
        text.append((word(CANON_12M, 'long'), word(twelve, 'long')))
    for a, b in zip(CANON_H[1:], hz[1:]):              # "the 2027 handovers", "end 2027"
        if a.year != b.year:
            text.append((f'{a.year} handovers', f'{b.year} handovers'))
            text.append((f'end {a.year}', f'end {b.year}'))
    # longest first, so "28 Feb 2027" is never half-replaced by the rule for "Feb 2027"
    text.sort(key=lambda kv: -len(kv[0]))
    return dates, text, twelve


CANON_FIRST = '9.625% sukuk due 28 February 2027'
CANON_COUNT = 'eight'
WORDS = {1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
         9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen'}


def _canon_instrument_text(items, hz):
    """The Dashboard headline (A9) and the Cover verdict are written around Binghatti's own first
    sukuk and its own eight dated lines. Two things went wrong on another issuer. The coupon stayed
    Binghatti's — the kind of wrong that reads as right. And the phrase carries the horizon date in
    full-month form ("28 February 2027"), so the month rule rewrote only its second half and left
    the canonical DAY standing in front of the new month: Emaar read "due 28 September 2026" for a
    sukuk due the 15th. Replacing the whole phrase, longest-first, settles both.
    """
    out = []
    dated = [i for i in items if i.get('maturity')]
    first = next((i for i in items if i.get('maturity') == hz[0]), None)
    if first is not None and first.get('coupon'):
        kind = (first.get('kind') or 'sukuk').lower()
        due = f"{hz[0].day} {hz[0].strftime('%B')} {hz[0].year}"
        out.append((CANON_FIRST, f"{first['coupon'] * 100:g}% {kind} due {due}"))
    if dated:
        n = len(dated)
        if WORDS.get(n, str(n)) != CANON_COUNT:
            out.append((f'the {CANON_COUNT} maturities', f'the {WORDS.get(n, n)} maturities'))
        last = max(i['maturity'] for i in dated).year
        if last != 2031:
            out.append((f'maturity to 2031', f'maturity to {last}'))
            out.append((f'maturities to 2031', f'maturities to {last}'))
    return out


IMPLIED_RATE_NOTE = (
    'IF($B$22<>"Implied","",'
    'IF($B$49="","No bank debt is listed in the schedule above, so no rate can be implied from the '
    'reported finance cost. The quoted EIBOR-plus-margin rate on the line above is used instead.",'
    'IF($B$49>2*$B$50,"Read this rate with care. It is a residual: reported finance cost less profit '
    'on the sukuk listed above, over the bank debt listed above. Where the reported finance cost '
    'covers more than that debt — lease liabilities, joint ventures, interest capitalised into work '
    'in progress — the residual is charged entirely to the bank line and the implied rate runs well '
    'above anything a bank would quote. It is left as it stands rather than overridden, because it '
    'overstates the interest outflow and so understates headroom. The quoted rate on the line above '
    'is the alternative; the gap between the two is the size of the question.","")))')

CANON_FACTS = ('9.625%', '7.75%, 8.125%', 'AED 1,836m')


def clear_canon_facts(zin, blobs, roots, items, notes, xlsxns):
    """Clear prose that states the canonical issuer's own debt figures on somebody else's sheet.

    retext() clears anything that names the canonical issuer, and set_horizons() rewrites the dates.
    Neither catches a sentence that states Binghatti's facts without naming it — "the four sukuk
    carry coupons of 9.625%, 7.75%, 8.125% and 8.375% on AED 1,836m each". On Emaar, Sobha and Arada
    those sentences were live on the Cash flow sheet and simply wrong. A gap with a note beside it
    is honest; a confident sentence about the wrong company's debt is not.
    """
    own = {round((i.get('coupon') or 0) * 100, 4) for i in items}
    if 9.625 in own:                     # the canonical issuer itself: leave the workbook untouched
        return 0
    key = 'xl/sharedStrings.xml'
    try:
        sst = xlsxns.parse(blobs[key]) if key in blobs else xlsxns.parse(zin.read(key))
    except KeyError:
        return 0
    bad = set()
    for i, si in enumerate(sst.findall(Q('si'))):
        whole = ''.join(t.text or '' for t in si.iter(Q('t')))
        if any(m in whole for m in CANON_FACTS):
            bad.add(i)
    if not bad:
        return 0
    n = 0
    for name, root in roots.items():
        for c in root.iter(Q('c')):
            v = c.find(Q('v'))
            if c.get('t') == 's' and v is not None and v.text and int(v.text) in bad:
                for ch in list(c):
                    c.remove(ch)
                c.attrib.pop('t', None)
                notes.append(f'{name}!{c.get("r")}: cleared — stated the canonical issuer\'s own '
                             f'coupons or tower value without naming it')
                n += 1
    return n


def set_horizons(zin, blobs, roots, items, asof, bs_date, notes, xlsxns, cells=None, put=None):
    """Rewrite the canonical horizons to this issuer's, in formulas and in every label that names
    them. Returns the three dates, or None when the issuer has no dated instrument left."""
    hz = horizons_for(items, asof)
    if hz is None:
        notes.append('Headroom horizons: no instrument matures on or after the register read, so the '
                     'canonical dates stand and the grid measures nothing — read section 6 instead')
        return None
    dates, text, twelve = _plan(hz, bs_date)
    text += _canon_instrument_text(items, hz)
    text.sort(key=lambda kv: -len(kv[0]))     # the whole instrument phrase before the month inside it
    if not dates and not text:
        notes.append(f"Headroom horizons: this issuer's own dates are the canonical ones "
                     f"({', '.join(word(d, 'long') for d in hz)}) — nothing rewritten")
        return hz

    # "Month 5 of the grid is February 2027" — the month wording is in `text`, the INDEX is not, and
    # an index that no longer matches the date beside it is worse than no sentence at all.
    grid_month = (hz[0].year - asof.year) * 12 + (hz[0].month - asof.month)
    month_n = re.compile(r'Month\s+\d+\s+of the grid')

    # ONE pass, never a chain. Replacing in sequence turned Sobha's second horizon into its third:
    # "31 Dec 2027" became "31 Dec 2028" by the h2 rule and the h3 rule then moved it again, so the
    # Dashboard summed debt to 31 Dec 2029 twice and never to 31 Dec 2028.
    text_re = re.compile('|'.join(re.escape(a) for a, _ in text)) if text else None
    text_map = dict(text)
    date_re = re.compile('|'.join(re.escape(a) for a in dates)) if dates else None

    def retext(s):
        if text_re is not None:
            s = text_re.sub(lambda m: text_map[m.group(0)], s)
        if 'of the grid' in s:
            s = month_n.sub(f'Month {grid_month} of the grid', s)
        return s

    def redate(s):
        return s if date_re is None else date_re.sub(lambda m: dates[m.group(0)], s)

    nf = ns = 0
    for root in roots.values():
        for c in root.iter(Q('c')):
            f = c.find(Q('f'))
            if f is not None and f.text:
                was = f.text
                f.text = redate(f.text)
                if '"' in f.text:
                    f.text = retext(f.text)
                if f.text != was:
                    for v in c.findall(Q('v')):
                        c.remove(v)          # drop the stored result; it was the old date's answer
                    nf += 1
            is_el = c.find(Q('is'))
            if is_el is not None:
                for t in is_el.iter(Q('t')):
                    if t.text:
                        was = t.text
                        t.text = retext(t.text)
                        ns += t.text != was

    key = 'xl/sharedStrings.xml'
    try:
        sst = xlsxns.parse(blobs[key]) if key in blobs else xlsxns.parse(zin.read(key))
    except KeyError:
        sst = None
    if sst is not None:
        for t in sst.iter(Q('t')):
            if t.text:
                was = t.text
                t.text = retext(t.text)
                ns += t.text != was
        blobs[key] = xlsxns.tostring(sst)

    # The Dashboard names the instrument beside the first horizon ("28 Feb 2027 — 9.625% sukuk").
    # Swapping only the date leaves the canonical issuer's COUPON on another issuer's sukuk, which
    # is the kind of wrong that reads as right.
    dash = roots.get('Dashboard')
    if dash is not None and cells is not None and put is not None:
        first = next((i for i in items if i.get('maturity') == hz[0]), None)
        if first is not None and first.get('coupon'):
            kind = (first.get('kind') or 'sukuk').lower()
            # the issuer file holds a coupon as a fraction (0.08125); the label reads in per cent
            label = f"{word(hz[0], 'long')} — {first['coupon'] * 100:g}% {kind}"
            if put(cells(dash), 'A17', label, 's'):
                notes.append(f'Dashboard A17 names this issuer\'s own first instrument: "{label}"')

    tail = ''
    if twelve is not None and twelve != CANON_12M:
        tail = f"; debt due within 12 months of the accounts now runs to {word(twelve, 'long')}"
    notes.append(f"Headroom horizons set to this issuer's own maturities — "
                 f"{', '.join(word(d, 'long') for d in hz)} (canonical: 28 Feb 2027, 31 Dec 2027, "
                 f"31 Dec 2028): {nf} formulas and {ns} labels rewritten{tail}")
    return hz


def add_new_project_finance(roots, notes, cells, put, set_formula):
    """An input for construction paid for by NEW BORROWING rather than the issuer's own cash.

    The model charges the whole cost to complete against cash. A book with towers newly launched and
    barely started therefore reads as a cash shortfall when what it shows is a construction FUNDING
    need: escrow releases nothing at 0% certified, so the early cost has to come from somewhere, and
    in practice it comes from project finance and not from the company's current account. This is
    what moved Binghatti's modelled shortfall from AED 188m to AED 521m across two builds when five
    towers were launched at 0% built.

    One input, defaulting to zero so that no published figure moves until a reader moves it, and one
    memo line so the borrowing the assumption implies is visible rather than hidden inside a smaller
    shortfall. That borrowing is NOT added to the Debt schedule and carries no interest here: it is
    an assumption about future funding, not an instrument the issuer has issued, and the memo says so.
    """
    sc, cf = roots.get('Scenarios'), roots.get('Cash flow')
    if sc is None or cf is None:
        return False
    cm = cells(sc)
    a20 = cm.get('A20')
    if a20 is None or a20.find(Q('f')) is not None or a20.find(Q('v')) is not None \
            or a20.find(Q('is')) is not None:
        notes.append('New project finance: Scenarios row 20 is not free — input NOT added')
        return False
    put(cm, 'A20', "Construction cost met by new project finance, not by the issuer's own cash", 's')
    for col in ('B', 'C', 'D', 'E'):
        put(cm, f'{col}20', 0.0)
    if cm.get('F20') is not None:
        set_formula(cm, 'F20', 'INDEX($B20:$E20,1,$B$3)')

    cmf = cells(cf)
    set_formula(cmf, 'B20', 'Scenarios!$F$15*(1-Scenarios!$F$20)')
    put(cmf, 'C20', 'Scenarios, active column — the cost-to-complete share NET of the share assumed '
                    'met by new borrowing (row 27)', 's')
    ok = True
    for ref, label, formula, note in (
            ('27', 'New project finance, share of construction cost', 'Scenarios!$F$20',
             'Scenarios, active column. Zero by default: nothing on this sheet moves until it is changed.'),
            ('28', 'New project finance drawn to the horizon (memo)',
             'IF($B$27>=1,"",SUM($C$64:$BN$64)*$B$27/(1-$B$27))',
             'AED m. What the assumption above implies the issuer must raise. It is NOT in the Debt '
             'schedule and carries no interest here: an assumption about future funding, not an '
             'instrument the issuer has issued.')):
        cell = cmf.get(f'A{ref}')
        if cell is None or cell.find(Q('f')) is not None:
            ok = False
            continue
        put(cmf, f'A{ref}', label, 's')
        set_formula(cmf, f'B{ref}', formula)
        put(cmf, f'C{ref}', note, 's')
    notes.append('New project finance: Scenarios row 20 (default 0), Cash flow rows 27-28; the '
                 'cost-to-complete charge on Cash flow B20 is now net of the funded share'
                 + ('' if ok else ' — one memo row could not be written'))
    return True
