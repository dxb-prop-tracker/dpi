// Convert the Bayut distressed_tracker output (Dubai_Distressed_Tracker_YYYY-MM-DD.xlsx files
// plus distressed_tracker_history.json) into the pipeline's scan CSVs (data/listings/scan-*.csv).
//
//   npm run adapt:bayut                  → reads from ~/Desktop
//   npm run adapt:bayut -- /some/folder  → reads from that folder
//
// Every tracker run date becomes one scan. Prices come from that day's xlsx; the history JSON
// fills any dates whose xlsx was deleted. Existing scan files are never overwritten.
// PRIVATE-INSTANCE DATA: scraped listings are for the internal build only — never for the public site.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import XLSX from 'xlsx';

const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.homedir(), 'Desktop');
const outDir = path.resolve('data/listings');
fs.mkdirSync(outDir, { recursive: true });

// Bayut community → DLD register area name (verified against the transaction register).
const COMMUNITY_AREA: Record<string, string> = {
  'The Meadows': 'Al Thanayah Fourth',
  'The Springs': 'Al Thanayah Fourth',
  'The Lakes': 'Al Thanayah Fourth',
  'Arabian Ranches': 'Wadi Al Safa 6',
  'Arabian Ranches 2': 'Wadi Al Safa 7',
  'Arabian Ranches 3': 'Wadi Al Safa 5',
  'Tilal Al Ghaf': 'Al Hebiah Fourth',
  'Dubai Marina': 'Marsa Dubai',
  'Downtown Dubai': 'Burj Khalifa',
  'Jumeirah Village Circle (JVC)': 'Al Barsha South Fourth',
  'Jumeirah Lake Towers (JLT)': 'Al Thanyah Fifth',
  'Dubai Hills Estate': 'Hadaeq Sheikh Mohammed Bin Rashid',
  'Palm Jumeirah': 'Palm Jumeirah',
};

// Location sub-community → the register's own project naming, where the register uses a different one.
function registerProjectName(sub: string, community: string): string {
  const springs = sub.match(/^The Springs (\d+)$/i);
  if (springs) return `Emirates Living - Springs ${springs[1]}`;
  if (sub && sub.toLowerCase() !== community.toLowerCase()) return sub;
  return '';
}

const idFromLink = (link: string) => {
  const m = link.match(/details-(\d+)/);
  return m ? `details-${m[1]}` : link.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
};
const roomsFrom = (beds: any) => {
  if (beds == null || beds === '') return '';
  const s = String(beds).trim().toLowerCase();
  if (s === 'studio' || s === '0') return 'Studio';
  const n = parseInt(s);
  return Number.isFinite(n) && n > 0 ? `${n} B/R` : '';
};
const esc = (v: any) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

type Obs = { price: number };
type Attrs = { community: string; area: string; sub: string; rooms: string; sqm: string; link: string };
const scans = new Map<string, Map<string, Obs>>();          // date → id → observation
const attrs = new Map<string, Attrs>();                      // id → latest known attributes
const attrDate = new Map<string, string>();

function addObs(date: string, id: string, price: number) {
  if (!price || price < 50000) return;
  if (!scans.has(date)) scans.set(date, new Map());
  scans.get(date)!.set(id, { price });
}

// ---- 1. Dated xlsx files: full attributes + that day's prices ----
const files = fs.readdirSync(dir).filter(f => /^Dubai_Distressed_Tracker_\d{4}-\d{2}-\d{2}\.xlsx$/.test(f)).sort();
for (const f of files) {
  const date = f.match(/(\d{4}-\d{2}-\d{2})/)![1];
  const wb = XLSX.readFile(path.join(dir, f));
  const ws = wb.Sheets['All Listings'];
  if (!ws || !ws['!ref']) { console.warn(`${f}: no All Listings sheet`); continue; }
  const range = XLSX.utils.decode_range(ws['!ref']);
  const headers: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) headers[c] = ws[XLSX.utils.encode_cell({ r: 0, c })]?.v ?? '';
  const col = (name: string) => headers.findIndex(h => h === name);
  const [cComm, cLoc, cBeds, cPrice, cSize, cLink] =
    ['Community', 'Location', 'Beds', 'Price (AED)', 'Size (sqft)', 'View Listing'].map(col);
  let n = 0;
  for (let r = 1; r <= range.e.r; r++) {
    const cell = (c: number) => c >= 0 ? ws[XLSX.utils.encode_cell({ r, c })] : undefined;
    const link: string = cell(cLink)?.l?.Target ?? '';
    const price = Number(cell(cPrice)?.v ?? 0);
    if (!link || !price) continue;
    const id = idFromLink(link);
    const community = String(cell(cComm)?.v ?? '');
    const sub = String(cell(cLoc)?.v ?? '').split(',')[0].trim();
    const sqft = Number(cell(cSize)?.v ?? 0);
    addObs(date, id, price);
    if (!attrDate.has(id) || attrDate.get(id)! <= date) {
      attrs.set(id, {
        community, area: COMMUNITY_AREA[community] ?? community, sub,
        rooms: roomsFrom(cell(cBeds)?.v), sqm: sqft > 0 ? (sqft * 0.092903).toFixed(1) : '', link,
      });
      attrDate.set(id, date);
    }
    n++;
  }
  console.log(`${f}: ${n} listings`);
}

// ---- 2. History JSON: fills dates whose xlsx is gone, and listings the xlsx missed ----
const histFile = path.join(dir, 'distressed_tracker_history.json');
if (fs.existsSync(histFile)) {
  const hist = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  let added = 0;
  for (const entry of Object.values(hist) as any[]) {
    const link = entry.link ?? '';
    if (!link) continue;
    const id = idFromLink(link);
    if (!attrs.has(id)) {
      const community = entry.community ?? '';
      attrs.set(id, { community, area: COMMUNITY_AREA[community] ?? community, sub: '', rooms: '', sqm: '', link });
    }
    for (const [d, p] of Object.entries(entry.price_log ?? {})) {
      if (!scans.get(d)?.has(id)) { addObs(d, id, Number(p)); added++; }
    }
  }
  console.log(`history json: ${Object.keys(hist).length} listings, ${added} observations added from price logs`);
} else console.warn(`no ${histFile}`);

// ---- 3. Emit one scan CSV per date ----
const HEADER = 'source,source_id,permit_number,url,area_name_en,project_name_en,building_name_en,unit_number,rooms_en,area_sqm,is_off_plan,asking_price';
let written = 0;
for (const date of [...scans.keys()].sort()) {
  const out = path.join(outDir, `scan-${date}.csv`);
  if (fs.existsSync(out)) { console.log(`skip scan-${date}.csv: already exists`); continue; }
  const lines = [HEADER];
  for (const [id, o] of scans.get(date)!) {
    const a = attrs.get(id)!;
    lines.push(['bayut', id, '', a.link, a.area, registerProjectName(a.sub, a.community), a.sub, '', a.rooms, a.sqm, '0', o.price].map(esc).join(','));
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`wrote scan-${date}.csv: ${scans.get(date)!.size} listings`);
  written++;
}
console.log(`done: ${written} scan file(s) → ${outDir}. Next: npm run ingest:listings && npm run drops`);
