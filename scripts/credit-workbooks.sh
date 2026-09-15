#!/bin/bash
# Rebuilds every issuer credit workbook from the register data published by `npm run issuer:data`,
# and drops the result where the desks can reach it. Runs at the end of the daily refresh.
#
#   bash scripts/credit-workbooks.sh            every issuer we publish data for
#   bash scripts/credit-workbooks.sh binghatti  one of them
#
# There is one model. reports/credit/templates/binghatti-template.xlsx is it - the model as the
# modeller built it, with every formula, chart and commentary. Each issuer's workbook is cut from it
# in three steps, so that every issuer computes the same things in the same cells:
#
#   1. issuer_model.py    resizes the project blocks to that issuer's own project count
#   2. refresh_workbook.py writes that issuer's register data into them
#   3. issuer_inputs.py   replaces the debt, the bond prices, the accounts, the sources and the
#                         canonical issuer's name, and CLEARS anything written about that issuer
#                         rather than carrying it across
#
# An issuer with a hand-finished template of its own skips steps 1 and 3 - the template is used as
# it stands and only the register data is refreshed into it.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.." || exit 1

DATA="public/data/issuers"
TPL="reports/credit/templates"
OUT="reports/credit"
PUB="public/downloads/credit"
CANON="$TPL/binghatti-template.xlsx"
CANON_BRAND="Binghatti"
STAMP=$(date +%Y-%m-%d)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$PUB" "$OUT"
DROP=""
for cand in "$HOME/Library/CloudStorage/Dropbox/ALI TAMMAM/Code/credit" "$HOME/Dropbox/ALI TAMMAM/Code/credit"; do
  [ -d "$cand" ] && { DROP="$cand"; break; }
done
say() { echo "$(date '+%F %T')  credit-workbooks: $*"; }

want="$1"
rc_all=0
found=0
for csvfile in "$DATA"/*-register.csv; do
  [ -e "$csvfile" ] || { say "no issuer data in $DATA — run npm run issuer:data first"; exit 1; }
  issuer=$(basename "$csvfile" -register.csv)
  [ -n "$want" ] && [ "$want" != "$issuer" ] && continue
  found=1
  hand="$DATA/$issuer-handover.csv"
  meta="$DATA/$issuer-meta.json"
  conf="data/issuers/$issuer.json"
  own="$TPL/$issuer-template.xlsx"
  name=$(python3 -c "print('$issuer'.replace('-',' ').title().replace(' ',''))" 2>/dev/null || echo "$issuer")
  out="$OUT/${name}-credit-workbook-${STAMP}.xlsx"
  derived=0; resized=0

  if [ -f "$own" ]; then
    # A hand-finished template is sized for the project count it was built with. When the register
    # now holds a different number of live projects (13 Sep 2026: 16 new Binghatti launches from the
    # live gateway), resize the template's own blocks first — the same cut the derived issuers get,
    # applied to the issuer's own workbook, so its narrative and inputs are kept and only the
    # Simulator, Projects and Handover blocks grow or shrink.
    if python3 scripts/issuer_model.py "$own" "$csvfile" "$hand" "$WORK/$issuer-sized.xlsx" >"$WORK/$issuer-sized.log" 2>&1; then
      src="$WORK/$issuer-sized.xlsx"; resized=1; grep -E "rows [0-9]+-[0-9]+" "$WORK/$issuer-sized.log" | sed 's/^/  /'
    else
      say "$issuer: could not resize its own template — using it as is"; src="$own"
    fi
  else
    # No hand-finished template: cut one from the canonical model for this issuer.
    if [ ! -f "$conf" ]; then say "$issuer: no data/issuers/$issuer.json — cannot replace the model's issuer inputs"; rc_all=1; continue; fi
    if ! python3 scripts/issuer_model.py "$CANON" "$csvfile" "$hand" "$WORK/$issuer-shell.xlsx"; then
      say "$issuer: could not size the model to this issuer"; rc_all=1; continue
    fi
    src="$WORK/$issuer-shell.xlsx"
    derived=1
  fi

  if ! python3 scripts/refresh_workbook.py "$src" "$csvfile" "$WORK/$issuer-data.xlsx" --meta "$meta"; then
    say "$issuer: REFUSED — the model needs attention before it can take today's data"; rc_all=1; continue
  fi

  if [ "$derived" = 1 ]; then
    if ! python3 scripts/issuer_inputs.py "$WORK/$issuer-data.xlsx" "$conf" "$out" --from "$CANON_BRAND"; then
      say "$issuer: REFUSED — this issuer's debt or accounts do not fit the model"; rc_all=1; continue
    fi
  else
    # B37: a hand-finished template skips issuer_inputs.py, so the new-project-finance input has to
    # be added on its own — otherwise the one issuer without it is the one it was written for.
    if python3 scripts/add_new_finance.py "$WORK/$issuer-data.xlsx" "$WORK/$issuer-npf.xlsx" | sed 's/^/  /'; then
      cp "$WORK/$issuer-npf.xlsx" "$out"
    else
      say "$issuer: new-project-finance input not added — workbook published without it"
      cp "$WORK/$issuer-data.xlsx" "$out"
    fi
  fi

  # The next-quarter sheet, written from the published forecast. Absent it, the workbook is still
  # complete - the forecast is an addition to the model, never something the model depends on.
  fcj="$DATA/$issuer-forecast.json"
  if [ -f "$fcj" ]; then
    if python3 scripts/forecast_sheet.py "$out" "$fcj" "$WORK/$issuer-fc.xlsx"; then
      mv "$WORK/$issuer-fc.xlsx" "$out"
    else
      say "$issuer: next-quarter sheet could not be written — workbook published without it"
    fi
  else
    say "$issuer: no forecast published — run npm run forecast"
  fi

  # A workbook cut from the canonical model still carries the canonical issuer's numbers as the
  # stored result of every formula cell. Excel recalculates on open and never shows them; a preview
  # pane, a script or LibreOffice's converter does. Strip them so no reader can show Binghatti's
  # figures on another issuer's sheet. (The canonical workbook keeps its own results — they are its.)
  if [ "$derived" = 1 ] || [ "$resized" = 1 ]; then
    if python3 scripts/strip_cached.py "$out" "$WORK/$issuer-stripped.xlsx" | tail -1; then
      mv "$WORK/$issuer-stripped.xlsx" "$out"
    else
      say "$issuer: could not strip cached values — NOT published"; continue
    fi
  fi

  cp "$out" "$OUT/${name}-credit-workbook-latest.xlsx"
  cp "$out" "$PUB/${name}-credit-model.xlsx"
  python3 - "$issuer" "$name" "$PUB" "$meta" "$derived" <<'PY'
import json, os, sys, datetime
issuer, name, pub, meta_path, derived = sys.argv[1:6]
mf = os.path.join(pub, 'manifest.json')
m = json.load(open(mf)) if os.path.exists(mf) else {}
meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
f = f'{name}-credit-model.xlsx'
m[issuer] = {'file': f, 'href': f'/downloads/credit/{f}',
             'built': datetime.date.today().isoformat(),
             'bytes': os.path.getsize(os.path.join(pub, f)),
             'derived': derived == '1',
             'registerLastRead': meta.get('registerLastRead'),
             'transactionsLastRead': meta.get('transactionsLastRead'),
             'liveProjects': meta.get('liveProjects'),
             'liveContractedAedM': meta.get('liveContractedAedM')}
json.dump(dict(sorted(m.items())), open(mf, 'w'), indent=1)
PY
  [ -n "$DROP" ] && cp "$out" "$DROP/${name}-credit-workbook-latest.xlsx"
  say "$issuer: published$([ "$derived" = 1 ] && echo ' (cut from the canonical model)')"
done
[ "$found" = 0 ] && { say "nothing to build${want:+ for '$want'}"; exit 1; }
exit $rc_all
