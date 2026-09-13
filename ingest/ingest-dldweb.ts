// Import a CSV downloaded by hand from the DLD open-data page
// (https://dubailand.gov.ae/en/open-data/real-estate-data/) into portal.db.
//
// Routine: on the DLD page set From Date, tick the captcha, Search, Download as CSV.
// Then: npm run ingest:web  (finds the newest transactions-*.csv in ~/Downloads)
//       npm run derive && npm run build
//
// The web export differs from the Dubai Pulse bulk dump:
//   - different column names (TRANSACTION_NUMBER, TRANS_VALUE, ...)
//   - AREA_EN mixes registry names ("Marsa Dubai") with master-community
//     names in caps ("DUBAI MARINA") -> mapped back via the project register
//   - no building name and no project number -> project linked by name;
//     rows lacking a building simply never join resale pairs
// Dedupe is by attributes (date + amount + area + registered size), so overlap
// with bulk data or with a previous web download inserts nothing twice.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { openDb } from './db';
import { txKey } from './tx-key';

const argFile = process.argv.includes('--file') ? process.argv[process.argv.indexOf('--file') + 1] : null;

function newestDownload(): string | null {
  const dir = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => /^transactions.*\.csv$/i.test(f))
    .map(f => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f ?? null;
}

const file = argFile ?? newestDownload();
if (!file || !fs.existsSync(file)) {
  console.error('No transactions-*.csv found in ~/Downloads. Download one from the DLD open-data page first, or pass --file <path>.');
  process.exit(1);
}
console.log('Importing', file);

const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
const rows = parse(raw, { columns: true, relax_column_count: true }) as Record<string, string>[];
console.log(rows.length.toLocaleString(), 'rows in file');
if (!rows.length || !('TRANSACTION_NUMBER' in rows[0])) {
  console.error('This does not look like a DLD web transactions export (TRANSACTION_NUMBER column missing).');
  process.exit(1);
}

const db = openDb();

// Canonical area names already in the database (registry casing).
const areaCanon = new Map<string, string>();
for (const r of db.prepare(`SELECT DISTINCT area_name_en a FROM transaction_ WHERE area_name_en IS NOT NULL`).all() as any[])
  areaCanon.set(r.a.toLowerCase(), r.a);

// Master community -> registry area (mode across the project register).
const masterArea = new Map<string, string>();
for (const r of db.prepare(`
  SELECT lower(trim(master_project_en)) m, area_name_en a, COUNT(*) c FROM project
  WHERE master_project_en IS NOT NULL AND master_project_en <> ''
  GROUP BY 1, 2 ORDER BY c`).all() as any[])
  masterArea.set(r.m, r.a); // later (bigger c) overwrite earlier

// Project name -> number + canonical name + registry area (for linking; case-insensitive).
const projByName = new Map<string, { pn: string; name: string; area: string }>();
for (const r of db.prepare(`SELECT project_number pn, name_en, area_name_en FROM project WHERE name_en IS NOT NULL`).all() as any[])
  projByName.set(r.name_en.toLowerCase(), { pn: r.pn, name: r.name_en, area: r.area_name_en });

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-(])\w/g, c => c.toUpperCase());
// Priority: the linked project's registry area > exact registry name > master-community name > title-cased as-is.
// Returns [name, mapped] — mapped=false means we could not translate it to a registry area.
const mapArea = (a: string, projArea: string | null): [string, boolean] => {
  const t = a.trim();
  if (projArea) return [projArea, true];
  if (!t) return [t, false];
  const c = areaCanon.get(t.toLowerCase()) ?? masterArea.get(t.toLowerCase());
  return c ? [c, true] : [titleCase(t), false];
};
const num = (v: string) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) && n !== 0 ? n : null; };
const normRooms = (v: string) => { const s = (v ?? '').trim(); if (!s || s === 'NA') return null; const m = s.match(/^(\d+)\s*B\/?R/i); if (m) return `${m[1]} B/R`; if (/^studio/i.test(s)) return 'Studio'; if (/^penthouse/i.test(s)) return 'PENTHOUSE'; return s; };

// The bulk dump truncates amounts to whole dirhams, so match on the truncated value.
// For rows whose area we could translate, the area is part of the key; for the few we
// could not, fall back to date + amount + size + rooms (identical enough to be the same row).
// This export is the register's own screen, so it carries two things the bulk dump and the API do not:
// the date the sale actually happened (they file late-afternoon registrations under the next working day)
// and the fils. Where we already hold the sale, we therefore CORRECT it rather than skip or duplicate it.
const heldByKey = db.prepare(`SELECT transaction_id, instance_date, actual_worth, procedure_area FROM transaction_ WHERE tx_key = ?`);
const correct = db.prepare(`UPDATE transaction_ SET instance_date = ?, actual_worth = ?, meter_sale_price = ?,
  feed_date = COALESCE(feed_date, instance_date) WHERE transaction_id = ?`);
const ins = db.prepare(`INSERT OR IGNORE INTO transaction_
  (transaction_id, instance_date, trans_group_en, procedure_name_en, reg_type_en, property_type_en, property_sub_type_en, property_usage_en, area_name_en, building_name_en, project_number, project_name_en, rooms_en, procedure_area, actual_worth, meter_sale_price, tx_key, feed_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`);

let added = 0, dupes = 0, moved = 0, minD = '9999', maxD = '0000';
const seq = new Map<string, number>();
const tx = db.transaction(() => {
  for (const r of rows) {
    const date = (r.INSTANCE_DATE ?? '').slice(0, 10);
    if (!date) continue;
    const proj = projByName.get((r.PROJECT_EN ?? '').trim().toLowerCase());
    const [area, mapped] = mapArea(r.AREA_EN ?? '', proj?.area ?? null);
    const worth = num(r.TRANS_VALUE);
    const parea = num(r.PROCEDURE_AREA);
    const rooms = normRooms(r.ROOMS_EN);
    const tid = (r.TRANSACTION_NUMBER ?? '').trim() || 'unknown';
    const n = (seq.get(tid) ?? 0) + 1; seq.set(tid, n);
    const reg = /off[\s-]*plan/i.test(r.IS_OFFPLAN_EN ?? '') ? 'Off-Plan Properties' : 'Existing Properties';
    const psm = worth && parea && parea > 0 ? Math.round((worth / parea) * 100) / 100 : null;
    const grp = (r.GROUP_EN ?? '').trim();
    const grpNorm = /^mortgage/i.test(grp) ? 'Mortgages' : /^gift/i.test(grp) ? 'Gifts' : grp || null;
    const key = txKey(tid, grpNorm);
    if (key) {
      const mine = heldByKey.get(key) as any;
      if (mine) {   // same sale, already held from the dump or the API — take this feed's date and amount
        if (mine.instance_date !== date) moved++;
        const w = worth ?? mine.actual_worth;
        const a = parea ?? mine.procedure_area;
        correct.run(date, w, w && a ? Math.round((w / a) * 100) / 100 : null, mine.transaction_id);
        dupes++; continue;
      }
    }
    ins.run(`w#${tid}#${n}`, date, grpNorm, (r.PROCEDURE_EN ?? '').trim() || null,
      reg, (r.PROP_TYPE_EN ?? '').trim() || null, (r.PROP_SB_TYPE_EN ?? '').trim() || null, (r.USAGE_EN ?? '').trim() || null,
      area, proj?.pn ?? null, proj?.name ?? ((r.PROJECT_EN ?? '').trim() || null), rooms,
      parea, worth, psm, key, null);
    added++;
    if (date < minD) minD = date;
    if (date > maxD) maxD = date;
  }
});
tx();
console.log(`Added ${added.toLocaleString()} new transactions (${added ? minD + ' .. ' + maxD : 'none'}), matched ${dupes.toLocaleString()} already held` +
  `${moved ? `, of which ${moved.toLocaleString()} had their date corrected to the register's own` : ''}.`);
console.log('Now run: npm run derive && npm run build');
db.close();
