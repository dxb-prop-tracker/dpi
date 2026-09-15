#!/usr/bin/env python3
"""Add the new-project-finance input to a workbook that was NOT cut from the canonical model.

    python3 scripts/add_new_finance.py <in.xlsx> <out.xlsx>

An issuer with a hand-finished template of its own (Binghatti) skips issuer_inputs.py, so it would
be the one issuer without the input — and it is the issuer whose modelled shortfall moved from AED
188m to AED 521m across two builds because five towers were launched at 0% built and their
construction cost was charged before escrow could release anything. This puts the same input on the
same rows there.

It adds nothing else and moves no figure: the input defaults to zero.
"""
import os
import shutil
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xlsxns
import issuer_horizons
from issuer_inputs import cells, put, set_formula, sheet_paths


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    src, out = argv[1], argv[2]
    zin = zipfile.ZipFile(src)
    paths = sheet_paths(zin)
    roots = {n: xlsxns.parse(zin.read(p)) for n, p in paths.items()}
    notes = []
    added = issuer_horizons.add_new_project_finance(roots, notes, cells, put, set_formula)
    for n in notes:
        print('  note: ' + n)
    if not added:
        print('  nothing added — the workbook is unchanged')
    blobs = {paths[n]: xlsxns.tostring(r) for n, r in roots.items()}
    shutil.copyfile(src, out)
    with zipfile.ZipFile(src) as s, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as d:
        for item in s.infolist():
            if item.filename == 'xl/calcChain.xml':
                continue
            d.writestr(item, blobs.get(item.filename, s.read(item.filename)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
