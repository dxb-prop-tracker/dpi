// Market-report engine shared by the weekly, monthly and yearly editions.
// Everything is computed from register rows by date of sale / contract start (not by when we loaded them),
// so a monthly or yearly figure is reproducible and comparable across editions.
import type Database from 'better-sqlite3';

export type Period = { from: string; to: string; label: string };   // from exclusive? No: inclusive from..to (YYYY-MM-DD)
type Row = Record<string, any>;

const r0 = (x: number | null | undefined) => x == null || Number.isNaN(x) ? null : Math.round(x);
const r1 = (x: number | null | undefined) => x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10;
const r2 = (x: number | null | undefined) => x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100;
const pctChange = (a: number | null | undefined, b: number | null | undefined) => a && b ? r1(100 * (a / b - 1)) : null;
export const areaSlug = (a: string) => a.toLowerCase().replace(/ /g, '-').replace(/'/g, '-').replace(/\./g, '-').replace(/--/g, '-');

// Sales rows we count as "the market": registered sales only (mortgages and gifts are separate registers).
const SALES = `t.trans_group_en='Sales'`;
// A price per sqm we trust: DLD's own meter price, in a sane band.
const PSM_OK = `t.meter_sale_price BETWEEN 500 AND 200000`;
const UNIT = `t.property_type_en='Unit'`;
const VILLA = `t.property_type_en='Villa'`;
const READY = `t.reg_type_en='Existing Properties'`;
const OFF = `t.reg_type_en='Off-Plan Properties'`;

export function addDays(day: string, n: number) { return new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10); }
export function monthEnd(ym: string) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
export function shiftMonths(ym: string, n: number) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); }
export const monthLabel = (ym: string) => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const shortMonth = (ym: string) => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Median of `valueExpr` over rows of `fromSql` (which must alias transaction_ as t), grouped by `groupExpr` (or '1' for one group). */
function medianBy(db: Database.Database, fromSql: string, groupExpr: string, valueExpr: string, params: any[] = []): Map<string, number> {
  const rows = db.prepare(`
    WITH x AS (SELECT ${groupExpr} AS g, ${valueExpr} AS v, ROW_NUMBER() OVER (PARTITION BY ${groupExpr} ORDER BY ${valueExpr}) rn, COUNT(*) OVER (PARTITION BY ${groupExpr}) c FROM ${fromSql})
    SELECT g, AVG(v) med FROM x WHERE rn IN ((c+1)/2, (c+2)/2) GROUP BY g`).all(...params) as Row[];
  return new Map(rows.map(r => [String(r.g), r.med]));
}

/** Core sales statistics for one date window. */
export function salesStats(db: Database.Database, p: Period) {
  const base = `transaction_ t WHERE ${SALES} AND t.instance_date BETWEEN ? AND ?`;
  const a = db.prepare(`SELECT COUNT(*) n, SUM(t.actual_worth)/1e9 valueBn,
      SUM(CASE WHEN ${OFF} THEN 1 ELSE 0 END) off, SUM(CASE WHEN ${READY} THEN 1 ELSE 0 END) ready,
      SUM(CASE WHEN ${UNIT} THEN 1 ELSE 0 END) units, SUM(CASE WHEN ${VILLA} THEN 1 ELSE 0 END) villas,
      SUM(CASE WHEN t.property_type_en='Land' THEN 1 ELSE 0 END) land, SUM(CASE WHEN t.property_type_en='Building' THEN 1 ELSE 0 END) buildings,
      SUM(CASE WHEN t.actual_worth>=10000000 THEN 1 ELSE 0 END) lux, SUM(CASE WHEN t.actual_worth>=10000000 THEN t.actual_worth ELSE 0 END)/1e9 luxBn,
      SUM(CASE WHEN t.property_usage_en='Residential' THEN 1 ELSE 0 END) residential
    FROM ${base}`).get(p.from, p.to) as Row;
  const m = db.prepare(`SELECT COUNT(*) n, SUM(actual_worth)/1e9 valueBn FROM transaction_ WHERE trans_group_en='Mortgages' AND instance_date BETWEEN ? AND ?`).get(p.from, p.to) as Row;
  const medAll = medianBy(db, `${base} AND ${PSM_OK}`, `'all'`, 't.meter_sale_price', [p.from, p.to]).get('all') ?? null;
  const medUnit = medianBy(db, `${base} AND ${PSM_OK} AND ${UNIT}`, `'u'`, 't.meter_sale_price', [p.from, p.to]).get('u') ?? null;
  const medVilla = medianBy(db, `${base} AND ${PSM_OK} AND ${VILLA}`, `'v'`, 't.meter_sale_price', [p.from, p.to]).get('v') ?? null;
  const medUnitOff = medianBy(db, `${base} AND ${PSM_OK} AND ${UNIT} AND ${OFF}`, `'x'`, 't.meter_sale_price', [p.from, p.to]).get('x') ?? null;
  const medUnitReady = medianBy(db, `${base} AND ${PSM_OK} AND ${UNIT} AND ${READY}`, `'x'`, 't.meter_sale_price', [p.from, p.to]).get('x') ?? null;
  const medPrice = medianBy(db, `${base} AND t.actual_worth>0`, `'x'`, 't.actual_worth', [p.from, p.to]).get('x') ?? null;
  return {
    label: p.label, from: p.from, to: p.to,
    n: a.n, valueBn: r2(a.valueBn), offplanPct: a.n ? r0(100 * a.off / a.n) : null, off: a.off, ready: a.ready,
    units: a.units, villas: a.villas, land: a.land, buildings: a.buildings, residentialPct: a.n ? r0(100 * a.residential / a.n) : null,
    lux: a.lux, luxBn: r2(a.luxBn), luxPct: a.n ? r1(100 * a.lux / a.n) : null,
    mortgages: m.n, mortgageBn: r2(m.valueBn), mortgagePct: a.n ? r0(100 * m.n / a.n) : null,
    medPsm: r0(medAll), medPsmUnit: r0(medUnit), medPsmVilla: r0(medVilla), medPsmUnitOff: r0(medUnitOff), medPsmUnitReady: r0(medUnitReady),
    offReadySpread: medUnitOff && medUnitReady ? r1(100 * (medUnitOff / medUnitReady - 1)) : null,
    medPrice: r0(medPrice), avgTicket: a.n ? r0(a.valueBn * 1e9 / a.n) : null,
  };
}

export function rentStats(db: Database.Database, p: Period) {
  const base = `rent_contract r WHERE r.contract_start_date BETWEEN ? AND ? AND r.annual_amount BETWEEN 1000 AND 50000000`;
  const a = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN r.contract_reg_type_en LIKE 'New%' THEN 1 ELSE 0 END) nw FROM ${base}`).get(p.from, p.to) as Row;
  // Rent levels are quoted for homes only (flats and villas); offices, shops and labour camps would distort a median.
  const med = (extra: string) => medianBy(db, `${base} AND r.ejari_property_type_en IN ('Flat','Villa') ${extra}`, `'x'`, 'r.annual_amount', [p.from, p.to]).get('x') ?? null;
  const medPsm = medianBy(db, `${base} AND r.ejari_property_type_en IN ('Flat','Villa') AND r.actual_area > 10 AND r.annual_amount/r.actual_area < 20000 AND r.contract_reg_type_en LIKE 'New%'`, `'x'`, 'r.annual_amount/r.actual_area', [p.from, p.to]).get('x') ?? null;
  const byRooms = db.prepare(`SELECT r.rooms_en g, COUNT(*) n FROM ${base} AND r.contract_reg_type_en LIKE 'New%' AND r.ejari_property_type_en IN ('Flat','Villa') GROUP BY 1`).all(p.from, p.to) as Row[];
  const medRooms = medianBy(db, `${base} AND r.contract_reg_type_en LIKE 'New%' AND r.ejari_property_type_en IN ('Flat','Villa')`, 'r.rooms_en', 'r.annual_amount', [p.from, p.to]);
  const rooms = ['Studio', '1 B/R', '2 B/R', '3 B/R', '4 B/R'].map(k => ({ key: k, n: byRooms.find(x => x.g === k)?.n ?? 0, medianNew: r0(medRooms.get(k) ?? null) }));
  return { label: p.label, n: a.n, newPct: a.n ? r0(100 * a.nw / a.n) : null, medianAll: r0(med('')), medianNew: r0(med(`AND r.contract_reg_type_en LIKE 'New%'`)), medianRenew: r0(med(`AND r.contract_reg_type_en LIKE 'Renew%'`)), medianPsmNew: r0(medPsm), rooms };
}

/** Compare three windows: this period, the previous period, the same period a year earlier. */
export function headline(db: Database.Database, cur: Period, prev: Period, yoy: Period) {
  const [c, p, y] = [cur, prev, yoy].map(w => salesStats(db, w));
  const [rc, rp, ry] = [cur, prev, yoy].map(w => rentStats(db, w));
  const row = (label: string, k: string, fmt: 'n' | 'bn' | 'aed' | 'pct' | 'pts' = 'n', src: 'sales' | 'rent' = 'sales') => {
    const [a, b, d] = src === 'sales' ? [(c as any)[k], (p as any)[k], (y as any)[k]] : [(rc as any)[k], (rp as any)[k], (ry as any)[k]];
    return { label, cur: a, prev: b, yoy: d, fmt, momPct: fmt === 'pct' || fmt === 'pts' ? (a != null && b != null ? r1(a - b) : null) : pctChange(a, b), yoyPct: fmt === 'pct' || fmt === 'pts' ? (a != null && d != null ? r1(a - d) : null) : pctChange(a, d) };
  };
  return {
    periods: { cur: cur.label, prev: prev.label, yoy: yoy.label },
    rows: [
      row('Recorded sales', 'n'), row('Value of sales', 'valueBn', 'bn'), row('Average ticket', 'avgTicket', 'aed'), row('Median price paid', 'medPrice', 'aed'),
      row('Median AED/sqm, apartments', 'medPsmUnit', 'aed'), row('Median AED/sqm, villas', 'medPsmVilla', 'aed'),
      row('Off-plan share of sales', 'offplanPct', 'pct'), row('Off-plan premium to ready, apartments', 'offReadySpread', 'pct'),
      row('Sales of AED 10m and above', 'lux'), row('Value of AED 10m+ sales', 'luxBn', 'bn'),
      row('Mortgage registrations', 'mortgages'), row('Mortgages per 100 sales', 'mortgagePct', 'pct'),
      row('Ejari contracts', 'n', 'n', 'rent'), row('New tenancies, share', 'newPct', 'pct', 'rent'), row('Median new rent, annual', 'medianNew', 'aed', 'rent'), row('Median renewal rent, annual', 'medianRenew', 'aed', 'rent'),
    ],
    cur: c, prev: p, yoy: y, rentCur: rc, rentPrev: rp, rentYoy: ry,
  };
}

/** Monthly series ending at `toMonth` (YYYY-MM), `months` long: count, value, off-plan count, median AED/sqm for apartments. */
export function monthlySeries(db: Database.Database, toMonth: string, months: number) {
  const fromMonth = shiftMonths(toMonth, -(months - 1));
  const from = fromMonth + '-01', to = monthEnd(toMonth);
  const base = `transaction_ t WHERE ${SALES} AND t.instance_date BETWEEN ? AND ?`;
  const rows = db.prepare(`SELECT substr(t.instance_date,1,7) m, COUNT(*) n, SUM(t.actual_worth)/1e9 valueBn, SUM(CASE WHEN ${OFF} THEN 1 ELSE 0 END) off FROM ${base} GROUP BY 1 ORDER BY 1`).all(from, to) as Row[];
  const med = medianBy(db, `${base} AND ${PSM_OK} AND ${UNIT}`, `substr(t.instance_date,1,7)`, 't.meter_sale_price', [from, to]);
  const medV = medianBy(db, `${base} AND ${PSM_OK} AND ${VILLA}`, `substr(t.instance_date,1,7)`, 't.meter_sale_price', [from, to]);
  const rents = db.prepare(`SELECT substr(contract_start_date,1,7) m, COUNT(*) n FROM rent_contract WHERE contract_start_date BETWEEN ? AND ? GROUP BY 1`).all(from, to) as Row[];
  const out: any[] = [];
  for (let m = fromMonth; m <= toMonth; m = shiftMonths(m, 1)) {
    const r = rows.find(x => x.m === m);
    out.push({ m, n: r?.n ?? 0, valueBn: r2(r?.valueBn ?? 0), off: r?.off ?? 0, psmUnit: r0(med.get(m) ?? null), psmVilla: r0(medV.get(m) ?? null), rents: rents.find(x => x.m === m)?.n ?? 0 });
  }
  return out;
}

/** Yearly series 2008..toYear (the current year is year-to-date up to `toDate`). */
export function yearlySeries(db: Database.Database, toYear: number, toDate: string) {
  const base = `transaction_ t WHERE ${SALES} AND t.instance_date BETWEEN '2008-01-01' AND ?`;
  const rows = db.prepare(`SELECT substr(t.instance_date,1,4) y, COUNT(*) n, SUM(t.actual_worth)/1e9 valueBn, SUM(CASE WHEN ${OFF} THEN 1 ELSE 0 END) off FROM ${base} GROUP BY 1 ORDER BY 1`).all(toDate) as Row[];
  const med = medianBy(db, `${base} AND ${PSM_OK} AND ${UNIT}`, `substr(t.instance_date,1,4)`, 't.meter_sale_price', [toDate]);
  const medV = medianBy(db, `${base} AND ${PSM_OK} AND ${VILLA}`, `substr(t.instance_date,1,4)`, 't.meter_sale_price', [toDate]);
  return rows.filter(r => +r.y <= toYear).map(r => ({ y: r.y, n: r.n, valueBn: r2(r.valueBn), off: r.off, psmUnit: r0(med.get(r.y) ?? null), psmVilla: r0(medV.get(r.y) ?? null), ytd: +r.y === toYear && !toDate.endsWith('-12-31') }));
}

/** The same calendar slice across years: e.g. August in each of the last 7 years, or 1 Jan–31 Aug (YTD) in each. */
export function acrossYears(db: Database.Database, mmddFrom: string, mmddTo: string, toYear: number, years = 7) {
  const out: any[] = [];
  for (let y = toYear - years + 1; y <= toYear; y++) {
    const s = salesStats(db, { from: `${y}-${mmddFrom}`, to: `${y}-${mmddTo}`, label: String(y) });
    const prev = out[out.length - 1];
    out.push({ y, n: s.n, valueBn: s.valueBn, medPsmUnit: s.medPsmUnit, medPsmVilla: s.medPsmVilla, offplanPct: s.offplanPct, lux: s.lux, nYoy: prev ? pctChange(s.n, prev.n) : null, valueYoy: prev ? pctChange(s.valueBn, prev.valueBn) : null, psmYoy: prev ? pctChange(s.medPsmUnit, prev.medPsmUnit) : null });
  }
  return out;
}

/** Price bands with a year-earlier comparison. */
export function priceBands(db: Database.Database, cur: Period, yoy: Period) {
  const bands: [string, number, number][] = [['Under AED 1m', 0, 1e6], ['AED 1–2m', 1e6, 2e6], ['AED 2–5m', 2e6, 5e6], ['AED 5–10m', 5e6, 10e6], ['AED 10–20m', 10e6, 20e6], ['AED 20m and above', 20e6, 1e15]];
  const q = db.prepare(`SELECT COUNT(*) n, SUM(actual_worth)/1e9 valueBn FROM transaction_ WHERE trans_group_en='Sales' AND instance_date BETWEEN ? AND ? AND actual_worth >= ? AND actual_worth < ?`);
  const totCur = (db.prepare(`SELECT COUNT(*) n FROM transaction_ WHERE trans_group_en='Sales' AND instance_date BETWEEN ? AND ?`).get(cur.from, cur.to) as Row).n || 1;
  return bands.map(([label, lo, hi]) => { const a = q.get(cur.from, cur.to, lo, hi) as Row, b = q.get(yoy.from, yoy.to, lo, hi) as Row; return { label, n: a.n, share: r1(100 * a.n / totCur), valueBn: r2(a.valueBn), nYoy: pctChange(a.n, b.n) }; });
}

/** Largest single sales in the window. */
export function biggestDeals(db: Database.Database, p: Period, top = 12) {
  return (db.prepare(`SELECT t.instance_date d, t.area_name_en area, t.project_name_en project, t.building_name_en building, t.property_type_en type, t.property_sub_type_en sub, t.rooms_en rooms, t.procedure_area sqm, t.actual_worth aed, t.meter_sale_price psm, t.reg_type_en reg, p.slug, p.area_slug
    FROM transaction_ t LEFT JOIN project p ON p.project_number=t.project_number WHERE ${SALES} AND t.instance_date BETWEEN ? AND ? AND t.property_type_en <> 'Land' ORDER BY t.actual_worth DESC LIMIT ?`).all(p.from, p.to, top) as Row[])
    .map(r => ({ ...r, url: r.slug ? `/dubai/${r.area_slug}/${r.slug}/` : null, aed: r0(r.aed), psm: r0(r.psm), sqm: r0(r.sqm) }));
}

/** Areas league with year-earlier price comparison. */
export function areaLeague(db: Database.Database, cur: Period, yoy: Period, top = 20) {
  const base = (p: Period) => `transaction_ t WHERE ${SALES} AND t.instance_date BETWEEN '${p.from}' AND '${p.to}'`;
  const rows = db.prepare(`SELECT t.area_name_en area, COUNT(*) n, SUM(t.actual_worth)/1e9 valueBn, SUM(CASE WHEN ${OFF} THEN 1 ELSE 0 END) off FROM ${base(cur)} GROUP BY 1 ORDER BY 2 DESC LIMIT ?`).all(top) as Row[];
  const tot = (db.prepare(`SELECT COUNT(*) n FROM ${base(cur)}`).get() as Row).n || 1;
  const medC = medianBy(db, `${base(cur)} AND ${PSM_OK} AND ${UNIT}`, 't.area_name_en', 't.meter_sale_price');
  const medY = medianBy(db, `${base(yoy)} AND ${PSM_OK} AND ${UNIT}`, 't.area_name_en', 't.meter_sale_price');
  const nY = new Map((db.prepare(`SELECT t.area_name_en area, COUNT(*) n FROM ${base(yoy)} GROUP BY 1`).all() as Row[]).map(r => [r.area, r.n]));
  return rows.map(r => ({ area: r.area, slug: areaSlug(r.area), n: r.n, share: r1(100 * r.n / tot), valueBn: r2(r.valueBn), offplanPct: r0(100 * r.off / r.n), medPsm: r0(medC.get(r.area) ?? null), psmYoy: pctChange(medC.get(r.area), medY.get(r.area)), nYoy: pctChange(r.n, nY.get(r.area)) }));
}

export function developerLeague(db: Database.Database, cur: Period, yoy: Period, top = 15) {
  const q = (p: Period) => db.prepare(`SELECT d.developer_number dn, d.name_en name, d.slug, COUNT(*) n, SUM(t.actual_worth)/1e9 valueBn, COUNT(DISTINCT t.project_number) projects
    FROM transaction_ t JOIN project p ON p.project_number=t.project_number JOIN developer d ON d.developer_number=p.developer_number
    WHERE ${SALES} AND t.instance_date BETWEEN ? AND ? GROUP BY 1 ORDER BY 4 DESC`).all(p.from, p.to) as Row[];
  const a = q(cur), b = q(yoy);
  const tot = (db.prepare(`SELECT COUNT(*) n FROM transaction_ t WHERE ${SALES} AND t.instance_date BETWEEN ? AND ?`).get(cur.from, cur.to) as Row).n || 1;
  const linked = a.reduce((s, r) => s + r.n, 0) || 1;
  // Two denominators, both shown and both labelled. The table used to print one share against ALL sales
  // under a heading that said "share of linked sales", which understated every developer by a third.
  return {
    rows: a.slice(0, top).map(r => ({ ...r, valueBn: r2(r.valueBn), shareLinked: r1(100 * r.n / linked), share: r1(100 * r.n / tot), nYoy: pctChange(r.n, b.find(x => x.dn === r.dn)?.n) })),
    linkedPct: r0(100 * linked / tot), linkedSales: linked, allSales: tot,
    top5Share: r1(100 * a.slice(0, 5).reduce((s, r) => s + r.n, 0) / tot),
    top5ShareLinked: r1(100 * a.slice(0, 5).reduce((s, r) => s + r.n, 0) / linked),
  };
}

export function projectLeague(db: Database.Database, cur: Period, top = 15) {
  return (db.prepare(`SELECT t.project_number pn, COALESCE(p.name_en, t.project_name_en) name, p.slug, p.area_slug, t.area_name_en area, COUNT(*) n, SUM(t.actual_worth)/1e6 valueM, SUM(CASE WHEN ${OFF} THEN 1 ELSE 0 END) off, p.units
    FROM transaction_ t LEFT JOIN project p ON p.project_number=t.project_number WHERE ${SALES} AND t.instance_date BETWEEN ? AND ? AND t.project_number IS NOT NULL GROUP BY 1 ORDER BY 6 DESC LIMIT ?`).all(cur.from, cur.to, top) as Row[])
    .map(r => ({ ...r, valueM: r0(r.valueM), offplanPct: r0(100 * r.off / r.n), url: r.slug ? `/dubai/${r.area_slug}/${r.slug}/` : null, soldPctOfUnits: r.units ? r1(100 * r.n / r.units) : null }));
}

/** Gross yields by area: median new-contract rent per sqm over the trailing 12 months ÷ median ready-apartment sale price per sqm. */
export function yieldMap(db: Database.Database, asOf: string, top = 15) {
  const from = addDays(asOf, -365);
  const rent = medianBy(db, `rent_contract r WHERE r.contract_start_date BETWEEN ? AND ? AND r.contract_reg_type_en LIKE 'New%' AND r.ejari_property_type_en='Flat' AND r.actual_area > 10 AND r.annual_amount BETWEEN 1000 AND 50000000 AND r.annual_amount/r.actual_area < 20000`, 'r.area_name_en', 'r.annual_amount/r.actual_area', [from, asOf]);
  const rentN = new Map((db.prepare(`SELECT area_name_en a, COUNT(*) n FROM rent_contract WHERE contract_start_date BETWEEN ? AND ? AND contract_reg_type_en LIKE 'New%' AND ejari_property_type_en='Flat' GROUP BY 1`).all(from, asOf) as Row[]).map(r => [r.a, r.n]));
  const sale = medianBy(db, `transaction_ t WHERE ${SALES} AND ${READY} AND ${UNIT} AND ${PSM_OK} AND t.instance_date BETWEEN ? AND ?`, 't.area_name_en', 't.meter_sale_price', [from, asOf]);
  const saleN = new Map((db.prepare(`SELECT t.area_name_en a, COUNT(*) n FROM transaction_ t WHERE ${SALES} AND ${READY} AND ${UNIT} AND t.instance_date BETWEEN ? AND ? GROUP BY 1`).all(from, asOf) as Row[]).map(r => [r.a, r.n]));
  const out: any[] = [];
  for (const [area, rp] of rent) { const sp = sale.get(area); const rn = rentN.get(area) ?? 0, sn = saleN.get(area) ?? 0; if (!sp || rn < 100 || sn < 30) continue; out.push({ area, slug: areaSlug(area), rentPsm: r0(rp), salePsm: r0(sp), yieldPct: r1(100 * rp / sp), rents: rn, sales: sn }); }
  out.sort((a, b) => b.yieldPct - a.yieldPct);
  return { top: out.slice(0, top), bottom: out.slice(-Math.min(8, out.length)).reverse(), all: out.length };
}

/** Resales completed in the window (same identity bought earlier), and off-plan flips among them. */
export function resales(db: Database.Database, p: Period) {
  // change_pct is stored as a fraction (0.26 = +26%). Pairs at exactly the same price within 60 days are re-registrations
  // (assignments, corrections), not resales; they are counted but kept out of the gain statistics.
  const raw = db.prepare(`SELECT change_pct*100 change_pct, hold_days, bought_reg, sold_reg, sold_for FROM resale_pair WHERE sold_on BETWEEN ? AND ? AND ambiguity=0`).all(p.from, p.to) as Row[];
  const rereg = raw.filter(r => Math.abs(r.change_pct) < 0.01 && r.hold_days < 60).length;
  const rows = raw.filter(r => !(Math.abs(r.change_pct) < 0.01 && r.hold_days < 60));
  const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const flips = rows.filter(r => /off/i.test(r.bought_reg || ''));
  const stat = (xs: Row[]) => ({ n: xs.length, medianGainPct: r1(med(xs.map(r => r.change_pct))), lossPct: xs.length ? r0(100 * xs.filter(r => r.change_pct < 0).length / xs.length) : null, medianHoldMonths: r1(med(xs.map(r => r.hold_days / 30.44))), q1: r1(quant(xs.map(r => r.change_pct), .25)), q3: r1(quant(xs.map(r => r.change_pct), .75)) });
  return { all: stat(rows), offplanBought: stat(flips), quickFlips: rows.filter(r => r.hold_days < 365).length, reregistrations: rereg };
}
const quant = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round((s.length - 1) * q))]; };

/** Supply pipeline from the register as of a date: units by expected completion year, by area, and slippage. */
export function pipeline(db: Database.Database, asOf: string) {
  // latest observation per project up to asOf
  const latest = db.prepare(`SELECT o.project_number pn, o.status, o.percent_completed pct, o.completion_date cd, p.units, p.area_name_en area, p.name_en name, p.slug, p.area_slug, d.name_en developer
    FROM project_observation o JOIN project p USING(project_number) LEFT JOIN developer d ON d.developer_number=p.developer_number
    WHERE o.observed_at <= ? AND o.id = (SELECT id FROM project_observation o2 WHERE o2.project_number=o.project_number AND o2.observed_at <= ? ORDER BY observed_at DESC, id DESC LIMIT 1)`).all(asOf, asOf) as Row[];
  const live = latest.filter(r => ['ACTIVE', 'PENDING', 'NOT_STARTED', 'CONDITIONAL_ACTIVATING'].includes(r.status));
  const active = latest.filter(r => r.status === 'ACTIVE');
  // ONE population (every project not finished or cancelled) and ONE test for lateness (the registered
  // completion date is in the past), used by every figure in this section. They used to differ: the tile
  // counted active projects past their date while the chart counted live projects whose completion YEAR
  // had passed, so the same page carried two "past due" totals — 67,846 and 39,043 — and everything
  // overdue since January sat in the current year's bar looking like supply still to come.
  const overdue = (r: Row) => !!r.cd && r.cd < asOf;
  const bucket = (r: Row) => !r.cd ? 'no date' : overdue(r) ? 'past due' : r.cd.slice(0, 4);
  const byYear = new Map<string, { projects: number; units: number }>();
  for (const r of live) { const k = bucket(r); const g = byYear.get(k) ?? { projects: 0, units: 0 }; g.projects++; g.units += r.units ?? 0; byYear.set(k, g); }
  const years = [...byYear.entries()].map(([k, v]) => ({ year: k, ...v })).sort((a, b) => a.year === 'past due' ? -1 : b.year === 'past due' ? 1 : a.year === 'no date' ? 1 : b.year === 'no date' ? -1 : a.year.localeCompare(b.year));
  const byArea = new Map<string, { projects: number; units: number; pastDue: number }>();
  for (const r of live) { const g = byArea.get(r.area) ?? { projects: 0, units: 0, pastDue: 0 }; g.projects++; g.units += r.units ?? 0; if (overdue(r)) g.pastDue++; byArea.set(r.area, g); }
  const areas = [...byArea.entries()].map(([area, v]) => ({ area, slug: areaSlug(area), ...v })).sort((a, b) => b.units - a.units).slice(0, 15);
  const next12 = addDays(asOf, 365);
  const dueSoon = live.filter(r => r.cd && !overdue(r) && r.cd <= next12);
  const pastDue = live.filter(overdue);
  const behind = live.filter(r => r.cd && r.pct != null && !overdue(r) && r.cd <= next12 && r.pct < 60); // still to come, yet under 60% certified
  const byDev = new Map<string, { projects: number; units: number; pastDue: number }>();
  for (const r of live) { const k = r.developer ?? 'Unknown'; const g = byDev.get(k) ?? { projects: 0, units: 0, pastDue: 0 }; g.projects++; g.units += r.units ?? 0; if (overdue(r)) g.pastDue++; byDev.set(k, g); }
  const developers = [...byDev.entries()].map(([developer, v]) => ({ developer, ...v })).sort((a, b) => b.units - a.units).slice(0, 12);
  const sumUnits = (xs: Row[]) => xs.reduce((s, r) => s + (r.units ?? 0), 0);
  return {
    asOf, liveProjects: live.length, liveUnits: sumUnits(live), activeProjects: active.length, activeUnits: sumUnits(active),
    years, areas, developers,
    dueNext12: { projects: dueSoon.length, units: sumUnits(dueSoon) }, pastDue: { projects: pastDue.length, units: sumUnits(pastDue) },
    behind: { projects: behind.length, units: sumUnits(behind), list: behind.sort((a, b) => (b.units ?? 0) - (a.units ?? 0)).slice(0, 15).map(r => ({ name: r.name, area: r.area, developer: r.developer, pct: r1(Math.min(100, r.pct)), due: r.cd, units: r.units, url: r.slug ? `/dubai/${r.area_slug}/${r.slug}/` : null })) },
    pastDueList: pastDue.sort((a, b) => (b.units ?? 0) - (a.units ?? 0)).slice(0, 15).map(r => ({ name: r.name, area: r.area, developer: r.developer, pct: r1(Math.min(100, r.pct)), due: r.cd, units: r.units, url: r.slug ? `/dubai/${r.area_slug}/${r.slug}/` : null })),
  };
}

/** Rents by area for the window, with a year-earlier comparison of the median new rent. */
export function rentAreas(db: Database.Database, cur: Period, yoy: Period, top = 15) {
  const base = (p: Period) => `rent_contract r WHERE r.contract_start_date BETWEEN '${p.from}' AND '${p.to}' AND r.annual_amount BETWEEN 1000 AND 50000000 AND r.ejari_property_type_en IN ('Flat','Villa')`;
  const rows = db.prepare(`SELECT r.area_name_en area, COUNT(*) n, SUM(CASE WHEN r.contract_reg_type_en LIKE 'New%' THEN 1 ELSE 0 END) nw FROM ${base(cur)} GROUP BY 1 ORDER BY 2 DESC LIMIT ?`).all(top) as Row[];
  const tot = (db.prepare(`SELECT COUNT(*) n FROM ${base(cur)}`).get() as Row).n || 1;
  const medC = medianBy(db, `${base(cur)} AND r.contract_reg_type_en LIKE 'New%'`, 'r.area_name_en', 'r.annual_amount');
  const medY = medianBy(db, `${base(yoy)} AND r.contract_reg_type_en LIKE 'New%'`, 'r.area_name_en', 'r.annual_amount');
  const medR = medianBy(db, `${base(cur)} AND r.contract_reg_type_en LIKE 'Renew%'`, 'r.area_name_en', 'r.annual_amount');
  return rows.map(r => ({ area: r.area, slug: areaSlug(r.area), n: r.n, share: r1(100 * r.n / tot), newPct: r0(100 * r.nw / r.n), medianNew: r0(medC.get(r.area) ?? null), medianRenew: r0(medR.get(r.area) ?? null), newYoy: pctChange(medC.get(r.area), medY.get(r.area)), spread: medC.get(r.area) && medR.get(r.area) ? r1(100 * (medC.get(r.area)! / medR.get(r.area)! - 1)) : null }));
}

/** Everything a period edition needs. */
export function marketReport(db: Database.Database, cur: Period, prev: Period, yoy: Period, opts: { kind: 'weekly' | 'monthly' | 'yearly'; toMonth: string; toYear: number }) {
  const t0 = Date.now();
  const hl = headline(db, cur, prev, yoy);
  const monthly = monthlySeries(db, opts.toMonth, opts.kind === 'yearly' ? 36 : 24);
  const yearly = yearlySeries(db, opts.toYear, cur.to);
  const mmdd = (d: string) => d.slice(5);
  const sameSlice = opts.kind === 'weekly' ? null : acrossYears(db, mmdd(cur.from), mmdd(cur.to), opts.toYear);
  const ytd = acrossYears(db, '01-01', mmdd(cur.to), opts.toYear);
  const out = {
    headline: hl, monthly, yearly, sameSlice, ytd,
    bands: priceBands(db, cur, yoy), deals: biggestDeals(db, cur), areas: areaLeague(db, cur, yoy), developers: developerLeague(db, cur, yoy), projects: projectLeague(db, cur),
    yields: yieldMap(db, cur.to), resales: resales(db, cur), pipeline: pipeline(db, cur.to), rentAreas: rentAreas(db, cur, yoy),
    computedMs: 0,
  };
  out.computedMs = Date.now() - t0;
  return out;
}
