// Prepare the Dubai Pulse bulk files (as downloaded from data.dubai / kept in Dropbox "ALI TAMMAM/DLD Open Data")
// into the three files the loader expects in data/dld/. Usage:
//   npm run prepare:pulse -- "/Users/you/Dropbox/ALI TAMMAM/DLD Open Data"
// - transactions_*_0001..N.csv  → data/dld/transactions.csv (parts merged, header kept once)
// - rent_contracts_*_0001..N.csv → data/dld/rents.csv (filtered to contracts starting 2024 onwards, 13 columns)
// - projects_*.csv, developers_*.csv, oa_service_charges_*.csv → copied as projects.csv / developers.csv / service_charges.csv
// Never open these files in Excel: they exceed Excel's row limit and would be truncated on save.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parse } from 'csv-parse';

import os from 'node:os';
// Find the Dropbox folder automatically when no path is given (macOS keeps it under ~/Library/CloudStorage nowadays).
function autoDetect(): string | null {
  const home = os.homedir();
  const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const ls = (p: string) => { try { return fs.readdirSync(p); } catch { return [] as string[]; } };
  const score = (p: string) => { const fl = ls(p).filter(f => f.endsWith('.csv') && !/\(\d+\)\.csv$/.test(f)); return fl.filter(f => f.startsWith('rent_contracts_')).length * 10 + fl.filter(f => f.startsWith('transactions_')).length; };
  // Only Dropbox roots — never Google Drive / OneDrive / iCloud mounts, which can hang on network access.
  const roots = [path.join(home, 'Dropbox'), ...ls(path.join(home, 'Library', 'CloudStorage')).filter(d => /^Dropbox/i.test(d)).map(d => path.join(home, 'Library', 'CloudStorage', d))];
  const cands = roots.flatMap(r => [path.join(r, 'ALI TAMMAM', 'DLD Open Data'), path.join(r, 'DLD Open Data'), path.join(r, 'ALI TAMMAM')]);
  let best: { p: string; s: number } | null = null;
  for (const c of cands) if (isDir(c)) { const sc = score(c); if (sc > (best?.s ?? 0)) best = { p: c, s: sc }; }
  if (best) return (best as { p: string }).p;
  console.error(`Looked in: ${cands.join(' | ')}`);
  return null;
}
let src = process.argv[2];
if (src && !fs.existsSync(src)) { console.error(`Folder not found: ${src}`); src = ''; }
if (!src) { const d = autoDetect(); if (d) { console.log(`Using Dropbox folder: ${d}`); src = d; } }
if (!src) {
  console.error('Could not find the DLD Open Data folder. Run:  npm run prepare:pulse -- "<path>"  — in Finder, right-click the folder → hold Option → "Copy as Pathname", or drag the folder into the terminal after the two dashes.');
  process.exit(1);
}
// Files that are "online-only" in Dropbox are 0 bytes on disk until downloaded.
const tiny = fs.readdirSync(src).filter(f => f.endsWith('.csv') && fs.statSync(path.join(src, f)).size < 1000);
if (tiny.length) { console.error(`These files are not downloaded on this Mac yet (online-only in Dropbox): ${tiny.join(', ')}. In Finder, right-click them → "Make available offline", wait for the download, then run again.`); process.exit(1); }
const out = path.resolve('data/dld'); fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(src);
// Ignore duplicate downloads such as "transactions_..._0001 (1).csv" — they would double-count every row.
const pick = (prefix: string) => files.filter(f => f.startsWith(prefix) && f.endsWith('.csv') && !/\(\d+\)\.csv$/.test(f)).sort();

async function mergeParts(prefix: string, dest: string) {
  const parts = pick(prefix); if (!parts.length) { console.warn(`no ${prefix}* files`); return; }
  const w = fs.createWriteStream(dest); let first = true;
  for (const p of parts) {
    console.log(`merging ${p}`);
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(src, p)) }); let line = 0;
    for await (const l of rl) { line++; if (line === 1 && !first) continue; w.write(l + '\n'); }
    first = false;
  }
  await new Promise(r => w.end(r)); console.log(`→ ${dest}`);
}

async function filterRents(dest: string, fromYear = 2024) {
  const parts = pick('rent_contracts_'); if (!parts.length) { console.warn('no rent_contracts_* files'); return; }
  const keep = ['contract_id', 'contract_start_date', 'contract_reg_type_en', 'annual_amount', 'area_name_en', 'project_name_en', 'project_number', 'ejari_property_type_en', 'ejari_property_sub_type_en', 'ejari_bus_property_type_en', 'actual_area', 'property_usage_en', 'no_of_prop'];
  const w = fs.createWriteStream(dest); w.write(keep.join(',') + '\n'); let kept = 0;
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  for (const p of parts) {
    console.log(`filtering ${p}`);
    const parser = fs.createReadStream(path.join(src, p)).pipe(parse({ columns: true, bom: true, relax_column_count: true, relax_quotes: true }));
    for await (const r of parser as AsyncIterable<Record<string, string>>) {
      const y = Number((r.contract_start_date || '').slice(0, 4)); if (y < fromYear || y > 2100) continue;
      w.write(keep.map(k => esc(r[k] ?? '')).join(',') + '\n'); kept++;
    }
  }
  await new Promise(r => w.end(r)); console.log(`→ ${dest} (${kept} contracts from ${fromYear})`);
}

// Small register files may live in the parent folder (e.g. "ALI TAMMAM") rather than the "DLD Open Data" subfolder.
function copyOne(prefix: string, dest: string) {
  for (const dir of [src, path.dirname(src)]) {
    let list: string[] = []; try { list = fs.readdirSync(dir); } catch { continue; }
    const f = list.filter(x => x.startsWith(prefix) && x.endsWith('.csv') && !/\(\d+\)\.csv$/.test(x)).sort().at(-1);
    if (f) { fs.copyFileSync(path.join(dir, f), dest); console.log(`${f} → ${dest}`); return; }
  }
  console.warn(`no ${prefix}* file found in ${src} or its parent folder`);
}

(async () => {
  copyOne('projects_', path.join(out, 'projects.csv'));
  copyOne('developers_', path.join(out, 'developers.csv'));
  copyOne('oa_service_charges_', path.join(out, 'service_charges.csv'));
  await mergeParts('transactions_', path.join(out, 'transactions.csv'));
  const rentParts = pick('rent_contracts_').length; if (rentParts && rentParts < 10) console.warn(`WARNING: only ${rentParts} of 10 rent_contracts parts found in ${src}`);
  await filterRents(path.join(out, 'rents.csv'));
  console.log('done. Now run: npm run ingest:dld && npm run build');
})();
