"""Binghatti Holding — developer credit workbook (prototype for the credit-desk product).
Every modelled number is a formula on inputs the user can change. No view is expressed."""
import json, datetime as dt
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter as L
from openpyxl.comments import Comment

REG = json.load(open('/home/user/credit/binghatti-register-2026-09-10.json'))
ISS = json.load(open('/home/user/credit/binghatti.json'))
ASOF = dt.date(2026, 9, 10)
FX = 3.6725
KEY_DATES = [('28 Feb 2027 — 9.625% sukuk', dt.date(2027, 2, 28), 5), ('31 Dec 2027', dt.date(2027, 12, 31), 15), ('31 Dec 2028', dt.date(2028, 12, 31), 27)]
NMONTHS = 28  # Oct 2026 .. Jan 2029

# ---------- styles ----------
F = 'Arial'
f_norm = Font(name=F, size=10); f_bold = Font(name=F, size=10, bold=True); f_title = Font(name=F, size=14, bold=True)
f_in = Font(name=F, size=10, color='0000FF'); f_link = Font(name=F, size=10, color='008000'); f_note = Font(name=F, size=9, italic=True, color='555555')
f_hdr = Font(name=F, size=10, bold=True, color='FFFFFF'); f_url = Font(name=F, size=10, color='0563C1', underline='single')
fill_hdr = PatternFill('solid', fgColor='1F3864'); fill_key = PatternFill('solid', fgColor='FFFF00'); fill_sub = PatternFill('solid', fgColor='D9E1F2'); fill_grey = PatternFill('solid', fgColor='F2F2F2')
thin = Side(style='thin', color='BFBFBF'); box = Border(top=thin, bottom=thin, left=thin, right=thin)
N0 = '#,##0;(#,##0);-'; N1 = '#,##0.0;(#,##0.0);-'; N2 = '#,##0.00;(#,##0.00);-'; PCT = '0.0%;(0.0%);-'; PCT0 = '0%;(0%);-'; X = '0.0x;(0.0x);-'; DATE = 'dd mmm yyyy'

wb = Workbook()

def put(ws, ref, v, font=f_norm, fmt=None, fill=None, align=None, wrap=False, comment=None):
    c = ws[ref]; c.value = v; c.font = font
    if fmt: c.number_format = fmt
    if fill: c.fill = fill
    if align or wrap: c.alignment = Alignment(horizontal=align, wrap_text=wrap, vertical='top' if wrap else None)
    if comment: c.comment = Comment(comment, 'DPI')
    return c

def header_row(ws, row, labels, col=1, widths=None):
    for i, lab in enumerate(labels):
        c = ws.cell(row=row, column=col + i, value=lab); c.font = f_hdr; c.fill = fill_hdr; c.alignment = Alignment(wrap_text=True, vertical='center'); c.border = box
    if widths:
        for i, w in enumerate(widths): ws.column_dimensions[L(col + i)].width = w

def title(ws, text, sub=None):
    put(ws, 'A1', text, f_title);
    if sub: put(ws, 'A2', sub, f_note)

AGENTS = [('بنك دبي', 'Dubai Islamic Bank'), ('الإمارات دبي', 'Emirates NBD'), ('الشارقه', 'Sharjah Islamic Bank'), ('ابوظبى الاسلامي', 'Abu Dhabi Islamic Bank'), ('أبوظبي الأول', 'First Abu Dhabi Bank'), ('أبوظبي ا', 'First Abu Dhabi Bank'), ('الفجيره', 'National Bank of Fujairah'), ('العربي', 'Arab Bank'), ('المشرق', 'Mashreq'), ('أبوظبي التجاري', 'Abu Dhabi Commercial Bank')]
def agent(a):
    a = a or ''
    for k, v in AGENTS:
        if k in a: return v
    return a or '—'

def d(s): return dt.datetime.strptime(s[:10], '%Y-%m-%d').date() if s else None

# =====================================================================
# Sheet: Scenarios (inputs)
# =====================================================================
sc = wb.active; sc.title = 'Scenarios'
title(sc, 'Scenario inputs — the only cells the escrow model reads', 'Blue cells are yours to change. Column F is the scenario currently driving the Simulator and the Dashboard. Nothing here is a forecast by DPI: the base column is the register plus the issuer\'s own disclosed payment terms.')
put(sc, 'A3', 'Active scenario (1–4)', f_bold); put(sc, 'B3', 1, f_in, fill=fill_key, comment='Type 1, 2, 3 or 4. Every formula on the Simulator and Dashboard follows this cell.')
put(sc, 'C3', '=INDEX(B4:E4,1,$B$3)', f_norm)
header_row(sc, 4, ['Input', 'Base', 'Delayed handovers', 'Cancellation spike', 'Price cut', 'Active', 'What it does'], widths=[52, 14, 16, 16, 14, 12, 90])
SCN = [
 ('Handover delay added to every registered completion date (months)', [0, 6, 0, 0], N0, 'The register date is what the developer filed. Base takes it at face value; "delayed" pushes every tower back by this many months.'),
 ('Months to completion for projects already past their registered date', [6, 12, 6, 6], N0, 'A tower whose date has passed has no useful date in the register. This is how long the model gives it from today.'),
 ('Months to completion for projects with no registered date', [24, 30, 24, 24], N0, 'Four active towers carry no completion date at all.'),
 ('Cancellation rate — share of contracted value that is never collected', [0, 0, 0.15, 0.05], PCT, 'Buyers who default on instalments. Applied to the remaining collections on every project.'),
 ('Sell-through of unsold units before completion', [0.6, 0.4, 0.4, 0.6], PCT, 'Share of currently unsold units that sell (and start paying) before handover.'),
 ('Price change on those future sales', [0, 0, 0, -0.15], PCT, 'Applied to the average ticket of each project for units still to be sold.'),
 ('Share of price collected at sale (booking)', [0.10, 0.10, 0.10, 0.10], PCT, 'Issuer discloses ~70% collected during construction including booking; 10/60/30 is the plan shape used here. Change it to the plan you know.'),
 ('Share of price collected at handover', [0.30, 0.30, 0.30, 0.30], PCT, 'The final instalment. Between booking and handover, collections track certified progress.'),
 ('RERA escrow retention held until one year after completion', [0.05, 0.05, 0.05, 0.05], PCT, 'Not released within the model horizon; treated as unavailable cash.'),
 ('Maximum certified progress per month (percentage points)', [8, 6, 8, 8], N1, 'A tower cannot be certified faster than it can be built. Caps the pace the model implies from the completion date.'),
]
for i, (lab, vals, fmt, why) in enumerate(SCN):
    r = 5 + i
    put(sc, f'A{r}', lab)
    for j, v in enumerate(vals): put(sc, f'{L(2+j)}{r}', v, f_in, fmt)
    put(sc, f'F{r}', f'=INDEX(B{r}:E{r},1,$B$3)', f_norm, fmt, fill=fill_grey)
    put(sc, f'G{r}', why, f_note, wrap=True)
    sc.row_dimensions[r].height = 30
# named positions
S = {k: 5 + i for i, k in enumerate(['delay', 'pastdue', 'undated', 'cancel', 'sell', 'price', 'book', 'hand', 'ret', 'cap'])}
COLS = {1: 'B', 2: 'C', 3: 'D', 4: 'E', 'act': 'F'}
def sref(key, scn='act'): return f"Scenarios!${COLS[scn]}${S[key]}"
put(sc, 'A17', 'How the model turns these into cash', f_bold)
put(sc, 'A18', 'For each live project: collected-to-date = contracted value × (booking + (1 − booking − handover) × certified %). Future months: certified % rises at the pace implied by the projected completion date (capped), collections follow, and at 100% the handover share is paid. Escrow does not hand the developer what has been collected: RERA releases collections in step with certified progress, so released = collected × certified %, less the retention — which is why the company reports AED 10.2 bn still sitting in escrow. Monthly release = the change in that cumulative figure. Contracted value = sold units × average registered ticket, plus future sales of unsold units at the sell-through and price change above.', f_note, wrap=True)
sc.merge_cells('A18:G18'); sc.row_dimensions[18].height = 70
sc.freeze_panes = 'B5'

# =====================================================================
# Sheet: Simulator
# =====================================================================
sim = wb.create_sheet('Simulator')
title(sim, 'Escrow release simulator — live projects', 'Register facts in blue (change them if you know better); everything to the right is arithmetic on the active scenario. AED millions unless stated.')
put(sim, 'A3', 'As of'); put(sim, 'C3', ASOF, f_in, DATE, fill=fill_key, comment='Register read date. Month 1 of the grid is the following month.')
put(sim, 'A4', 'Active scenario'); put(sim, 'C4', '=Scenarios!$C$3', f_link)
put(sim, 'E3', 'Register readings: certified % and dates are the latest observation per project (DLD register 15 Jun 2026, updated by the 30 Aug 2026 register extract where available). Units and sales are from the DLD transactions register to the as-of date.', f_note, wrap=True); sim.merge_cells('E3:T4'); sim.row_dimensions[3].height = 28

live = [x for x in REG if x['status'] != 'FINISHED']
live.sort(key=lambda x: (x['registered_completion'] or '9999-12-31', x['name']))
base_cols = ['Project no.', 'Project', 'Status', 'Last read', 'Units', 'Sold units', 'Avg ticket (AED)', 'Certified %', 'Registered completion', 'Contracted value', 'Unsold units', 'Sold %',
             'Projected completion', 'Months to go', 'Pace %/mo', 'Effective contracted value', 'Released from escrow to date (est.)', 'Release by 28 Feb 2027', 'Release by 31 Dec 2027', 'Release by 31 Dec 2028', 'Collected to date (est.)']
HR = 7; R0 = 8
header_row(sim, HR, base_cols, widths=[10, 34, 11, 11, 8, 9, 13, 10, 13, 12, 9, 8, 13, 9, 9, 13, 13, 13, 13, 13, 13])
# monthly grid headers
GC0 = len(base_cols) + 1  # first grid column index (U = 21)
months = []
y, m = ASOF.year, ASOF.month
for t in range(1, NMONTHS + 1):
    m += 1
    if m > 12: m = 1; y += 1
    months.append(dt.date(y, m, 1))
for t, md in enumerate(months, start=1):
    c = sim.cell(row=HR, column=GC0 + t - 1, value=md); c.number_format = 'mmm yy'; c.font = f_hdr; c.fill = fill_hdr; c.alignment = Alignment(horizontal='center'); sim.column_dimensions[L(GC0 + t - 1)].width = 8
    sim.cell(row=HR - 1, column=GC0 + t - 1, value=t).font = f_note
put(sim, f'{L(GC0)}{HR-2}', 'Cumulative future escrow release under the active scenario, AED m (month index in the row below)', f_bold)
# scenario blocks (to the right of the grid), 7 cols each
SB0 = GC0 + NMONTHS + 1
blk = ['Months', 'Pace', 'Eff. value', 'Released to date', 'By Feb-27', 'By Dec-27', 'By Dec-28']
for s in range(1, 5):
    c0 = SB0 + (s - 1) * 7
    put(sim, f'{L(c0)}{HR-2}', f'Scenario {s}: ' + ['Base', 'Delayed handovers', 'Cancellation spike', 'Price cut'][s - 1], f_bold)
    header_row(sim, HR, blk, col=c0, widths=[8, 8, 11, 11, 11, 11, 11])

def curve(pcell, scn):  # share of price COLLECTED at certified % p
    return f"IF({pcell}>=100,1,{sref('book',scn)}+(1-{sref('book',scn)}-{sref('hand',scn)})*{pcell}/100)"
def rel(pcell, scn):    # share of price RELEASED from escrow: collections, drawn down in step with certified progress
    return f"({curve(pcell, scn)}*MIN(1,{pcell}/100))"

last_row = R0 + len(live) - 1
for i, x in enumerate(live):
    r = R0 + i
    units = x['units'] or 0; noff = x['n_off'] or 0
    units_eff = units if units > 0 else noff
    sold = min(units_eff, noff)
    avg = (x['v_off'] / noff) if noff else 0
    put(sim, f'A{r}', x['pn']); put(sim, f'B{r}', x['name']); put(sim, f'C{r}', x['status'].replace('_', ' ').title()); put(sim, f'D{r}', d(x['last_read']), fmt=DATE)
    put(sim, f'E{r}', units_eff, f_in, N0, comment=None if units > 0 else 'Register carries 0 units for this project; registered off-plan sales used instead.')
    put(sim, f'F{r}', sold, f_in, N0, comment='Registered off-plan sales, capped at units (resales of the same unit are not separated).')
    put(sim, f'G{r}', round(avg), f_in, N0, comment='Registered off-plan sales value ÷ number of off-plan sales.')
    put(sim, f'H{r}', x['pct'] or 0, f_in, N1)
    put(sim, f'I{r}', d(x['registered_completion']), f_in, DATE)
    put(sim, f'J{r}', f'=F{r}*G{r}/1000000', fmt=N0)
    put(sim, f'K{r}', f'=MAX(0,E{r}-F{r})', fmt=N0)
    put(sim, f'L{r}', f'=IF(E{r}>0,F{r}/E{r},0)', fmt=PCT0)
    # active-scenario helpers
    put(sim, f'M{r}', f'=IF(I{r}="",EDATE($C$3,{sref("undated")}),IF(I{r}<$C$3,EDATE($C$3,{sref("pastdue")}),EDATE(I{r},{sref("delay")})))', fmt=DATE)
    put(sim, f'N{r}', f'=MAX(1,(YEAR(M{r})-YEAR($C$3))*12+MONTH(M{r})-MONTH($C$3))', fmt=N0)
    put(sim, f'O{r}', f'=MIN({sref("cap")},(100-H{r})/N{r})', fmt=N1)
    put(sim, f'P{r}', f'=J{r}*(1-{sref("cancel")})+K{r}*G{r}/1000000*{sref("sell")}*(1+{sref("price")})', fmt=N0)
    put(sim, f'Q{r}', f'=J{r}*{rel(f"H{r}","act")}*(1-{sref("ret")})', fmt=N0)
    for t in range(1, NMONTHS + 1):
        col = L(GC0 + t - 1)
        p = f'MIN(100,$H{r}+$O{r}*{col}${HR-1})'
        put(sim, f'{col}{r}', f'=MAX(0,$P{r}*{rel(p,"act")}*(1-{sref("ret")})-$Q{r})', fmt=N0)
    for k, (_, _, t) in enumerate(KEY_DATES):
        put(sim, f'{L(18+k)}{r}', f'={L(GC0+t-1)}{r}', fmt=N0)
    put(sim, f'U{r}', f'=J{r}*{curve(f"H{r}","act")}', fmt=N0)
    # per-scenario blocks
    for s in range(1, 5):
        c0 = SB0 + (s - 1) * 7
        mcol, pcol, vcol, rcol = L(c0), L(c0 + 1), L(c0 + 2), L(c0 + 3)
        proj = f'IF(I{r}="",EDATE($C$3,{sref("undated",s)}),IF(I{r}<$C$3,EDATE($C$3,{sref("pastdue",s)}),EDATE(I{r},{sref("delay",s)})))'
        put(sim, f'{mcol}{r}', f'=MAX(1,(YEAR({proj})-YEAR($C$3))*12+MONTH({proj})-MONTH($C$3))', fmt=N0)
        put(sim, f'{pcol}{r}', f'=MIN({sref("cap",s)},(100-H{r})/{mcol}{r})', fmt=N1)
        put(sim, f'{vcol}{r}', f'=J{r}*(1-{sref("cancel",s)})+K{r}*G{r}/1000000*{sref("sell",s)}*(1+{sref("price",s)})', fmt=N0)
        put(sim, f'{rcol}{r}', f'=J{r}*{rel(f"H{r}",s)}*(1-{sref("ret",s)})', fmt=N0)
        for k, (_, _, t) in enumerate(KEY_DATES):
            p = f'MIN(100,$H{r}+{pcol}{r}*{t})'
            put(sim, f'{L(c0+4+k)}{r}', f'=MAX(0,{vcol}{r}*{rel(p,s)}*(1-{sref("ret",s)})-{rcol}{r})', fmt=N0)
TR = last_row + 1
put(sim, f'B{TR}', 'Total, all live projects', f_bold)
for col in ['E', 'F', 'J', 'K', 'P', 'Q', 'R', 'S', 'T', 'U'] + [L(GC0 + t - 1) for t in range(1, NMONTHS + 1)] + [L(SB0 + (s - 1) * 7 + j) for s in range(1, 5) for j in (2, 3, 4, 5, 6)]:
    put(sim, f'{col}{TR}', f'=SUM({col}{R0}:{col}{last_row})', f_bold, N0, fill=fill_sub)
put(sim, f'B{TR+1}', 'Monthly release (change in cumulative)', f_bold)
for t in range(1, NMONTHS + 1):
    col = L(GC0 + t - 1); prev = L(GC0 + t - 2)
    put(sim, f'{col}{TR+1}', f'={col}{TR}' if t == 1 else f'={col}{TR}-{prev}{TR}', f_norm, N0)
put(sim, f'B{TR+3}', 'Reading the row: a tower at 30% certified with a registered date already passed is given the "past due" months; its pace is (100 − 30) ÷ months, capped. Release is what collections exceed what has already been released. Retention is never released inside the horizon. A project with sold units above register units is capped at 100% sold.', f_note, wrap=True)
sim.merge_cells(f'B{TR+3}:T{TR+4}'); sim.row_dimensions[TR + 3].height = 40
# outline: collapse scenario blocks
sim.column_dimensions.group(L(SB0), L(SB0 + 27), hidden=True)
sim.freeze_panes = f'C{R0}'

# =====================================================================
# Sheet: Debt (instruments, schedule, covenants)
# =====================================================================
db = wb.create_sheet('Debt')
title(db, 'Debt and covenants', 'Sukuk from the offering circulars and exchange listings; bank debt from the H1 2026 accounts and rating reports. Bank maturity dates within a year are assumptions (blue) — the accounts give amounts by period, not dates.')
put(db, 'A3', 'AED per USD'); put(db, 'B3', FX, f_in, N2, fill=fill_key)
header_row(db, 5, ['Instrument', 'ISIN', 'Type', 'Size (USD m)', 'Size (AED m)', 'Coupon', 'Issued', 'Maturity', 'Listing', 'Ranking / security', 'Notes'], widths=[34, 16, 12, 12, 12, 9, 18, 13, 20, 42, 60])
DEBT = [
 ('9.625% sukuk due 28 Feb 2027', 'XS2753304349', 'Sukuk', 500, 0.09625, 'Feb 2024 + Jul 2024 tap', dt.date(2027, 2, 28), 'Nasdaq Dubai · LSE', 'Senior unsecured (trust certificates)', 'Bullet; no call.'),
 ('7.75% green sukuk due 2 Jul 2029', 'XS3187728277', 'Sukuk', 500, 0.0775, 'Oct 2025', dt.date(2029, 7, 2), 'Nasdaq Dubai · LSE ISM', 'Senior unsecured', ''),
 ('8.125% sukuk due 7 Aug 2030', 'XS3145700491', 'Sukuk', 500, 0.08125, 'Aug 2025', dt.date(2030, 8, 7), 'Nasdaq Dubai · LSE ISM', 'Senior unsecured', '5x covered at issue.'),
 ('8.375% sukuk due 12 Aug 2031', 'XS3289056395', 'Sukuk', 500, 0.08375, 'Feb 2026', dt.date(2031, 8, 12), 'Nasdaq Dubai · LSE ISM', 'Senior unsecured', 'Longest tenor by a UAE private developer.'),
 ('Secured bank debt — due H2 2026', '', 'Bank', 281, None, 'various', dt.date(2026, 12, 31), '—', 'Secured on land (AED 3.7 bn of mortgages), shareholder guarantees', 'Date assumed: end of the period the accounts give. 3M EIBOR + 2.0–2.75%.'),
 ('Secured bank debt — due H1 2027', '', 'Bank', 188, None, 'various', dt.date(2027, 6, 30), '—', 'Secured on land, shareholder guarantees', 'Split assumed. H2 2026 + H1 2027 bank debt + the Feb-2027 sukuk = AED 3,56x m, the current portion of borrowings in the 30 Jun 2026 accounts.'),
 ('Secured bank debt — due H2 2027', '', 'Bank', 322, None, 'various', dt.date(2027, 12, 31), '—', 'Secured on land, shareholder guarantees', 'Balance of the USD 510m the rating reports place in 2027. Date assumed.'),
 ('Secured bank debt — due 2028', '', 'Bank', 374, None, 'various', dt.date(2028, 6, 30), '—', 'Secured on land, shareholder guarantees', 'Date assumed mid-year.'),
]
for i, row in enumerate(DEBT):
    r = 6 + i
    name, isin, typ, usd, cpn, issued, mat, listing, rank, note = row
    put(db, f'A{r}', name); put(db, f'B{r}', isin); put(db, f'C{r}', typ); put(db, f'D{r}', usd, f_in, N0); put(db, f'E{r}', f'=D{r}*$B$3', fmt=N0)
    put(db, f'F{r}', cpn, f_in, PCT if cpn else None); put(db, f'G{r}', issued); put(db, f'H{r}', mat, f_in if typ == 'Bank' else f_norm, DATE); put(db, f'I{r}', listing); put(db, f'J{r}', rank, wrap=True); put(db, f'K{r}', note, f_note, wrap=True)
DR0, DR1 = 6, 6 + len(DEBT) - 1
put(db, f'A{DR1+1}', 'Total', f_bold); put(db, f'D{DR1+1}', f'=SUM(D{DR0}:D{DR1})', f_bold, N0); put(db, f'E{DR1+1}', f'=SUM(E{DR0}:E{DR1})', f_bold, N0)
put(db, f'A{DR1+2}', 'Accounts, 30 Jun 2026: gross debt AED 11,521m (sukuk ~7.2bn, bank ~4.3bn); current portion AED 3,560m. The instrument list reconciles to USD 3,165m ≈ AED 11.6bn (FX and accrued profit explain the difference), and the lines dated up to 30 Jun 2027 sum to the current portion.', f_note, wrap=True); db.merge_cells(f'A{DR1+2}:K{DR1+2}')
put(db, f'A{DR1+3}', 'Due within 12 months of the accounts (to 30 Jun 2027), from the schedule'); put(db, f'E{DR1+3}', f'=SUMIFS(E{DR0}:E{DR1},H{DR0}:H{DR1},"<="&DATE(2027,6,30))', f_bold, N0); put(db, f'F{DR1+3}', 'vs 3,560 reported', f_note)
# maturity wall
W0 = DR1 + 6
put(db, f'A{W0-1}', 'Maturity wall (AED m)', f_bold)
header_row(db, W0, ['Year', 'Sukuk', 'Bank', 'Total'], widths=None)
for i, yr in enumerate(range(2026, 2032)):
    r = W0 + 1 + i
    put(db, f'A{r}', str(yr))
    put(db, f'B{r}', f'=SUMPRODUCT((YEAR($H${DR0}:$H${DR1})={yr})*($C${DR0}:$C${DR1}="Sukuk")*$E${DR0}:$E${DR1})', fmt=N0)
    put(db, f'C{r}', f'=SUMPRODUCT((YEAR($H${DR0}:$H${DR1})={yr})*($C${DR0}:$C${DR1}="Bank")*$E${DR0}:$E${DR1})', fmt=N0)
    put(db, f'D{r}', f'=B{r}+C{r}', f_bold, N0)
# covenants
C0 = W0 + 9
put(db, f'A{C0-1}', 'Bank covenants (from the financing notes) against reported figures', f_bold)
header_row(db, C0, ['Covenant', 'Threshold', 'Reported / computed, H1 2026', 'Headroom', 'Basis', 'Note'], widths=None)
COV = [
 ('Net debt / equity', 1.25, '=Financials!D32', 'max', 'Computed with ALL escrow counted as cash. The company counts only the releasable part and reports 0.35x; with no escrow counted it is 1.14x (Financials row 27). The covenant is tested on the company\'s definition.', ''),
 ('Net debt / EBITDA', 2.5, '=Financials!D26', 'max', 'Same three bases: all escrow 0.1x here; company (releasable escrow) 0.56x; no escrow 1.5x (row 25). H1 annualised.', ''),
 ('EBITDA / interest', 2.0, '=Financials!D28', 'min', 'H1 annualised on both sides.', ''),
 ('Dividends', 'None permitted', 'None paid', '', 'Under the sukuk and bank terms.', ''),
]
for i, (lab, thr, val, kind, basis, note) in enumerate(COV):
    r = C0 + 1 + i
    put(db, f'A{r}', lab); put(db, f'B{r}', thr, f_in, X if isinstance(thr, float) else None); put(db, f'C{r}', val, f_link if str(val).startswith('=') else f_norm, X if isinstance(thr, float) else None)
    if kind == 'max': put(db, f'D{r}', f'=B{r}-C{r}', fmt=X)
    elif kind == 'min': put(db, f'D{r}', f'=C{r}-B{r}', fmt=X)
    put(db, f'E{r}', basis, f_note, wrap=True)
db.freeze_panes = 'A6'

# =====================================================================
# Sheet: Financials
# =====================================================================
fin = wb.create_sheet('Financials')
title(fin, 'Financial statements, standardised (AED m)', 'FY2024 and FY2025 audited (Deloitte); H1 2026 reviewed interim. Ratios are computed here from these lines, not copied from the company presentation.')
header_row(fin, 4, ['Line', 'FY2024', 'FY2025', 'H1 2026', 'Note'], widths=[46, 12, 12, 12, 80])
P = {p['label']: p for p in ISS['periods']}
LINES = [('Revenue', 'revenue'), ('Gross profit', 'grossProfit'), ('EBITDA', 'ebitda'), ('Net profit', 'netProfit'), ('Total assets', 'totalAssets'), ('Cash and bank balances', 'cash'), ('  of which in RERA escrow', 'escrow'), ('Gross debt', 'debt'), ('Equity', 'equity'), ('Customer advances (contract liabilities)', 'contractLiabilities'), ('Revenue backlog', 'backlog'), ('Presales in the period', 'sales'), ('Cash from operations', 'cfo'), ('Finance cost', 'financeCost')]
for i, (lab, key) in enumerate(LINES):
    r = 5 + i
    put(fin, f'A{r}', lab)
    for j, per in enumerate(['FY2024', 'FY2025', 'H1 2026']):
        put(fin, f'{L(2+j)}{r}', P[per].get(key), f_in, N0)
    if key == 'ebitda': put(fin, f'E{r}', P['H1 2026'].get('note', ''), f_note, wrap=True)
# r: 5 rev,6 gp,7 ebitda,8 np,9 ta,10 cash,11 escrow,12 debt,13 equity,14 cl,15 backlog,16 sales,17 cfo,18 fincost
put(fin, 'A19', 'Cash outside escrow', f_bold)
for j in range(3): put(fin, f'{L(2+j)}19', f'={L(2+j)}10-{L(2+j)}11', f_bold, N0)
put(fin, 'E19', 'Moody\'s "unrestricted cash". The only cash that can repay a bond; escrow belongs to the projects.', f_note, wrap=True)
put(fin, 'A20', 'Debt due within 12 months', f_bold); put(fin, 'D20', 3560, f_in, N0, fill=fill_key, comment='From the 30 Jun 2026 interim accounts: current portion of borrowings including the Feb-2027 sukuk. Change if you read it differently.')
put(fin, 'B20', None); put(fin, 'C20', None)
put(fin, 'A21', 'EBITDA, annualised for H1', f_note); put(fin, 'B21', '=B7', fmt=N0); put(fin, 'C21', '=C7', fmt=N0); put(fin, 'D21', '=D7*2', fmt=N0); put(fin, 'E21', 'H1 doubled. The company reports LTM; doubling a strong half flatters the ratio slightly — read the H1 column with that in mind.', f_note, wrap=True)
put(fin, 'A22', 'Finance cost, annualised for H1', f_note); put(fin, 'B22', '=B18', fmt=N0); put(fin, 'C22', '=C18', fmt=N0); put(fin, 'D22', '=D18*2', fmt=N0)
put(fin, 'A23', 'Ratios (computed)', f_bold)
RAT = [('Gross debt / EBITDA', '=IF({c}21>0,{c}12/{c}21,"n/a")', X), ('Net debt (ex-escrow cash) / EBITDA', '=IF({c}21>0,({c}12-{c}19)/{c}21,"n/a")', X), ('Company-basis net debt / EBITDA (escrow counted as cash)', '=IF({c}21>0,({c}12-{c}10)/{c}21,"n/a")', X), ('Net debt (ex-escrow cash) / equity', '=IF({c}13>0,({c}12-{c}19)/{c}13,"n/a")', X), ('EBITDA / finance cost', '=IF({c}22>0,{c}21/{c}22,"n/a")', X), ('Cash outside escrow / debt due within 12 months', '=IF({c}20>0,{c}19/{c}20,"")', X), ('Escrow as share of reported cash', '=IF({c}10>0,{c}11/{c}10,"n/a")', PCT), ('Gross debt / equity', '=IF({c}13>0,{c}12/{c}13,"n/a")', X), ('Company-basis net debt / equity (escrow counted as cash)', '=IF({c}13>0,({c}12-{c}10)/{c}13,"n/a")', X)]
for i, (lab, fml, fmt) in enumerate(RAT):
    r = 24 + i
    put(fin, f'A{r}', lab)
    for j in range(3):
        c = L(2 + j)
        put(fin, f'{c}{r}', fml.format(c=c), fmt=fmt)
put(fin, 'E24', 'Bank covenant ≤ 2.5x on the company\'s net basis.', f_note); put(fin, 'E27', 'Bank covenant ≤ 1.25x on the company\'s basis.', f_note); put(fin, 'E28', 'Bank covenant ≥ 2.0x. H1 finance cost is annualised to match annualised EBITDA.', f_note); put(fin, 'E29', 'The liquidity test. Below 1.0x the company needs handovers or new money to pay what is due — the number that triggered Moody\'s review.', f_note, wrap=True)
put(fin, 'A35', 'Sources', f_bold)
for i, s in enumerate(ISS['sources'][:6]):
    put(fin, f'A{36+i}', f'=HYPERLINK("{s["url"]}","{s["title"]} ({s["date"]})")', f_url)
fin.freeze_panes = 'B5'

# =====================================================================
# Sheet: Bonds (price inputs → yield)
# =====================================================================
bd = wb.create_sheet('Bonds')
title(bd, 'Sukuk pricing — enter the prices you see', 'Prices are yours to paste (blue). Defaults are indicative bank quotes from 4 Sep 2026, NOT traded prices, and will be stale by the time you open this. Yield uses semi-annual profit distributions, 30/360.')
put(bd, 'A3', 'Settlement / as of'); put(bd, 'B3', ASOF, f_in, DATE, fill=fill_key)
put(bd, 'A4', 'Benchmark yield for spread (e.g. UST of matching tenor)'); put(bd, 'B4', 0.04, f_in, PCT, fill=fill_key, comment='Enter the risk-free yield you want the spread measured against. One cell for all four for simplicity — replace per line if you prefer.')
header_row(bd, 6, ['Sukuk', 'ISIN', 'Coupon', 'Maturity', 'Price (bid)', 'Price (ask)', 'YTM at bid', 'YTM at ask', 'Spread at bid (bp)', 'Price if yield +100bp', 'Years to maturity', 'Indicative source'], widths=[32, 16, 9, 13, 11, 11, 11, 11, 13, 14, 11, 40])
BONDS = [('9.625% sukuk due 28 Feb 2027', 'XS2753304349', 0.09625, dt.date(2027, 2, 28), 98.25, 99.75), ('7.75% green sukuk due 2 Jul 2029', 'XS3187728277', 0.0775, dt.date(2029, 7, 2), 87.5, 89.25), ('8.125% sukuk due 7 Aug 2030', 'XS3145700491', 0.08125, dt.date(2030, 8, 7), 84.5, 86.5), ('8.375% sukuk due 12 Aug 2031', 'XS3289056395', 0.08375, dt.date(2031, 8, 12), 84.5, 86.25)]
for i, (name, isin, cpn, mat, bid, ask) in enumerate(BONDS):
    r = 7 + i
    put(bd, f'A{r}', name); put(bd, f'B{r}', isin); put(bd, f'C{r}', cpn, f_in, PCT); put(bd, f'D{r}', mat, f_in, DATE)
    put(bd, f'E{r}', bid, f_in, N2, fill=fill_key); put(bd, f'F{r}', ask, f_in, N2, fill=fill_key)
    put(bd, f'G{r}', f'=YIELD($B$3,D{r},C{r},E{r},100,2,0)', fmt=PCT); put(bd, f'H{r}', f'=YIELD($B$3,D{r},C{r},F{r},100,2,0)', fmt=PCT)
    put(bd, f'I{r}', f'=(G{r}-$B$4)*10000', fmt=N0); put(bd, f'J{r}', f'=PRICE($B$3,D{r},C{r},G{r}+0.01,100,2,0)', fmt=N2); put(bd, f'K{r}', f'=(D{r}-$B$3)/365.25', fmt=N1)
    put(bd, f'L{r}', 'DIB indicative run, 4 Sep 2026 — replace', f_note)
put(bd, 'A12', 'A price far below par with a yield well above the coupon is the market saying the issuer cannot refinance at the old rate; the Feb-2027 line near par says the market expects that one to be paid. Spread is a simple difference to the benchmark cell, not a Z-spread — swap in your own curve if you need one.', f_note, wrap=True); bd.merge_cells('A12:L13'); bd.row_dimensions[12].height = 30
bd.freeze_panes = 'A7'

# =====================================================================
# Sheet: Projects (register facts, all 68)
# =====================================================================
pr = wb.create_sheet('Projects')
title(pr, 'Every Binghatti project on the Dubai Land Department register', f'Developer no. 1051. Register read {ASOF:%d %b %Y}. Sales are registered transactions; "12m" is the twelve months to the as-of date; resales are matched pairs of the same unit sold twice in the last 24 months.')
cols = ['Project no.', 'Project', 'Area', 'Status', 'Certified %', 'Registered completion', 'First-seen completion', 'Last read', 'Units', 'Off-plan sales (all time)', 'Off-plan value (AED m)', 'All sales (all time)', 'Sales 12m', 'Value 12m (AED m)', 'Sales prior 12m', 'Sales 90d', 'Avg AED/sqm 12m', 'Mortgages 12m', 'Resales 24m', 'Resales at a loss', 'Avg resale change %', 'Avg hold (days)', 'Escrow agent', 'First sale', 'Last sale', 'Project start']
header_row(pr, 4, cols, widths=[9, 34, 22, 12, 9, 12, 12, 11, 8, 10, 11, 10, 9, 11, 9, 8, 11, 9, 9, 9, 10, 9, 24, 11, 11, 11])
order = {'ACTIVE': 0, 'PENDING': 1, 'NOT_STARTED': 2, 'FINISHED': 3}
allp = sorted(REG, key=lambda x: (order.get(x['status'], 9), x['registered_completion'] or '9999'))
for i, x in enumerate(allp):
    r = 5 + i
    vals = [x['pn'], x['name'], x['area'], (x['status'] or '').replace('_', ' ').title(), x['pct'], d(x['registered_completion']), d(x['planned_completion']), d(x['last_read']), x['units'], x['n_off'], (x['v_off'] or 0) / 1e6, x['n_all'], x['n12'], (x['v12'] or 0) / 1e6, x['n12prev'], x['n90'], x['avg_psm12'], x['mort12'], x['rs_n'], x['rs_loss'], (x['rs_avg_pct'] or None), x['rs_hold'], agent(x['escrow_agent']), d(x['first_sale']), d(x['last_sale']), d(x['start_date'])]
    fmts = [None, None, None, None, N1, DATE, DATE, DATE, N0, N0, N1, N0, N0, N1, N0, N0, N0, N0, N0, N0, N1, N0, None, DATE, DATE, DATE]
    for j, (v, fmt) in enumerate(zip(vals, fmts)):
        put(pr, f'{L(1+j)}{r}', v, fmt=fmt)
PR1 = 5 + len(allp) - 1
put(pr, f'B{PR1+1}', 'Total', f_bold)
for col in ['I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T']:
    put(pr, f'{col}{PR1+1}', f'=SUM({col}5:{col}{PR1})', f_bold, N1 if col in ('K', 'N') else N0, fill=fill_sub)
put(pr, f'B{PR1+3}', 'Certified % and dates are the register\'s own (DLD project register, 15 Jun 2026 dump; 30 Aug 2026 register extract where a later reading exists). A finished building can read below 100% until its certificate is issued. Resale change is before costs.', f_note, wrap=True); pr.merge_cells(f'B{PR1+3}:L{PR1+4}')
pr.freeze_panes = 'C5'
pr.auto_filter.ref = f'A4:{L(len(cols))}{PR1}'

# =====================================================================
# Sheet: Ratings & sources
# =====================================================================
rs = wb.create_sheet('Ratings & sources')
title(rs, 'Ratings, filings and links', 'Public rating actions with the agencies\' own rationale. Full rating reports sit behind Moody\'s and Fitch subscriptions and are linked, not reproduced.')
header_row(rs, 4, ['Date', 'Agency', 'Action', 'Agency rationale (summarised)'], widths=[12, 10, 40, 100])
for i, a in enumerate(ISS['ratingsHistory']):
    r = 5 + i
    put(rs, f'A{r}', a['date']); put(rs, f'B{r}', a['agency']); put(rs, f'C{r}', a['action'], wrap=True); put(rs, f'D{r}', a['why'], wrap=True)
R1 = 5 + len(ISS['ratingsHistory'])
put(rs, f'A{R1+1}', 'Current: ' + ISS['header']['ratings'], f_bold)
put(rs, f'A{R1+3}', 'Filings and documents', f_bold)
for i, s in enumerate(ISS['sources']):
    put(rs, f'A{R1+4+i}', s['date']); put(rs, f'B{R1+4+i}', f'=HYPERLINK("{s["url"]}","{s["title"]}")', f_url)
R2 = R1 + 4 + len(ISS['sources']) + 1
put(rs, f'A{R2}', 'Where to look', f_bold)
LINKS = [('Issuer investor relations', 'https://www.binghatti.com/investor-relations'), ('Moody\'s — issuer search', 'https://www.moodys.com/search?keyword=Binghatti'), ('Fitch Ratings — issuer search', 'https://www.fitchratings.com/search/?query=Binghatti'), ('Nasdaq Dubai — listed sukuk', 'https://www.nasdaqdubai.com/'), ('London Stock Exchange — RNS and ISM listings', 'https://www.londonstockexchange.com/'), ('Dubai Land Department — project register (open data)', 'https://dubailand.gov.ae/en/open-data/'), ('Dubai Pulse — DLD datasets', 'https://www.dubaipulse.gov.ae/')]
for i, (lab, url) in enumerate(LINKS):
    put(rs, f'A{R2+1+i}', lab); put(rs, f'B{R2+1+i}', f'=HYPERLINK("{url}","{url}")', f_url)
put(rs, f'A{R2+9}', 'Gaps we could not close', f_bold)
for i, g in enumerate(ISS['gaps']):
    put(rs, f'A{R2+10+i}', '• ' + g, f_note, wrap=True); rs.merge_cells(f'A{R2+10+i}:D{R2+10+i}'); rs.row_dimensions[R2 + 10 + i].height = 28

# =====================================================================
# Sheet: Dashboard (first)
# =====================================================================
ds = wb.create_sheet('Dashboard', 0)
title(ds, 'Binghatti Holding — liquidity against maturities, from the register', 'Can the escrow release from towers under construction, plus the cash the company holds outside escrow, meet the debt falling due? Every number below is a register fact, a filed figure, or arithmetic on the scenario inputs. DPI expresses no view.')
put(ds, 'A3', 'As of'); put(ds, 'B3', '=Simulator!$C$3', f_link, DATE)
put(ds, 'A4', 'Active scenario'); put(ds, 'B4', '=Scenarios!$C$3', f_link); put(ds, 'C4', 'change on the Scenarios sheet, cell B3', f_note)
put(ds, 'A5', 'Cash outside escrow, AED m (30 Jun 2026)'); put(ds, 'B5', '=Financials!D19', f_link, N0); put(ds, 'C5', 'from the accounts; the company reported AED 1.8 bn received from three handovers since June — add it in D5 if you accept it', f_note)
put(ds, 'D5', 0, f_in, N0, fill=fill_key, comment='Cash received since the balance sheet date that you choose to count. Default 0.')
put(ds, 'A6', 'Legend', f_bold); put(ds, 'B6', 'blue = input you can change', f_in); put(ds, 'C6', 'black = formula'); put(ds, 'D6', 'green = pulled from another sheet', f_link); put(ds, 'E6', 'yellow = key assumption', fill=fill_key)

put(ds, 'A8', '1. Liquidity coverage by maturity date — all four scenarios', f_bold)
header_row(ds, 9, ['Date', 'Debt due by then (AED m)', 'Cash outside escrow + received', 'Scenario', 'Modelled escrow release by then', 'Coverage (x)', 'Shortfall (AED m)'], widths=[36, 16, 16, 20, 16, 12, 14])
r = 10
SCN_NAMES = ['Base', 'Delayed handovers', 'Cancellation spike', 'Price cut']
for k, (lab, kd, t) in enumerate(KEY_DATES):
    for s in range(1, 5):
        put(ds, f'A{r}', lab if s == 1 else '', f_bold if s == 1 else f_norm)
        put(ds, f'B{r}', f'=SUMIFS(Debt!$E${DR0}:$E${DR1},Debt!$H${DR0}:$H${DR1},"<="&DATE({kd.year},{kd.month},{kd.day}))', f_link, N0)
        put(ds, f'C{r}', '=$B$5+$D$5', fmt=N0)
        put(ds, f'D{r}', SCN_NAMES[s - 1])
        col = L(SB0 + (s - 1) * 7 + 4 + k)
        put(ds, f'E{r}', f'=Simulator!{col}{TR}', f_link, N0)
        put(ds, f'F{r}', f'=IF(B{r}>0,(C{r}+E{r})/B{r},"")', f_bold, X)
        put(ds, f'G{r}', f'=MAX(0,B{r}-C{r}-E{r})', fmt=N0)
        if s == 1:
            for c in 'ABCDEFG': ds[f'{c}{r}'].fill = fill_sub
        r += 1
put(ds, f'A{r}', 'Debt due is cumulative from today to the date shown: the Feb-2027 line includes the bank debt the accounts place in H2 2026. Coverage above 1.0x means modelled release plus free cash meets what is due; below it, the gap is what refinancing, new bank lines or asset sales would have to supply. The model releases collections only in step with certified progress (as RERA does), nothing from towers already handed over, and nothing from retention.', f_note, wrap=True); ds.merge_cells(f'A{r}:G{r+1}'); ds.row_dimensions[r].height = 30
r += 3
put(ds, f'A{r}', '2. Monthly escrow release, active scenario (AED m)', f_bold); r += 1
header_row(ds, r, ['Month', 'Cumulative release', 'In the month', 'Debt falling due in the month', 'Running cash after debt (from free cash)'])
r += 1; mr0 = r
for t, md in enumerate(months, start=1):
    col = L(GC0 + t - 1)
    put(ds, f'A{r}', md, fmt='mmm yyyy'); put(ds, f'B{r}', f'=Simulator!{col}{TR}', f_link, N0); put(ds, f'C{r}', f'=Simulator!{col}{TR+1}', f_link, N0)
    put(ds, f'D{r}', f'=SUMPRODUCT((YEAR(Debt!$H${DR0}:$H${DR1})={md.year})*(MONTH(Debt!$H${DR0}:$H${DR1})={md.month})*Debt!$E${DR0}:$E${DR1})', f_link, N0)
    put(ds, f'E{r}', f'=$B$5+$D$5+B{r}-SUM($D${mr0}:D{r})', fmt=N0)
    r += 1
put(ds, f'A{r}', 'Running cash assumes no other operating inflow or outflow — no land purchases, no construction spend outside escrow, no new borrowing. It isolates one question: do handovers alone cover maturities?', f_note, wrap=True); ds.merge_cells(f'A{r}:G{r+1}'); ds.row_dimensions[r].height = 30
r += 3
put(ds, f'A{r}', '3. The towers that matter most before 28 Feb 2027 — largest modelled release, active scenario', f_bold); r += 1
header_row(ds, r, ['Project', 'Status', 'Certified %', 'Registered completion', 'Projected completion', 'Sold %', 'Release by 28 Feb 2027 (AED m)'])
r += 1
# helper column on Simulator for unique ranking
put(sim, f'{L(SB0+28)}{HR}', 'rank key', f_note)
for i in range(len(live)):
    rr = R0 + i
    put(sim, f'{L(SB0+28)}{rr}', f'=R{rr}+ROW()/1000000', f_note, N2)
RK = L(SB0 + 28)
for k in range(1, 11):
    put(ds, f'A{r}', f'=INDEX(Simulator!$B${R0}:$B${last_row},MATCH(LARGE(Simulator!${RK}${R0}:${RK}${last_row},{k}),Simulator!${RK}${R0}:${RK}${last_row},0))', f_link)
    for c, srccol, fmt in [('B', 'C', None), ('C', 'H', N1), ('D', 'I', DATE), ('E', 'M', DATE), ('F', 'L', PCT0), ('G', 'R', N0)]:
        put(ds, f'{c}{r}', f'=INDEX(Simulator!${srccol}${R0}:${srccol}${last_row},MATCH(LARGE(Simulator!${RK}${R0}:${RK}${last_row},{k}),Simulator!${RK}${R0}:${RK}${last_row},0))', f_link, fmt)
    r += 1
put(ds, f'A{r}', 'Set the certified % against the date: a tower at 30% with its registered date passed will not hand over before February whatever the plan says; one at 99% is paperwork. The ten towers the issuer itself names as funding the maturity are the ones to check here first.', f_note, wrap=True); ds.merge_cells(f'A{r}:G{r+1}'); ds.row_dimensions[r].height = 30
r += 3
put(ds, f'A{r}', '4. Register facts, issuer level, and one calibration check', f_bold); r += 1
FACTS = [('Projects on the register', f'=COUNTA(Projects!A5:A{PR1})', N0), ('  of which live (active, pending, not started)', f'=COUNTIF(Projects!D5:D{PR1},"<>Finished")', N0), ('Registered units, live projects', f'=Simulator!E{TR}', N0), ('Sold units, live projects', f'=Simulator!F{TR}', N0), ('Contracted value, live projects (AED m)', f'=Simulator!J{TR}', N0), ('Estimated collected to date (AED m)', f'=Simulator!U{TR}', N0), ('Estimated released from escrow to date (AED m)', f'=Simulator!Q{TR}', N0), ('  implied still held in escrow — model', f'=Simulator!U{TR}-Simulator!Q{TR}', N0), ('  reported in escrow, 30 Jun 2026 — accounts', '=Financials!D11', N0), ('Live projects past their registered completion date', f'=COUNTIFS(Projects!D5:D{PR1},"<>Finished",Projects!F5:F{PR1},"<"&$B$3)', N0), ('Units in those projects', f'=SUMIFS(Projects!I5:I{PR1},Projects!D5:D{PR1},"<>Finished",Projects!F5:F{PR1},"<"&$B$3)', N0), ('Registered sales, last 12 months', f'=Projects!M{PR1+1}', N0), ('  value (AED m)', f'=Projects!N{PR1+1}', N0), ('  share of all Dubai sales', f'=Projects!M{PR1+1}/187123', PCT), ('Resales in Binghatti buildings, 24 months', f'=Projects!S{PR1+1}', N0), ('  of which at a loss', f'=Projects!T{PR1+1}/Projects!S{PR1+1}', PCT)]
for lab, fml, fmt in FACTS:
    put(ds, f'A{r}', lab); put(ds, f'B{r}', fml, f_link, fmt); r += 1
put(ds, f'C{r-3}', 'Dubai registered 187,123 sales in the twelve months to the as-of date (register).', f_note)
put(ds, f'C{r-7}', 'The model holds less in escrow than the accounts report: certified % is the June register reading for most towers, so collections since then are not yet in it, and the accounts include finished towers awaiting release. Read the release figures as conservative by roughly that gap.', f_note, wrap=True); ds.merge_cells(f'C{r-7}:G{r-6}'); ds.row_dimensions[r-7].height = 30
r += 1
put(ds, f'A{r}', 'Sources: Dubai Land Department transactions and project registers (open data, read daily; attribution: DLD / data.dubai); Binghatti Holding audited FY2025 and reviewed H1 2026 accounts; offering circulars; Moody\'s and Fitch public releases; indicative bank price run 4 Sep 2026. Prepared by Dubai Property Intelligence. General information about a developer\'s published finances and its projects on the public register; not a recommendation to buy, sell or hold any security.', f_note, wrap=True); ds.merge_cells(f'A{r}:G{r+2}'); ds.row_dimensions[r].height = 55
ds.freeze_panes = 'A8'

for ws in wb.worksheets:
    ws.sheet_view.showGridLines = False
    for row in ws.iter_rows():
        for c in row:
            if c.font is None or c.font.name != F: c.font = Font(name=F, size=10)

OUT = '/home/user/credit/Binghatti-credit-workbook-2026-09-10.xlsx'
wb.save(OUT); print('saved', OUT, 'live projects', len(live), 'sim rows', R0, last_row, 'total row', TR)
