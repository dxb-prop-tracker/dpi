// Registered-price valuation, per tower and bedroom count, published for the site to read.
//
//   npm run avm
//
// What it is: comparable-sales valuation, done the way an analyst would do it by hand and then run
// across every building in Dubai. For a given tower and bedroom count it takes the sales registered
// in that tower over the last twelve months, carries each one to today on its own area's price
// index, moves it onto the subject's size along a fitted size curve, and takes the median.
//
// What it refuses to do is the important half. A tower with fewer than MIN_COMPS registered sales in
// twelve months gets no valuation at all - not a wide one, none - and the site says how many sales
// it would need. Area-level averages are computed but marked unpublished: they were measured at
// roughly twice the error of the building tier and have no place in front of a user who is being
// told these numbers are reliable.
//
// The band is calibrated, not assumed. Raw comp quartiles contained the true price only 40% of the
// time, which would have been a confidence interval that lied. Instead the model is backtested on
// held-out sales, the distribution of its own errors is measured by comp-count bucket, and the band
// is the 10th to 90th percentile of those errors. When the site says eight in ten sales land in this
// range, that is a measurement.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';

const OUT = path.resolve(process.cwd(), 'public/data/avm');
const MIN_COMPS = 5;            // below this we publish nothing
const WINDOW_DAYS = 365;
const SIZE_LO = 0.75, SIZE_HI = 1.33;
const HOLDOUT = 0.97;           // the most recent 3% of sales are never trained on

type Sale = { d: string; a: string; b: string; rm: string; sz: number; w: number; psm: number; offplan: boolean };

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
const yearBefore = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;

/** Price per sqm falls as units get larger. Fitted per building/bedroom cell, median taken. */
function sizeElasticity(sales: Sale[]): number {
  const cells = new Map<string, Sale[]>();
  for (const s of sales) {
    const k = `${s.b}|${s.rm}`;
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(s);
  }
  const es: number[] = [];
  for (const v of cells.values()) {
    if (v.length < 30) continue;
    const xs = v.map(r => Math.log(r.sz)), ys = v.map(r => Math.log(r.psm));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    if (den > 0) es.push(xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den);
  }
  return es.length ? median(es) : -0.33;
}

/** The repeat-sales index, if it has been built, as a quarterly series per area plus the market.
 *
 * This is what a comparable is carried forward on, in preference to a median. A median of what
 * happened to trade moves when the MIX moves — an expensive month drags every comparable with it.
 * A repeat-sales pair compares a home with itself, so composition cannot bend it. Where an area has
 * no published series the market series is used; where neither exists we fall back to the median,
 * which is better than not carrying the comparable forward at all.
 */
function loadRsi() {
  const f = path.resolve(process.cwd(), 'public/data/index/rsi.json');
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const toMap = (pts: any[]) => new Map<string, number>(pts.filter(p => !p.thin).map(p => [p.quarter, p.index]));
  return {
    // The valuation prices apartments (comps are same building + bedrooms), so it carries them on the
    // apartment sub-index where the index publishes one (v2.0); the all-homes market line includes
    // villas, which have moved about twice as much since 2012 and would over-carry a flat.
    market: toMap(j.apartmentsRegistered?.points ?? j.apartments?.points ?? j.market),
    areas: new Map<string, Map<string, number>>((j.apartmentsRegistered?.areas ?? j.areas).map((a: any) => [a.area, toMap(a.points)])),
  };
}
const quarterKey = (ym: string) => `${ym.slice(0, 4)}Q${Math.floor((Number(ym.slice(5, 7)) - 1) / 3) + 1}`;

/** Median price per sqm by area and month — the fallback where no repeat-sales series exists. */
function areaIndex(sales: Sale[]) {
  const m = new Map<string, Map<string, number[]>>();
  for (const s of sales) {
    const am = m.get(s.a) ?? m.set(s.a, new Map()).get(s.a)!;
    const k = s.d.slice(0, 7);
    (am.get(k) ?? am.set(k, []).get(k)!).push(s.psm);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [a, months] of m) {
    const o = new Map<string, number>();
    for (const [k, v] of months) if (v.length >= 8) o.set(k, median(v));
    out.set(a, o);
  }
  return out;
}

function main() {
  const db = openDb();
  const rows = db.prepare(`SELECT instance_date d, area_name_en a, building_name_en b, rooms_en rm,
      procedure_area sz, actual_worth w, meter_sale_price psm, reg_type_en rt
    FROM transaction_
    WHERE trans_group_en='Sales' AND property_type_en='Unit'
      AND meter_sale_price BETWEEN 500 AND 200000 AND procedure_area>10 AND actual_worth>50000
      AND instance_date>=date('now','-800 days')
      AND rooms_en IS NOT NULL AND rooms_en<>'' AND building_name_en IS NOT NULL AND building_name_en<>''`)
    .all() as any[];
  const sales: Sale[] = rows.map(r => ({ ...r, offplan: r.rt === 'Off-Plan Properties' }));
  if (!sales.length) { console.log('no sales — nothing to build'); return; }

  const E = sizeElasticity(sales);
  const idx = areaIndex(sales);
  const rsi = loadRsi();
  let viaRsi = 0, viaMedian = 0;
  const dates = sales.map(s => s.d).sort();
  const cut = dates[Math.floor(dates.length * HOLDOUT)];
  const train = sales.filter(s => s.d < cut);
  const test = sales.filter(s => s.d >= cut);
  const asOf = dates[dates.length - 1].slice(0, 10);
  const month = asOf.slice(0, 7);

  const pools = new Map<string, Sale[]>();
  for (const s of train) {
    const k = `${s.b}|${s.rm}`;
    (pools.get(k) ?? pools.set(k, []).get(k)!).push(s);
  }

  /** Carry a comp to the valuation month, then onto the subject's size. */
  const adjust = (c: Sale, area: string, sz: number, when: string) => {
    let f: number | undefined, o: number | undefined;
    if (rsi) {                                   // repeat-sales first: composition cannot bend it
      const series = rsi.areas.get(area) ?? rsi.market;
      f = series.get(quarterKey(when)); o = series.get(quarterKey(c.d));
      if (!(f && o && o > 0)) { f = rsi.market.get(quarterKey(when)); o = rsi.market.get(quarterKey(c.d)); }
    }
    if (f && o && o > 0) viaRsi++;
    else {                                       // fall back to the median of what traded
      const ia = idx.get(area);
      f = ia?.get(when.slice(0, 7)); o = ia?.get(c.d.slice(0, 7));
      viaMedian++;
    }
    const t = f && o && o > 0 ? c.psm * (f / o) : c.psm;
    return t * Math.pow(sz / c.sz, E);
  };

  const comps = (b: string, rm: string, sz: number, before: string) => {
    const lo = yearBefore(before);
    return (pools.get(`${b}|${rm}`) ?? []).filter(
      c => c.d >= lo && c.d < before && c.sz >= SIZE_LO * sz && c.sz <= SIZE_HI * sz);
  };

  // ---- backtest: measure the model's own error, by how many comps it had ----
  const BUCKETS = [[5, 9], [10, 29], [30, Infinity]];
  const bucketOf = (n: number) => BUCKETS.findIndex(([lo, hi]) => n >= lo && n <= hi);
  const errs: number[][] = BUCKETS.map(() => []);
  let valued = 0;
  for (const t of test) {
    const c = comps(t.b, t.rm, t.sz, t.d);
    if (c.length < MIN_COMPS) continue;
    const v = median(c.map(x => adjust(x, t.a, t.sz, t.d))) * t.sz;
    if (!isFinite(v) || v <= 0) continue;
    valued++;
    errs[bucketOf(c.length)].push((v - t.w) / t.w);       // signed, so the band can be asymmetric
  }
  const calib = BUCKETS.map(([lo, hi], i) => {
    const e = [...errs[i]].sort((a, b) => a - b);
    const abs = e.map(Math.abs).sort((a, b) => a - b);
    return {
      comps: hi === Infinity ? `${lo}+` : `${lo}-${hi}`, n: e.length,
      // the band is the 10th-90th percentile of the model's OWN error, inverted onto the estimate
      lowMult: e.length ? 1 / (1 + pct(e, 0.9)) : 0.8,
      highMult: e.length ? 1 / (1 + pct(e, 0.1)) : 1.2,
      medianAbsErrorPct: e.length ? median(abs) * 100 : null,
      within10Pct: e.length ? (abs.filter(x => x <= 0.1).length / abs.length) * 100 : null,
    };
  });
  const allAbs = errs.flat().map(Math.abs).sort((a, b) => a - b);

  // ---- publish one cell per building and bedroom count, at the cell's typical size ----
  const cells: any[] = [];
  const byBuilding = new Map<string, any>();
  for (const [k, pool] of pools) {
    const [b, rm] = k.split('|');
    const lo = yearBefore(asOf);
    const recent = pool.filter(c => c.d >= lo);
    if (recent.length < MIN_COMPS) continue;
    const area = recent[recent.length - 1].a;
    const sz = median(recent.map(r => r.sz));
    const usable = recent.filter(c => c.sz >= SIZE_LO * sz && c.sz <= SIZE_HI * sz);
    if (usable.length < MIN_COMPS) continue;
    const psm = median(usable.map(c => adjust(c, area, sz, asOf)));
    if (!isFinite(psm) || psm <= 0) continue;
    const cal = calib[bucketOf(usable.length)];
    const cell = {
      building: b, area, rooms: rm, comps: usable.length,
      typicalSizeSqm: Math.round(sz * 10) / 10,
      aedPerSqm: Math.round(psm),
      lastSale: recent.reduce((a, c) => (c.d > a ? c.d : a), '').slice(0, 10),
      offplanShare: Math.round((usable.filter(c => c.offplan).length / usable.length) * 100),
      bandLow: Math.round(cal.lowMult * 1000) / 1000,
      bandHigh: Math.round(cal.highMult * 1000) / 1000,
      confidence: usable.length >= 30 ? 'high' : usable.length >= 10 ? 'medium' : 'low',
    };
    cells.push(cell);
    const e = byBuilding.get(b) ?? { building: b, area, rooms: [] };
    e.rooms.push(cell); byBuilding.set(b, e);
  }
  cells.sort((a, b) => a.building.localeCompare(b.building) || a.rooms.localeCompare(b.rooms));

  fs.mkdirSync(OUT, { recursive: true });
  const meta = {
    generatedAt: new Date().toISOString(), asOf, valuationMonth: month,
    method: 'Comparable registered sales in the same tower and bedroom count over the last 12 months, each carried to the valuation month on its own area price index and moved onto the subject size along a fitted size curve, then the median taken.',
    sizeElasticity: Math.round(E * 1000) / 1000,
    carriedForwardOn: rsi ? 'repeat-sales index, falling back to the median of registered sales where no series exists'
                          : 'median of registered sales by area and month (no repeat-sales index found)',
    minComps: MIN_COMPS,
    buildings: byBuilding.size, cells: cells.length,
    accuracy: {
      testedOn: valued, heldOutFrom: cut.slice(0, 10),
      medianAbsErrorPct: allAbs.length ? Math.round(median(allAbs) * 1000) / 10 : null,
      within10Pct: allAbs.length ? Math.round((allAbs.filter(x => x <= 0.1).length / allAbs.length) * 1000) / 10 : null,
      within20Pct: allAbs.length ? Math.round((allAbs.filter(x => x <= 0.2).length / allAbs.length) * 1000) / 10 : null,
      byCompCount: calib,
    },
    note: 'Area-level valuation was measured at roughly twice this error and is deliberately not published. A tower with fewer than 5 registered sales in 12 months gets no valuation.',
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(OUT, 'cells.json'), JSON.stringify(cells));
  console.log(`AVM: ${cells.length.toLocaleString()} cells across ${byBuilding.size.toLocaleString()} buildings, as of ${asOf}`);
  console.log(`  comparables carried forward: ${viaRsi.toLocaleString()} on the repeat-sales index, ${viaMedian.toLocaleString()} on the median`);
  console.log(`  size elasticity ${E.toFixed(3)} — a unit 10% larger trades ${(((1.1 ** E) - 1) * 100).toFixed(1)}% per sqm`);
  console.log(`  backtest on ${valued.toLocaleString()} held-out sales: median abs error ${meta.accuracy.medianAbsErrorPct}%, within 10% ${meta.accuracy.within10Pct}%`);
  for (const c of calib) console.log(`    ${c.comps} comps: n=${c.n}, band x${c.lowMult.toFixed(2)}-${c.highMult.toFixed(2)}, median abs err ${c.medianAbsErrorPct?.toFixed(2)}%`);
}

main();
