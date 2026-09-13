// Ingest DLD CSV exports into SQLite. Two header styles are recognised automatically:
//   (A) dubailand.gov.ae "Download as CSV" — UPPERCASE headers (PROJECT_NUMBER, PROJECT_EN, AREA_EN ...)
//   (B) Dubai Pulse API/CSV — lowercase headers (project_number, project_name_en, area_name_en ...)
// Files go in data/dld/ as transactions.csv, projects.csv, rents.csv.
// Run `npm run check:dld` to see which headers were found and which are missing before ingesting.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { Transform } from 'node:stream';
import { openDb, slugify } from './db.js';
import XLSX from 'xlsx';
import { txKey } from './tx-key';

// The DLD site sometimes serves an Excel workbook under a .csv name. If data/dld/<name>.csv is missing
// (or is really a zip/xlsx), look for <name>.xlsx and convert it to CSV once.
function ensureCsv(name: string) {
  const csv = path.resolve('data/dld', `${name}.csv`); const xlsx = path.resolve('data/dld', `${name}.xlsx`);
  const isZip = (p: string) => { if (!fs.existsSync(p)) return false; const b = Buffer.alloc(2); const fd = fs.openSync(p, 'r'); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); return b[0] === 0x50 && b[1] === 0x4b; };
  if (isZip(csv)) { fs.renameSync(csv, xlsx); console.log(`${name}.csv was an Excel file; renamed to ${name}.xlsx`); }
  if (!fs.existsSync(csv) && fs.existsSync(xlsx)) {
    console.log(`converting ${name}.xlsx → ${name}.csv (one-off; can take a minute for large files)`);
    const wb = XLSX.readFile(xlsx, { cellDates: true }); const ws = wb.Sheets[wb.SheetNames[0]];
    fs.writeFileSync(csv, XLSX.utils.sheet_to_csv(ws, { dateNF: 'yyyy-mm-dd hh:mm:ss' }));
  }
}

type Map = Record<string, string[]>; // our field -> candidate source headers, first match wins

const M: Record<'projects' | 'transactions' | 'rents' | 'developers' | 'service_charges', Map> = {
  developers: { developer_number: ['developer_number', 'DEVELOPER_NUMBER'], developer_name_en: ['developer_name_en', 'DEVELOPER_EN'], license_source: ['license_source_en'], registration_date: ['registration_date'], webpage: ['webpage'] },
  service_charges: { budget_year: ['budget_year'], project_id: ['project_id'], project_name: ['project_name'], master_community: ['master_community_name_en'], management_company: ['management_company_name_en'], property_group: ['property_group_name_en'], category: ['service_category_name_en'], usage: ['usage_name_en'], cost: ['service_cost'] },
  projects: {
    project_number: ['PROJECT_NUMBER', 'project_number'],
    project_name_en: ['PROJECT_EN', 'project_name_en', 'project_name'],
    area_name_en: ['AREA_EN', 'area_name_en'],
    developer_number: ['DEVELOPER_NUMBER', 'developer_number'],
    developer_name_en: ['DEVELOPER_EN', 'developer_name_en'],  // Pulse projects file carries Arabic only; English comes from developers.csv
    master_developer_number: ['master_developer_number'],
    cancellation_date: ['cancellation_date'],
    master_project_en: ['MASTER_PROJECT_EN', 'master_project_en'],
    escrow: ['ESCROW_ACCOUNT_NUMBER', 'escrow_agent_name_en', 'escrow_agent_name'],
    project_start_date: ['START_DATE', 'project_start_date'],
    planned_end_date: ['END_DATE', 'project_end_date'],
    completion_date: ['COMPLETION_DATE', 'completion_date'],
    percent_completed: ['PERCENT_COMPLETED', 'percent_completed'],
    project_status: ['PROJECT_STATUS', 'project_status'],
    load_timestamp: ['load_timestamp', 'LOAD_TIMESTAMP'],
    project_value: ['PROJECT_VALUE', 'project_value'],
    units: ['CNT_UNIT', 'no_of_units'],
    villas: ['CNT_VILLA', 'no_of_villas'],
    buildings: ['CNT_BUILDING', 'no_of_buildings'],
  },
  transactions: {
    transaction_id: ['TRANSACTION_NUMBER', 'transaction_id'],
    instance_date: ['INSTANCE_DATE', 'instance_date'],
    trans_group_en: ['GROUP_EN', 'trans_group_en'],
    procedure_name_en: ['PROCEDURE_EN', 'procedure_name_en'],
    reg_type_en: ['IS_OFFPLAN_EN', 'reg_type_en'],
    property_type_en: ['PROP_TYPE_EN', 'property_type_en'],
    property_sub_type_en: ['PROP_SB_TYPE_EN', 'property_sub_type_en'],
    property_usage_en: ['USAGE_EN', 'property_usage_en'],
    area_name_en: ['AREA_EN', 'area_name_en'],
    building_name_en: ['BUILDING_NAME_EN', 'building_name_en'],
    project_number: ['PROJECT_NUMBER', 'project_number'],
    project_name_en: ['PROJECT_EN', 'project_name_en'],
    rooms_en: ['ROOMS_EN', 'rooms_en'],
    procedure_area: ['PROCEDURE_AREA', 'ACTUAL_AREA', 'procedure_area'],
    actual_worth: ['TRANS_VALUE', 'actual_worth'],
    meter_sale_price: ['METER_SALE_PRICE', 'meter_sale_price'],
  },
  rents: {
    contract_id: ['CONTRACT_NUMBER', 'CONTRACT_ID', 'contract_id'],
    contract_start_date: ['START_DATE', 'CONTRACT_START_DATE', 'contract_start_date'],
    contract_reg_type_en: ['CONTRACT_REG_TYPE_EN', 'VERSION_EN', 'contract_reg_type_en'],
    annual_amount: ['ANNUAL_AMOUNT', 'annual_amount'],
    area_name_en: ['AREA_EN', 'area_name_en'],
    project_name_en: ['PROJECT_EN', 'project_name_en'],
    project_number: ['PROJECT_NUMBER', 'project_number'],
    ejari_property_type_en: ['PROP_TYPE_EN', 'EJARI_PROPERTY_TYPE_EN', 'ejari_property_type_en'],
    rooms_en: ['ROOMS_EN', 'ejari_property_sub_type_en', 'rooms_en'],
    actual_area: ['ACTUAL_AREA', 'actual_area'],
  },
};

// DLD writes area names inconsistently across files ("BUSINESS BAY" vs "Business Bay"); normalise to Title Case.
const normArea = (v: any) => String(v ?? '').trim().toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bAl\b/g, 'Al') || 'Unknown';
const pnum = (v: any) => { if (v == null || v === '') return null; const n = Number(String(v).trim()); return Number.isFinite(n) ? String(Math.trunc(n)) : String(v).trim(); };
// Ejari sub-types ("2 bed rooms+hall", "Studio", "Penthouse") → DLD sales style ("2 B/R", "Studio", "PENTHOUSE").
const normRooms = (v: any) => { const s = String(v ?? '').trim(); const m = s.match(/^(\d+)\s*bed/i); if (m) return `${m[1]} B/R`; if (/^studio/i.test(s)) return 'Studio'; return s || null; };
const num = (v: any) => (v === '' || v == null ? null : Number(String(v).replace(/,/g, '')));
const iso = (v: any) => {
  if (!v) return null; const s = String(v).trim();
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s.slice(0, 10);
};

function resolveMap(headers: string[], map: Map) {
  const found: Record<string, string | null> = {}; const missing: string[] = [];
  for (const [k, cands] of Object.entries(map)) { const h = cands.find(c => headers.includes(c)) ?? null; found[k] = h; if (!h) missing.push(k); }
  return { found, missing };
}

async function* rows(file: string) {
  const p = path.resolve('data/dld', file);
  if (!fs.existsSync(p)) { console.warn(`skip: ${p} not found`); return; }
  // DLD exports mix \r\n and \n line endings and do not escape quote characters inside text fields
  // (e.g. `Residential" 2 Towers"`). Normalise line endings and neutralise any quote that is not at a
  // field boundary (i.e. not preceded by , or newline and not followed by , or newline).
  // Quote replacement is 1:1 so positions are preserved; keep one emitted char of context for the
  // lookbehind and hold back two chars for the lookahead across chunk boundaries.
  const RX = /(?<![,\n])"(?![,\n"])|(?<![,\n"])"(?![,\n])/g;
  let pending = '', prev = '\n';
  const clean = new Transform({
    transform(chunk, _e, cb) {
      const raw = pending + chunk.toString('utf8').replace(/\r\n?/g, '\n');
      const out = (prev + raw).replace(RX, "'");
      const emitLen = Math.max(0, raw.length - 2);
      cb(null, out.slice(1, 1 + emitLen));
      pending = raw.slice(emitLen); prev = emitLen ? raw[emitLen - 1] : prev;
    },
    flush(cb) { cb(null, (prev + pending).replace(RX, "'").slice(1)); },
  });
  const parser = fs.createReadStream(p).pipe(clean).pipe(parse({ columns: true, bom: true, relax_column_count: true, relax_quotes: true, trim: true }));
  for await (const r of parser) yield r as Record<string, string>;
}

async function headersOf(file: string): Promise<string[] | null> {
  ensureCsv(file.replace(/\.csv$/, ''));
  const p = path.resolve('data/dld', file); if (!fs.existsSync(p)) return null;
  const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(8192); fs.readSync(fd, buf, 0, 8192, 0); fs.closeSync(fd);
  return buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/)[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
}

export async function check() {
  for (const kind of ['projects', 'transactions', 'rents'] as const) {
    const h = await headersOf(`${kind}.csv`);
    if (!h) { console.log(`${kind}.csv: not found`); continue; }
    const { found, missing } = resolveMap(h, M[kind]);
    console.log(`\n${kind}.csv — headers found: ${h.length}`);
    for (const [k, v] of Object.entries(found)) console.log(`  ${v ? '✓' : '✗'} ${k.padEnd(22)} ← ${v ?? '(missing)'}`);
    if (missing.length) console.log(`  missing (optional unless marked): ${missing.join(', ')}`);
  }
}

// `--only projects,developers` limits which sections run (used by the daily API refresh,
// which updates transactions/rents directly and only needs the registers re-read).
const onlyArg = process.argv[process.argv.indexOf('--only') + 1];
const only = process.argv.includes('--only') && onlyArg ? new Set(onlyArg.split(',')) : null;
const want = (k: string) => !only || only.has(k);

async function main() {
  if (want('transactions') && !fs.existsSync(path.resolve('data/dld', 'transactions.csv')) && !fs.existsSync(path.resolve('data/dld', 'transactions.xlsx'))) { console.error('No data/dld/transactions.csv found. Run `npm run prepare:pulse` (Dropbox files) or `npm run seed` (sample data) first.'); process.exit(1); }
  const db = openDb();
  const observedAt = new Date().toISOString().slice(0, 10);
  const g = (r: Record<string, string>, f: Record<string, string | null>, k: string) => (f[k] ? r[f[k]!] : undefined);

  // ---- developers (Pulse register: English names, licence source) ----
  let h = want('developers') ? await headersOf('developers.csv') : null;
  const upDev0 = db.prepare(`INSERT INTO developer(developer_number,name_en,slug) VALUES(?,?,?) ON CONFLICT(developer_number) DO UPDATE SET name_en=excluded.name_en, slug=excluded.slug`);
  // A developer number we have never seen gets a vintage row, so reports can list "developers added".
  // (The very first load records nothing: every number is new then, and that is not news.)
  const devKnown = db.prepare(`SELECT 1 FROM developer WHERE developer_number=?`);
  const devSeen = db.prepare(`INSERT OR IGNORE INTO vintage(kind,id,first_seen) VALUES('developer',?,?)`);
  const anyDev = !!db.prepare(`SELECT 1 FROM developer LIMIT 1`).get();
  if (h) {
    const { found: f } = resolveMap(h, M.developers); let n = 0, added = 0;
    const tx = db.transaction((b: Record<string, string>[]) => { for (const r of b) {
      const dn = String(num(g(r, f, 'developer_number')) ?? g(r, f, 'developer_number') ?? '').trim(); const name = (g(r, f, 'developer_name_en') || '').trim(); if (!dn || !name) continue;
      if (anyDev && !devKnown.get(dn)) { devSeen.run(dn, observedAt); added++; }
      // slugs must be unique; disambiguate duplicate names with the number
      const slug = slugify(name) || dn; const clash = db.prepare(`SELECT 1 FROM developer WHERE slug=? AND developer_number<>?`).get(slug, dn);
      upDev0.run(dn, name, clash ? `${slug}-${dn}` : slug); n++; } });
    let batch: Record<string, string>[] = []; for await (const r of rows('developers.csv')) { batch.push(r); if (batch.length >= 2000) { tx(batch); batch = []; } } if (batch.length) tx(batch);
    console.log(`developers: ${n}${added ? ` (${added} new)` : ''}`);
  }

  // ---- projects ----
  h = want('projects') ? await headersOf('projects.csv') : null;
  if (h) {
    const { found: f } = resolveMap(h, M.projects);
    const upDev = db.prepare(`INSERT INTO developer(developer_number,name_en,slug) VALUES(?,?,?) ON CONFLICT(developer_number) DO UPDATE SET name_en=excluded.name_en`);
    const upProj = db.prepare(`INSERT INTO project(project_number,name_en,slug,area_name_en,area_slug,developer_number,master_project_en,escrow_agent_en,project_start_date,project_value,units,villas,buildings)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_number) DO UPDATE SET name_en=excluded.name_en, area_name_en=excluded.area_name_en, area_slug=excluded.area_slug, developer_number=excluded.developer_number,
      project_value=COALESCE(excluded.project_value,project.project_value), units=COALESCE(excluded.units,project.units)`);
    const slugTaken = db.prepare(`SELECT 1 FROM project WHERE area_slug=? AND slug=? AND project_number<>?`);
    const projKnown = db.prepare(`SELECT 1 FROM project WHERE project_number=?`);
    const projSeen = db.prepare(`INSERT OR IGNORE INTO vintage(kind,id,first_seen) VALUES('project',?,?)`);
    const anyProj = !!db.prepare(`SELECT 1 FROM project LIMIT 1`).get();
    const insObs = db.prepare(`INSERT OR IGNORE INTO project_observation(project_number,observed_at,status,percent_completed,completion_date,source) VALUES(?,?,?,?,?,'dld')`);
    let n = 0;
    const tx = db.transaction((batch: Record<string, string>[]) => {
      for (const r of batch) {
        const pn = pnum(g(r, f, 'project_number')); if (!pn) continue;
        if (anyProj && !projKnown.get(pn)) projSeen.run(pn, iso(g(r, f, 'load_timestamp'))?.slice(0, 10) || observedAt);
        const devRaw = g(r, f, 'developer_number'); const dev = devRaw ? String(num(devRaw) ?? devRaw).trim() : null; const devName = g(r, f, 'developer_name_en');
        if (dev && devName) upDev.run(dev, devName, slugify(devName) || dev);
        else if (dev) db.prepare(`INSERT OR IGNORE INTO developer(developer_number,name_en,slug) VALUES(?,?,?)`).run(dev, `Developer ${dev}`, `developer-${dev}`);
        const name = (g(r, f, 'project_name_en') || pn).trim(); const area = normArea(g(r, f, 'area_name_en'));
        let slug = slugify(name) || pn; const areaSlug = slugify(area) || 'unknown';
        const clash = slugTaken.get(areaSlug, slug, pn); if (clash) slug = `${slug}-${pn}`;
        upProj.run(pn, name, slug, area, areaSlug, dev, g(r, f, 'master_project_en') || null, g(r, f, 'escrow') || null,
          iso(g(r, f, 'project_start_date')), num(g(r, f, 'project_value')), num(g(r, f, 'units')), num(g(r, f, 'villas')), num(g(r, f, 'buildings')));
        // Planned end date is what slips; actual completion date replaces it once the project finishes.
        const completion = iso(g(r, f, 'completion_date')) || iso(g(r, f, 'planned_end_date'));
        // Date the observation by when the REGISTER says the data was extracted (load_timestamp),
        // not by when this script happens to run — re-reading an old file must not create a "newer" reading.
        const obsDate = iso(g(r, f, 'load_timestamp'))?.slice(0, 10) || observedAt;
        insObs.run(pn, obsDate, g(r, f, 'project_status') || null, num(g(r, f, 'percent_completed')), completion);
        const canc = iso(g(r, f, 'cancellation_date')); if (canc) db.prepare(`UPDATE project SET cancellation_date=? WHERE project_number=?`).run(canc, pn);
        n++;
      }
    });
    let batch: Record<string, string>[] = [];
    for await (const r of rows('projects.csv')) { batch.push(r); if (batch.length >= 2000) { tx(batch); batch = []; } }
    if (batch.length) tx(batch);
    console.log(`projects: ${n}`);
  }

  // ---- service charges (Mollak) ----
  h = want('service_charges') ? await headersOf('service_charges.csv') : null;
  if (h) {
    const { found: f } = resolveMap(h, M.service_charges);
    const ins = db.prepare(`INSERT OR IGNORE INTO service_charge(budget_year,project_id,project_name,master_community,management_company,property_group,category,usage,cost) VALUES(?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction((b: any[][]) => b.forEach(x => ins.run(...x))); let n = 0, batch: any[][] = [];
    for await (const r of rows('service_charges.csv')) { batch.push([num(g(r, f, 'budget_year')), g(r, f, 'project_id'), (g(r, f, 'project_name') || '').trim(), g(r, f, 'master_community'), g(r, f, 'management_company'), g(r, f, 'property_group'), g(r, f, 'category'), g(r, f, 'usage'), num(g(r, f, 'cost'))]); if (batch.length >= 5000) { tx(batch); n += batch.length; batch = []; } }
    if (batch.length) { tx(batch); n += batch.length; } console.log(`service charge lines: ${n}`);
  }

  // ---- transactions ----
  h = want('transactions') ? await headersOf('transactions.csv') : null;
  if (h) {
    const { found: f, missing } = resolveMap(h, M.transactions);
    if (!f.transaction_id || !f.instance_date || !f.actual_worth) throw new Error(`transactions.csv: cannot find id/date/value columns. Missing: ${missing.join(', ')}. Headers: ${h.join(', ')}`);
    // Explicit column list, and the canonical key with it: the unique index on tx_key is what stops the
    // same sale being stored twice when the dump and the API date it differently (ingest/tx-key.ts).
    const ins = db.prepare(`INSERT OR IGNORE INTO transaction_
      (transaction_id, instance_date, trans_group_en, procedure_name_en, reg_type_en, property_type_en,
       property_sub_type_en, property_usage_en, area_name_en, building_name_en, project_number, project_name_en,
       rooms_en, procedure_area, actual_worth, meter_sale_price, tx_key, feed_date)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let held = 0, unkeyed = 0;
    const tx = db.transaction((b: any[][]) => b.forEach(x => { if (ins.run(...x).changes === 0) held++; }));
    let n = 0, batch: any[][] = [], seq = 0;
    for await (const r of rows('transactions.csv')) {
      seq++; // TRANSACTION_NUMBER repeats for portfolio mortgages (one row per unit) — make the id unique per row
      const area = num(g(r, f, 'procedure_area')); const worth = num(g(r, f, 'actual_worth'));
      let psm = num(g(r, f, 'meter_sale_price')); if (psm == null && area && worth) psm = Math.round(worth / area);
      // DLD site uses IS_OFFPLAN_EN = "Off-Plan" / "Ready"; Pulse uses reg_type_en = "Off-Plan Properties" / "Existing Properties".
      const regRaw = g(r, f, 'reg_type_en') || ''; const reg = /off/i.test(regRaw) ? 'Off-Plan Properties' : regRaw ? 'Existing Properties' : null;
      const number = g(r, f, 'transaction_id'); const date = iso(g(r, f, 'instance_date'));
      const group = g(r, f, 'trans_group_en') || null;
      const key = txKey(number, group); if (!key) unkeyed++;
      batch.push([`${number}#${seq}`, date, group, g(r, f, 'procedure_name_en') || null, reg,
        g(r, f, 'property_type_en') || null, g(r, f, 'property_sub_type_en') || null, g(r, f, 'property_usage_en') || null, normArea(g(r, f, 'area_name_en')),
        g(r, f, 'building_name_en') || null, pnum(g(r, f, 'project_number')), g(r, f, 'project_name_en') || null, g(r, f, 'rooms_en') || null, area, worth, psm, key, date]);
      if (batch.length >= 5000) { tx(batch); n += batch.length; batch = []; }
    }
    if (batch.length) { tx(batch); n += batch.length; }
    // "held" is rows the database already had under the same transaction number. On a re-run of the same
    // dump that is all of them and is expected; a large count on a NEW dump means the file repeats numbers
    // (portfolio mortgages once did) and those rows are being dropped — check before trusting the totals.
    console.log(`transactions: ${n} read, ${n - held} stored, ${held} already held${unkeyed ? `, ${unkeyed} with an unreadable transaction number (stored, but not duplicate-checked)` : ''}`);
  }

  // ---- rents ----
  h = want('rents') ? await headersOf('rents.csv') : null;
  if (h) {
    const { found: f, missing } = resolveMap(h, M.rents);
    if (!f.contract_id || !f.annual_amount) throw new Error(`rents.csv: cannot find id/amount columns. Missing: ${missing.join(', ')}. Headers: ${h.join(', ')}`);
    const ins = db.prepare(`INSERT OR IGNORE INTO rent_contract VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction((b: any[][]) => b.forEach(x => ins.run(...x)));
    let n = 0, batch: any[][] = [];
    for await (const r of rows('rents.csv')) {
      batch.push([g(r, f, 'contract_id'), iso(g(r, f, 'contract_start_date')), g(r, f, 'contract_reg_type_en') || null, num(g(r, f, 'annual_amount')), normArea(g(r, f, 'area_name_en')),
        g(r, f, 'project_name_en') || null, pnum(g(r, f, 'project_number')), g(r, f, 'ejari_property_type_en') || null, normRooms(g(r, f, 'rooms_en')), num(g(r, f, 'actual_area'))]);
      if (batch.length >= 5000) { tx(batch); n += batch.length; batch = []; }
    }
    if (batch.length) { tx(batch); n += batch.length; }
    console.log(`rents: ${n}`);
  }

  // Link transactions/rents to projects by name when the file has no project number (the DLD site export doesn't).
  db.exec(`UPDATE transaction_ SET project_number=(SELECT project_number FROM project p WHERE UPPER(TRIM(p.name_en))=UPPER(TRIM(transaction_.project_name_en))) WHERE (project_number IS NULL OR project_number='') AND project_name_en IS NOT NULL;
           UPDATE rent_contract SET project_number=(SELECT project_number FROM project p WHERE UPPER(p.name_en)=UPPER(rent_contract.project_name_en)) WHERE (project_number IS NULL OR project_number='') AND project_name_en IS NOT NULL;`);
  // The Dubai Pulse project register carries Arabic names only; take the English name from the transaction
  // register (most frequent project_name_en per project number) and keep the Arabic as name_ar.
  db.exec(`UPDATE project SET name_ar = name_en WHERE name_ar IS NULL AND name_en GLOB '*[\u0600-\u06FF]*'`);
  const enNames = db.prepare(`SELECT project_number, project_name_en AS name, COUNT(*) c FROM transaction_ WHERE project_number IS NOT NULL AND project_name_en<>'' GROUP BY 1,2 ORDER BY project_number, c DESC`).all() as any[];
  const seen = new Set<string>(); const setName = db.prepare(`UPDATE project SET name_en=?, slug=? WHERE project_number=? AND (name_ar IS NOT NULL OR name_en LIKE 'Project %')`);
  const areaOf = db.prepare(`SELECT area_slug FROM project WHERE project_number=?`); const taken = db.prepare(`SELECT 1 FROM project WHERE area_slug=? AND slug=? AND project_number<>?`);
  db.transaction(() => { for (const r of enNames) { if (seen.has(r.project_number)) continue; seen.add(r.project_number);
    const a = areaOf.get(r.project_number) as any; if (!a) continue; let slug = slugify(r.name) || r.project_number; if (taken.get(a.area_slug, slug, r.project_number)) slug = `${slug}-${r.project_number}`;
    setName.run(r.name.trim(), slug, r.project_number); } })();
  const still = db.prepare(`SELECT COUNT(*) c FROM project WHERE name_en GLOB '*[\u0600-\u06FF]*'`).get() as any;
  console.log(`projects still without an English name (no transactions yet): ${still.c}`);
  const linked = db.prepare(`SELECT COUNT(*) c FROM transaction_ WHERE project_number IS NOT NULL`).get() as any;
  const total = db.prepare(`SELECT COUNT(*) c FROM transaction_`).get() as any;
  console.log(`transactions linked to a project: ${linked.c} of ${total.c}`);
  db.close();
}

if (process.argv.includes('--check')) check(); else main().catch(e => { console.error(e.message); process.exit(1); });
