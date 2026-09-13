// The register-moved feed: what changed, per project, since the last run.
//
//   npm run moves
//
// This is what a watchlist watches. The site is static, so there is no server to push an alert from;
// instead every project's recent movement is published as one small file, the browser holds the list
// of projects a person follows, and the page tells them what has moved since they last looked. The
// list never leaves their device, which for a product whose users are tracking specific towers is a
// feature rather than a limitation.
//
// Only things that genuinely moved are recorded. A project with no new sale, no certified-progress
// change and no completion-date change produces no row at all, so an empty feed means nothing
// happened rather than that the job failed.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';

const OUT = path.resolve(process.cwd(), 'public/data');
const WINDOW = 45;          // days of movement to carry

type Row = Record<string, any>;

function main() {
  const db = openDb();
  const today = new Date().toISOString().slice(0, 10);

  const sales = db.prepare(`SELECT t.project_number pn, COUNT(*) n, SUM(t.actual_worth)/1e6 vM,
      MAX(t.instance_date) last, ROUND(AVG(t.meter_sale_price)) psm
    FROM transaction_ t
    WHERE t.trans_group_en='Sales' AND t.instance_date >= date('now','-${WINDOW} days')
      AND t.project_number IS NOT NULL GROUP BY 1`).all() as Row[];
  const prior = db.prepare(`SELECT project_number pn, COUNT(*) n, ROUND(AVG(meter_sale_price)) psm
    FROM transaction_ WHERE trans_group_en='Sales'
      AND instance_date >= date('now','-${WINDOW * 2} days') AND instance_date < date('now','-${WINDOW} days')
      AND project_number IS NOT NULL GROUP BY 1`).all() as Row[];
  const priorBy = new Map(prior.map(r => [r.pn, r]));

  // Certified progress and completion dates, comparing the two most recent readings per project.
  const obs = db.prepare(`SELECT project_number pn, substr(observed_at,1,10) d, percent_completed p,
      completion_date cd, status st FROM project_observation ORDER BY project_number, observed_at`).all() as Row[];
  const moved = new Map<string, Row>();
  let cur: Row[] = [], curPn = '';
  const flush = () => {
    if (cur.length >= 2) {
      const a = cur[cur.length - 2], b = cur[cur.length - 1];
      const dp = (b.p ?? null) !== null && (a.p ?? null) !== null ? b.p - a.p : null;
      if ((dp !== null && Math.abs(dp) >= 0.5) || (a.cd ?? '') !== (b.cd ?? '') || a.st !== b.st)
        moved.set(curPn, { from: a, to: b, deltaPct: dp === null ? null : Math.round(dp * 10) / 10 });
    }
  };
  for (const o of obs) {
    if (o.pn !== curPn) { flush(); cur = []; curPn = o.pn; }
    cur.push(o);
  }
  flush();

  const projects = db.prepare(`SELECT p.project_number pn, p.name_en nm, p.slug, p.area_slug asl,
      p.area_name_en area, d.name_en dev FROM project p LEFT JOIN developer d
      ON d.developer_number=p.developer_number`).all() as Row[];
  const meta = new Map(projects.map(p => [p.pn, p]));

  const rows: Row[] = [];
  const keys = new Set([...sales.map(s => s.pn), ...moved.keys()]);
  for (const pn of keys) {
    const m = meta.get(pn);
    if (!m || !m.slug) continue;
    const s = sales.find(x => x.pn === pn);
    const pv = priorBy.get(pn);
    const mv = moved.get(pn);
    const events: Row[] = [];
    if (s && s.n > 0) {
      const ch = pv && pv.n > 0 ? Math.round(((s.n - pv.n) / pv.n) * 100) : null;
      events.push({ kind: 'sales', n: s.n, valueAedM: Math.round(s.vM), last: s.last?.slice(0, 10),
        psm: s.psm, vsPriorPct: ch });
    }
    if (mv?.deltaPct != null && Math.abs(mv.deltaPct) >= 0.5)
      events.push({ kind: 'progress', deltaPct: mv.deltaPct, from: mv.from.p, to: mv.to.p,
        readOn: mv.to.d });
    if (mv && (mv.from.cd ?? '') !== (mv.to.cd ?? ''))
      events.push({ kind: 'completionDate', from: mv.from.cd, to: mv.to.cd, readOn: mv.to.d });
    if (mv && mv.from.st !== mv.to.st)
      events.push({ kind: 'status', from: mv.from.st, to: mv.to.st, readOn: mv.to.d });
    if (!events.length) continue;
    rows.push({ pn, name: m.nm, area: m.area, developer: m.dev,
      url: `/dubai/${m.asl}/${m.slug}/`, events });
  }
  rows.sort((a, b) => (b.events[0].n ?? 0) - (a.events[0].n ?? 0));

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'moves.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), windowDays: WINDOW, asOf: today,
    projects: rows.length, rows,
  }));
  const kinds = rows.flatMap(r => r.events.map((e: Row) => e.kind));
  console.log(`moves: ${rows.length.toLocaleString()} projects moved in the last ${WINDOW} days ` +
    `(${kinds.filter(k => k === 'sales').length} with sales, ` +
    `${kinds.filter(k => k === 'progress').length} progress, ` +
    `${kinds.filter(k => k === 'completionDate').length} date changes, ` +
    `${kinds.filter(k => k === 'status').length} status changes)`);
}

main();
