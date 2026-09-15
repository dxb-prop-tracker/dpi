#!/usr/bin/env python3
"""Hold src/engine/escrow.mjs to the PRODUCT's escrow fixture — the fourth implementation, checked.

    python3 tests/escrow_fixture_parity.py [path/to/escrow_fixture.json]
    default: ../uae-pi/refresh/credit/fixtures/escrow_fixture.json  (env ESCROW_FIXTURE overrides)

Why it exists. The escrow arithmetic has four implementations: the product's Python engine, its
browser copy and its workbook — all three held to `escrow_fixture.json` to the dirham — and this
test bed's `src/engine/escrow.mjs`, which until now was held to nothing. "The two engines agree"
was therefore a statement about one day's comparison (B3, 14 September 2026) and not a check that
runs. This is the check. It is row 6 of the product's docs/DEFINITIONS.md section 13.

What it proves, and what it does not.

  TO DATE — the same model, and it must agree to the dirham. Both engines compute collections as
  `sold_value × collected_share(certified)` and the release as `collections × certified/100`, less
  the retention. Any drift here is a defect in one of them.

  THE EXCLUSION SET — the register rows that cannot enter the simulator at all. The .mjs leaves this
  to its caller, so the caller's rule is reproduced here and held to the fixture's own list: a row
  the product refuses and the test bed models is a difference that would never show up in a total.

  FORWARD — NOT the same model, and the test says so with a number instead of passing quietly. The
  product ramps unsold sales over the months to completion, applies the cancellation rate to the
  INCREMENTAL collection, and releases the retention twelve months after modelled completion. The
  test bed applies cancellation and sell-through to an effective value up front and holds the
  retention for good. Neither is wrong on its face; they are different forward models, and the gap
  is printed per horizon so that a figure from one is never set beside a figure from the other by
  accident. It is reported, never asserted — asserting it would freeze a difference that ought to
  be decided, not preserved.

Exit 1 on a to-date or exclusion-set failure. Exit 0, with the forward gap printed, otherwise.
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "src/engine/escrow.mjs")
DEFAULT_FIXTURE = os.path.join(ROOT, "..", "uae-pi", "refresh", "credit", "fixtures",
                               "escrow_fixture.json")
TOL_AED = 1.0     # the fixture's own tolerance: one dirham

#: the product's usable() — refresh/credit/escrow.py. Reproduced, not imported, because the point is
#: to check that THIS repository's caller refuses the same rows; importing it would prove nothing.
def usable(p):
    if not p.get("live"):
        return False, "not live in the register"
    if p.get("sold_value_aed") is None or p.get("sold_units") is None:
        return False, "no matched sales record for this project"
    if p.get("avg_ticket_aed") in (None, 0):
        return False, "no average ticket"
    if p.get("certified_pct") is None:
        return False, "no certified progress reading"
    return True, ""


NODE = r"""
import fs from 'fs';
const { projectRow } = await import(process.argv[2]);
const spec = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const asOf = new Date(spec.asof + 'T00:00:00Z');
const out = {};
for (const [name, i] of Object.entries(spec.presets)) {
  const s = { delay: i.delay_months, pastdue: i.past_due_months, undated: i.no_date_months,
              cancel: i.cancel_rate, sell: i.sell_through, price: i.price_change,
              book: i.booking, hand: i.handover, ret: i.retention, cap: i.max_pace };
  let coll = 0, rel = 0; const byH = {};
  for (const h of spec.horizons) byH[h.key] = 0;
  for (const p of spec.projects) {
    const r = projectRow({ units: p.units ?? 0, sold: p.sold_units ?? 0,
      ticket: p.avg_ticket_aed ?? 0, cert: p.certified_pct ?? 0,
      completion: p.end_date ? new Date(p.end_date + 'T00:00:00Z') : null, asOf, s,
      horizons: spec.horizons.map(h => ({ key: h.key, months: h.months })) });
    coll += r.collectedToDate * 1e6; rel += r.releasedToDate * 1e6;
    for (const h of spec.horizons) byH[h.key] += r.byHorizon[h.key] * 1e6;
  }
  out[name] = { collected_to_date_aed: coll, released_to_date_aed: rel, by_horizon: byH };
}
process.stdout.write(JSON.stringify(out));
"""


def months_between(a, b):
    ay, am = int(a[:4]), int(a[5:7])
    by, bm = int(b[:4]), int(b[5:7])
    return (by - ay) * 12 + (bm - am)


def main(argv):
    path = (argv[1] if len(argv) > 1 else os.environ.get("ESCROW_FIXTURE") or DEFAULT_FIXTURE)
    if not os.path.exists(path):
        print(f"escrow fixture not found at {path}\n"
              f"It lives in the product repository at refresh/credit/fixtures/escrow_fixture.json. "
              f"Clone it beside this one, or pass the path.", file=sys.stderr)
        return 2
    fx = json.load(open(path))
    print(f"fixture {os.path.relpath(path, ROOT)} | engine_version {fx['engine_version']} | "
          f"as-of {fx['asof']} | tolerance AED {fx['tolerance_aed']:.0f}")

    modelled = [p for p in fx["projects"] if usable(p)[0]]
    excluded = [{"project_number": p["project_number"], "reason": usable(p)[1]}
                for p in fx["projects"] if not usable(p)[0]]

    spec = {"asof": fx["asof"], "presets": fx["presets"], "projects": modelled,
            "horizons": [{"key": h["key"], "months": months_between(fx["asof"], h["date"])}
                         for h in fx["horizons"]]}
    with tempfile.TemporaryDirectory() as td:
        sp = os.path.join(td, "spec.json")
        js = os.path.join(td, "run.mjs")
        open(sp, "w").write(json.dumps(spec))
        open(js, "w").write(NODE)
        proc = subprocess.run(["node", js, ENGINE, sp], capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        return 1
    got = json.loads(proc.stdout)

    failures = []
    for preset, exp in fx["expected"].items():
        if exp.get("projects_modelled") != len(modelled):
            failures.append(f"{preset}: modelled {len(modelled)}, fixture {exp.get('projects_modelled')}")
        if exp.get("projects_excluded") != excluded:
            failures.append(f"{preset}: exclusion set differs\n  ours    {excluded}\n  fixture {exp.get('projects_excluded')}")
        for key in ("collected_to_date_aed", "released_to_date_aed"):
            a, b = got[preset][key], exp[key]
            if abs(a - b) > TOL_AED:
                failures.append(f"{preset}.{key}: engine {a:,.2f} against fixture {b:,.2f} "
                                f"(AED {a - b:,.2f})")

    print()
    print(f"{'preset':14} {'collected to date':>20} {'released to date':>20} {'drift AED':>12}")
    for preset in fx["expected"]:
        a, b = got[preset]["released_to_date_aed"], fx["expected"][preset]["released_to_date_aed"]
        print(f"{preset:14} {got[preset]['collected_to_date_aed']:>20,.2f} "
              f"{a:>20,.2f} {a - b:>12,.2f}")
    print(f"\n{len(modelled)} projects modelled, {len(excluded)} excluded "
          f"({', '.join(x['project_number'] for x in excluded) or 'none'}) — "
          f"{'matches' if not any('exclusion' in f for f in failures) else 'DIFFERS FROM'} the fixture.")

    print("\nFORWARD PATH — reported, not asserted: the two are different models (see the docstring).")
    print(f"{'preset':14} {'horizon':8} {'test bed AED':>18} {'product AED':>18} {'gap':>18}")
    for preset in fx["expected"]:
        for h in fx["horizons"]:
            ours = got[preset]["by_horizon"][h["key"]]
            theirs = fx["expected"][preset]["by_horizon"].get(h["key"])
            theirs = theirs.get("further_release_aed") if isinstance(theirs, dict) else theirs
            if theirs is None:
                continue
            print(f"{preset:14} {h['key']:8} {ours:>18,.0f} {theirs:>18,.0f} {ours - theirs:>18,.0f}")

    if failures:
        print("\nFAILED")
        for f in failures:
            print("  " + f)
        return 1
    print("\nOK — the to-date figures and the exclusion set agree with the product's fixture.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
