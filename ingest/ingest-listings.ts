// Ingest one scan of listings from a partnered feed or the agent-submission portal.
// Input: data/listings/scan-YYYY-MM-DD.csv with columns:
//   source,source_id,permit_number,url,area_name_en,project_name_en,building_name_en,unit_number,rooms_en,area_sqm,is_off_plan,asking_price
// Every scan appends a price observation. Listings present in the previous scan but absent
// from this one get a seen=0 row, which the drop validator uses for continuity checks.
// No agent contact fields are accepted — by design (PDPL).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { openDb, slugify } from './db.js';

const dir = path.resolve('data/listings');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^scan-\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort() : [];
if (!files.length) { console.warn('no scan files in data/listings'); process.exit(0); }

const db = openDb();
const upListing = db.prepare(`INSERT INTO listing(listing_id,source,permit_number,url,area_name_en,project_number,building_name_en,unit_number,rooms_en,area_sqm,is_off_plan,first_seen_at,resolution_confidence,resolution_method)
  VALUES(@listing_id,@source,@permit_number,@url,@area_name_en,@project_number,@building_name_en,@unit_number,@rooms_en,@area_sqm,@is_off_plan,@first_seen_at,@conf,@method)
  ON CONFLICT(listing_id) DO UPDATE SET url=excluded.url, project_number=COALESCE(excluded.project_number, listing.project_number)`);
const insObs = db.prepare(`INSERT OR IGNORE INTO listing_price_observation(listing_id,observed_at,asking_price,seen) VALUES(?,?,?,?)`);
const lastObs = db.prepare(`SELECT listing_id, asking_price FROM listing_price_observation o WHERE observed_at=(SELECT MAX(observed_at) FROM listing_price_observation WHERE listing_id=o.listing_id) AND seen=1`);
const projByName = db.prepare(`SELECT project_number FROM project WHERE name_en=? OR slug=?`);
const projByArea = db.prepare(`SELECT project_number FROM project WHERE area_slug=? AND (name_en LIKE ? OR slug LIKE ?)`);

// Entity resolution: exact project name → fuzzy within area → unresolved (manual queue).
function resolve(r: any): { pn: string | null; conf: number; method: string } {
  const name = r.project_name_en || r.building_name_en || '';
  let hit = projByName.get(name, slugify(name)) as any;
  if (hit) return { pn: hit.project_number, conf: 1, method: 'exact-name' };
  const first = slugify(name).split('-').find(t => t.length > 2 && t !== 'the'); // skip stopwords: 'The Meadows 9' must not fuzzy-match on 'the'
  if (first) {
    hit = projByArea.get(slugify(r.area_name_en || ''), `%${first}%`, `%${first}%`) as any;
    if (hit) return { pn: hit.project_number, conf: 0.6, method: 'fuzzy-area-prefix' };
  }
  return { pn: null, conf: 0, method: 'unresolved' };
}

for (const f of files) {
  const observedAt = f.slice(5, 15);
  const alreadyRan = db.prepare(`SELECT 1 FROM listing_price_observation WHERE observed_at=? LIMIT 1`).get(observedAt);
  if (alreadyRan) { console.log(`skip ${f}: already ingested`); continue; }
  const rows = parse(fs.readFileSync(path.join(dir, f)), { columns: true, bom: true, trim: true }) as any[];
  const seenNow = new Set<string>();
  const prev = new Map((lastObs.all() as any[]).map(x => [x.listing_id, x.asking_price]));
  const tx = db.transaction(() => {
    for (const r of rows) {
      const id = `${r.source}:${r.source_id}`; seenNow.add(id);
      const { pn, conf, method } = resolve(r);
      upListing.run({ listing_id: id, source: r.source, permit_number: r.permit_number || null, url: r.url || null, area_name_en: r.area_name_en || null,
        project_number: pn, building_name_en: r.building_name_en || null, unit_number: r.unit_number || null, rooms_en: r.rooms_en || null,
        area_sqm: r.area_sqm ? Number(r.area_sqm) : null, is_off_plan: /^(1|true|yes)$/i.test(r.is_off_plan || '') ? 1 : 0, first_seen_at: observedAt, conf, method });
      insObs.run(id, observedAt, Number(String(r.asking_price).replace(/,/g, '')), 1);
    }
    for (const [id, price] of prev) if (!seenNow.has(id)) insObs.run(id, observedAt, price, 0);
  });
  tx();
  console.log(`${f}: ${rows.length} listings, ${[...prev.keys()].filter(k => !seenNow.has(k)).length} missing`);
}
db.close();
