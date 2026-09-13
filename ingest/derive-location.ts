// Derive per-project location context from the DLD transactions file.
//
// The register publishes no coordinates, but every transaction carries
// nearest_metro_en / nearest_landmark_en / nearest_mall_en and a
// master_project_en (the community). This pass streams transactions.csv once,
// takes the modal value of each field per project, and stores them in a
// project_location table. It also backfills project.master_project_en where
// the project register left it empty but transactions know the community.
//
// Run via `npm run derive` (chained) or `tsx ingest/derive-location.ts`.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { openDb } from './db';

const TX = path.join(process.cwd(), 'data', 'dld', 'transactions.csv');

type Tally = Map<string, number>;
interface Acc { metro: Tally; landmark: Tally; mall: Tally; master: Tally; n: number }

// Same normalisation as ingest-dld.ts pnum: "1740.00" → "1740", so keys match transaction_/project.
const pnum = (v: string) => { const s = v.trim(); if (!s) return ''; const n = Number(s); return Number.isFinite(n) ? String(Math.trunc(n)) : s; };

const bump = (t: Tally, v: string | undefined) => {
  const s = (v ?? '').trim();
  if (!s) return;
  t.set(s, (t.get(s) ?? 0) + 1);
};
const modal = (t: Tally): string | null => {
  let best: string | null = null, bn = 0;
  for (const [k, n] of t) if (n > bn) { best = k; bn = n; }
  return best;
};

async function main() {
  if (!fs.existsSync(TX)) {
    console.log('derive-location: data/dld/transactions.csv not found — skipping.');
    return;
  }
  const acc = new Map<string, Acc>();
  const parser = parse({ columns: true, relax_column_count: true });
  fs.createReadStream(TX).pipe(parser);
  let rows = 0;
  for await (const r of parser as AsyncIterable<Record<string, string>>) {
    rows++;
    const pn = pnum(r.project_number ?? '');
    if (!pn) continue;
    let a = acc.get(pn);
    if (!a) acc.set(pn, a = { metro: new Map(), landmark: new Map(), mall: new Map(), master: new Map(), n: 0 });
    a.n++;
    bump(a.metro, r.nearest_metro_en);
    bump(a.landmark, r.nearest_landmark_en);
    bump(a.mall, r.nearest_mall_en);
    bump(a.master, r.master_project_en);
  }
  console.log(`derive-location: read ${rows.toLocaleString()} transactions, ${acc.size.toLocaleString()} projects with location context`);

  const db = openDb();
  db.exec(`CREATE TABLE IF NOT EXISTS project_location (
    project_number TEXT PRIMARY KEY,
    metro TEXT, landmark TEXT, mall TEXT, master_project_en TEXT, n INTEGER
  );`);
  const up = db.prepare(`INSERT INTO project_location (project_number, metro, landmark, mall, master_project_en, n)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_number) DO UPDATE SET metro=excluded.metro, landmark=excluded.landmark,
      mall=excluded.mall, master_project_en=excluded.master_project_en, n=excluded.n`);
  const tx = db.transaction(() => {
    for (const [pn, a] of acc) up.run(pn, modal(a.metro), modal(a.landmark), modal(a.mall), modal(a.master), a.n);
  });
  tx();

  // Backfill communities the project register left blank.
  const filled = db.prepare(`UPDATE project SET master_project_en = (
      SELECT pl.master_project_en FROM project_location pl
      WHERE pl.project_number = project.project_number AND pl.master_project_en IS NOT NULL)
    WHERE (master_project_en IS NULL OR master_project_en = '')
      AND EXISTS (SELECT 1 FROM project_location pl
        WHERE pl.project_number = project.project_number AND pl.master_project_en IS NOT NULL)`).run();
  console.log(`derive-location: wrote ${acc.size.toLocaleString()} location rows, backfilled community on ${filled.changes} projects.`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
