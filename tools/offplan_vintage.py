#!/usr/bin/env python3
"""The off-plan count for a month, as at each day it was read — the rule-13 test for §13 row 2.

    python3 tools/offplan_vintage.py [YYYY-MM] [--db data/portal.db]

Two owners count August 2026 off-plan registrations differently: 8,270 here (8,334 by 15 September)
against 8,149 on the product. Row 2 of the product's docs/DEFINITIONS.md calls it "the one
difference that should not exist" and names three candidate causes — the product's canonical-key
de-duplication, its correction of 20,006 registration dates, and our API tail.

This measures all three on our own rows, which is enough to settle it, because two of them are
bounded from this side alone:

  TAIL   how many rows DATED in the month were first seen after the month closed. Our store keeps
         the day each row first appeared (`feed_date`), so the month's count can be re-read at any
         past date rather than argued about.
  DEDUPE how many rows a canonical key — procedure, date, area, building, project, rooms, area size,
         price — would collapse. If the answer is smaller than the gap, de-duplication cannot be
         the cause.

It prints the month's count as at every distinct read date, so the number the other side saw is a
row in the table rather than a reconciliation.
"""
import argparse
import sqlite3
import sys

Q_CURVE = """
SELECT feed_date AS seen, COUNT(*) AS added
FROM transaction_
WHERE reg_type_en='Off-Plan Properties' AND instance_date BETWEEN ? AND ?
GROUP BY feed_date ORDER BY feed_date
"""
Q_DEDUPE = """
WITH k AS (
  SELECT procedure_name_en||'|'||instance_date||'|'||IFNULL(area_name_en,'')||'|'
       ||IFNULL(building_name_en,'')||'|'||IFNULL(project_number,'')||'|'||IFNULL(rooms_en,'')||'|'
       ||printf('%.2f',IFNULL(procedure_area,0))||'|'||printf('%.2f',IFNULL(actual_worth,0)) ck,
         COUNT(*) c
  FROM transaction_
  WHERE reg_type_en='Off-Plan Properties' AND instance_date BETWEEN ? AND ?
  GROUP BY ck)
SELECT IFNULL(SUM(c-1),0), IFNULL(SUM(c),0) FROM k WHERE c>1
"""


def month_bounds(ym):
    y, m = int(ym[:4]), int(ym[5:7])
    last = [31, 29 if (y % 4 == 0 and (y % 100 or y % 400 == 0)) else 28,
            31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return f"{ym}-01", f"{ym}-{last:02d}"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("month", nargs="?", default="2026-08")
    ap.add_argument("--db", default="data/portal.db")
    a = ap.parse_args(argv)
    lo, hi = month_bounds(a.month)
    db = sqlite3.connect(a.db)
    curve = db.execute(Q_CURVE, (lo, hi)).fetchall()
    dupes, in_dupe_groups = db.execute(Q_DEDUPE, (lo, hi)).fetchone()
    total = sum(n for _, n in curve)

    print(f"Off-plan registrations DATED {lo} to {hi}, by the day the row was first seen.")
    print(f"{'first seen':14} {'added':>8} {'count as at that day':>22}")
    run = 0
    for seen, n in curve:
        run += n
        print(f"{seen or '(no feed date)':14} {n:>8,} {run:>22,}")
    print(f"\nTotal now: {total:,}")
    at_close = sum(n for seen, n in curve if seen and seen <= hi)
    print(f"As at the month's own last day ({hi}): {at_close:,} — "
          f"{total - at_close:,} row(s) arrived later (the TAIL).")
    print(f"A canonical key would collapse {dupes:,} row(s) out of {in_dupe_groups:,} in duplicate "
          f"groups (the DEDUPE bound).")
    print("\nA monthly count keeps growing for days after the month closes, so a count without the "
          "date it was read is not a number two sides can compare.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
