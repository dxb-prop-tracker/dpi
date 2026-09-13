// Developer profiles: a brand is one or more DLD developer numbers (data/developer-groups.json). Everything here is
// computed from the register's dated observations and the sales register — planned dates are the EARLIEST completion
// date we ever observed for a project, reality is its latest status and date.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const db = new Database(path.resolve(process.cwd(), 'data/portal.db'), { readonly: true });
type Row = Record<string, any>;
const today = new Date().toISOString().slice(0, 10);
const thisYear = +today.slice(0, 4);

export type Group = { slug: string; name: string; members: string[]; issuer?: string };
export const groups: Group[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/developer-groups.json'), 'utf8'));
export const groupOf = (dn: string) => groups.find(g => g.members.includes(dn)) ?? null;
export const issuer = (id?: string) => { if (!id) return null; const p = path.resolve(process.cwd(), `data/issuers/${id}.json`); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (x: number | null) => x == null ? null : Math.round(x * 10) / 10;
const months = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (30.44 * 86400000);

/** Full profile for a set of developer numbers. */
export function developerProfile(dns: string[]) {
  const ph = dns.map(() => '?').join(',');
  const projects = db.prepare(`SELECT p.*, d.name_en AS developer FROM project p LEFT JOIN developer d USING(developer_number) WHERE p.developer_number IN (${ph})`).all(...dns) as Row[];
  const pns = projects.map(p => p.project_number);
  if (!pns.length) return null;
  const pph = pns.map(() => '?').join(',');
  const obs = db.prepare(`SELECT project_number, observed_at, status, percent_completed, completion_date, source FROM project_observation WHERE project_number IN (${pph}) ORDER BY project_number, observed_at`).all(...pns) as Row[];
  const byP = new Map<string, Row[]>(); for (const o of obs) { const a = byP.get(o.project_number) ?? []; a.push(o); byP.set(o.project_number, a); }
  // all-time sales per project (absorption), 12m sales, 90d price
  const sales = new Map((db.prepare(`SELECT project_number pn, COUNT(*) n, SUM(CASE WHEN instance_date>=date('now','-365 days') THEN 1 ELSE 0 END) n12, SUM(CASE WHEN instance_date>=date('now','-365 days') THEN actual_worth ELSE 0 END)/1e6 v12,
      SUM(CASE WHEN reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END) off, MIN(instance_date) first, MAX(instance_date) last FROM transaction_ WHERE trans_group_en='Sales' AND project_number IN (${pph}) GROUP BY 1`).all(...pns) as Row[]).map(r => [r.pn, r]));
  const psm90 = new Map((db.prepare(`SELECT project_number pn, ROUND(AVG(meter_sale_price)) psm, COUNT(*) n FROM transaction_ WHERE trans_group_en='Sales' AND property_type_en='Unit' AND meter_sale_price BETWEEN 500 AND 200000 AND instance_date>=date('now','-90 days') AND project_number IN (${pph}) GROUP BY 1`).all(...pns) as Row[]).map(r => [r.pn, r]));

  const rows = projects.map(p => {
    const o = byP.get(p.project_number) ?? [];
    const latest = o[o.length - 1] ?? null;
    const planned = o.map(x => x.completion_date).filter(Boolean).sort()[0] ?? null;          // earliest promised date
    const current = latest?.completion_date ?? null;
    const status = latest?.status ?? null;
    const pct = latest?.percent_completed == null ? null : Math.min(100, latest.percent_completed);
    const s = sales.get(p.project_number);
    const slip = planned && current && current !== planned ? r1(months(planned, current)) : 0;
    const finished = status === 'FINISHED';
    const cancelled = status === 'CANCELLED';
    const live = !finished && !cancelled && status != null;
    const pastDue = live && !!current && current < today;
    const deliveredYear = finished && current ? current.slice(0, 4) : null;
    const plannedYear = planned ? planned.slice(0, 4) : null;
    // delivered late = finished, and its final date is later than the first date we ever saw for it
    const lateMonths = finished && planned && current && current > planned ? r1(months(planned, current)) : 0;
    return { pn: p.project_number, name: p.name_en, area: p.area_name_en, url: `/dubai/${p.area_slug}/${p.slug}/`, units: p.units, status, pct, planned, current, plannedYear, deliveredYear, slipMonths: slip, lateMonths, finished, cancelled, live, pastDue,
      salesAll: s?.n ?? 0, sales12m: s?.n12 ?? 0, value12mM: s?.v12 ? Math.round(s.v12) : 0, offplanAll: s?.off ?? 0, firstSale: s?.first ?? null, lastSale: s?.last ?? null, soldPct: p.units && s?.n ? Math.min(100, Math.round(100 * s.n / p.units)) : null,
      psm90: psm90.get(p.project_number)?.psm ?? null, psm90n: psm90.get(p.project_number)?.n ?? 0, readings: o.length, sources: [...new Set(o.map(x => x.source))] };
  });
  const delivered = rows.filter(r => r.finished).sort((a, b) => (b.current ?? '').localeCompare(a.current ?? ''));
  const building = rows.filter(r => r.live && r.status === 'ACTIVE').sort((a, b) => (a.current ?? '9999').localeCompare(b.current ?? '9999'));
  const pipeline = rows.filter(r => r.live && r.status !== 'ACTIVE').sort((a, b) => (a.current ?? '9999').localeCompare(b.current ?? '9999'));
  const cancelledRows = rows.filter(r => r.cancelled);
  const sum = (xs: Row[], k: string) => xs.reduce((s, r) => s + (r[k] ?? 0), 0);

  // Planned vs reality by year: units the register once promised for year Y (earliest date), what was actually finished in Y,
  // and what promised for Y is still not finished (moved later or past due).
  const years = new Map<string, { plannedUnits: number; plannedProjects: number; deliveredUnits: number; deliveredProjects: number; deliveredOnTimeUnits: number; movedUnits: number; movedProjects: number; pastDueUnits: number }>();
  const yrow = (y: string) => { let g = years.get(y); if (!g) { g = { plannedUnits: 0, plannedProjects: 0, deliveredUnits: 0, deliveredProjects: 0, deliveredOnTimeUnits: 0, movedUnits: 0, movedProjects: 0, pastDueUnits: 0 }; years.set(y, g); } return g; };
  for (const r of rows) {
    if (r.cancelled) continue;
    if (r.plannedYear) { const g = yrow(r.plannedYear); g.plannedUnits += r.units ?? 0; g.plannedProjects++; if (!r.finished && r.current && r.current.slice(0, 4) !== r.plannedYear) { g.movedUnits += r.units ?? 0; g.movedProjects++; } if (r.pastDue) g.pastDueUnits += r.units ?? 0; }
    if (r.deliveredYear) { const g = yrow(r.deliveredYear); g.deliveredUnits += r.units ?? 0; g.deliveredProjects++; if (!r.lateMonths) g.deliveredOnTimeUnits += r.units ?? 0; }
  }
  const byYear = [...years.entries()].map(([y, g]) => ({ year: y, ...g })).filter(x => +x.year >= 2015 && +x.year <= thisYear + 5).sort((a, b) => a.year.localeCompare(b.year));

  // Delivery record
  const finishedWithDates = delivered.filter(r => r.planned && r.current);
  const late = finishedWithDates.filter(r => r.lateMonths > 0.5);
  const record = {
    delivered: delivered.length, deliveredUnits: sum(delivered, 'units'),
    withDates: finishedWithDates.length, late: late.length, onTimePct: finishedWithDates.length ? Math.round(100 * (finishedWithDates.length - late.length) / finishedWithDates.length) : null,
    medianLateMonths: r1(median(late.map(r => r.lateMonths))), worstLate: late.sort((a, b) => b.lateMonths - a.lateMonths).slice(0, 5),
    building: building.length, buildingUnits: sum(building, 'units'), pastDue: building.filter(r => r.pastDue).length, pastDueUnits: sum(building.filter(r => r.pastDue), 'units'),
    slipped: rows.filter(r => r.live && r.slipMonths > 0.5).length, medianSlipMonths: r1(median(rows.filter(r => r.live && r.slipMonths > 0.5).map(r => r.slipMonths))),
    pipeline: pipeline.length, pipelineUnits: sum(pipeline, 'units'), cancelled: cancelledRows.length,
    dueThisYear: building.filter(r => r.current && r.current.slice(0, 4) === String(thisYear)), dueNext: building.filter(r => r.current && +r.current.slice(0, 4) > thisYear),
  };

  // Sales momentum: monthly for 24 months, plus market share of Dubai sales in the last 12 months
  const monthly = db.prepare(`SELECT substr(instance_date,1,7) m, COUNT(*) n, SUM(actual_worth)/1e6 vM, SUM(CASE WHEN reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END) off FROM transaction_ WHERE trans_group_en='Sales' AND project_number IN (${pph}) AND instance_date >= date('now','-24 months') GROUP BY 1 ORDER BY 1`).all(...pns) as Row[];
  const totals = db.prepare(`SELECT COUNT(*) n, SUM(actual_worth)/1e9 bn, SUM(CASE WHEN reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END) off FROM transaction_ WHERE trans_group_en='Sales' AND project_number IN (${pph}) AND instance_date >= date('now','-365 days')`).get(...pns) as Row;
  const prev = db.prepare(`SELECT COUNT(*) n, SUM(actual_worth)/1e9 bn FROM transaction_ WHERE trans_group_en='Sales' AND project_number IN (${pph}) AND instance_date >= date('now','-730 days') AND instance_date < date('now','-365 days')`).get(...pns) as Row;
  const market = db.prepare(`SELECT COUNT(*) n FROM transaction_ WHERE trans_group_en='Sales' AND instance_date >= date('now','-365 days')`).get() as Row;
  const psm = db.prepare(`WITH x AS (SELECT meter_sale_price v, ROW_NUMBER() OVER (ORDER BY meter_sale_price) rn, COUNT(*) OVER () c FROM transaction_ WHERE trans_group_en='Sales' AND property_type_en='Unit' AND meter_sale_price BETWEEN 500 AND 200000 AND project_number IN (${pph}) AND instance_date >= date('now','-365 days')) SELECT AVG(v) m FROM x WHERE rn IN ((c+1)/2,(c+2)/2)`).get(...pns) as Row;
  const psmPrev = db.prepare(`WITH x AS (SELECT meter_sale_price v, ROW_NUMBER() OVER (ORDER BY meter_sale_price) rn, COUNT(*) OVER () c FROM transaction_ WHERE trans_group_en='Sales' AND property_type_en='Unit' AND meter_sale_price BETWEEN 500 AND 200000 AND project_number IN (${pph}) AND instance_date >= date('now','-730 days') AND instance_date < date('now','-365 days')) SELECT AVG(v) m FROM x WHERE rn IN ((c+1)/2,(c+2)/2)`).get(...pns) as Row;
  // Buyer outcomes: resales in the developer's projects
  const rs = db.prepare(`SELECT change_pct*100 c, hold_days h, bought_reg FROM resale_pair WHERE ambiguity=0 AND project_number IN (${pph}) AND sold_on >= date('now','-730 days') AND NOT (ABS(change_pct) < 0.0001 AND hold_days < 60)`).all(...pns) as Row[];
  const resales = { n: rs.length, medianGain: r1(median(rs.map(r => r.c))), lossPct: rs.length ? Math.round(100 * rs.filter(r => r.c < 0).length / rs.length) : null, medianHoldMonths: r1(median(rs.map(r => r.h / 30.44))), offplan: rs.filter(r => /off/i.test(r.bought_reg || '')).length };
  // Areas the developer builds in
  const areas = [...rows.reduce((m, r) => { const g = m.get(r.area) ?? { area: r.area, projects: 0, units: 0, live: 0 }; g.projects++; g.units += r.units ?? 0; if (r.live) g.live++; m.set(r.area, g); return m; }, new Map<string, any>()).values()].sort((a, b) => b.units - a.units);

  return {
    projects: rows, delivered, building, pipeline, cancelled: cancelledRows, byYear, record, areas,
    sales: { monthly, n12: totals.n, bn12: totals.bn ? Math.round(totals.bn * 100) / 100 : 0, off12Pct: totals.n ? Math.round(100 * totals.off / totals.n) : null, nPrev: prev.n, bnPrev: prev.bn, sharePct: market.n ? Math.round(1000 * totals.n / market.n) / 10 : null, medPsm12: psm.m ? Math.round(psm.m) : null, medPsmPrev: psmPrev.m ? Math.round(psmPrev.m) : null },
    resales,
    totals: { projects: rows.length, units: sum(rows.filter(r => !r.cancelled), 'units'), readings: obs.length, readingDates: [...new Set(obs.map(o => o.observed_at))].sort() },
  };
}
