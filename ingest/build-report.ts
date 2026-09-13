// Register reports — three cadences, one engine.
//   weekly  : "The register moved" — vintage-to-vintage diff of our copy of the DLD data + the market pack for the window
//   monthly : a calendar month against the previous month and the same month a year earlier, plus the month across years and YTD
//   yearly  : a calendar year (the current one year-to-date) against previous years
// Output: data/reports/<kind>/<key>.json, rendered by src/pages/reports/…
//
//   npm run report                         automatic: weekly every 7 days; last month's edition from the 3rd; yearly YTD refreshed weekly
//   npm run report -- --weekly [--from D --to D] [--force]
//   npm run report -- --monthly 2026-08
//   npm run report -- --yearly 2026
//   npm run report -- --backfill           the last 6 months and the last 3 years
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';
import { marketReport, monthEnd, shiftMonths, monthLabel, addDays } from './report-lib';
import type { Period } from './report-lib';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = path.resolve('data/reports');
const dir = (kind: string) => { const d = path.join(ROOT, kind); fs.mkdirSync(d, { recursive: true }); return d; };
const list = (kind: string) => fs.existsSync(path.join(ROOT, kind)) ? fs.readdirSync(path.join(ROOT, kind)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort() : [];
const db = openDb(true);
const today = new Date().toISOString().slice(0, 10);
const FIRST_FROM = '2026-08-24'; // our bulk register is the 31 Aug dump; the first weekly edition looks back to the same day Ali's series starts

function movedReport(from: string, to: string, prevEdition: string | null) {
const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
// ---------- helpers ----------
const q = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
const one = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; };
const r0 = (x: number | null) => x == null ? null : Math.round(x);
const r1 = (x: number | null) => x == null ? null : Math.round(x * 10) / 10;
const r2 = (x: number | null) => x == null ? null : Math.round(x * 100) / 100;
const areaSlug = (a: string) => a.toLowerCase().replace(/ /g, '-').replace(/'/g, '-').replace(/\./g, '-').replace(/--/g, '-');
const year = to.slice(0, 4);

// Rows "in the register" as of a date D: no vintage (pre-tracking) or first_seen <= D, and not withdrawn by D.
const asOf = (alias: string, d: string) => `(${alias}.first_seen IS NULL OR ${alias}.first_seen <= '${d}') AND (${alias}.withdrawn_on IS NULL OR ${alias}.withdrawn_on > '${d}')`;

// ---------- sales: vintage comparison by month, current year ----------
const salesByMonth = q<{ m: string; prev: number; now: number; valueBn: number; prevOff: number; nowOff: number; valueOffBn: number }>(`
  SELECT substr(t.instance_date,1,7) AS m,
    SUM(CASE WHEN ${asOf('v', from)} THEN 1 ELSE 0 END) AS prev,
    SUM(CASE WHEN ${asOf('v', to)} THEN 1 ELSE 0 END) AS now,
    SUM(CASE WHEN ${asOf('v', to)} THEN IFNULL(t.actual_worth,0) ELSE 0 END)/1e9 AS valueBn,
    SUM(CASE WHEN ${asOf('v', from)} AND t.reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END) AS prevOff,
    SUM(CASE WHEN ${asOf('v', to)} AND t.reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END) AS nowOff,
    SUM(CASE WHEN ${asOf('v', to)} AND t.reg_type_en='Off-Plan Properties' THEN IFNULL(t.actual_worth,0) ELSE 0 END)/1e9 AS valueOffBn
  FROM transaction_ t LEFT JOIN vintage v ON v.kind='tx' AND v.id=t.transaction_id
  WHERE t.instance_date >= '${year}-01-01' AND t.instance_date <= '${to}' AND t.trans_group_en='Sales'
  GROUP BY 1 ORDER BY 1`).map(r => ({ ...r, valueBn: r2(r.valueBn)!, valueOffBn: r2(r.valueOffBn)!, change: r.now - r.prev, changeOff: r.nowOff - r.prevOff }));

// ---------- sales added to the register in the window ----------
const gained = q<any>(`
  SELECT t.*, v.first_seen FROM transaction_ t JOIN vintage v ON v.kind='tx' AND v.id=t.transaction_id
  WHERE v.first_seen > ? AND v.first_seen <= ? AND v.withdrawn_on IS NULL AND t.trans_group_en='Sales'`, from, to);
const dated = q<any>(`
  SELECT t.*, v.first_seen FROM transaction_ t LEFT JOIN vintage v ON v.kind='tx' AND v.id=t.transaction_id
  WHERE t.instance_date > ? AND t.instance_date <= ? AND t.trans_group_en='Sales' AND (v.withdrawn_on IS NULL OR v.withdrawn_on > ?)`, from, to, to);
const withdrawnRows = q<any>(`
  SELECT t.transaction_id, t.instance_date, t.area_name_en, t.project_name_en, t.actual_worth, t.reg_type_en, v.withdrawn_on
  FROM vintage v JOIN transaction_ t ON t.transaction_id=v.id WHERE v.kind='tx' AND v.withdrawn_on > ? AND v.withdrawn_on <= ? ORDER BY t.instance_date DESC`, from, to);

function salesProfile(rows: any[]) {
  const psm = rows.map(r => r.meter_sale_price).filter((x: any) => x != null && x > 0 && x < 200000);
  const prices = rows.map(r => r.actual_worth).filter((x: any) => x != null && x > 0);
  const buckets = [[0, 10000, '0–10k'], [10000, 15000, '10–15k'], [15000, 20000, '15–20k'], [20000, 25000, '20–25k'], [25000, 30000, '25–30k'], [30000, 40000, '30–40k'], [40000, 1e9, '40k+']] as const;
  const hist = buckets.map(([lo, hi, label]) => ({ bucket: label, n: psm.filter((x: number) => x >= lo && x < hi).length }));
  const group = (key: (r: any) => string, top = 12) => {
    const m = new Map<string, { n: number; value: number; psm: number[]; off: number }>();
    for (const r of rows) { const k = key(r); if (!k) continue; const g = m.get(k) ?? { n: 0, value: 0, psm: [], off: 0 }; g.n++; g.value += r.actual_worth ?? 0; if (r.meter_sale_price > 0 && r.meter_sale_price < 200000) g.psm.push(r.meter_sale_price); if (r.reg_type_en === 'Off-Plan Properties') g.off++; m.set(k, g); }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, top).map(([k, g]) => ({ key: k, n: g.n, share: r1(100 * g.n / rows.length), valueBn: r2(g.value / 1e9), valueM: r0(g.value / 1e6), medianPsm: r0(median(g.psm)), offplanPct: r0(100 * g.off / g.n) }));
  };
  const projSlug = new Map(q<any>(`SELECT project_number, slug, area_slug, name_en FROM project`).map(p => [p.project_number, p]));
  const off = rows.filter(r => r.reg_type_en === 'Off-Plan Properties').length;
  return {
    n: rows.length, valueBn: r2(rows.reduce((s, r) => s + (r.actual_worth ?? 0), 0) / 1e9),
    offplan: off, offplanPct: rows.length ? r0(100 * off / rows.length) : null,
    medianPrice: r0(median(prices)), medianPsm: r0(median(psm)),
    pcts: { p10: r0(pct(psm, .1)), p25: r0(pct(psm, .25)), p50: r0(pct(psm, .5)), p75: r0(pct(psm, .75)), p90: r0(pct(psm, .9)) }, withArea: psm.length, hist,
    byArea: group(r => r.area_name_en).map(a => ({ ...a, slug: areaSlug(a.key) })),
    byProject: group(r => r.project_number ? `${r.project_number}` : '', 14).map(p => { const pr = projSlug.get(p.key); return { ...p, name: pr?.name_en ?? rows.find(r => r.project_number === p.key)?.project_name_en ?? p.key, url: pr ? `/dubai/${pr.area_slug}/${pr.slug}/` : null }; }),
    byRooms: group(r => r.rooms_en || 'Not stated', 10), byType: group(r => r.property_type_en || 'Not stated', 6), byUsage: group(r => r.property_usage_en || 'Not stated', 4),
  };
}
const gainedProfile = salesProfile(gained);
const datedProfile = salesProfile(dated);
const lateRegistrations = gained.filter(r => r.instance_date <= from).length;
const lagDays = gained.filter(r => r.instance_date > from).map(r => Math.round((Date.parse(r.first_seen) - Date.parse(r.instance_date)) / 86400000));

// ---------- rents ----------
const rentGained = q<any>(`SELECT r.*, v.first_seen FROM rent_contract r JOIN vintage v ON v.kind='rent' AND v.id=r.contract_id WHERE v.first_seen > ? AND v.first_seen <= ?`, from, to);
const rentDated = q<any>(`SELECT r.* FROM rent_contract r WHERE r.contract_start_date > ? AND r.contract_start_date <= ?`, from, to);
function rentProfile(rows: any[]) {
  const amt = rows.map(r => r.annual_amount).filter((x: any) => x > 1000 && x < 5e7);
  const psm = rows.filter(r => r.actual_area > 10 && r.annual_amount > 1000).map(r => r.annual_amount / r.actual_area).filter((x: number) => x < 20000);
  const isNew = rows.filter(r => /^new/i.test(r.contract_reg_type_en || '')).length;
  const group = (key: (r: any) => string, top = 12) => {
    const m = new Map<string, { n: number; amt: number[]; psm: number[]; nw: number }>();
    for (const r of rows) { const k = key(r); if (!k) continue; const g = m.get(k) ?? { n: 0, amt: [], psm: [], nw: 0 }; g.n++; if (r.annual_amount > 1000 && r.annual_amount < 5e7) g.amt.push(r.annual_amount); if (r.actual_area > 10 && r.annual_amount > 1000 && r.annual_amount / r.actual_area < 20000) g.psm.push(r.annual_amount / r.actual_area); if (/^new/i.test(r.contract_reg_type_en || '')) g.nw++; m.set(k, g); }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, top).map(([k, g]) => ({ key: k, n: g.n, share: r1(100 * g.n / rows.length), medianAnnual: r0(median(g.amt)), medianPsm: r0(median(g.psm)), newPct: r0(100 * g.nw / g.n) }));
  };
  return { n: rows.length, newPct: rows.length ? r0(100 * isNew / rows.length) : null, medianAnnual: r0(median(amt)), medianPsm: r0(median(psm)),
    byArea: group(r => r.area_name_en).map(a => ({ ...a, slug: areaSlug(a.key) })), byRooms: group(r => r.rooms_en || 'Not stated', 8), byType: group(r => r.ejari_property_type_en || 'Not stated', 5) };
}
const rentGainedProfile = rentProfile(rentGained);
const rentDatedProfile = rentProfile(rentDated);

// ---------- register ----------
const projects = q<any>(`SELECT p.project_number, p.name_en, p.slug, p.area_slug, p.area_name_en, p.units, d.name_en AS developer FROM project p LEFT JOIN developer d USING(developer_number)`);
const pmap = new Map(projects.map(p => [p.project_number, p]));
const obs = q<any>(`SELECT project_number, observed_at, status, percent_completed, completion_date, source FROM project_observation ORDER BY project_number, observed_at`);
const byProj = new Map<string, any[]>();
for (const o of obs) { const a = byProj.get(o.project_number) ?? []; a.push(o); byProj.set(o.project_number, a); }
const latestOf = (arr: any[], upTo: string) => { let best: any = null; for (const o of arr) if (o.observed_at <= upTo) best = o; return best; };
const progress: any[] = [], statusChanges: any[] = [], completionChanges: any[] = [], entered: any[] = [];
const vProj = new Map(q<any>(`SELECT id, first_seen FROM vintage WHERE kind='project'`).map(v => [v.id, v.first_seen]));
for (const [pn, arr] of byProj) {
  const before = latestOf(arr, from), after = latestOf(arr, to);
  const p = pmap.get(pn) ?? { name_en: pn, area_name_en: '', units: null };
  const firstSeen = vProj.get(pn) ?? arr[0].observed_at;
  if (firstSeen > from && firstSeen <= to) entered.push({ pn, name: p.name_en, area: p.area_name_en, developer: p.developer, status: after?.status, pct: after?.percent_completed, units: p.units, url: p.slug ? `/dubai/${p.area_slug}/${p.slug}/` : null });
  if (!before || !after || before === after) continue;
  const link = p.slug ? `/dubai/${p.area_slug}/${p.slug}/` : null;
  const bp = before.percent_completed == null ? null : Math.min(100, before.percent_completed), ap = after.percent_completed == null ? null : Math.min(100, after.percent_completed);
  // A jump straight to 100% between two different extracts is usually the extracts measuring completion differently
  // (the register's percent vs. an extract's "certified complete" flag), not construction: keep it, but mark it suspect.
  const suspect = before.source !== after.source && ap != null && ap >= 99.9 && bp != null && ap - bp >= 50;
  if (bp != null && ap != null && Math.abs(ap - bp) >= 0.05) progress.push({ pn, name: p.name_en, area: p.area_name_en, before: r1(bp), after: r1(ap), change: r1(ap - bp), beforeAt: before.observed_at, afterAt: after.observed_at, beforeSrc: before.source, afterSrc: after.source, suspect, url: link });
  if (before.status && after.status && before.status !== after.status) statusChanges.push({ pn, name: p.name_en, area: p.area_name_en, from: before.status, to: after.status, url: link });
  if (before.completion_date && after.completion_date && before.completion_date !== after.completion_date) completionChanges.push({ pn, name: p.name_en, area: p.area_name_en, from: before.completion_date, to: after.completion_date, months: r1((Date.parse(after.completion_date) - Date.parse(before.completion_date)) / (30.44 * 86400000)), url: link });
}
progress.sort((a, b) => (a.suspect === b.suspect ? 0 : a.suspect ? 1 : -1) || Math.abs(b.change) - Math.abs(a.change));
completionChanges.sort((a, b) => b.months - a.months);
const latestAll = [...byProj.entries()].map(([pn, arr]) => latestOf(arr, to)).filter(Boolean);
const statusMix = (() => { const m = new Map<string, number>(); for (const o of latestAll) m.set(o.status ?? 'Unknown', (m.get(o.status ?? 'Unknown') ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ status: k, n })); })();
const pctMix = (() => { const b: [string, number, number][] = [['0%', 0, 0.0001], ['1–25%', 0.0001, 25], ['25–50%', 25, 50], ['50–75%', 50, 75], ['75–99%', 75, 99.9999], ['100%', 99.9999, 100.0001]]; const out = b.map(([label, lo, hi]) => ({ bucket: label, n: latestAll.filter(o => o.percent_completed != null && Math.min(100, o.percent_completed) >= lo && Math.min(100, o.percent_completed) < hi).length })); out.push({ bucket: 'not stated', n: latestAll.filter(o => o.percent_completed == null).length }); return out; })();
const over100 = latestAll.filter(o => o.percent_completed != null && o.percent_completed > 100).length;
const obsDates = q<any>(`SELECT source, observed_at, COUNT(*) n FROM project_observation GROUP BY 1,2 ORDER BY 2 DESC`);
const readingAges = latestAll.map(o => Math.round((Date.parse(to) - Date.parse(o.observed_at)) / 86400000));
const devsAdded = q<any>(`SELECT d.developer_number, d.name_en, d.slug, v.first_seen FROM vintage v JOIN developer d ON d.developer_number=v.id WHERE v.kind='developer' AND v.first_seen > ? AND v.first_seen <= ? ORDER BY d.developer_number`, from, to);
const registerStamp = one<any>(`SELECT register_stamp FROM refresh_run WHERE register_stamp IS NOT NULL ORDER BY run_date DESC LIMIT 1`)?.register_stamp ?? obsDates.find(o => o.source === 'dld')?.observed_at ?? null;

// ---------- integrity ----------
const runs = q<any>(`SELECT * FROM refresh_run WHERE run_date > ? AND run_date <= ? ORDER BY run_date`, from, to);
const totals = one<any>(`SELECT (SELECT COUNT(*) FROM transaction_) AS tx, (SELECT COUNT(*) FROM rent_contract) AS rents, (SELECT COUNT(*) FROM project) AS projects, (SELECT COUNT(*) FROM developer) AS developers`);
const txTo = one<any>(`SELECT MAX(instance_date) d FROM transaction_ WHERE instance_date <= ?`, to)?.d;
const rentTo = one<any>(`SELECT MAX(contract_start_date) d FROM rent_contract WHERE contract_start_date <= ?`, to)?.d;

const report = {
  date: to, from, to, days, prevEdition, generatedAt: new Date().toISOString(),
  headline: {
    salesGained: gainedProfile.n, salesGainedValueBn: gainedProfile.valueBn, salesDated: datedProfile.n, salesDatedValueBn: datedProfile.valueBn,
    withdrawn: withdrawnRows.length, lateRegistrations, medianLagDays: r0(median(lagDays)),
    rentsGained: rentGainedProfile.n, rentsDated: rentDatedProfile.n,
    projectsEntered: entered.length, progressRevisions: progress.filter(p => !p.suspect).length, progressSuspect: progress.filter(p => p.suspect).length, statusChanges: statusChanges.length, completionChanges: completionChanges.length, developersAdded: devsAdded.length,
  },
  sales: { byMonth: salesByMonth, gained: gainedProfile, dated: datedProfile, withdrawn: withdrawnRows.slice(0, 30), withdrawnCount: withdrawnRows.length },
  rents: { gained: rentGainedProfile, dated: rentDatedProfile },
  register: { total: projects.length, statusMix, pctMix, over100, entered, progress, statusChanges, completionChanges, devsAdded, readings: obsDates, medianReadingAgeDays: r0(median(readingAges)), registerStamp },
  integrity: { runs, totals, txTo, rentTo },
};
return report;
}

// Monthly series stop at the last COMPLETE month: a month still filling in would show as a false dip.
const fullMonth = (to: string) => to === monthEnd(to.slice(0, 7)) ? to.slice(0, 7) : shiftMonths(to.slice(0, 7), -1);
const niceDay = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function weeklyEdition(from: string, to: string, prevEdition: string | null) {
  const moved = movedReport(from, to, prevEdition);
  const cur: Period = { from: addDays(from, 1), to, label: `${from} → ${to}` };
  const len = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const prev: Period = { from: addDays(from, 1 - len), to: from, label: `previous ${len} days` };
  const yoy: Period = { from: addDays(cur.from, -365), to: addDays(to, -365), label: 'same days last year' };
  const market = marketReport(db, cur, prev, yoy, { kind: 'weekly', toMonth: fullMonth(to), toYear: +to.slice(0, 4) });
  const out = { kind: 'weekly', key: to, ...moved, market };
  fs.writeFileSync(path.join(dir('weekly'), `${to}.json`), JSON.stringify(out, null, 1));
  console.log(`weekly ${from} → ${to}: ${moved.headline.salesGained.toLocaleString()} sales added, ${moved.headline.withdrawn} withdrawn, ${moved.headline.progressRevisions} progress revisions · market pack in ${(market.computedMs / 1000).toFixed(0)}s`);
}
function monthlyEdition(ym: string) {
  const cur: Period = { from: `${ym}-01`, to: monthEnd(ym), label: monthLabel(ym) };
  const pm = shiftMonths(ym, -1), ly = shiftMonths(ym, -12);
  const prev: Period = { from: `${pm}-01`, to: monthEnd(pm), label: monthLabel(pm) };
  const yoy: Period = { from: `${ly}-01`, to: monthEnd(ly), label: monthLabel(ly) };
  const market = marketReport(db, cur, prev, yoy, { kind: 'monthly', toMonth: ym, toYear: +ym.slice(0, 4) });
  const out = { kind: 'monthly', key: ym, month: ym, from: cur.from, to: cur.to, label: cur.label, generatedAt: new Date().toISOString(), market };
  fs.writeFileSync(path.join(dir('monthly'), `${ym}.json`), JSON.stringify(out, null, 1));
  console.log(`monthly ${cur.label}: ${market.headline.cur.n.toLocaleString()} sales, AED ${market.headline.cur.valueBn} bn, median AED ${market.headline.cur.medPsmUnit}/sqm (apartments) · ${(market.computedMs / 1000).toFixed(0)}s`);
}
function yearlyEdition(y: number) {
  const ytd = y === +today.slice(0, 4);
  const to = ytd ? today : `${y}-12-31`;
  const cur: Period = { from: `${y}-01-01`, to, label: ytd ? `${y} to ${niceDay(to)}` : String(y) };
  const prev: Period = { from: `${y - 1}-01-01`, to: ytd ? `${y - 1}${to.slice(4)}` : `${y - 1}-12-31`, label: ytd ? `${y - 1} to the same date` : String(y - 1) };
  const yoy: Period = { from: `${y - 2}-01-01`, to: ytd ? `${y - 2}${to.slice(4)}` : `${y - 2}-12-31`, label: ytd ? `${y - 2} to the same date` : String(y - 2) };
  const market = marketReport(db, cur, prev, yoy, { kind: 'yearly', toMonth: fullMonth(to), toYear: y });
  const out = { kind: 'yearly', key: String(y), year: y, ytd, from: cur.from, to, label: cur.label, generatedAt: new Date().toISOString(), market };
  fs.writeFileSync(path.join(dir('yearly'), `${y}.json`), JSON.stringify(out, null, 1));
  console.log(`yearly ${cur.label}: ${market.headline.cur.n.toLocaleString()} sales, AED ${market.headline.cur.valueBn} bn · ${(market.computedMs / 1000).toFixed(0)}s`);
}

// ---------- CLI ----------
const force = args.includes('--force');
if (args.includes('--monthly')) monthlyEdition(flag('--monthly')!);
else if (args.includes('--yearly')) yearlyEdition(+flag('--yearly')!);
else if (args.includes('--backfill')) {
  const thisMonth = today.slice(0, 7);
  for (let i = 6; i >= 1; i--) { const ym = shiftMonths(thisMonth, -i); if (force || !list('monthly').includes(ym)) monthlyEdition(ym); }
  const y = +today.slice(0, 4);
  for (const yy of [y - 2, y - 1]) if (force || !list('yearly').includes(String(yy))) yearlyEdition(yy);
  yearlyEdition(y);
} else {
  // weekly (default / --weekly)
  const to = flag('--to') ?? today;
  const weeklies = list('weekly').filter(d => d < to);
  const prevEdition = weeklies.length ? weeklies[weeklies.length - 1] : null;
  const from = flag('--from') ?? prevEdition ?? FIRST_FROM;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const explicit = !!flag('--from') || !!flag('--to') || args.includes('--weekly');
  if (!force && !explicit && prevEdition && days < 7) console.log(`weekly: ${days} day${days === 1 ? '' : 's'} since the ${prevEdition} edition — next after 7 (use --force to write one now)`);
  else {
    weeklyEdition(from, to, prevEdition);
    yearlyEdition(+to.slice(0, 4)); // the year-to-date edition is refreshed with every weekly
  }
  // last month's edition, once the month is at least 3 days old (late registrations)
  const lastMonth = shiftMonths(today.slice(0, 7), -1);
  if (+today.slice(8, 10) >= 3 && !list('monthly').includes(lastMonth)) monthlyEdition(lastMonth);
  const lastYear = +today.slice(0, 4) - 1;
  if (!list('yearly').includes(String(lastYear))) yearlyEdition(lastYear);
}
