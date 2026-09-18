// How long after a project launches do its first-sale registrations reach the register?
//
//   npx tsx tools/export-registration-lag.ts --developer 1051 [--from 2024Q1] [--out data/exports]
//
// Writes <developer>_registration_lag.csv: for every quarter of registration, the first-sale value split by how long
// after the project's start date it registered. The issuer engines use it as evidence about the lag between a sale and
// its registration — the project's launch is the only sale-side date the open register carries.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDb, DB_PATH } from '../ingest/db';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const developer = flag('--developer');
if (!developer) { console.error('usage: export-registration-lag.ts --developer <number> [--from 2022Q1] [--out data/exports]'); process.exit(2); }
const from = flag('--from') ?? '2022Q1';
const outDir = path.resolve(flag('--out') ?? 'data/exports');

// The first-sale procedures and the home rule of tools/panels/*.json, kept in step with the panel generator.
const PROCEDURES = ['Sell - Pre registration', 'Delayed Sell', 'Sale On Payment Plan'];
const BUCKETS: [string, number, number][] = [
  ['under_3_months', -10000, 90], ['3_to_6_months', 90, 180], ['6_to_12_months', 180, 365],
  ['12_to_18_months', 365, 548], ['over_18_months', 548, 1e9],
];

const db = openDb();
const fromDate = `${from.slice(0, 4)}-${String((Number(from.slice(5)) - 1) * 3 + 1).padStart(2, '0')}-01`;
const rows = db.prepare(`
  SELECT t.instance_date, t.actual_worth, p.project_start_date, p.project_number, p.name_en
  FROM transaction_ t JOIN project p ON p.project_number = t.project_number
  WHERE p.developer_number = ? AND t.instance_date >= ?
    AND t.procedure_name_en IN (${PROCEDURES.map(() => '?').join(',')})
    AND (t.property_type_en IN ('Unit','Villa') OR (t.property_type_en = 'Land' AND t.procedure_area <= 3000))
`).all(developer, fromDate, ...PROCEDURES) as any[];

type Cell = { value: number; n: number };
const grid = new Map<string, Map<string, Cell>>();
let noLaunchDate = 0, noLaunchValue = 0;
for (const r of rows) {
  const q = `${r.instance_date.slice(0, 4)}Q${Math.floor((Number(r.instance_date.slice(5, 7)) - 1) / 3) + 1}`;
  if (!r.project_start_date) { noLaunchDate++; noLaunchValue += Number(r.actual_worth ?? 0); continue; }
  const days = Math.round((Date.parse(r.instance_date) - Date.parse(r.project_start_date)) / 86400000);
  const bucket = BUCKETS.find(([, lo, hi]) => days >= lo && days < hi)![0];
  const row = grid.get(q) ?? new Map<string, Cell>();
  const cell = row.get(bucket) ?? { value: 0, n: 0 };
  cell.value += Number(r.actual_worth ?? 0); cell.n += 1;
  row.set(bucket, cell); grid.set(q, row);
}

const lines = ['quarter,lag_bucket,registrations,first_sale_value'];
for (const q of [...grid.keys()].sort())
  for (const [bucket] of BUCKETS) {
    const cell = grid.get(q)!.get(bucket);
    if (cell) lines.push(`${q},${bucket},${cell.n},${cell.value.toFixed(2)}`);
  }
const csv = lines.join('\n') + '\n';
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `developer_${developer}_registration_lag.csv`);
fs.writeFileSync(out, csv);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.writeFileSync(out.replace(/\.csv$/, '.manifest.json'), JSON.stringify({
  developer_number: developer, from_quarter: from, procedures: PROCEDURES,
  home_rule: 'Unit or Villa, or Land up to 3,000 m² — the panel generator\'s rule',
  lag_measured_from: 'project.project_start_date, the launch date in the DLD project register',
  registrations_without_a_launch_date: noLaunchDate,
  value_without_a_launch_date: Number(noLaunchValue.toFixed(2)),
  rows: rows.length, database: DB_PATH, dpi_commit: commit,
  generated_at: new Date().toISOString(), sha256: crypto.createHash('sha256').update(csv).digest('hex'),
}, null, 2) + '\n');
console.log(`developer ${developer}: ${rows.length.toLocaleString()} first-sale registrations → ${path.relative(process.cwd(), out)}` +
  (noLaunchDate ? ` (${noLaunchDate} with no launch date, AED ${(noLaunchValue / 1e6).toFixed(1)}m, left out)` : ''));
