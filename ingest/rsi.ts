// The Dubai Repeat-Sales Index.
//
//   npm run rsi    ->  public/data/index/{rsi.json, rsi-market.csv, rsi-areas.csv, crosswalk.csv}
//
// A price index built only from homes that sold at least twice, so each observation compares a home
// with ITSELF. That is what makes it different from a median: a median moves when the MIX of what
// traded changes — a quarter in which mostly large or mostly cheap homes happened to sell will bend
// it — whereas a repeat-sales pair has the home's own size, floor, view and finish on both sides of
// the comparison, where they cancel.
//
// Method: Bailey, Muth and Nourse (1963). For each pair, log(second price / first price) is
// regressed on a set of period dummies, +1 at the period of the second sale and -1 at the first.
// The fitted coefficients are the log index. The first period is fixed at zero and the series is
// scaled to 100 there.
//
// Four exclusions, each because including it would measure something other than price:
//   - OFF-PLAN on either side. A home bought off the plan gained partly because it GOT BUILT. That
//     is a construction story and it belongs in a different series.
//   - holds under MIN_HOLD_DAYS. Two sales weeks apart are usually one transaction settling, a
//     related-party transfer, or a correction — not a price change.
//   - ratios beyond MAX_LOG_MOVE. A home that appears to have octupled is a mismatched unit, not a
//     market move. The pair-matching that produced these rows is already conservative, but this is
//     the second line of defence.
//   - pairs whose two sales fall in the same period. They carry no information about the change
//     between periods and only add noise to the normal equations.
//
// The index is published with the PAIR COUNT behind every period, because a period standing on
// forty pairs and one standing on two thousand are not the same number and should not look alike.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';

const OUT = path.resolve(process.cwd(), 'public/data/index');
const BASE_YEAR = 2012;
const MIN_HOLD_DAYS = 180;
const MAX_LOG_MOVE = 1.6;         // about 5x either way
const MIN_AREA_PAIRS = 400;       // below this an area series is noise dressed as a number
const MIN_PERIOD_PAIRS = 15;      // periods thinner than this are published but flagged
const RIDGE = 1e-6;
const VERSION = '1.0';

type Pair = { bought_on: string; sold_on: string; bought_for: number; sold_for: number; area: string };

const quarterOf = (d: string) => (Number(d.slice(0, 4)) - BASE_YEAR) * 4 + Math.floor((Number(d.slice(5, 7)) - 1) / 3);
const label = (q: number) => `${BASE_YEAR + Math.floor(q / 4)}Q${(q % 4) + 1}`;

/** Solve the normal equations by Gaussian elimination with partial pivoting and a small ridge. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let i = 0; i < n; i++) A[i][i] += RIDGE;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    if (Math.abs(A[i][i]) < 1e-12) continue;
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      if (!f) continue;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = Math.abs(A[i][i]) > 1e-12 ? s / A[i][i] : 0;
  }
  return x;
}

/** Fit the index over `periods` consecutive quarters starting at `lo`. */
function fit(pairs: Pair[], lo: number, hi: number) {
  const n = hi - lo + 1;
  const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  const soldIn = new Array(n).fill(0);
  const seen = new Array(n).fill(0);
  let used = 0;
  for (const p of pairs) {
    const i = quarterOf(p.bought_on) - lo, j = quarterOf(p.sold_on) - lo;
    if (i < 0 || j < 0 || i >= n || j >= n || i === j) continue;
    const y = Math.log(p.sold_for / p.bought_for);
    if (!isFinite(y) || Math.abs(y) > MAX_LOG_MOVE) continue;
    used++; soldIn[j]++; seen[i]++; seen[j]++;
    b[j] += y; b[i] -= y;
    A[j][j] += 1; A[i][i] += 1; A[i][j] -= 1; A[j][i] -= 1;
  }
  A[0] = [1, ...new Array(n - 1).fill(0)]; b[0] = 0;     // base period pinned
  const x = solve(A, b);
  return {
    used,
    points: Array.from({ length: n }, (_, k) => ({
      quarter: label(lo + k),
      index: Math.round(100 * Math.exp(x[k]) * 10) / 10,
      pairsSold: soldIn[k],
      pairsTouching: seen[k],
      thin: seen[k] < MIN_PERIOD_PAIRS,
    })),
  };
}

function main() {
  const db = openDb();
  const pairs = db.prepare(`SELECT bought_on, sold_on, bought_for, sold_for, area_name_en area
    FROM resale_pair
    WHERE bought_reg='Existing Properties' AND sold_reg='Existing Properties'
      AND bought_for>50000 AND sold_for>50000 AND hold_days>=${MIN_HOLD_DAYS}
      AND bought_on>='${BASE_YEAR}-01-01' AND sold_on IS NOT NULL`).all() as Pair[];
  if (pairs.length < 500) { console.log(`only ${pairs.length} pairs — not publishing an index`); return; }

  const qs = pairs.flatMap(p => [quarterOf(p.bought_on), quarterOf(p.sold_on)]);
  const lo = Math.min(...qs), hi = Math.max(...qs);
  const market = fit(pairs, lo, hi);

  const byArea = new Map<string, Pair[]>();
  for (const p of pairs) {
    if (!p.area) continue;
    (byArea.get(p.area) ?? byArea.set(p.area, []).get(p.area)!).push(p);
  }
  const areas = [...byArea.entries()]
    .filter(([, v]) => v.length >= MIN_AREA_PAIRS)
    .map(([area, v]) => ({ area, pairs: v.length, ...fit(v, lo, hi) }))
    .sort((a, b) => b.pairs - a.pairs);

  const last = market.points[market.points.length - 1];
  const peak = market.points.reduce((a, p) => (p.index > a.index ? p : a), market.points[0]);
  const trough = market.points.reduce((a, p) => (p.index < a.index ? p : a), market.points[0]);

  const out = {
    name: 'Dubai Repeat-Sales Index',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    base: { quarter: label(lo), value: 100 },
    method: 'Bailey-Muth-Nourse (1963). log(second price / first price) regressed on period dummies, +1 at the period of the second sale and -1 at the first; the fitted coefficients are the log index, the base period pinned at zero and scaled to 100.',
    universe: `Homes that sold at least twice, both sales registered as Existing Properties, held at least ${MIN_HOLD_DAYS} days, both prices above AED 50,000, first sale from ${BASE_YEAR}.`,
    exclusions: [
      'Off-plan on either side: a home bought off the plan gained partly because it got built, which is a construction story, not a price one.',
      `Holds under ${MIN_HOLD_DAYS} days: two sales weeks apart are usually one transaction settling, a related-party transfer or a correction.`,
      `Price ratios beyond ${Math.round(Math.exp(MAX_LOG_MOVE))}x either way: a mismatched unit, not a market move.`,
      'Pairs whose two sales fall in the same quarter: they carry no information about the change between quarters.',
    ],
    limits: [
      'Homes that never resold are not counted at all, and sellers may differ systematically from holders.',
      'A pair assumes the home is unchanged between sales. A renovation is read as a price rise; damage as a fall.',
      `Quarters standing on fewer than ${MIN_PERIOD_PAIRS} pairs are published but flagged thin, because a number on 12 pairs and one on 2,000 should not look alike.`,
      `Area series are published only above ${MIN_AREA_PAIRS} pairs. Below that the estimate is noise dressed as a number.`,
    ],
    pairsAvailable: pairs.length,
    pairsUsed: market.used,
    headline: {
      latest: last, peak, trough,
      fromPeakPct: Math.round((last.index / peak.index - 1) * 1000) / 10,
      fromTroughPct: Math.round((last.index / trough.index - 1) * 1000) / 10,
    },
    market: market.points,
    areas,
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'rsi.json'), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(OUT, 'rsi-market.csv'),
    'quarter,index,pairs_sold,pairs_touching,thin\n' +
    market.points.map(p => `${p.quarter},${p.index},${p.pairsSold},${p.pairsTouching},${p.thin ? 1 : 0}`).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'rsi-areas.csv'),
    'area,quarter,index,pairs_sold,thin\n' +
    areas.flatMap(a => a.points.map(p => `"${a.area.replace(/"/g, '""')}",${p.quarter},${p.index},${p.pairsSold},${p.thin ? 1 : 0}`)).join('\n') + '\n');

  // A stable identifier per project, so anyone citing the index can join to it and keep joining
  // after a display name is cleaned up. The register's project number is the stable thing; the name
  // is not, as we both found out.
  const cross = db.prepare(`SELECT p.project_number pn, p.name_en name, p.area_name_en area,
      p.area_slug area_slug, p.slug, d.name_en developer
    FROM project p LEFT JOIN developer d ON d.developer_number=p.developer_number
    ORDER BY p.project_number`).all() as any[];
  fs.writeFileSync(path.join(OUT, 'crosswalk.csv'),
    'project_number,project_name,developer,area,area_slug,slug\n' +
    cross.map(r => [r.pn, r.name, r.developer, r.area, r.area_slug, r.slug]
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n') + '\n');

  console.log(`RSI v${VERSION}: ${out.pairsUsed.toLocaleString()} pairs used of ${pairs.length.toLocaleString()}, ` +
    `${market.points.length} quarters from ${out.base.quarter}`);
  console.log(`  latest ${last.quarter} ${last.index} · peak ${peak.quarter} ${peak.index} · trough ${trough.quarter} ${trough.index}`);
  console.log(`  ${out.headline.fromPeakPct}% from peak, ${out.headline.fromTroughPct >= 0 ? '+' : ''}${out.headline.fromTroughPct}% from trough`);
  console.log(`  ${areas.length} area series published (>=${MIN_AREA_PAIRS} pairs); crosswalk ${cross.length.toLocaleString()} projects`);
}

main();
