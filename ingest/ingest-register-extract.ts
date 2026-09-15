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

// B18 — the Blob cache first, the old folders after it.
//
// The register export runs in the cloud and uploads the workbook to the `register-export`
// container; `ingest/pull-register.sh` brings it down into data/register/. That is now the first
// place this looks. ~/Downloads and the Dropbox folders stay behind it so an older checkout and a
// hand-downloaded file both still work, but nothing depends on a synced folder any more: run
// `npm run pull:register` (or the script directly) and this finds it.
//
// Two name shapes are accepted. The cloud job writes Dubai_Project_Register_2026-09-15.xlsx and
// the hand exports were Dubai_Project_Register_20260915.xlsx; the date is parsed from either
// below, so a mixed folder sorts and dates correctly instead of silently skipping half of it.
const REGISTER_NAME = /^Dubai_Project_Register_(\d{4})-?(\d{2})-?(\d{2})\.xlsx$/i;

function findFile(): string | null {
  const home = os.homedir();
  const ls = (p: string) => { try { return fs.readdirSync(p); } catch { return [] as string[]; } };
  const roots = [
    // ESM: no __dirname. npm scripts run from the repo root, which is what this resolves against.
    process.env.REGISTER_DIR || path.join(process.cwd(), 'data', 'register'),
    path.join(home, 'Downloads'),
    path.join(home, 'Dropbox', 'ALI TAMMAM', 'DLD Open Data'),
    ...ls(path.join(home, 'Library', 'CloudStorage')).filter(d => /^Dropbox/i.test(d))
      .map(d => path.join(home, 'Library', 'CloudStorage', d, 'ALI TAMMAM', 'DLD Open Data')),
  ];
  // Ordered by the register date in the NAME, not by mtime: a re-download or a Dropbox resync
  // touches the mtime of an old workbook and used to make it outrank a newer one.
  const cands: { f: string; d: string; rank: number }[] = [];
  roots.forEach((r, rank) => { for (const f of ls(r)) {
    const m = f.match(REGISTER_NAME);
    if (m) cands.push({ f: path.join(r, f), d: `${m[1]}-${m[2]}-${m[3]}`, rank });
  }});
  cands.sort((a, b) => (b.d < a.d ? -1 : b.d > a.d ? 1 : a.rank - b.rank));
  return cands[0]?.f ?? null;
}

const file = argFile ?? findFile();
if (!file || !fs.existsSync(file)) {
  console.error('No Dubai_Project_Register_*.xlsx found. Run "bash ingest/pull-register.sh" to bring the\n'
    + 'newest one down from the register-export Blob container, or pass --file "<path>".');
  process.exit(1);
}
// Both name shapes again. Matching only eight consecutive digits skipped the dashed form the cloud
// job writes, and the fallback silently dated the whole import TODAY — every reading in it would
// have been stamped with the day it was loaded rather than the day the register was cut.
const m = path.basename(file).match(REGISTER_NAME);
if (!m) console.warn(`WARNING: cannot read a register date out of "${path.basename(file)}" — dating this import today.`);
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

// B18 — two workbooks wear the same file name, and they are not the same workbook.
//
// The one that used to arrive by Dropbox is Ali's CURATED extract: sheets README / Projects /
// Developers / Areas, friendly headers, prices and yields, and no project number — rows are matched
// to the database by NAME. The one in the `register-export` Blob container is the RAW register:
// one sheet called Register, the gateway's own upper-case columns, and PROJECT_NUMBER on every row.
//
// Reading both is the point. The raw one is the better input for what this loader does — it joins
// on the register's own key instead of guessing at names, so the unmatched list goes to nothing —
// and it is the one that arrives without a file-exchange folder in the middle. The curated one is
// still read so an older checkout, or a hand-downloaded file, keeps working unchanged.
type Reading = { key: string | null; name: string; area: string; pct: number | null; status: string | null; completion: string | null; inspected: any };

const wb = XLSX.readFile(file);
let rows: Reading[];
if (wb.SheetNames.includes('Register')) {
  const raw = XLSX.utils.sheet_to_json(wb.Sheets['Register']) as Record<string, any>[];
  // PERCENT_COMPLETED is already a percentage here (13.69); the curated sheet carries a fraction.
  rows = raw.map(r => ({
    key: r['PROJECT_NUMBER'] == null ? null : String(r['PROJECT_NUMBER']).trim(),
    name: String(r['PROJECT_EN'] ?? '').trim(),
    area: String(r['AREA_EN'] ?? '').trim(),
    pct: Number.isFinite(Number(r['PERCENT_COMPLETED'])) && r['PERCENT_COMPLETED'] != null
      ? Math.round(Number(r['PERCENT_COMPLETED']) * 100) / 100 : null,
    status: String(r['PROJECT_STATUS'] ?? '').trim() || null,
    completion: String(r['COMPLETION_DATE'] ?? '').trim() || String(r['END_DATE'] ?? '').trim() || null,
    inspected: r['INSPECTION_DATE'],
  }));
  console.log(`${rows.length} projects in the raw register export (joined on PROJECT_NUMBER)`);
} else if (wb.SheetNames.includes('Projects')) {
  const cur = XLSX.utils.sheet_to_json(wb.Sheets['Projects']) as Record<string, any>[];
  rows = cur.map(r => ({
    key: null,
    name: String(r['Project'] ?? '').trim(),
    area: String(r['Area'] ?? '').trim(),
    pct: r['Certified complete'] != null && Number.isFinite(Number(r['Certified complete']))
      ? Math.round(Number(r['Certified complete']) * 10000) / 100 : null,
    status: String(r['Status'] ?? '').trim() || null,
    completion: String(r['Completed on'] ?? '').trim() || String(r['Registered end'] ?? '').trim() || null,
    inspected: r['Last inspection'],
  }));
  console.log(`${rows.length} projects in the curated extract (matched by name)`);
} else {
  console.error(`No "Register" or "Projects" sheet in this file (it has: ${wb.SheetNames.join(', ')}) — is it a register extract?`);
  process.exit(1);
}

const db = openDb();
const byName = new Map<string, { pn: string; area: string }[]>();
const known = new Set<string>();
for (const r of db.prepare(`SELECT project_number pn, name_en, area_name_en area FROM project`).all() as any[]) {
  const k = r.name_en.trim().toLowerCase();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k)!.push({ pn: r.pn, area: r.area });
  known.add(String(r.pn).trim());
}
const ins = db.prepare(`INSERT OR IGNORE INTO project_observation(project_number, observed_at, status, percent_completed, completion_date, source) VALUES(?,?,?,?,?, 'register-extract')`);

let added = 0, undated = 0, unmatched: string[] = [];
const tx = db.transaction(() => {
  for (const r of rows) {
    // The register's own key when the export carries one, the name only when it does not.
    let pn: string | null = null;
    if (r.key && known.has(r.key)) pn = r.key;
    else if (r.key) { unmatched.push(`${r.key} ${r.name}`); continue; }
    else {
      if (!r.name) continue;
      const cands = byName.get(r.name.toLowerCase()) ?? [];
      // Prefer the same-area match when a name is ambiguous.
      const hit = cands.length === 1 ? cands[0]
        : cands.find(c => c.area.toLowerCase() === r.area.toLowerCase()) ?? cands[0];
      if (!hit) { unmatched.push(r.name); continue; }
      pn = hit.pn;
    }
    const observedAt = inspectionDate(r.inspected) ?? (r.pct == null ? fileDate : null);
    if (!observedAt) { undated++; continue; }   // a percentage with no inspection date is not a dated reading
    const res = ins.run(pn, observedAt, r.status, r.pct, r.completion);
    added += res.changes;
  }
});
tx();
if (unmatched.length) fs.writeFileSync(path.resolve('data', 'register-extract-unmatched.txt'), unmatched.sort().join('\n') + '\n');
console.log(`Recorded ${added} observations dated by inspection (${undated} rows carried a percentage but no inspection date and were skipped); ${unmatched.length} extract rows had no exact register match (grouped phases or newly registered projects) — list saved to data/register-extract-unmatched.txt.`);
console.log('Now run: npm run derive && npm run build');
db.close();
