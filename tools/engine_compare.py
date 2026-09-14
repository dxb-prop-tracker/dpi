#!/usr/bin/env python3
"""B3 — the two escrow engines on each other's inputs (CLAUDE.md rule 13 test, both ways).

Engine A: this test bed's src/engine/escrow.mjs (run through node).
Engine B: the product's refresh/credit/escrow.py (imported from the sibling clone).
Inputs A: this test bed's public/data/issuers/<issuer>-register.csv (live rows).
Inputs B: the product's published credit/<issuer>/register.json rows, saved to data/b3/ali-credit-<date>.json.

Four cells per issuer: A(A) A(B) B(A) B(B), Base scenario, as-of = each side's register read date.
Then, for the SAME inputs, the per-project arithmetic difference (should be zero), and for the SAME
engine, the per-project input differences (live status, units, sold, ticket, certified %, end date).

Usage: python3 tools/engine_compare.py <path-to-uae-pi-clone> data/b3/ali-credit-2026-09-13.json
"""
import csv, json, os, subprocess, sys, importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_A = os.path.join(ROOT, 'src/engine/escrow.mjs')
NODE = r'''
import fs from 'fs';
const { SCENARIOS, projectRow } = await import(process.argv[2]);
const rows = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const asOf = new Date(process.argv[4] + 'T00:00:00Z'); const s = SCENARIOS[0];
const out = {};
for (const r of rows) {
  const p = projectRow({ units: r.units || 0, sold: r.sold || 0, ticket: r.ticket || 0, cert: r.cert || 0,
    completion: r.end ? new Date(r.end + 'T00:00:00Z') : null, asOf, s });
  out[r.pn] = { collected: p.collectedToDate * 1e6, released: p.releasedToDate * 1e6 };
}
process.stdout.write(JSON.stringify(out));
'''

def load_b(path):
    spec = importlib.util.spec_from_file_location('escrow_b', path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

def inputs_a(issuer):
    rows = []
    for r in csv.DictReader(open(os.path.join(ROOT, f'public/data/issuers/{issuer}-register.csv'), encoding='utf-8')):
        live = r['is_live'] == '1'
        units = int(float(r['units'])) if r['units'] else None
        sold = int(float(r['sold_units'])) if r['sold_units'] else None
        ticket = float(r['avg_ticket_aed']) if r['avg_ticket_aed'] else None
        rows.append({'pn': r['project_number'], 'name': r['project'], 'live': live, 'units': units, 'sold': sold,
                     'ticket': ticket, 'value': (sold * ticket) if (sold is not None and ticket) else None,
                     'cert': float(r['certified_pct']) if r['certified_pct'] else None,
                     'end': r['registered_completion'] or None})
    return rows

def inputs_b(doc, issuer):
    rows = []
    for pn, name, live, units, sold, ticket, value, cert, end, insp, src in doc[issuer]['rows']:
        rows.append({'pn': pn, 'name': name, 'live': bool(live), 'units': units, 'sold': sold, 'ticket': ticket,
                     'value': value, 'cert': cert, 'end': end or None})
    return rows

def usable(r):
    return r['live'] and r['sold'] is not None and r['value'] is not None and r['ticket'] and r['cert'] is not None

def run_a(rows, asof):
    rows = [r for r in rows if usable(r)]
    tmp = os.path.join(ROOT, 'data/b3/_rows.json'); json.dump(rows, open(tmp, 'w'))
    js = os.path.join(ROOT, 'data/b3/_run.mjs'); open(js, 'w').write(NODE)
    out = subprocess.run(['node', js, ENGINE_A, tmp, asof], capture_output=True, text=True, check=True).stdout
    return json.loads(out)

def run_b(mod, rows, asof):
    projects = [{'project_number': r['pn'], 'live': r['live'], 'units': r['units'], 'sold_units': r['sold'],
                 'avg_ticket_aed': r['ticket'], 'sold_value_aed': r['value'], 'certified_pct': r['cert'],
                 'end_date': r['end']} for r in rows]
    res = mod.run(projects, mod.PRESETS['base'], asof, [{'key': 'h', 'date': '2028-12-31'}])
    return {p['project_number']: {'collected': p['collected_to_date_aed'], 'released': p['released_to_date_aed']} for p in res['per_project']}

def tot(d):
    c = sum(v['collected'] for v in d.values()); r = sum(v['released'] for v in d.values()); return c, r, c - r

def m(x): return f'{x/1e6:,.0f}'

def main(uae_pi, bpath):
    mod = load_b(os.path.join(uae_pi, 'refresh/credit/escrow.py'))
    doc = json.load(open(bpath, encoding='utf-8'))
    for issuer in ('sobha', 'binghatti'):
        A = inputs_a(issuer); B = inputs_b(doc, issuer)
        meta = json.load(open(os.path.join(ROOT, f'public/data/issuers/{issuer}-meta.json')))
        asof_a, asof_b = meta['registerLastRead'], doc[issuer]['asof']
        cells = {('A', 'A'): run_a(A, asof_a), ('A', 'B'): run_a(B, asof_b), ('B', 'A'): run_b(mod, A, asof_a), ('B', 'B'): run_b(mod, B, asof_b)}
        print(f'\n== {issuer.upper()}  (as-of: ours {asof_a}, product {asof_b}; Base scenario; AED m)')
        print(f'{"engine \\ inputs":<22}{"ours (A)":>34}{"product (B)":>34}')
        for eng, label in (('A', 'ours (escrow.mjs)'), ('B', 'product (escrow.py)')):
            ca, ra, ha = tot(cells[(eng, 'A')]); cb, rb, hb = tot(cells[(eng, 'B')])
            print(f'{label:<22}{"n=" + str(len(cells[(eng, "A")])):>8} coll {m(ca):>7} rel {m(ra):>6} held {m(ha):>6}'
                  f'{"n=" + str(len(cells[(eng, "B")])):>8} coll {m(cb):>7} rel {m(rb):>6} held {m(hb):>6}')
        pub = doc[issuer]
        print(f'  product published (meta.engine.results.base): n={pub["n"]} coll {m(pub["coll"])} rel {m(pub["rel"])} held {m(pub["bal"])}')
        # 1. same inputs, two engines: arithmetic
        for inp, rows in (('A', A), ('B', B)):
            x, y = cells[('A', inp)], cells[('B', inp)]
            diffs = [(pn, x[pn]['released'] - y[pn]['released'], x[pn]['collected'] - y[pn]['collected']) for pn in x if pn in y]
            worst = max(diffs, key=lambda d: abs(d[1]) + abs(d[2])) if diffs else None
            print(f'  arithmetic, inputs {inp}: {len(diffs)} projects in both; max |released diff| {max(abs(d[1]) for d in diffs)/1e6:,.3f} m, '
                  f'max |collected diff| {max(abs(d[2]) for d in diffs)/1e6:,.3f} m (project {worst[0]})')
        # 2. same engine, two input sets: which rows differ and why
        a = {r['pn']: r for r in A}; b = {r['pn']: r for r in B}
        live_a = {pn for pn, r in a.items() if usable(r)}; live_b = {pn for pn, r in b.items() if usable(r)}
        print(f'  scope: modelled on our side only: {sorted(live_a - live_b)}; on product side only: {sorted(live_b - live_a)}')
        for pn in sorted(live_a - live_b): print(f'     ours-only {pn} {a[pn]["name"]}: product row ' + (f'live={b[pn]["live"]} sold={b[pn]["sold"]} value={b[pn]["value"]} cert={b[pn]["cert"]}' if pn in b else 'absent'))
        for pn in sorted(live_b - live_a): print(f'     product-only {pn} {b[pn]["name"]}: our row ' + (f'live={a[pn]["live"]} sold={a[pn]["sold"]} ticket={a[pn]["ticket"]} cert={a[pn]["cert"]}' if pn in a else 'absent'))
        both = sorted(live_a & live_b)
        print(f'  {len(both)} projects modelled on both sides; input differences (ours vs product):')
        print(f'  {"project":<34}{"units":>13}{"sold":>13}{"ticket m":>15}{"cert %":>15}{"end":>24}{"held ours":>11}{"held prod":>11}')
        tot_ha = tot_hb = 0
        for pn in both:
            ra, rb = a[pn], b[pn]
            ha = cells[('A', 'A')][pn]['collected'] - cells[('A', 'A')][pn]['released']
            hb = cells[('A', 'B')][pn]['collected'] - cells[('A', 'B')][pn]['released']
            tot_ha += ha; tot_hb += hb
            def col(x, y, f=lambda v: f'{v}'):
                return (f'{f(x)}' if x == y else f'{f(x)}|{f(y)}')
            flag = '' if abs(ha - hb) < 1e6 else ' *'
            print(f'  {ra["name"][:33]:<34}{col(ra["units"], rb["units"]):>13}{col(ra["sold"], rb["sold"]):>13}'
                  f'{col(round((ra["ticket"] or 0)/1e6,2), round((rb["ticket"] or 0)/1e6,2)):>15}{col(ra["cert"], rb["cert"]):>15}'
                  f'{col(ra["end"] or "-", rb["end"] or "-"):>24}{m(ha):>11}{m(hb):>11}{flag}')
        print(f'  {"TOTAL (both sides)":<34}{"":>13}{"":>13}{"":>15}{"":>15}{"":>24}{m(tot_ha):>11}{m(tot_hb):>11}')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
