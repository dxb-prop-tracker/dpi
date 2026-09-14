#!/usr/bin/env python3
"""Why do two repeat-sales indices on the same data differ? Switch one rule at a time and watch.

Runs Bailey-Muth-Nourse on pairs built from data/portal.db under several rule sets and prints the
annual index (2012 = 100) for each, so the rule that moves the level is named, not guessed.
Rules varied (each relative to the previous row, cumulative):
  A  our published rule: pairs on project+building+rooms+size, both legs 'Existing', hold >= 180 d,
     groups of <= 12 sales, change in (-60%, +300%)
  B  A, but 'Delayed Sell' and 'Sale On Payment Plan' (developer preliminary/payment-plan sales that
     the register types as 'Existing') are excluded from BOTH legs — only procedure 'Sell' is a resale
  C  B, hold >= 90 d (Ali's rule)
  D  C, key with more than 4 sales dropped (Ali's ambiguity rule)
  E  D, annualised move beyond +/-60%/yr trimmed (Ali's noise rule)
Usage: ~/Sites/venv-rsi/bin/python tests/rsi_decompose.py [data/portal.db]
"""
import sqlite3, sys
import numpy as np, pandas as pd

db = sys.argv[1] if len(sys.argv) > 1 else 'data/portal.db'
con = sqlite3.connect(db)
tx = pd.read_sql("""
  SELECT project_number pn, area_name_en ar, building_name_en b, rooms_en r, procedure_area a, instance_date d, actual_worth w, reg_type_en reg, procedure_name_en proc, property_type_en pt
  FROM transaction_
  WHERE trans_group_en='Sales' AND procedure_name_en IN ('Sell','Sell - Pre registration','Delayed Sell','Sale On Payment Plan')
    AND property_type_en IN ('Unit','Villa') AND procedure_area>10 AND actual_worth>150000
    AND instance_date>='2010-01-01' AND rooms_en IS NOT NULL AND rooms_en<>''""", con)
tx['d'] = pd.to_datetime(tx['d']); tx = tx.sort_values(['pn', 'b', 'r', 'a', 'd'])
print(f'{len(tx):,} sales rows;', tx['proc'].value_counts().to_dict())

def pairs(df, max_group=12):
    g = df.groupby(['pn', 'b', 'r', 'a'], sort=False)
    n = g['d'].transform('size'); df = df[(n >= 2) & (n <= max_group)].copy()
    df['n'] = n[df.index]
    prev = df.groupby(['pn', 'b', 'r', 'a'], sort=False).shift(1)
    p = df[prev['d'].notna()].copy(); pv = prev[prev['d'].notna()]
    p['d0'] = pv['d']; p['w0'] = pv['w']; p['reg0'] = pv['reg']; p['proc0'] = pv['proc']
    p['days'] = (p['d'] - p['d0']).dt.days; p['chg'] = p['w'] / p['w0'] - 1
    return p[(p['days'] >= 30) & (p['chg'] > -0.6) & (p['chg'] < 3)]

def bmn(p, base=2012):
    p = p[p['d0'].dt.year >= base]
    yrs = sorted(set(p['d0'].dt.year) | set(p['d'].dt.year)); idx = {y: i for i, y in enumerate(yrs)}
    X = np.zeros((len(p), len(yrs))); y = np.log(p['w'].values / p['w0'].values)
    X[np.arange(len(p)), p['d'].dt.year.map(idx).values] = 1; X[np.arange(len(p)), p['d0'].dt.year.map(idx).values] -= 1
    X = X[:, 1:]  # base year pinned at 0
    beta = np.linalg.lstsq(X.T @ X + 1e-6 * np.eye(X.shape[1]), X.T @ y, rcond=None)[0]
    return dict(zip(yrs, [100.0] + list(100 * np.exp(beta)))), len(p)

rows = {}
tx['b'] = tx['b'].fillna('') + '|' + tx['pt']   # a Unit never pairs with a Villa
allrows = tx.copy()
print(f"rows without a project number: {tx['pn'].isna().sum():,} of {len(tx):,} (villas without: {(tx['pn'].isna() & (tx['pt']=='Villa')).sum():,})")
tx = tx[tx['pn'].notna()]
units = tx[tx['pt'] == 'Unit']
P = pairs(units)
A = P[(P['reg0'] == 'Existing Properties') & (P['reg'] == 'Existing Properties') & (P['days'] >= 180)]
rows['A ours'] = bmn(A)
B = P[(P['proc0'] == 'Sell') & (P['proc'] == 'Sell') & (P['days'] >= 180)]
rows['B no Delayed Sell'] = bmn(B)
C = P[(P['proc0'] == 'Sell') & (P['proc'] == 'Sell') & (P['days'] >= 90)]
rows['C hold>=90'] = bmn(C)
D = C[C['n'] <= 4]
rows['D key<=4 sales'] = bmn(D)
ann = (1 + D['chg']) ** (365.0 / D['days'].clip(lower=1)) - 1
E = D[(ann > -0.6) & (ann < 0.6)]
rows['E trim 60%/yr'] = bmn(E)
# F: E, but villas in the universe too (Ali's loader keeps Unit and Villa; ours kept Unit only)
PV = pairs(tx)
F0 = PV[(PV['proc0'] == 'Sell') & (PV['proc'] == 'Sell') & (PV['days'] >= 90) & (PV['n'] <= 4)]
annv = (1 + F0['chg']) ** (365.0 / F0['days'].clip(lower=1)) - 1
F = F0[(annv > -0.6) & (annv < 0.6)]
rows['F +villas'] = bmn(F)
# G: F, pairs whose two legs fall in different years only (Ali regresses y1 > y0)
G = F[F['d'].dt.year > F['d0'].dt.year]
rows['G diff years'] = bmn(G)
# H: villas only, for the record
VO = F[F['pt'] == 'Villa']
rows['H villas only'] = bmn(VO)
# I: G, but homes WITHOUT a register project number kept too, keyed on area + building (Ali keys on
#    area + building; the older villa communities carry no project number in the record)
ar = allrows.copy(); ar['pn'] = ar['ar'].fillna('')
PI = pairs(ar.sort_values(['pn', 'b', 'r', 'a', 'd']))
I0 = PI[(PI['proc0'] == 'Sell') & (PI['proc'] == 'Sell') & (PI['days'] >= 90) & (PI['n'] <= 4)]
anni = (1 + I0['chg']) ** (365.0 / I0['days'].clip(lower=1)) - 1
I = I0[(anni > -0.6) & (anni < 0.6)]; I = I[I['d'].dt.year > I['d0'].dt.year]
rows['I area+bldg key'] = bmn(I)

years = list(range(2012, 2027))
print('\n' + 'year'.ljust(6) + ''.join(k.rjust(20) for k in rows))
for yv in years:
    print(str(yv).ljust(6) + ''.join(f"{rows[k][0].get(yv, float('nan')):20.1f}" for k in rows))
print('pairs '.ljust(6) + ''.join(f"{rows[k][1]:20,}" for k in rows))
