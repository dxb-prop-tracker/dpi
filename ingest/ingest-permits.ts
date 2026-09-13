// Dubai Municipality building permits — the earliest public signal that construction is starting.
//
//   npm run ingest:permits
//
// Input: data/permits/*.csv, downloaded from Dubai Pulse (dm-general / dm_building_permits-open).
// That is a registered download rather than an API, the same route as the DLD bulk files, so the
// file has to be fetched by hand and dropped in. If the folder is empty this exits quietly and says
// what is missing rather than failing the build.
//
// Why it is worth having: a building permit is the municipality's go-ahead to put a building up. In
// Dubai an off-plan project is usually launched and sold on its Land Department registration and
// escrow account, frequently BEFORE the permit is issued — so a permit is not a signal of what is
// coming to market. It is a signal of what is coming OUT OF THE GROUND, and it is one of the
// earliest honest measures of how much construction is actually beginning.
//
// The limitation, stated once here and again wherever the number is shown: the Municipality uses its
// own, much older project numbering, unrelated to the Land Department's. A permit CANNOT be tied to
// a named project on this site. It works as a market-wide and area-wide leading indicator and
// nothing finer. Anyone claiming a permit belongs to a named tower is guessing.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { openDb } from './db';

const DIR = path.resolve(process.cwd(), 'data/permits');
const OUT = path.resolve(process.cwd(), 'public/data');

// Dubai Pulse column names vary between vintages of the export, so each field lists the spellings
// seen. An unrecognised header is reported rather than silently dropped.
const FIELDS: Record<string, string[]> = {
  permit_number: ['permit_number', 'PERMIT_NUMBER', 'application_number', 'APPLICATION_NUMBER'],
  permit_date: ['permit_date', 'PERMIT_DATE', 'application_date', 'APPLICATION_DATE', 'issue_date'],
  permit_type: ['permit_type_en', 'PERMIT_TYPE_EN', 'permit_type', 'application_type_en'],
  area: ['area_name_en', 'AREA_NAME_EN', 'area_en', 'community_en'],
  status: ['status_en', 'STATUS_EN', 'permit_status_en'],
};

const pick = (row: Record<string, string>, names: string[]) => {
  for (const k of names) if (row[k] != null && row[k] !== '') return String(row[k]).trim();
  return '';
};
const isoDate = (s: string) => {
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/) || s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return '';
  return m[0].includes('/') ? `${m[3]}-${m[2]}-${m[1]}` : `${m[1]}-${m[2]}-${m[3]}`;
};

// "New building" is the subset that matters — the rest is renovations, additions, decor and
// administrative filings, which are the large majority and would drown the signal.
const isNewBuilding = (t: string) => /new\s*build|new\s*construction|building\s*permit\b/i.test(t)
  && !/modif|renov|addition|demol|decor|maintenance|fit\s*out/i.test(t);

function main() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  if (!files.length) {
    console.log(`no permit files in data/permits/.\n` +
      `  Download dm_building_permits-open from Dubai Pulse (group dm-general) and drop the CSV there.\n` +
      `  Nothing else in the build depends on it, so this is not an error.`);
    return;
  }

  const db = openDb();
  db.exec(`CREATE TABLE IF NOT EXISTS building_permit (
    permit_number TEXT PRIMARY KEY, permit_date TEXT, permit_type TEXT, area_name_en TEXT,
    status TEXT, is_new_building INTEGER);
    CREATE INDEX IF NOT EXISTS ix_permit_date ON building_permit(permit_date);`);
  const ins = db.prepare(`INSERT INTO building_permit
    (permit_number,permit_date,permit_type,area_name_en,status,is_new_building)
    VALUES(?,?,?,?,?,?) ON CONFLICT(permit_number) DO UPDATE SET
    permit_date=excluded.permit_date, permit_type=excluded.permit_type,
    area_name_en=excluded.area_name_en, status=excluded.status,
    is_new_building=excluded.is_new_building`);

  let read = 0, kept = 0, undated = 0;
  const unknownHeaders = new Set<string>();
  const tx = db.transaction((rows: Record<string, string>[]) => {
    for (const row of rows) {
      read++;
      const num = pick(row, FIELDS.permit_number);
      if (!num) continue;
      const date = isoDate(pick(row, FIELDS.permit_date));
      if (!date) undated++;
      const type = pick(row, FIELDS.permit_type);
      ins.run(num, date || null, type || null, pick(row, FIELDS.area) || null,
        pick(row, FIELDS.status) || null, isNewBuilding(type) ? 1 : 0);
      kept++;
    }
  });

  for (const f of files) {
    const rows = parse(fs.readFileSync(path.join(DIR, f)), { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
    if (rows.length) {
      const known = new Set(Object.values(FIELDS).flat());
      for (const h of Object.keys(rows[0])) if (!known.has(h)) unknownHeaders.add(h);
    }
    tx(rows);
    console.log(`  ${f}: ${rows.length.toLocaleString()} rows`);
  }

  const monthly = db.prepare(`SELECT substr(permit_date,1,7) m, COUNT(*) all_permits,
      SUM(is_new_building) new_building FROM building_permit
    WHERE permit_date IS NOT NULL AND permit_date>='2000-01' GROUP BY 1 ORDER BY 1`).all() as any[];
  const byArea = db.prepare(`SELECT area_name_en area, COUNT(*) n, SUM(is_new_building) newb
    FROM building_permit WHERE permit_date >= date('now','-365 days') AND area_name_en IS NOT NULL
    GROUP BY 1 ORDER BY newb DESC`).all() as any[];
  const totals = db.prepare(`SELECT COUNT(*) n, SUM(is_new_building) newb,
      SUM(CASE WHEN permit_date>=date('now','-365 days') THEN is_new_building ELSE 0 END) newb12
    FROM building_permit`).get() as any;

  fs.writeFileSync(path.join(OUT, 'permits.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'Dubai Municipality building permits, via Dubai Pulse (dm-general / dm_building_permits-open)',
    caveat: 'The Municipality uses its own project numbering, unrelated to the Land Department\'s, so a permit cannot be tied to a named project. This is a market-wide and area-wide indicator only.',
    whatItMeans: 'A building permit is the go-ahead to put a building up. In Dubai an off-plan project is usually launched and sold on its Land Department registration and escrow account, often before the permit is issued — so this is not a signal of what is coming to market, but of what is coming out of the ground.',
    permits: totals.n, newBuilding: totals.newb, newBuildingLast12Months: totals.newb12,
    undatedRows: undated,
    monthly, byArea,
  }));
  console.log(`permits: ${kept.toLocaleString()} rows of ${read.toLocaleString()} kept · ` +
    `${totals.newb?.toLocaleString() ?? 0} new-building of ${totals.n.toLocaleString()} total · ` +
    `${totals.newb12?.toLocaleString() ?? 0} in the last 12 months`);
  if (undated) console.log(`  ${undated.toLocaleString()} rows carried no readable date and are stored but excluded from the monthly series`);
  if (unknownHeaders.size) console.log(`  headers not mapped (check the export vintage): ${[...unknownHeaders].slice(0, 12).join(', ')}`);
}

main();
