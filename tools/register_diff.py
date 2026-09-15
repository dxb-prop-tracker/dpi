#!/usr/bin/env python3
"""The register moved — what changed between two dated register workbooks.

D11's weekly edition has two halves. The market pack (sales, prices, rents) is built from the
transaction store and goes back to 2008. The REGISTER half needs two vintages of the register
itself, and our own accumulated vintage only starts on 7 September — so until today the weekly
edition printed "0 progress revisions" not because nothing moved but because we had nothing to
compare against.

The `register-export` container holds one full register workbook per collected day from 24 August
2026 (back-filled by Ali on 15 September). This reads two of them and diffs them, so the register
half of the edition is built from the archive rather than from our own short series.

    python3 tools/register_diff.py 2026-09-08 2026-09-15 [--json out.json] [--top 20]

Needs the az CLI signed in with read on the storage account. Nothing is cached in the repository:
the workbooks are pulled to data/register/ (git-ignored) and read from there.

Every figure this prints is a difference between two dated readings of the same field. It is NOT a
claim about construction: a percentage that has not moved means no inspection was recorded, not an
idle site, and that is said on the face of the output because a credit reader will otherwise assume
the opposite.
"""
import argparse
import datetime as dt
import json
import pathlib
import subprocess
import sys

ACCOUNT = "hkaspropertydata"
CONTAINER = "register-export"
DEST = pathlib.Path(__file__).resolve().parents[1] / "data" / "register"
NAME = "Dubai_Project_Register_{}.xlsx"

# The register's own column names, from the About sheet's 23-column raw export.
KEY, NAME_EN, DEV, STATUS, PCT = "PROJECT_NUMBER", "PROJECT_EN", "DEVELOPER_EN", "PROJECT_STATUS", "PERCENT_COMPLETED"
AREA, END, INSP, UNITS = "AREA_EN", "END_DATE", "INSPECTION_DATE", "CNT_UNIT"


def available():
    """The days the container actually holds. The collector does not run every day — there is no
    4, 8 or 9 September — so a window edge has to snap to a real reading rather than fail."""
    r = subprocess.run(["az", "storage", "blob", "list", "--auth-mode", "login", "--account-name",
                        ACCOUNT, "--container-name", CONTAINER, "--num-results", "5000",
                        "--query", "[].name", "-o", "tsv"], capture_output=True, text=True)
    days = sorted({n.strip()[-15:-5] for n in r.stdout.splitlines()
                   if n.startswith("Dubai_Project_Register_") and n.strip().endswith(".xlsx")})
    return [d for d in days if len(d) == 10 and d[4] == "-"]


def snap(want, days, forward):
    """The nearest reading at or after `want` for the window's start, at or before it for its end.
    Returns the day and whether it moved, so the edition can say which readings it actually used."""
    pool = [d for d in days if (d >= want if forward else d <= want)]
    if not pool:
        sys.exit(f"register_diff: no register workbook {'on or after' if forward else 'on or before'} "
                 f"{want}. The container holds {days[0]} to {days[-1]}.")
    return (pool[0] if forward else pool[-1])


def fetch(day):
    """Pull one dated workbook out of the container, unless it is already here."""
    DEST.mkdir(parents=True, exist_ok=True)
    dst = DEST / NAME.format(day)
    if dst.exists():
        return dst
    cmd = ["az", "storage", "blob", "download", "--auth-mode", "login", "--account-name", ACCOUNT,
           "--container-name", CONTAINER, "-n", NAME.format(day), "-f", str(dst), "--output", "none"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not dst.exists():
        dst.unlink(missing_ok=True)
        sys.exit(f"register_diff: no workbook for {day} in {CONTAINER}\n{r.stderr.strip()[:300]}")
    return dst


def read(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = "Register" if "Register" in wb.sheetnames else wb.sheetnames[0]
    it = wb[sheet].iter_rows(values_only=True)
    head = list(next(it))
    idx = {h: i for i, h in enumerate(head)}
    out = {}
    for row in it:
        k = row[idx[KEY]]
        if k is None:
            continue
        out[str(k).strip()] = {c: row[idx[c]] for c in
                               (NAME_EN, DEV, STATUS, PCT, AREA, END, INSP, UNITS) if c in idx}
    return out


def day(v):
    if v is None:
        return None
    if isinstance(v, (dt.datetime, dt.date)):
        return v.date().isoformat() if isinstance(v, dt.datetime) else v.isoformat()
    s = str(v).strip()[:10]
    return s if len(s) == 10 and s[4] == "-" else None


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def months(a, b):
    """Whole months between two ISO days, signed. Positive means the date moved LATER — slippage."""
    if not a or not b:
        return None
    ya, ma, da = (int(x) for x in a.split("-"))
    yb, mb, db = (int(x) for x in b.split("-"))
    return round((yb - ya) * 12 + (mb - ma) + (db - da) / 30.44, 1)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("frm")
    ap.add_argument("to")
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--json")
    a = ap.parse_args(argv)

    days = available()
    frm, to = snap(a.frm, days, True), snap(a.to, days, False)
    if (frm, to) != (a.frm, a.to):
        print(f"  (asked for {a.frm} → {a.to}; the register was read on {frm} and {to} — "
              f"the collector does not run every day, and an edition must name the readings it used)\n")
    a.frm, a.to = frm, to
    before, after = read(fetch(a.frm)), read(fetch(a.to))
    added = [k for k in after if k not in before]
    gone = [k for k in before if k not in after]

    progress, status, dates, impossible = [], [], [], []
    for k in after:
        if k not in before:
            continue
        b, c = before[k], after[k]
        pb, pc = num(b.get(PCT)), num(c.get(PCT))
        # The register carries certified progress ABOVE 100% on 17 projects today, to 17,692% on
        # Fairway Villas 2. Every one is a villa or plot community — Fairway Villas, DAMAC Lagoons,
        # Cavalli Estates, LANAI Island, Mira Villas — which is the same population D28 found
        # counting on a different basis. Whatever the field means there, it is not a percentage of
        # one building, and a "+27 pts" line on a project reading 1,945% is not a progress revision.
        # They are held out of the movement tables and listed on their own, because the fault is
        # worth publishing and the number is not.
        off_scale = (pb is not None and not 0 <= pb <= 100) or (pc is not None and not 0 <= pc <= 100)
        if off_scale:
            impossible.append(dict(key=k, name=c.get(NAME_EN), area=c.get(AREA),
                                   status=c.get(STATUS), before=pb, after=pc))
        # only the PROGRESS line is suppressed — a status change or a moved date on the same
        # project is still a fact about the register and still belongs in the edition
        if not off_scale and pb is not None and pc is not None and abs(pc - pb) >= 0.05:
            progress.append(dict(key=k, name=c.get(NAME_EN), area=c.get(AREA),
                                 before=round(pb, 2), after=round(pc, 2), change=round(pc - pb, 2),
                                 read_before=day(b.get(INSP)), read_after=day(c.get(INSP))))
        if (b.get(STATUS) or "") != (c.get(STATUS) or ""):
            status.append(dict(key=k, name=c.get(NAME_EN), area=c.get(AREA),
                               **{"from": b.get(STATUS), "to": c.get(STATUS)}))
        eb, ec = day(b.get(END)), day(c.get(END))
        if eb and ec and eb != ec:
            dates.append(dict(key=k, name=c.get(NAME_EN), area=c.get(AREA),
                              was=eb, now=ec, months=months(eb, ec)))

    progress.sort(key=lambda r: -abs(r["change"]))
    dates.sort(key=lambda r: -abs(r["months"] or 0))
    up = sum(1 for r in progress if r["change"] > 0)
    slipped = sum(1 for r in dates if (r["months"] or 0) > 0)
    stale = sum(1 for k, c in after.items()
                if k in before and num(c.get(PCT)) is not None
                and num(before[k].get(PCT)) == num(c.get(PCT)))

    rep = dict(window=dict(frm=a.frm, to=a.to,
                           days=(dt.date.fromisoformat(a.to) - dt.date.fromisoformat(a.frm)).days),
               counts=dict(projects_before=len(before), projects_after=len(after),
                           off_scale_percentages=len(impossible),
                           added=len(added), gone=len(gone),
                           progress_revisions=len(progress), revised_up=up, revised_down=len(progress) - up,
                           status_changes=len(status), completion_dates_moved=len(dates), slipped_later=slipped,
                           unchanged_percentage=stale),
               added=[dict(key=k, name=after[k].get(NAME_EN), developer=after[k].get(DEV),
                           area=after[k].get(AREA), status=after[k].get(STATUS),
                           units=after[k].get(UNITS)) for k in added],
               gone=[dict(key=k, name=before[k].get(NAME_EN), area=before[k].get(AREA)) for k in gone],
               progress=progress, status=status, dates=dates, off_scale=impossible)

    if a.json:
        pathlib.Path(a.json).write_text(json.dumps(rep, indent=2, ensure_ascii=False, default=str))

    c = rep["counts"]
    print(f"The register moved — {a.frm} to {a.to} ({rep['window']['days']} days)\n")
    print(f"  {c['projects_after']:,} projects on the register, against {c['projects_before']:,} at the start")
    print(f"  {c['added']} added · {c['gone']} no longer returned")
    print(f"  {c['progress_revisions']} certified-progress revisions — {c['revised_up']} up, {c['revised_down']} down")
    print(f"  {c['status_changes']} status changes · {c['completion_dates_moved']} completion dates moved "
          f"({c['slipped_later']} later)")
    print(f"  {c['unchanged_percentage']:,} projects carry the SAME percentage as at the start — no inspection was")
    print("    recorded in the window. That is a reading about the register, not about the sites.\n")

    if impossible:
        print(f"  HELD OUT — {len(impossible)} projects whose certified progress is outside 0-100%:")
        for r in sorted(impossible, key=lambda r: -(r['after'] or 0))[:6]:
            print(f"    {r['after']:>10.1f}%  {str(r['name'])[:38]:<38} {str(r['area'])[:22]:<22} {r['status']}")
        print("    Every one is a villa or plot community. Whatever this field counts there, it is not")
        print("    a percentage of one building, so these carry no progress line in this edition.\n")
    if progress:
        print(f"  Largest progress revisions ({min(a.top, len(progress))} of {len(progress)}):")
        for r in progress[:a.top]:
            print(f"    {r['change']:+7.2f} pts  {str(r['name'])[:38]:<38} {str(r['area'])[:22]:<22} "
                  f"{r['before']:>6.1f}% -> {r['after']:>6.1f}%   read {r['read_before']} -> {r['read_after']}")
        print()
    if status:
        print(f"  Status changes ({len(status)}):")
        for r in status[:a.top]:
            print(f"    {str(r['name'])[:38]:<38} {str(r['area'])[:22]:<22} {r['from']} -> {r['to']}")
        print()
    if dates:
        print(f"  Completion dates moved ({len(dates)}, {slipped} later):")
        for r in dates[:a.top]:
            print(f"    {r['months']:+7.1f} mo  {str(r['name'])[:38]:<38} {r['was']} -> {r['now']}")
        print()
    if added:
        print(f"  New on the register ({len(added)}):")
        for r in rep["added"][:a.top]:
            print(f"    {str(r['name'])[:38]:<38} {str(r['area'])[:22]:<22} {r['status']} · "
                  f"{r['units'] or '—'} units · {str(r['developer'])[:34]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
