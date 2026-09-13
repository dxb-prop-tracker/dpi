#!/bin/bash
# The pre-ship gate. Nothing reaches the site or the download folder unless every step here passes.
#
#   bash scripts/preship.sh            run everything
#   bash scripts/preship.sh --quick    skip the astro build (for iterating on data and workbooks)
#
# Modelled on the checklist Ali runs before every pull request. Each step is a proof of something
# that has actually gone wrong once: the data invariants because the register double-counted for
# three months; the workbook acceptance because Excel refused three files that every other tool
# opened; the escrow parity because the website and the workbook had drifted apart in four places
# without anyone noticing. A step that has never failed is not on this list.
#
# Exit code is non-zero on the first failure, and the daily refresh treats that as "do not deploy".
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.." || exit 1
QUICK=0; [ "$1" = "--quick" ] && QUICK=1
fail=0; n=0
step() { n=$((n+1)); printf '\n[%d] %s\n' "$n" "$1"; }
ok()   { printf '    PASS\n'; }
bad()  { printf '    FAIL — %s\n' "$1"; fail=1; }

step "data invariants (selfcheck: 13 rules anchored on Ali's reference figures)"
if npm run --silent check >/tmp/preship-check.log 2>&1; then ok; else bad "see /tmp/preship-check.log"; tail -8 /tmp/preship-check.log; fi

step "published data files exist and parse"
python3 - <<'PY' && ok || bad "a published data file is missing or malformed"
import json, os, sys
need = ['public/data/avm/meta.json', 'public/data/avm/cells.json', 'public/data/index/rsi.json',
        'public/data/moves.json', 'public/data/supply.json', 'public/downloads/credit/manifest.json']
bad = []
for f in need:
    if not os.path.exists(f): bad.append(f + ' missing'); continue
    try: json.load(open(f))
    except Exception as e: bad.append(f'{f}: {e}')
for iss in ('binghatti', 'sobha', 'arada'):
    for suf in ('register.csv', 'handover.csv', 'meta.json', 'forecast.json'):
        if not os.path.exists(f'public/data/issuers/{iss}-{suf}'): bad.append(f'{iss}-{suf} missing')
if bad: print('\n'.join('    ' + b for b in bad)); sys.exit(1)
PY

step "every published workbook passes the Excel acceptance test"
if python3 tests/xlsx_acceptance.py public/downloads/credit/*.xlsx >/tmp/preship-xlsx.log 2>&1; then ok; else bad "a workbook would not open in Excel"; grep -v PASS /tmp/preship-xlsx.log | head -12; fi

step "escrow parity: workbook Simulator vs the one engine, every issuer"
pp=0
for f in public/downloads/credit/*-credit-model.xlsx; do
  if ! python3 tests/escrow_parity.py "$f" >/tmp/preship-parity.log 2>&1; then pp=1; cat /tmp/preship-parity.log | tail -8; fi
done
[ $pp = 0 ] && ok || bad "the workbook and the engine disagree"

step "the website inlines the engine, not a copy of it"
if grep -q "ENGINE_SRC" "src/pages/credit/[issuer].astro" && ! grep -q "function rel(p, s)" "src/pages/credit/[issuer].astro"; then ok; else bad "the credit page carries its own escrow arithmetic"; fi

step "AVM accuracy is published and within bounds"
python3 - <<'PY' && ok || bad "AVM accuracy missing or degraded"
import json, sys
m = json.load(open('public/data/avm/meta.json'))['accuracy']
e = m.get('medianAbsErrorPct'); n = m.get('testedOn', 0)
print(f'    median abs error {e}% on {n:,} held-out sales')
if e is None or n < 2000: sys.exit(1)
if e > 8.0: print('    error above the 8% ceiling — investigate before shipping'); sys.exit(1)
PY

step "repeat-sales index: published, current, and the AVM is using it"
python3 - <<'PY' && ok || bad "index stale or not wired into the AVM"
import json, sys
r = json.load(open('public/data/index/rsi.json')); a = json.load(open('public/data/avm/meta.json'))
print(f"    RSI v{r['version']}, latest {r['headline']['latest']['quarter']} = {r['headline']['latest']['index']}, {r['pairsUsed']:,} pairs")
if 'repeat-sales' not in a.get('carriedForwardOn', ''): print('    AVM is not carrying comparables on the index'); sys.exit(1)
PY

if [ $QUICK = 0 ]; then
  step "astro build"
  if npx astro build >/tmp/preship-build.log 2>&1; then ok; else bad "build failed"; grep -iE "error" /tmp/preship-build.log | head -6; fi

  step "built site carries the new sections and the downloads"
  python3 - <<'PY' && ok || bad "a page or download is missing from dist"
import os, sys
need = ['dist/credit/index.html', 'dist/credit/binghatti/index.html', 'dist/value/index.html',
        'dist/price-index/index.html', 'dist/accuracy/index.html', 'dist/watchlist/index.html',
        'dist/downloads/credit/Binghatti-credit-model.xlsx', 'dist/data/index/rsi-market.csv']
miss = [f for f in need if not os.path.exists(f)]
if miss: print('\n'.join('    missing ' + m for m in miss)); sys.exit(1)
for f in ('dist/credit/binghatti/index.html', 'dist/developers/index.html'):
    t = open(f).read()
    for w in ('Stressed', 'Credit view:', 'chip bad'):
        if w in t: print(f'    {f} still contains "{w}"'); sys.exit(1)
PY
fi

printf '\n'
if [ $fail = 0 ]; then echo "PRESHIP: ALL $n STEPS PASSED"; exit 0
else echo "PRESHIP: FAILED — do not deploy"; exit 1; fi
