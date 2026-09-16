// Quarterly developer panel for the issuer engines, built from one read of portal.db with a manifest that
// says exactly what it was built from.
//
//   npx tsx tools/export-developer-panel.ts --config tools/panels/emaar.json
//   npx tsx tools/export-developer-panel.ts --config tools/panels/emaar.json --reconcile <legacy.csv>
//
// Why it exists. real-estate-engine read a panel that nobody could rebuild: it had been made by hand, it
// carried a source_as_of that nothing could verify, and it was missing an in-scope developer (1275 Mina
// Rashid Properties, AED 12bn of off-plan registrations). Before this generator replaced it, it was reconciled
// against that panel row by row: every one of the 696 rows, every column, from the database as it stood on
// 16 September 2026. The reconciliation is what fixed the definition below — it was not the one the column
// names suggest, and a generator written from the names would have been 17% out.
//
// The definition is config, and there are two:
//
//   tools/panels/emaar.json         the panel real-estate-engine reads. Sales registrations only; ready/off-plan by
//                                   reg_type; median_price_per_sqm is a true median over prices dpi's reports accept
//                                   (500-200,000 AED/sqm); active_projects counts projects with a sale that quarter.
//   tools/panels/emaar-legacy.json  the definition the hand-made panel actually used, kept so that vintage can be
//                                   rebuilt: the *_sales_* columns counted every registration group (Sales,
//                                   Mortgages, Gifts — a mortgage's actual_worth is the loan), median_price_per_sqm
//                                   was a mean below 200,000, and mapped_transaction_percentage was 100 by
//                                   construction (an unattributable registration never reaches a developer row).
//
// The number that does measure attribution is the orphan share — registrations under a project number we do not
// hold, in the same registration groups as the panel — which drives `maturity` and is in the manifest.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDb, DB_PATH } from '../ingest/db';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const configPath = flag('--config');
if (!configPath) { console.error('usage: export-developer-panel.ts --config <panel.json> [--out <dir>] [--reconcile <legacy.csv>] [--no-write]'); process.exit(2); }
const reconcilePath = flag('--reconcile');
const noWrite = args.includes('--no-write');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const def = cfg.definition, mat = cfg.maturity;
const groups: string[] | null = def.trans_groups === 'all' ? null : def.trans_groups;
if (groups !== null && !(Array.isArray(groups) && groups.length)) throw new Error('definition.trans_groups must be "all" or a list');
const psmDef = def.price_per_sqm;
if (!['mean', 'median'].includes(psmDef?.statistic)) throw new Error('definition.price_per_sqm.statistic must be mean or median');
if (def.exclude_withdrawn !== false) throw new Error('exclude_withdrawn is not implemented; withdrawn registrations are counted');
const groupSql = groups ? ` AND t.trans_group_en IN (${groups.map(() => '?').join(',')})` : '';
const groupArgs = groups ?? [];
const psmCond = [psmDef.min_inclusive != null ? `t.meter_sale_price >= ${Number(psmDef.min_inclusive)}` : null,
  psmDef.max_inclusive != null ? `t.meter_sale_price <= ${Number(psmDef.max_inclusive)}` : null,
  psmDef.max_exclusive != null ? `t.meter_sale_price < ${Number(psmDef.max_exclusive)}` : null].filter(Boolean).join(' AND ') || '1';

const COLUMNS: string[] = cfg.columns;
if (!Array.isArray(COLUMNS) || !COLUMNS.includes('quarter')) throw new Error('config.columns must list the output columns');
const QUARTER = `substr(t.instance_date,1,4)||'Q'||((CAST(substr(t.instance_date,6,2) AS INT)+2)/3)`;
const quarterIndex = (q: string) => Number(q.slice(0, 4)) * 4 + Number(q.slice(5)) - 1;

const db = openDb(true);
const devs: { developer_number: string; attribution_scope: string }[] = cfg.developers;
const ids = devs.map(d => d.developer_number);
const ph = ids.map(() => '?').join(',');

// One read transaction: every number below comes from the same state of the database.
const build = db.transaction(() => {
  const asOf = (db.prepare(`SELECT MAX(instance_date) d FROM transaction_ WHERE instance_date <= date('now')`).get() as any).d as string;
  const fromDate = `${cfg.from_quarter.slice(0, 4)}-${String((Number(cfg.from_quarter.slice(5)) - 1) * 3 + 1).padStart(2, '0')}-01`;
  const names = new Map((db.prepare(`SELECT developer_number, name_en FROM developer WHERE developer_number IN (${ph})`).all(...ids) as any[]).map(r => [r.developer_number, r.name_en]));
  const missing = ids.filter(id => !names.has(id));
  if (missing.length) throw new Error(`developer(s) not in the register: ${missing.join(', ')}`);

  const cells = db.prepare(`SELECT ${QUARTER} q, p.developer_number d,
      SUM(t.reg_type_en='Off-Plan Properties') oc, SUM(CASE WHEN t.reg_type_en='Off-Plan Properties' THEN t.actual_worth ELSE 0 END) ov,
      SUM(t.reg_type_en='Existing Properties') rc, SUM(CASE WHEN t.reg_type_en='Existing Properties' THEN t.actual_worth ELSE 0 END) rv,
      COUNT(*) tc, SUM(t.actual_worth) tv,
      AVG(CASE WHEN ${psmCond} THEN t.meter_sale_price END) psm_mean,
      COUNT(DISTINCT t.project_number) ap
    FROM transaction_ t JOIN project p ON p.project_number = t.project_number
    WHERE p.developer_number IN (${ph}) AND t.instance_date >= @from AND t.instance_date <= @asOf${groupSql}
    GROUP BY 1, 2`).all(...ids, ...groupArgs, { from: fromDate, asOf }) as any[];
  // SQLite has no median; collect the accepted prices per cell and take the middle here.
  const medians = new Map<string, number>();
  if (psmDef.statistic === 'median') {
    const prices = new Map<string, number[]>();
    for (const r of db.prepare(`SELECT ${QUARTER} q, p.developer_number d, t.meter_sale_price v
        FROM transaction_ t JOIN project p ON p.project_number = t.project_number
        WHERE p.developer_number IN (${ph}) AND t.instance_date >= @from AND t.instance_date <= @asOf${groupSql}
          AND t.meter_sale_price IS NOT NULL AND ${psmCond}`).iterate(...ids, ...groupArgs, { from: fromDate, asOf }) as any) {
      const k = `${r.q}|${r.d}`; const a = prices.get(k) ?? []; a.push(r.v); prices.set(k, a);
    }
    for (const [k, a] of prices) {
      a.sort((x, y) => x - y); const m = a.length >> 1;
      medians.set(k, a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2);
    }
  }
  for (const c of cells) c.psm = psmDef.statistic === 'median' ? medians.get(`${c.q}|${c.d}`) ?? null : c.psm_mean;

  const orphans = db.prepare(`SELECT ${QUARTER} q, COUNT(*) n,
      SUM(p.project_number IS NULL AND IFNULL(t.project_number,'') <> '') orphan
    FROM transaction_ t LEFT JOIN project p ON p.project_number = t.project_number
    WHERE t.instance_date >= @from AND t.instance_date <= @asOf${groupSql} GROUP BY 1`).all(...groupArgs, { from: fromDate, asOf }) as any[];

  const withdrawn = (db.prepare(`SELECT COUNT(*) n FROM transaction_ t JOIN project p ON p.project_number = t.project_number
    JOIN vintage v ON v.kind='tx' AND v.id = t.transaction_id AND v.withdrawn_on IS NOT NULL
    WHERE p.developer_number IN (${ph}) AND t.instance_date >= ? AND t.instance_date <= ?${groupSql}`).get(...ids, fromDate, asOf, ...groupArgs) as any).n;

  const register = db.prepare(`SELECT (SELECT COUNT(*) FROM transaction_) tx, (SELECT COUNT(*) FROM project) projects,
    (SELECT COUNT(*) FROM developer) developers`).get() as any;
  const baseline = db.prepare(`SELECT * FROM vintage_baseline`).all();
  return { asOf, names, cells, orphans, withdrawn, register, baseline };
});
const { asOf, names, cells, orphans, withdrawn, register, baseline } = build();

const asOfQ = quarterIndex(`${asOf.slice(0, 4)}Q${Math.floor((Number(asOf.slice(5, 7)) + 2) / 3)}`);
const orphanShare = new Map(orphans.map(o => [o.q, o.n ? o.orphan / o.n : 0]));
// Two different things can be wrong with a quarter, and only one of them is "not finished yet". A recent
// quarter is still filling in: the gateway adds new projects and ~6,000 held registrations became attributable
// overnight on 13 Sep 2026. An old quarter with orphans has a hole that will not close — 2023Q4 carries 1.8%
// of registrations under two projects that neither the open-data file nor the gateway lists any more. So the
// orphan rule only marks a quarter provisional inside the lookback window; beyond it the gap is reported in
// the manifest as an attribution gap and the quarter stays mature.
const reasonsOf = (q: string) => {
  const age = asOfQ - quarterIndex(q), share = orphanShare.get(q) ?? 0, reasons: string[] = [];
  if (age < mat.provisional_trailing_quarters) reasons.push('recent');
  if (share > mat.max_orphan_share && age < mat.orphan_rule_lookback_quarters) reasons.push('orphans');
  return reasons;
};
const maturityOf = (q: string) => reasonsOf(q).length ? 'provisional' : 'mature';
const attributionGap = (q: string) => (orphanShare.get(q) ?? 0) > mat.max_orphan_share && asOfQ - quarterIndex(q) >= mat.orphan_rule_lookback_quarters;

const byKey = new Map(cells.map(c => [`${c.q}|${c.d}`, c]));
const rows: Record<string, string | number>[] = [];
for (const dev of devs) {
  const quarters = cells.filter(c => c.d === dev.developer_number).map(c => c.q).sort();
  for (const q of quarters) {
    const c = byKey.get(`${q}|${dev.developer_number}`)!;
    rows.push({ quarter: q, developer_number: dev.developer_number, legal_developer_name: names.get(dev.developer_number)!,
      attribution_scope: dev.attribution_scope, offplan_sales_count: c.oc, offplan_sales_value: c.ov,
      ready_sales_count: c.rc, ready_sales_value: c.rv, total_sales_count: c.tc, total_sales_value: c.tv,
      median_price_per_sqm: c.psm ?? '', active_projects: c.ap, mapped_transaction_percentage: 100,
      source_as_of: asOf, maturity: maturityOf(q) });
  }
}

const cell = (v: string | number) => typeof v === 'number' ? String(v) : `"${String(v).replace(/"/g, '""')}"`;
const csv = [COLUMNS.map(c => `"${c}"`).join(','), ...rows.map(r => COLUMNS.map(c => cell(r[c])).join(','))].join('\n') + '\n';
const sha256 = crypto.createHash('sha256').update(csv).digest('hex');

const git = (...a: string[]) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return null; } };
const stat = fs.statSync(DB_PATH);
const quarters = [...new Set(rows.map(r => String(r.quarter)))].sort();
const manifest = {
  output: `${cfg.output_name}.csv`, sha256, rows: rows.length, generated_at: new Date().toISOString(), source_as_of: asOf,
  generator: { script: 'tools/export-developer-panel.ts', config: configPath,
    config_sha256: crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'),
    dpi_commit: git('rev-parse', 'HEAD'), // Tracked changes only: an untracked scratch file elsewhere in dpi does not change what produced this panel.
    dpi_worktree_dirty: (git('status', '--porcelain', '--untracked-files=no') ?? '') !== '' },
  database: { path: path.relative(process.cwd(), DB_PATH), bytes: stat.size, modified: stat.mtime.toISOString(), ...register,
    vintage_baseline: baseline },
  definition: def, maturity_config: mat,
  developers: devs.map(d => ({ ...d, name: names.get(d.developer_number), quarters: rows.filter(r => r.developer_number === d.developer_number).length })),
  quarters: quarters.map(q => ({ quarter: q, rows: rows.filter(r => r.quarter === q).length,
    market_orphan_share: Number((orphanShare.get(q) ?? 0).toFixed(6)), maturity: maturityOf(q), reasons: reasonsOf(q),
    attribution_gap: attributionGap(q) })),
  withdrawn_registrations_included: withdrawn,
};

if (!noWrite) {
  const out = path.resolve(flag('--out') ?? 'data/exports');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${cfg.output_name}.csv`), csv);
  fs.writeFileSync(path.join(out, `${cfg.output_name}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), out)}/${cfg.output_name}.csv — ${rows.length} rows, ${devs.length} developers, as of ${asOf}, sha256 ${sha256.slice(0, 12)}`);
}
console.log(`maturity: ${manifest.quarters.filter(q => q.maturity === 'provisional').map(q => q.quarter).join(', ') || 'none'} provisional`);
const gaps = manifest.quarters.filter(q => q.attribution_gap);
if (gaps.length) console.log(`attribution gap (old quarters, will not fill in): ${gaps.map(q => `${q.quarter} ${(q.market_orphan_share * 100).toFixed(2)}%`).join(', ')}`);

// ---- reconciliation against a panel this one is meant to replace ----
if (reconcilePath) {
  const parse = (line: string) => { const out: string[] = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) { const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out; };
  const lines = fs.readFileSync(reconcilePath, 'utf8').replace(/^﻿/, '').trimEnd().split('\n');
  const head = parse(lines[0]);
  const legacy = lines.slice(1).map(l => Object.fromEntries(parse(l).map((v, i) => [head[i], v])));
  const mine = new Map(rows.map(r => [`${r.quarter}|${r.developer_number}`, r]));
  const EXACT = ['legal_developer_name', 'attribution_scope', 'offplan_sales_count', 'offplan_sales_value', 'ready_sales_count',
    'ready_sales_value', 'total_sales_count', 'total_sales_value', 'active_projects', 'mapped_transaction_percentage']
    .filter(c => COLUMNS.includes(c));
  let matched = 0, byteIdentical = 0; const problems: string[] = [];
  for (const l of legacy) {
    const k = `${l.quarter}|${l.developer_number}`, m = mine.get(k);
    if (!m) { problems.push(`${k}: in the legacy panel, not generated`); continue; }
    // Numbers compare as numbers, exactly: the legacy file wrote values of AED 10bn and over in scientific
    // notation (1.1002659382e+10), which is the same number as the 11002659382 written here.
    const same = (c: string) => typeof m[c] === 'number' ? Number(l[c]) === m[c] : String(m[c]) === l[c];
    const bad = EXACT.filter(c => c in l && !same(c)).map(c => `${c} ${l[c]} → ${m[c]}`);
    if ('median_price_per_sqm' in l && COLUMNS.includes('median_price_per_sqm')) {
      const a = Number(l.median_price_per_sqm), b = Number(m.median_price_per_sqm);
      if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a))) bad.push(`median_price_per_sqm ${a} → ${b}`);
    }
    if (bad.length) problems.push(`${k}: ${bad.join('; ')}`); else matched++;
    if (head.every(c => c === 'source_as_of' || (COLUMNS.includes(c) && String(m[c]) === l[c]))) byteIdentical++;
  }
  const extra = rows.filter(r => !legacy.some(l => l.quarter === r.quarter && l.developer_number === r.developer_number));
  console.log(`\nreconciliation against ${reconcilePath}`);
  console.log(`  ${matched}/${legacy.length} legacy rows match (counts and values exactly, price per sqm to 1e-9), ${byteIdentical} byte-identical apart from source_as_of`);
  const extraDevs = [...new Set(extra.map(r => r.developer_number))];
  console.log(`  ${extra.length} generated row(s) not in the legacy panel${extraDevs.length ? ` — developer(s) ${extraDevs.join(', ')}` : ''}`);
  const legacyAsOf = [...new Set(legacy.map(l => l.source_as_of).filter(Boolean))];
  if (legacyAsOf.length) console.log(`  legacy source_as_of ${legacyAsOf.join(', ')}; generated ${asOf}`);
  for (const p of problems.slice(0, 10)) console.log(`  MISMATCH ${p}`);
  if (problems.length) { console.log(`  ${problems.length} mismatch(es) — this panel does not reproduce the legacy one`); process.exit(1); }
}
