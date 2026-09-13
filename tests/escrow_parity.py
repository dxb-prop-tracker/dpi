#!/usr/bin/env python3
"""Prove the workbook's Simulator agrees with the engine, row by row, to the dirham.

    python3 tests/escrow_parity.py [workbook.xlsx]     default: the published Binghatti model

How: the workbook is recalculated by LibreOffice (its Simulator columns use only IF, MIN, MAX,
EDATE, YEAR and MONTH, which LibreOffice evaluates exactly), every project row's inputs are read
back, the engine in src/engine/escrow.mjs is run on the same inputs under the workbook's ACTIVE
scenario, and the two are compared column by column.

Why it exists: the escrow arithmetic lives in two places — the engine, and the spreadsheet's
formulas. Nothing else stops them drifting apart. This did not exist when the website simulator and
the workbook were first built, and they had already diverged in four places before anyone noticed.
It fails loudly, and the build refuses to publish a workbook that fails it.
"""
import json, os, subprocess, sys, tempfile, datetime as dt, shutil
import openpyxl, warnings
warnings.simplefilter('ignore')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, 'src/engine/escrow.mjs')
TOL_AED_M = 1e-6            # one dirham, in millions
EPOCH = dt.date(1899, 12, 30)

SCN_ROWS = {'delay': 5, 'pastdue': 6, 'undated': 7, 'cancel': 8, 'sell': 9, 'price': 10,
            'book': 11, 'hand': 12, 'ret': 13, 'cap': 14}
COLS = {'contracted': 'J', 'unsold': 'K', 'soldPct': 'L', 'months': 'N', 'pace': 'O',
        'effective': 'P', 'releasedToDate': 'Q', 'collectedToDate': 'U'}
HORIZONS = {'R': 5, 'S': 15, 'T': 27}      # Feb-27, Dec-27, Dec-28 as months after the as-of month


def recalc(src):
    """Return a path to a copy of `src` whose cached values have just been recomputed — by Excel where
    it is installed, by LibreOffice otherwise. scripts/recalc.sh decides, and refuses if it has
    neither: a parity proof that silently skipped would be no proof at all."""
    out = os.path.join(tempfile.mkdtemp(), 'recalc.xlsx')
    r = subprocess.run(['bash', os.path.join(ROOT, 'scripts/recalc.sh'), src, out],
                       capture_output=True, text=True, timeout=240)
    if r.returncode != 0 or not os.path.exists(out):
        raise SystemExit(f'recalculation failed: {(r.stderr or r.stdout)[-400:]}')
    print(f'  ({r.stdout.strip()})')
    return out


def to_date(v):
    if v is None or v == '':
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, (int, float)):
        return EPOCH + dt.timedelta(days=int(v))
    return dt.date.fromisoformat(str(v)[:10])


def main(path):
    calc = recalc(path)
    wb_v = openpyxl.load_workbook(calc, data_only=True)
    wb_f = openpyxl.load_workbook(path)
    sim_v, sim_f = wb_v['Simulator'], wb_f['Simulator']
    sc = wb_v['Scenarios']
    active = int(sc['B3'].value or 1)
    col = 'BCDE'[active - 1]
    s = {k: float(sc[f'{col}{r}'].value) for k, r in SCN_ROWS.items()}
    as_of = to_date(sim_v['C3'].value)

    # rows: from 8 while column A carries a project number (a formula-free anchor)
    rows = []
    r = 8
    while True:
        a = sim_f[f'A{r}'].value
        if a is None or str(a).strip() == '' or str(a).lower().startswith('total'):
            break
        rows.append(r); r += 1

    inputs = []
    for r in rows:
        inputs.append({
            'row': r,
            'units': float(sim_v[f'E{r}'].value or 0), 'sold': float(sim_v[f'F{r}'].value or 0),
            'ticket': float(sim_v[f'G{r}'].value or 0), 'cert': float(sim_v[f'H{r}'].value or 0),
            'completion': (to_date(sim_v[f'I{r}'].value).isoformat() if sim_v[f'I{r}'].value not in (None, '') else None),
        })
    payload = json.dumps({'asOf': as_of.isoformat(), 's': s, 'rows': inputs,
                          'horizons': [{'key': k, 'months': m} for k, m in HORIZONS.items()]})
    js = f"""
import {{ projectRow }} from '{ENGINE}';
const p = JSON.parse(process.argv[1]);
const asOf = new Date(p.asOf + 'T00:00:00Z');
const out = p.rows.map(r => {{
  const x = projectRow({{ ...r, completion: r.completion ? new Date(r.completion + 'T00:00:00Z') : null, asOf, s: p.s, horizons: p.horizons }});
  return {{ row: r.row, contracted: x.contracted, unsold: x.unsold, soldPct: x.soldPct, months: x.months, pace: x.pace,
           effective: x.effective, releasedToDate: x.releasedToDate, collectedToDate: x.collectedToDate, ...x.byHorizon }};
}});
console.log(JSON.stringify(out));
"""
    res = subprocess.run(['node', '--input-type=module', '-e', js, payload], capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit('engine failed: ' + res.stderr[-600:])
    engine = {e['row']: e for e in json.loads(res.stdout)}

    fails, checked = [], 0
    for r in rows:
        e = engine[r]
        for key, c in list(COLS.items()) + [(k, k) for k in HORIZONS]:
            wbv = sim_v[f'{c}{r}'].value
            if wbv is None or isinstance(wbv, str):
                fails.append((r, c, key, wbv, e[key], 'workbook cell not numeric')); continue
            checked += 1
            tol = 0.5 if key == 'months' else (1e-6 if key in ('soldPct',) else (1e-4 if key == 'pace' else TOL_AED_M))
            if abs(float(wbv) - float(e[key])) > tol:
                fails.append((r, c, key, wbv, e[key], ''))

    name = os.path.basename(path)
    print(f'escrow parity: {name} · scenario {active} · {len(rows)} rows · {checked} cells compared · as of {as_of}')
    if fails:
        print(f'  FAIL — {len(fails)} cells disagree beyond tolerance:')
        for r, c, key, wbv, ev, note in fails[:12]:
            print(f'    {c}{r} {key:16} workbook {wbv!r:>16}  engine {ev!r:>16}  {note}')
        if len(fails) > 12:
            print(f'    ... and {len(fails) - 12} more')
        return 1
    print('  PASS — every compared cell agrees within one dirham')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'public/downloads/credit/Binghatti-credit-model.xlsx')))
