// Next-quarter sales forecast, per issuer and for the market, written to public/data/issuers/.
//
//   npm run forecast                 every issuer
//   npm run forecast -- binghatti    one of them
//
// Why this exists: a credit fund is not buying a snapshot, it is buying the next quarter. The
// register tells us what has been sold to date; this turns that history into a range for what the
// next two quarters look like if nothing new is launched.
//
// The method, in order:
//   1. Monthly sales from the transactions register, whole months only - a part-month would read as
//      a collapse.
//   2. Seasonal factors: each month's ratio to the centred twelve-month mean, taken as the median
//      across all the years we hold, then normalised to average one. Dubai's seasonality is real but
//      mild (roughly 0.88 in April to 1.11 in October), so it is a correction, not the story.
//   3. Two cases, always both, because a single number here would be a forecast dressed as a fact:
//        FLAT      the last three seasonally adjusted months held, re-seasonalised
//        MOMENTUM  a log-linear trend through the last twelve seasonally adjusted months, DAMPED
//      The trend is damped (each month carries 0.85 of the previous month's slope) so that it fades
//      towards a level instead of compounding to nothing. Undamped, Binghatti's own -21% a month
//      reaches near zero inside a year, which no one believes and which would make the low end of
//      the range useless. Damping is the standard treatment and it is stated, not hidden.
//      The market is falling sharply, so momentum is materially below flat. Which is right depends
//      on whether you think the decline has found a floor - a judgement we do not make for the user.
//   4. Issuer level: the issuer's own monthly series, with the market's seasonal factors (an issuer's
//      own series is too thin to estimate seasonality from) and the issuer's own momentum.
//
// Nothing here is an opinion about any issuer. It is arithmetic on the register, and both ends of
// the range are shown.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';

const OUT = path.resolve(process.cwd(), 'public/data/issuers');
const ISSUER_DIR = path.resolve(process.cwd(), 'data/issuers');
const HISTORY_FROM = '2019-01';
const MIN_MONTHS = 30;          // below this a trend is noise, and we say so rather than print one
const DAMPING = 0.85;           // each month carries this much of the previous month's slope

type Row = { m: string; n: number; v: number };

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** The last whole month we hold: a part-month in the series would read as a collapse. */
function lastWholeMonth(maxDate: string): string {
  const [y, m, d] = maxDate.slice(0, 10).split('-').map(Number);
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d >= daysIn) return `${y}-${String(m).padStart(2, '0')}`;
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

/** Ratio of each month to its centred twelve-month mean, median across years, normalised to 1. */
function seasonalFactors(keys: string[], series: Map<string, number>): number[] {
  const buckets: number[][] = Array.from({ length: 13 }, () => []);
  for (let i = 6; i + 6 < keys.length; i++) {
    let sum = 0;
    for (let j = i - 6; j <= i + 6; j++) sum += series.get(keys[j]) ?? 0;
    const avg = sum / 13;
    if (avg > 0) buckets[Number(keys[i].slice(5, 7))].push((series.get(keys[i]) ?? 0) / avg);
  }
  const raw = Array.from({ length: 13 }, (_, m) => (m && buckets[m].length ? median(buckets[m]) : 1));
  const mean = raw.slice(1).reduce((a, b) => a + b, 0) / 12;
  return raw.map((f, i) => (i === 0 ? 1 : f / mean));
}

/** Log-linear trend through the last twelve seasonally adjusted months. */
function momentumPerMonth(sa: number[]): number {
  const n = sa.length, xs = [...Array(n).keys()];
  const ys = sa.map(v => Math.log(Math.max(v, 1e-9)));
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

const key = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

function forecast(keys: string[], series: Map<string, number>, factors: number[], horizon = 8) {
  const sa = keys.map(k => (series.get(k) ?? 0) / factors[Number(k.slice(5, 7))]);
  const last12 = sa.slice(-12);
  const flatLevel = last12.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const b = momentumPerMonth(last12);
  const a = last12.map(Math.log).reduce((s, v) => s + v, 0) / 12 - b * 5.5;
  const [ly, lm] = keys[keys.length - 1].split('-').map(Number);
  const months: { month: string; flat: number; momentum: number }[] = [];
  const anchor = a + b * 11;          // the fitted level at the last observed month
  let damped = 0;
  for (let h = 1; h <= horizon; h++) {
    let m = lm + h, y = ly;
    while (m > 12) { m -= 12; y++; }
    damped += b * Math.pow(DAMPING, h);   // the slope fades rather than compounding
    const f = factors[m];
    months.push({ month: key(y, m), flat: flatLevel * f, momentum: Math.exp(anchor + damped) * f });
  }
  return { months, momentumPctPerMonth: (Math.exp(b) - 1) * 100, damping: DAMPING, flatLevel };
}

/** Calendar quarters, so a quarter is a quarter and not "the next three months". */
function quarters(months: { month: string; flat: number; momentum: number }[]) {
  const q = new Map<string, { quarter: string; flat: number; momentum: number; months: number }>();
  for (const m of months) {
    const [y, mm] = m.month.split('-').map(Number);
    const key = `${y}-Q${Math.ceil(mm / 3)}`;
    const cur = q.get(key) ?? { quarter: key, flat: 0, momentum: 0, months: 0 };
    cur.flat += m.flat; cur.momentum += m.momentum; cur.months++;
    q.set(key, cur);
  }
  // A quarter we only hold part of would read as a collapse, so say how many months it covers.
  return [...q.values()];
}

function main() {
  const db = openDb();
  const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const maxDate = (db.prepare(`SELECT MAX(instance_date) d FROM transaction_ WHERE trans_group_en='Sales'`).get() as any).d;
  const last = lastWholeMonth(maxDate);

  const marketRows = db.prepare(`SELECT substr(instance_date,1,7) m, COUNT(*) n, SUM(actual_worth)/1e6 v
    FROM transaction_ WHERE trans_group_en='Sales' AND instance_date>=? AND substr(instance_date,1,7)<=?
    GROUP BY 1 ORDER BY 1`).all(HISTORY_FROM + '-01', last) as Row[];
  const keys = marketRows.map(r => r.m);
  const mN = new Map(marketRows.map(r => [r.m, r.n]));
  const mV = new Map(marketRows.map(r => [r.m, r.v]));
  const fN = seasonalFactors(keys, mN);
  const fV = seasonalFactors(keys, mV);

  const ids = fs.readdirSync(ISSUER_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
    .filter(id => !only.length || only.includes(id));

  const market = {
    units: forecast(keys, mN, fN), value: forecast(keys, mV, fV),
  };

  for (const id of ids) {
    const conf = JSON.parse(fs.readFileSync(path.join(ISSUER_DIR, `${id}.json`), 'utf8'));
    const dn: string[] = conf.dldDevelopers ?? [];
    if (!dn.length) { console.log(`${id}: no DLD developer numbers — skipped`); continue; }
    const ph = dn.map(() => '?').join(',');
    const rows = db.prepare(`SELECT substr(t.instance_date,1,7) m, COUNT(*) n, SUM(t.actual_worth)/1e6 v
      FROM transaction_ t JOIN project p ON p.project_number=t.project_number
      WHERE t.trans_group_en='Sales' AND p.developer_number IN (${ph})
        AND t.instance_date>=? AND substr(t.instance_date,1,7)<=? GROUP BY 1 ORDER BY 1`)
      .all(...dn, HISTORY_FROM + '-01', last) as Row[];

    // Fill the gaps: a month with no sale is a zero, not a missing observation.
    const have = new Map(rows.map(r => [r.m, r]));
    const iN = new Map(keys.map(k => [k, have.get(k)?.n ?? 0]));
    const iV = new Map(keys.map(k => [k, have.get(k)?.v ?? 0]));
    const months = rows.filter(r => r.n > 0).length;

    const out: any = {
      issuer: id, brand: conf.brand, generatedAt: new Date().toISOString(),
      throughMonth: last, monthsOfHistory: months,
      method: 'Seasonal factors from the whole Dubai sales series (median ratio to the centred 12-month mean, normalised to 1). Two cases: FLAT holds the last three seasonally adjusted months; MOMENTUM continues a log-linear trend through the last twelve. Both are shown because neither is a fact.',
      seasonalFactors: Object.fromEntries(fN.slice(1).map((f, i) => [i + 1, Number(f.toFixed(4))])),
      market: {
        units: { ...market.units, quarters: quarters(market.units.months) },
        valueAedM: { ...market.value, quarters: quarters(market.value.months) },
      },
    };
    if (months >= MIN_MONTHS) {
      const u = forecast(keys, iN, fN), v = forecast(keys, iV, fV);
      out.issuerForecast = {
        units: { ...u, quarters: quarters(u.months) },
        valueAedM: { ...v, quarters: quarters(v.months) },
      };
      out.lastTwelveMonths = {
        units: keys.slice(-12).reduce((a, k) => a + (iN.get(k) ?? 0), 0),
        valueAedM: keys.slice(-12).reduce((a, k) => a + (iV.get(k) ?? 0), 0),
      };
    } else {
      out.issuerForecast = null;
      out.why = `only ${months} months with recorded sales — too thin to put a trend through, so the market case is shown alone`;
    }
    out.history = keys.slice(-24).map(k => ({ month: k, units: iN.get(k) ?? 0, valueAedM: Number((iV.get(k) ?? 0).toFixed(1)),
      marketUnits: mN.get(k) ?? 0, marketValueAedM: Number((mV.get(k) ?? 0).toFixed(1)) }));

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${id}-forecast.json`), JSON.stringify(out, null, 1));
    const q = out.issuerForecast?.units.quarters?.[1];
    console.log(`${id}: through ${last}, ${months} months of sales` +
      (q ? `, next full quarter ${q.quarter} ${Math.round(q.flat).toLocaleString()} units flat / ${Math.round(q.momentum).toLocaleString()} momentum` : ` — ${out.why}`));
  }
  console.log(`market momentum: units ${market.units.momentumPctPerMonth.toFixed(1)}%/month, value ${market.value.momentumPctPerMonth.toFixed(1)}%/month`);
}

main();
