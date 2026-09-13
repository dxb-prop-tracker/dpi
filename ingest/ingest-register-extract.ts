// Load a "Dubai Project Register" xlsx extract (Ali's dashboard export) as a fresh
// register OBSERVATION for each project it covers. This is what makes the delay
// watch move: every new extract adds a dated status/percent-complete reading to
// project_observation (append-only, never overwritten), so slippage becomes visible.
//
// Usage: npm run ingest:register            (finds the newest Dubai_Project_Register_*.xlsx
//                                            in ~/Downloads or the Dropbox DLD folder)
//        npm run ingest:register -- --file "<path>"
// Then:  npm run derive && npm run build

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { openDb } from './db';

const argFile = process.argv.includes('--file') ? process.argv[process.argv.indexOf('--file') + 1] : null;

function findFile(): string | null {
  const home = os.homedir();
  const ls = (p: string) => { try { return fs.readdirSync(p); } catch { return [] as string[]; } };
  const roots = [
    path.join(home, 'Downloads'),
    path.join(home, 'Dropbox', 'ALI TAMMAM', 'DLD Open Data'),
    ...ls(path.join(home, 'Library', 'CloudStorage')).filter(d => /^Dropbox/i.test(d))
      .map(d => path.join(home, 'Library', 'CloudStorage', d, 'ALI TAMMAM', 'DLD Open Data')),
  ];
  const cands: { f: string; t: number }[] = [];
  for (const r of roots) for (const f of ls(r))
    if (/^Dubai_Project_Register_\d{8}\.xlsx$/i.test(f)) { try { cands.push({ f: path.join(r, f), t: fs.statSync(path.join(r, f)).mtimeMs }); } catch {} }
  cands.sort((a, b) => b.t - a.t);
  return cands[0]?.f ?? null;
}

const file = argFile ?? findFile();
if (!file || !fs.existsSync(file)) {
  console.error('No Dubai_Project_Register_*.xlsx found in ~/Downloads or the Dropbox DLD folder. Pass --file "<path>".');
  process.exit(1);
}
const m = path.basename(file).match(/(\d{4})(\d{2})(\d{2})/);
const observedAt = m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
console.log(`Importing ${file} as register observation dated ${observedAt}`);

const wb = XLSX.readFile(file);
if (!wb.SheetNames.includes('Projects')) { console.error('No "Projects" sheet in this file — is it the register extract?'); process.exit(1); }
const rows = XLSX.utils.sheet_to_json(wb.Sheets['Projects']) as Record<string, any>[];
console.log(rows.length, 'projects in extract');

const db = openDb();
const byName = new Map<string, { pn: string; area: string }[]>();
for (const r of db.prepare(`SELECT project_number pn, name_en, area_name_en area FROM project`).all() as any[]) {
  const k = r.name_en.trim().toLowerCase();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k)!.push({ pn: r.pn, area: r.area });
}
const ins = db.prepare(`INSERT OR IGNORE INTO project_observation(project_number, observed_at, status, percent_completed, completion_date, source) VALUES(?,?,?,?,?, 'register-extract')`);

let added = 0, unmatched: string[] = [];
const tx = db.transaction(() => {
  for (const r of rows) {
    const name = String(r['Project'] ?? '').trim();
    if (!name) continue;
    const cands = byName.get(name.toLowerCase()) ?? [];
    // Prefer the same-area match when a name is ambiguous.
    const hit = cands.length === 1 ? cands[0]
      : cands.find(c => c.area.toLowerCase() === String(r['Area'] ?? '').trim().toLowerCase()) ?? cands[0];
    if (!hit) { unmatched.push(name); continue; }
    const pct = r['Certified complete'] != null && Number.isFinite(Number(r['Certified complete']))
      ? Math.round(Number(r['Certified complete']) * 100) : null;
    const completion = String(r['Completed on'] ?? '').trim() || String(r['Registered end'] ?? '').trim() || null;
    const res = ins.run(hit.pn, observedAt, String(r['Status'] ?? '').trim() || null, pct, completion);
    added += res.changes;
  }
});
tx();
if (unmatched.length) fs.writeFileSync(path.resolve('data', 'register-extract-unmatched.txt'), unmatched.sort().join('\n') + '\n');
console.log(`Recorded ${added} observations dated ${observedAt}; ${unmatched.length} extract rows had no exact register match (grouped phases or newly registered projects) — list saved to data/register-extract-unmatched.txt.`);
console.log('Now run: npm run derive && npm run build');
db.close();
