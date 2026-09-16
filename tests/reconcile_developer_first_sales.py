#!/usr/bin/env python3
"""Independent reconciliation of the developer-first-sales panel.

    python3 tests/reconcile_developer_first_sales.py <export dir> tools/panels/emaar.json

Re-derives every cell from portal.db with no code shared with tools/export-developer-panel.ts — its own project to
entity mapping (named projects, carve-outs), its own date-ordered walk and repeat rule, its own quarter bucketing and
median — and compares the panel cell by cell: units and value by procedure, repeats, median price per sqm, active
projects. It then checks the panel against the sales-only reference built for the same entities (off-plan first sales
can never exceed off-plan registrations), and the manifest's identity. Exits 1 on any disagreement.
"""
import csv
import json
import sqlite3
import statistics
import sys
from collections import defaultdict
from pathlib import Path

export_dir, config_path = Path(sys.argv[1]), Path(sys.argv[2])
cfg = json.loads(config_path.read_text())
d = cfg["definition"]
assert d["kind"] == "developer_first_sales", "this reconciles the developer_first_sales definition only"
name = cfg["output_name"]
panel = list(csv.DictReader((export_dir / f"{name}.csv").open(encoding="utf-8")))
manifest = json.loads((export_dir / f"{name}.manifest.json").read_text())
as_of = manifest["source_as_of"]
from_q = cfg["from_quarter"]
db = sqlite3.connect("file:data/portal.db?mode=ro", uri=True)

# entities
project_entity = {}
for e in cfg["developers"]:
    dev = e["developer_number"]
    if e.get("project_numbers"):
        ent, projects = f"{dev}/{'+'.join(e['project_numbers'])}", e["project_numbers"]
    else:
        ent = dev
        skip = set(e.get("exclude_project_numbers", []))
        projects = [r[0] for r in db.execute("SELECT project_number FROM project WHERE developer_number=?", (dev,)) if r[0] not in skip]
    for pn in projects:
        assert pn not in project_entity, f"project {pn} in two entities"
        project_entity[pn] = ent

def quarter(date):
    return f"{date[:4]}Q{(int(date[5:7]) - 1) // 3 + 1}"

procs = d["procedures"]; types = set(d["home"]["property_types"]); land_max = d["home"]["land_max_sqm"]
first, tol = d["repeat_rule"]["first_procedure"], d["repeat_rule"]["price_tolerance"]
lo, hi = d["price_per_sqm"].get("min_inclusive"), d["price_per_sqm"].get("max_inclusive")
records = []
for tid, date, proc, pn, bld, ptype, rooms, area, worth, psm in db.execute(
        f"""SELECT transaction_id, instance_date, procedure_name_en, project_number, building_name_en, property_type_en,
                   rooms_en, procedure_area, actual_worth, meter_sale_price FROM transaction_
            WHERE trans_group_en='Sales' AND procedure_name_en IN ({",".join("?" * len(procs))}) AND instance_date <= ?""",
        (*procs, as_of)):
    if pn not in project_entity:
        continue
    if not (ptype in types or (ptype == "Land" and (area or 0) <= land_max)):
        continue
    records.append((date, tid, proc, pn, (bld or "").strip(), ptype, rooms or "", round(area or 0, 2), worth, psm))
records.sort(key=lambda r: (r[0], r[1]))

cells = defaultdict(lambda: {"n": 0, "v": 0.0, "on": 0, "ov": 0.0, "dn": 0, "dv": 0.0, "rn": 0, "rv": 0.0, "p": [], "proj": set()})
open_units = defaultdict(list)
for date, tid, proc, pn, bld, ptype, rooms, area, worth, psm in records:
    key = (pn, bld, ptype, rooms, area)
    q = quarter(date); c = cells[(q, project_entity[pn])] if q >= from_q else None
    if proc == first:
        open_units[key].append([worth, False])
    else:
        hit = next((u for u in open_units[key] if not u[1] and worth and u[0] and abs(u[0] - worth) / u[0] <= tol), None)
        if hit:
            hit[1] = True
            if c is not None:
                c["rn"] += 1; c["rv"] += worth or 0
            continue
    if c is None:
        continue
    c["n"] += 1; c["v"] += worth or 0
    if proc == first:
        c["on"] += 1; c["ov"] += worth or 0
    else:
        c["dn"] += 1; c["dv"] += worth or 0
    if psm is not None and (lo is None or psm >= lo) and (hi is None or psm <= hi):
        c["p"].append(psm)
    c["proj"].add(pn)

problems = []
got = {(r["quarter"], r["entity_id"]): r for r in panel}
for k, c in cells.items():
    r = got.get(k)
    if r is None:
        problems.append(f"{k}: recomputed but missing from panel"); continue
    checks = [("first_sale_units", c["n"], int(r["first_sale_units"])), ("offplan_first_sale_units", c["on"], int(r["offplan_first_sale_units"])),
              ("delayed_first_sale_units", c["dn"], int(r["delayed_first_sale_units"])), ("repeat_registrations_dropped", c["rn"], int(r["repeat_registrations_dropped"])),
              ("active_projects", len(c["proj"]), int(r["active_projects"]))]
    for col, want, have in checks:
        if want != have: problems.append(f"{k} {col}: recomputed {want}, panel {have}")
    for col, want in (("first_sale_value", c["v"]), ("offplan_first_sale_value", c["ov"]), ("delayed_first_sale_value", c["dv"]), ("repeat_value_dropped", c["rv"])):
        if abs(want - float(r[col])) > 1: problems.append(f"{k} {col}: recomputed {want}, panel {r[col]}")
    med = statistics.median(c["p"]) if c["p"] else None
    if (med is None) != (r["median_price_per_sqm"] == "") or (med is not None and abs(med - float(r["median_price_per_sqm"])) > 1e-6):
        problems.append(f"{k} median_price_per_sqm: recomputed {med}, panel {r['median_price_per_sqm']}")
for k in got:
    if k not in cells: problems.append(f"{k}: in panel but not recomputed")

# against the sales-only reference for the same entities
ref_path = export_dir / f"{name}.sales-only.csv"
if ref_path.exists():
    ref = {(r["quarter"], r["entity_id"]): r for r in csv.DictReader(ref_path.open(encoding="utf-8"))}
    for k, r in got.items():
        if int(r["offplan_first_sale_units"]) > int(ref.get(k, {}).get("offplan_sales_count", 0)):
            problems.append(f"{k}: {r['offplan_first_sale_units']} off-plan first sales exceed {ref.get(k, {}).get('offplan_sales_count', 0)} off-plan registrations")
else:
    problems.append(f"sales-only reference {ref_path.name} not found beside the panel")

fs = manifest["first_sales"]
if sum(int(r["first_sale_units"]) + int(r["repeat_registrations_dropped"]) for r in panel) != fs["raw_registrations"]:
    problems.append("manifest identity broken: first sales + repeats != raw registrations")

print(f"reconciled {len(cells)} cells independently from portal.db; {len(panel)} panel rows; "
      f"{sum(c['n'] for c in cells.values()):,} first sales, {sum(c['rn'] for c in cells.values())} repeats")
for p in problems[:15]:
    print("  MISMATCH", p)
if problems:
    print(f"{len(problems)} problem(s)"); sys.exit(1)
print("all cells agree; off-plan first sales within the sales-only reference; manifest identity holds")
