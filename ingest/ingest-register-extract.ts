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
const fileDate = m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
console.log(`Importing ${file} (register as at ${fileDate}); each reading is dated by its "Last inspection"`);

// A reading is dated by the inspection that produced it, never by the day the workbook was built.
// The 30 August 2026 workbook carried Burj Binghatti at 35% with a last inspection of 16 December
// 2025; dated 30 August it outranked the gateway's 25 August reading of 52% and 14 other towers'
// current readings the same way (B3 engine comparison, 14 September 2026). Excel serials, Dates and
// ISO strings all appear in the column depending on how the workbook was written.
function inspectionDate(v: any): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) { const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000); return d.toISOString().slice(0, 10); }
  const s = String(v).trim(); const mm = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return mm ? `${mm[1]}-${mm[2]}-${mm[3]}` : null;
}

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

let added = 0, undated = 0, unmatched: string[] = [];
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
      ? Math.round(Number(r['Certified complete']) * 10000) / 100 : null;
    const completion = String(r['Completed on'] ?? '').trim() || String(r['Registered end'] ?? '').trim() || null;
    const observedAt = inspectionDate(r['Last inspection']) ?? (pct == null ? fileDate : null);
    if (!observedAt) { undated++; continue; }   // a percentage with no inspection date is not a dated reading
    const res = ins.run(hit.pn, observedAt, String(r['Status'] ?? '').trim() || null, pct, completion);
    added += res.changes;
  }
});
tx();
if (unmatched.length) fs.writeFileSync(path.resolve('data', 'register-extract-unmatched.txt'), unmatched.sort().join('\n') + '\n');
console.log(`Recorded ${added} observations dated by inspection (${undated} rows carried a percentage but no inspection date and were skipped); ${unmatched.length} extract rows had no exact register match (grouped phases or newly registered projects) — list saved to data/register-extract-unmatched.txt.`);
console.log('Now run: npm run derive && npm run build');
db.close();
