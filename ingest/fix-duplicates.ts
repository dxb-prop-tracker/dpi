// One-off repair: merge transactions that the register filed twice under two different dates.
//
//   npm run fix:dups -- --dry     show what would change, touch nothing
//   npm run fix:dups              back up the database, merge, add the unique index
//
// Background. The bulk dump and the open-data API date a sale by the next working day when it was
// registered from about 16:00; the DLD website export (and the register's own screen) date it by the
// day it actually happened. Our duplicate check matched on transaction number AND date, so every one
// of those sales was stored twice. June-August 2026 were inflated by 30-40%; earlier months, where we
// hold no website export, were never affected.
//
// The merge keeps ONE row per canonical key (ingest/tx-key.ts): the register's own date, the more
// precise amount, and the fuller set of names — see pick() below for the rule on each field.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';
import { txKey, isWebId } from './tx-key';

const DRY = process.argv.includes('--dry');
const TEXT_COLS = ['trans_group_en', 'procedure_name_en', 'reg_type_en', 'property_type_en', 'property_sub_type_en',
  'property_usage_en', 'area_name_en', 'building_name_en', 'project_number', 'project_name_en', 'rooms_en'] as const;

const src = (id: string) => isWebId(id) ? 'web' : /#a2/.test(id) ? 'api' : 'bulk';
const clean = (v: any) => { const t = String(v ?? '').trim(); return t || null; };
const hasFils = (v: any) => typeof v === 'number' && Math.abs(v - Math.round(v)) > 1e-9;

function monthTable(db: any, title: string) {
  const rows = db.prepare(`SELECT substr(instance_date,1,7) m, COUNT(*) n, ROUND(SUM(actual_worth)/1e9,2) bn
    FROM transaction_ WHERE trans_group_en='Sales' AND instance_date >= '2026-01-01' GROUP BY 1 ORDER BY 1`).all();
  console.log(`\n${title}`);
  for (const r of rows) console.log(`  ${r.m}  ${String(r.n).padStart(7)} sales  AED ${String(r.bn).padStart(6)} bn`);
}

function main() {
  const dbPath = path.resolve('data/portal.db');
  if (!fs.existsSync(dbPath)) { console.error('No data/portal.db'); process.exit(1); }
  if (!DRY) {
    const backup = dbPath.replace(/\.db$/, `.before-dedupe-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(backup)) { console.log(`Backing up → ${path.basename(backup)}`); fs.copyFileSync(dbPath, backup); }
  }
  const db = openDb();
  db.pragma('journal_mode = WAL');
  monthTable(db, 'Sales per month BEFORE:');

  // 1. Canonical key + feed date on every row.
  console.log('\nKeying rows…');
  const setKey = db.prepare(`UPDATE transaction_ SET tx_key=?, feed_date=? WHERE transaction_id=?`);
  let keyed = 0, unkeyable = 0;
  // Read a page, then write it: better-sqlite3 refuses writes while a cursor is open on the same
  // connection, and holding 1.8m rows in memory to get around that is not worth it.
  const page = db.prepare(`SELECT transaction_id, instance_date, trans_group_en FROM transaction_
    WHERE transaction_id > ? ORDER BY transaction_id LIMIT 50000`);
  const writePage = db.transaction((rows: any[]) => {
    for (const r of rows) {
      const k = txKey(r.transaction_id, r.trans_group_en);
      if (!k) { unkeyable++; continue; }
      setKey.run(k, isWebId(r.transaction_id) ? null : r.instance_date, r.transaction_id);
      keyed++;
    }
  });
  for (let cursor = ''; ;) {
    const rows = page.all(cursor) as any[];
    if (!rows.length) break;
    writePage(rows);
    cursor = rows[rows.length - 1].transaction_id;
    if (keyed % 400000 < 50000) process.stdout.write(`  … ${keyed.toLocaleString()}\r`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS ix_tx_key ON transaction_(tx_key)`);
  console.log(`  ${keyed.toLocaleString()} rows keyed${unkeyable ? `, ${unkeyable} of an unrecognised shape (left alone)` : ''}`);

  // 2. Groups of rows that are the same transaction.
  const dupKeys = db.prepare(`SELECT tx_key FROM transaction_ WHERE tx_key IS NOT NULL GROUP BY tx_key HAVING COUNT(*)>1`).all() as any[];
  console.log(`  ${dupKeys.length.toLocaleString()} transactions are stored more than once`);

  const rowsOf = db.prepare(`SELECT * FROM transaction_ WHERE tx_key=?`);
  const upd = db.prepare(`UPDATE transaction_ SET instance_date=?, feed_date=?, actual_worth=?, procedure_area=?,
    meter_sale_price=?, ${TEXT_COLS.map(c => `${c}=?`).join(', ')} WHERE transaction_id=?`);
  const del = db.prepare(`DELETE FROM transaction_ WHERE transaction_id=?`);
  const vinOf = db.prepare(`SELECT * FROM vintage WHERE kind='tx' AND id=?`);
  const vinDel = db.prepare(`DELETE FROM vintage WHERE kind='tx' AND id=?`);
  const vinSet = db.prepare(`INSERT INTO vintage(kind,id,first_seen,withdrawn_on) VALUES('tx',?,?,?)
    ON CONFLICT(kind,id) DO UPDATE SET first_seen=excluded.first_seen, withdrawn_on=excluded.withdrawn_on`);

  let merged = 0, removed = 0, dateFixed = 0, worthFixed = 0, filled = 0;
  const sample: string[] = [];

  const mergeAll = db.transaction(() => {
    for (const { tx_key } of dupKeys) {
      const rows = (rowsOf.all(tx_key) as any[]).sort((a, b) => {
        const rank = (r: any) => src(r.transaction_id) === 'bulk' ? 0 : src(r.transaction_id) === 'api' ? 1 : 2;
        return rank(a) - rank(b) || String(a.instance_date).localeCompare(String(b.instance_date));
      });
      const keep = rows[0];                       // richest feed wins the row; its fields are corrected below
      const losers = rows.slice(1);
      const web = rows.find(r => isWebId(r.transaction_id));
      const feed = rows.filter(r => !isWebId(r.transaction_id)).map(r => r.instance_date).filter(Boolean).sort()[0] ?? null;

      // The register's own date beats the feed's next-working-day date.
      const date = web?.instance_date ?? rows.map(r => r.instance_date).filter(Boolean).sort()[0] ?? keep.instance_date;
      // Fils: the website export carries them, the bulk dump truncates to whole dirhams.
      const worths = rows.map(r => r.actual_worth).filter(v => v != null);
      const worth = worths.find(hasFils) ?? (worths.length ? Math.max(...worths) : null);
      const area = rows.map(r => r.procedure_area).find(v => v != null) ?? null;
      const text: Record<string, any> = {};
      for (const c of TEXT_COLS) text[c] = rows.map(r => clean(r[c])).find(v => v != null) ?? null;
      const psm = worth != null && area ? Math.round(worth / area) : (rows.map(r => r.meter_sale_price).find(v => v != null) ?? null);

      if (date !== keep.instance_date) dateFixed++;
      if (worth != null && keep.actual_worth != null && worth !== keep.actual_worth) worthFixed++;
      for (const c of TEXT_COLS) if (clean(keep[c]) == null && text[c] != null) { filled++; break; }
      if (sample.length < 5 && web && date !== keep.instance_date)
        sample.push(`    ${tx_key.split('|').slice(0, 3).join('-')}  kept ${date} (feed said ${keep.instance_date}), AED ${Number(worth).toLocaleString()}`);

      if (!DRY) {
        upd.run(date, feed, worth, area, psm, ...TEXT_COLS.map(c => text[c]), keep.transaction_id);
        // Vintage: the sale was first seen on the earliest date any copy of it was; it counts as
        // withdrawn only if every copy was withdrawn (one copy surviving means it is still in the register).
        const vins = rows.map(r => vinOf.get(r.transaction_id)).filter(Boolean) as any[];
        if (vins.length) {
          const firstSeen = vins.map(v => v.first_seen).filter(Boolean).sort()[0];
          const allGone = vins.length === rows.length && vins.every(v => v.withdrawn_on);
          vinSet.run(keep.transaction_id, firstSeen ?? '1970-01-01', allGone ? vins.map(v => v.withdrawn_on).sort()[0] : null);
        }
        for (const l of losers) { vinDel.run(l.transaction_id); del.run(l.transaction_id); removed++; }
      } else removed += losers.length;
      merged++;
    }
  });
  mergeAll();

  console.log(`\n  ${merged.toLocaleString()} transactions merged, ${removed.toLocaleString()} duplicate rows ${DRY ? 'would be ' : ''}removed`);
  console.log(`  ${dateFixed.toLocaleString()} dates corrected to the register's own date, ${worthFixed.toLocaleString()} amounts given their fils back, ${filled.toLocaleString()} rows gained missing names`);
  if (sample.length) { console.log('  examples:'); sample.forEach(s => console.log(s)); }

  // 3. Withdrawal marks made by the old date-based check cannot be trusted: a sale whose date moved
  // simply stopped matching its day and was recorded as withdrawn. Clear them and let the corrected
  // check (which compares feed days, see fetch-dda.ts) re-derive them on the next refresh.
  const stale = db.prepare(`SELECT COUNT(*) n FROM vintage WHERE kind='tx' AND withdrawn_on IS NOT NULL`).get() as any;
  if (!DRY && stale.n) db.exec(`UPDATE vintage SET withdrawn_on=NULL WHERE kind='tx' AND withdrawn_on IS NOT NULL`);
  console.log(`  ${stale.n} withdrawal marks from the old date-based check cleared${DRY ? ' (would be)' : ''}`);

  // 4. Lock it: from here a second copy of the same transaction cannot be inserted, whatever its date.
  if (!DRY) {
    const left = db.prepare(`SELECT COUNT(*) n FROM (SELECT tx_key FROM transaction_ WHERE tx_key IS NOT NULL GROUP BY tx_key HAVING COUNT(*)>1)`).get() as any;
    if (left.n) { console.error(`\n${left.n} duplicate keys remain — unique index NOT created. Investigate before rebuilding.`); process.exit(1); }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_tx_key ON transaction_(tx_key)`);
    console.log('  unique index on tx_key created — the same sale can never be stored twice again');
    db.exec(`ANALYZE`);
  }

  if (!DRY) monthTable(db, 'Sales per month AFTER:');
  else console.log('\nDry run: rows were keyed (tx_key/feed_date filled in, which is harmless and idempotent)\nbut no transaction was merged, moved or deleted. Run without --dry to apply.');
}

main();
