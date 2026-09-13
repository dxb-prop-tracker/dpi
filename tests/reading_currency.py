#!/usr/bin/env python3
"""Reading currency: the handover check may only rest on register readings taken this year.

The data.dubai dld_projects load is stamped 2026-06-15 but holds October-2025 content (Ali's audit,
13 Sep 2026). A project whose latest reading is that load has no current percentage. This test fails if
  - any published handover candidate carries a last_read before 2026-01-01,
  - meta.liveReadCurrent + len(meta.liveReadStale) != meta.liveProjects,
  - a register row is flagged reading_current=1 with a last_read before 2026-01-01 (or vice versa),
  - the database still holds a 'dld' observation dated 2026-06-15 (the un-redated load).
Usage: python3 tests/reading_currency.py [public/data/issuers] [data/portal.db]
"""
import csv, json, os, sqlite3, sys

CURRENT_FROM = '2026-01-01'
d = sys.argv[1] if len(sys.argv) > 1 else 'public/data/issuers'
db = sys.argv[2] if len(sys.argv) > 2 else 'data/portal.db'
bad = []
issuers = sorted(f[:-len('-meta.json')] for f in os.listdir(d) if f.endswith('-meta.json'))
for i in issuers:
    meta = json.load(open(f'{d}/{i}-meta.json'))
    cur, stale, live = meta.get('liveReadCurrent'), meta.get('liveReadStale'), meta.get('liveProjects')
    if cur is None or stale is None: bad.append(f'{i}: meta lacks liveReadCurrent/liveReadStale'); continue
    if cur + len(stale) != live: bad.append(f'{i}: liveReadCurrent {cur} + stale {len(stale)} != liveProjects {live}')
    for r in csv.DictReader(open(f'{d}/{i}-handover.csv')):
        if (r.get('last_read') or '') < CURRENT_FROM: bad.append(f'{i}: handover candidate {r["project"]} rests on a reading of {r.get("last_read") or "(none)"}')
    for r in csv.DictReader(open(f'{d}/{i}-register.csv')):
        flag = r.get('reading_current') == '1'; ok = (r.get('last_read') or '') >= CURRENT_FROM
        if flag != ok: bad.append(f'{i}: {r["project"]} reading_current={r.get("reading_current")} but last_read={r.get("last_read")}')
        # The gateway's certified % can be a per-building sum; above 100 it is not a reading and must never be published as one.
        try: pct = float(r.get('certified_pct') or 'nan')
        except ValueError: pct = float('nan')
        if pct == pct and pct > 100: bad.append(f'{i}: {r["project"]} publishes certified_pct {pct} (>100 — a per-building sum, not a percentage)')
    print(f'{i}: {live} live, {cur} on a current reading, {len(stale)} not')
if os.path.exists(db):
    n = sqlite3.connect(db).execute("SELECT COUNT(*) FROM project_observation WHERE source='dld' AND observed_at='2026-06-15'").fetchone()[0]
    if n: bad.append(f'database: {n} API observations still dated 2026-06-15 (run the re-date)')
if bad:
    print('\n'.join('  FAIL ' + b for b in bad)); sys.exit(1)
print('PASS reading currency')
