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
// The definition is config. Two kinds, three panels:
//
//   kind developer_first_sales      tools/panels/emaar.json — the panel real-estate-engine reads. Each home a developer
//                                   sells is counted once, when it is first registered. A developer sale is one of the
//                                   procedures in the config (Sell - Pre registration, Delayed Sell, Sale On Payment
//                                   Plan) on a home — a Unit, a Villa, or Land up to 3,000 m² — which is dpi's
//                                   issuer-data rule: "Delayed Sell" is how villa and plot sales register (typed
//                                   Existing), and a larger Land row is the developer buying its own parcel. A later
//                                   Delayed Sell or payment-plan registration of a unit first registered off-plan, at
//                                   the same price, is the same sale re-registered at completion and is dropped. The
//                                   open register has no unit id, so a unit is project + building + type + rooms +
//                                   size; identical layouts share a key, which is why a repeat needs the price to match
//                                   and the first registration to be off-plan (same-price Delayed Sell pairs in one
//                                   launch are different plots: median 12 days apart). The walk runs over all history,
//                                   so a repeat of a registration before from_quarter is still recognised.
//   kind registrations              tools/panels/emaar-sales-only.json — reference: every Sales registration, split by
//                                   reg_type, true median price. tools/panels/emaar-legacy.json — the hand-made panel's
//                                   definition: every registration group (Sales, Mortgages at the loan amount, Gifts),
//                                   and a mean labelled median.
//
// The number that measures attribution is the orphan share — registrations under a project number we do not hold, in
// the panel's registration groups — which drives `maturity` and is in the manifest.
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
const KIND: 'registrations' | 'developer_first_sales' = def.kind ?? 'registrations';
if (!['registrations', 'developer_first_sales'].includes(KIND)) throw new Error(`unknown definition.kind ${KIND}`);
if (KIND === 'developer_first_sales') {
  if (!Array.isArray(def.procedures) || !def.procedures.length) throw new Error('developer_first_sales needs definition.procedures');
  if (!Array.isArray(def.home?.property_types) || def.home?.land_max_sqm == null) throw new Error('developer_first_sales needs definition.home');
  if (!def.repeat_rule?.first_procedure || def.repeat_rule?.price_tolerance == null) throw new Error('developer_first_sales needs definition.repeat_rule');
}
const groups: string[] | null = KIND === 'developer_first_sales' ? ['Sales'] : def.trans_groups === 'all' ? null : def.trans_groups;
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
// An entity is a whole developer, or named projects of a developer when only those belong to the issuer (e.g. an
// Emaar-branded project registered under another developer). entity_id is the developer number, or
// "<developer>/<project>[+<project>]" for a project-level entity.
// A whole-developer entity may carve projects out (exclude_project_numbers) when they belong to another entity —
// e.g. The Oasis, an Emaar Development community registered under Emaar Properties (555), the parent read-through.
type Entity = { developer_number: string; attribution_scope: string; project_numbers?: string[]; exclude_project_numbers?: string[] };
const devs: (Entity & { entity_id: string })[] = (cfg.developers as Entity[]).map(d => ({
  ...d, entity_id: d.project_numbers?.length ? `${d.developer_number}/${d.project_numbers.join('+')}` : d.developer_number }));
const ids = [...new Set(devs.map(d => d.developer_number))];
const ph = ids.map(() => '?').join(',');

// One read transaction: every number below comes from the same state of the database.
const build = db.transaction(() => {
  const asOf = (db.prepare(`SELECT MAX(instance_date) d FROM transaction_ WHERE instance_date <= date('now')`).get() as any).d as string;
  const fromDate = `${cfg.from_quarter.slice(0, 4)}-${String((Number(cfg.from_quarter.slice(5)) - 1) * 3 + 1).padStart(2, '0')}-01`;
  const names = new Map((db.prepare(`SELECT developer_number, name_en FROM developer WHERE developer_number IN (${ph})`).all(...ids) as any[]).map(r => [r.developer_number, r.name_en]));
  const missing = ids.filter(id => !names.has(id));
  if (missing.length) throw new Error(`developer(s) not in the register: ${missing.join(', ')}`);

  // Map every in-scope project to exactly one entity. A project claimed twice would be counted twice.
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS entity_project (project_number TEXT PRIMARY KEY, entity_id TEXT NOT NULL)`);
  db.exec(`DELETE FROM temp.entity_project`);
  const claim = db.prepare(`INSERT INTO temp.entity_project(project_number, entity_id) VALUES (?, ?)`);
  const ownerOf = db.prepare(`SELECT developer_number FROM project WHERE project_number = ?`);
  for (const e of devs) {
    const excluded = new Set(e.exclude_project_numbers ?? []);
    if (excluded.size && e.project_numbers?.length) throw new Error(`${e.entity_id}: an entity names projects or excludes them, not both`);
    for (const pn of excluded) if ((ownerOf.get(pn) as any)?.developer_number !== e.developer_number)
      throw new Error(`${e.entity_id}: excluded project ${pn} does not belong to developer ${e.developer_number}`);
    const projects = e.project_numbers?.length ? e.project_numbers
      : (db.prepare(`SELECT project_number FROM project WHERE developer_number = ?`).all(e.developer_number) as any[])
          .map(r => r.project_number).filter((pn: string) => !excluded.has(pn));
    for (const pn of projects) {
      const owner = (ownerOf.get(pn) as any)?.developer_number;
      if (owner !== e.developer_number) throw new Error(`${e.entity_id}: project ${pn} belongs to developer ${owner ?? 'none'}, not ${e.developer_number}`);
      try { claim.run(pn, e.entity_id); }
      catch { throw new Error(`project ${pn} is claimed by more than one entity (${e.entity_id})`); }
    }
  }
  // Recorded, not judged: the other projects of a project-level developer that have registrations. For a developer
  // like Nshama (1162) these are its own projects and rightly out of scope; for a single-project SPV a new entry here
  // is a project someone should look at.
  const unscoped = devs.filter(e => e.project_numbers?.length).flatMap(e =>
    (db.prepare(`SELECT p.project_number, p.name_en, COUNT(t.transaction_id) n FROM project p
       JOIN transaction_ t ON t.project_number = p.project_number
       WHERE p.developer_number = ? AND p.project_number NOT IN (SELECT project_number FROM temp.entity_project)
         AND t.instance_date >= ?${groupSql} GROUP BY 1, 2`).all(e.developer_number, fromDate, ...groupArgs) as any[])
      .map(r => ({ developer_number: e.developer_number, project_number: r.project_number, name: r.name_en, registrations: r.n })));

  let cells: any[];
  const firstSales = { raw_registrations: 0, repeats_dropped: 0, repeat_value_dropped: 0, by_quarter: {} as Record<string, { repeats: number; value: number }> };
  if (KIND === 'developer_first_sales') {
    const procs = def.procedures as string[];
    const home = `(t.property_type_en IN (${(def.home.property_types as string[]).map(() => '?').join(',')}) OR (t.property_type_en='Land' AND IFNULL(t.procedure_area,0) <= ?))`;
    const walk = db.prepare(`SELECT ep.entity_id d, t.instance_date dt, t.procedure_name_en proc, t.project_number pn,
        IFNULL(TRIM(t.building_name_en),'') bld, t.property_type_en ptype, IFNULL(t.rooms_en,'') rooms,
        ROUND(IFNULL(t.procedure_area,0),2) area, t.actual_worth worth, t.meter_sale_price psm
      FROM transaction_ t JOIN temp.entity_project ep ON ep.project_number = t.project_number
      WHERE t.trans_group_en='Sales' AND t.procedure_name_en IN (${procs.map(() => '?').join(',')}) AND ${home}
        AND t.instance_date <= ?
      ORDER BY t.instance_date, t.transaction_id`);
    const tol = Number(def.repeat_rule.price_tolerance), firstProc = def.repeat_rule.first_procedure as string;
    const open = new Map<string, { worth: number; used: boolean }[]>();
    const acc = new Map<string, any>();
    const q = (dt: string) => `${dt.slice(0, 4)}Q${Math.floor((Number(dt.slice(5, 7)) + 2) / 3)}`;
    // Bind in SQL order: procedures, then the home rule's types and land cap, then the as-of date.
    for (const r of walk.iterate(...procs, ...def.home.property_types, Number(def.home.land_max_sqm), asOf) as any) {
      firstSales.raw_registrations += r.dt >= fromDate ? 1 : 0;
      const key = `${r.pn}|${r.bld}|${r.ptype}|${r.rooms}|${r.area}`;
      if (r.proc === firstProc) {
        const list = open.get(key) ?? []; list.push({ worth: r.worth, used: false }); open.set(key, list);
      } else {
        const hit = (open.get(key) ?? []).find(o => !o.used && r.worth && o.worth && Math.abs(o.worth - r.worth) / o.worth <= tol);
        if (hit) {
          hit.used = true;
          if (r.dt >= fromDate) {
            firstSales.repeats_dropped++; firstSales.repeat_value_dropped += r.worth ?? 0;
            const b = (firstSales.by_quarter[q(r.dt)] ??= { repeats: 0, value: 0 }); b.repeats++; b.value += r.worth ?? 0;
            const c = acc.get(`${q(r.dt)}|${r.d}`); if (c) { c.rep_n++; c.rep_v += r.worth ?? 0; }
            else acc.set(`${q(r.dt)}|${r.d}`, { q: q(r.dt), d: r.d, n: 0, v: 0, on: 0, ov: 0, dn: 0, dv: 0, rep_n: 1, rep_v: r.worth ?? 0, prices: [], projects: new Set() });
          }
          continue;
        }
      }
      if (r.dt < fromDate) continue;
      const k = `${q(r.dt)}|${r.d}`;
      const c = acc.get(k) ?? { q: q(r.dt), d: r.d, n: 0, v: 0, on: 0, ov: 0, dn: 0, dv: 0, rep_n: 0, rep_v: 0, prices: [] as number[], projects: new Set<string>() };
      c.n++; c.v += r.worth ?? 0;
      if (r.proc === firstProc) { c.on++; c.ov += r.worth ?? 0; } else { c.dn++; c.dv += r.worth ?? 0; }
      if (r.psm != null && (psmDef.min_inclusive == null || r.psm >= psmDef.min_inclusive) && (psmDef.max_inclusive == null || r.psm <= psmDef.max_inclusive)
          && (psmDef.max_exclusive == null || r.psm < psmDef.max_exclusive)) c.prices.push(r.psm);
      c.projects.add(r.pn); acc.set(k, c);
    }
    const middle = (a: number[]) => { if (!a.length) return null; a.sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
    // A cell holding only a dropped repeat is still emitted (0 first sales), so the manifest identity stays exact.
    cells = [...acc.values()].filter(c => c.n > 0 || c.rep_n > 0).map(c => ({ ...c, psm: psmDef.statistic === 'median' ? middle(c.prices) : (c.prices.length ? c.prices.reduce((a: number, b: number) => a + b, 0) / c.prices.length : null), ap: c.projects.size }));
  } else {
  cells = db.prepare(`SELECT ${QUARTER} q, ep.entity_id d,
      SUM(t.reg_type_en='Off-Plan Properties') oc, SUM(CASE WHEN t.reg_type_en='Off-Plan Properties' THEN t.actual_worth ELSE 0 END) ov,
      SUM(t.reg_type_en='Existing Properties') rc, SUM(CASE WHEN t.reg_type_en='Existing Properties' THEN t.actual_worth ELSE 0 END) rv,
      COUNT(*) tc, SUM(t.actual_worth) tv,
      AVG(CASE WHEN ${psmCond} THEN t.meter_sale_price END) psm_mean,
      COUNT(DISTINCT t.project_number) ap
    FROM transaction_ t JOIN temp.entity_project ep ON ep.project_number = t.project_number
    WHERE t.instance_date >= @from AND t.instance_date <= @asOf${groupSql}
    GROUP BY 1, 2`).all(...groupArgs, { from: fromDate, asOf }) as any[];
  // SQLite has no median; collect the accepted prices per cell and take the middle here.
  const medians = new Map<string, number>();
  if (psmDef.statistic === 'median') {
    const prices = new Map<string, number[]>();
    for (const r of db.prepare(`SELECT ${QUARTER} q, ep.entity_id d, t.meter_sale_price v
        FROM transaction_ t JOIN temp.entity_project ep ON ep.project_number = t.project_number
        WHERE t.instance_date >= @from AND t.instance_date <= @asOf${groupSql}
          AND t.meter_sale_price IS NOT NULL AND ${psmCond}`).iterate(...groupArgs, { from: fromDate, asOf }) as any) {
      const k = `${r.q}|${r.d}`; const a = prices.get(k) ?? []; a.push(r.v); prices.set(k, a);
    }
    for (const [k, a] of prices) {
      a.sort((x, y) => x - y); const m = a.length >> 1;
      medians.set(k, a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2);
    }
  }
  for (const c of cells) c.psm = psmDef.statistic === 'median' ? medians.get(`${c.q}|${c.d}`) ?? null : c.psm_mean;
  }

  const orphans = db.prepare(`SELECT ${QUARTER} q, COUNT(*) n,
      SUM(p.project_number IS NULL AND IFNULL(t.project_number,'') <> '') orphan
    FROM transaction_ t LEFT JOIN project p ON p.project_number = t.project_number
    WHERE t.instance_date >= @from AND t.instance_date <= @asOf${groupSql} GROUP BY 1`).all(...groupArgs, { from: fromDate, asOf }) as any[];

  const withdrawn = (db.prepare(`SELECT COUNT(*) n FROM transaction_ t JOIN temp.entity_project ep ON ep.project_number = t.project_number
    JOIN vintage v ON v.kind='tx' AND v.id = t.transaction_id AND v.withdrawn_on IS NOT NULL
    WHERE t.instance_date >= ? AND t.instance_date <= ?${groupSql}`).get(fromDate, asOf, ...groupArgs) as any).n;

  const register = db.prepare(`SELECT (SELECT COUNT(*) FROM transaction_) tx, (SELECT COUNT(*) FROM project) projects,
    (SELECT COUNT(*) FROM developer) developers`).get() as any;
  const baseline = db.prepare(`SELECT * FROM vintage_baseline`).all();
  return { asOf, names, cells, orphans, withdrawn, register, baseline, unscoped, firstSales };
});
const { asOf, names, cells, orphans, withdrawn, register, baseline, unscoped, firstSales } = build();

const asOfQ = quarterIndex(`${asOf.slice(0, 4)}Q${Math.floor((Number(asOf.slice(5, 7)) + 2) / 3)}`);
const orphanShare = new Map<string, number>(orphans.map((o: any) => [o.q, o.n ? o.orphan / o.n : 0]));
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

const byKey = new Map<string, any>(cells.map((c: any) => [`${c.q}|${c.d}`, c]));
const rows: Record<string, string | number>[] = [];
for (const dev of devs) {
  const quarters = cells.filter(c => c.d === dev.entity_id).map(c => c.q).sort();
  for (const q of quarters) {
    const c = byKey.get(`${q}|${dev.entity_id}`)!;
    const common = { quarter: q, developer_number: dev.developer_number, entity_id: dev.entity_id,
      project_numbers: (dev.project_numbers ?? []).join(';'), excluded_project_numbers: (dev.exclude_project_numbers ?? []).join(';'),
      legal_developer_name: names.get(dev.developer_number)!, attribution_scope: dev.attribution_scope,
      median_price_per_sqm: c.psm ?? '', active_projects: c.ap, source_as_of: asOf, maturity: maturityOf(q) };
    rows.push(KIND === 'developer_first_sales'
      ? { ...common, first_sale_units: c.n, first_sale_value: c.v, offplan_first_sale_units: c.on, offplan_first_sale_value: c.ov,
          delayed_first_sale_units: c.dn, delayed_first_sale_value: c.dv, repeat_registrations_dropped: c.rep_n, repeat_value_dropped: c.rep_v }
      : { ...common, offplan_sales_count: c.oc, offplan_sales_value: c.ov, ready_sales_count: c.rc, ready_sales_value: c.rv,
          total_sales_count: c.tc, total_sales_value: c.tv, mapped_transaction_percentage: 100 });
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
    dpi_commit: git('rev-parse', 'HEAD'),
    // Only the files that produce the panel count: other work in progress in dpi (a .gitignore or CI edit, a scratch
    // script) does not change what produced it and must not make its provenance look uncommitted.
    dpi_worktree_dirty: (git('status', '--porcelain', '--', 'tools/export-developer-panel.ts', 'tools/panels', 'ingest/db.ts') ?? '') !== '' },
  database: { path: path.relative(process.cwd(), DB_PATH), bytes: stat.size, modified: stat.mtime.toISOString(), ...register,
    vintage_baseline: baseline },
  definition: def, maturity_config: mat,
  developers: devs.map(d => ({ ...d, name: names.get(d.developer_number), quarters: rows.filter(r => r.entity_id === d.entity_id).length })),
  unscoped_projects_of_project_level_developers: unscoped,
  ...(KIND === 'developer_first_sales' ? { first_sales: { ...firstSales,
    identity: 'sum(first_sale_units) + repeat_registrations_dropped = raw_registrations over the emitted quarters' } } : {}),
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
  console.log(`wrote ${path.relative(process.cwd(), out)}/${cfg.output_name}.csv — ${rows.length} rows, ${devs.length} entities, as of ${asOf}, sha256 ${sha256.slice(0, 12)}`);
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
  const mine = new Map(rows.map(r => [`${r.quarter}|${r.entity_id}`, r]));
  const EXACT = ['legal_developer_name', 'attribution_scope', 'offplan_sales_count', 'offplan_sales_value', 'ready_sales_count',
    'ready_sales_value', 'total_sales_count', 'total_sales_value', 'active_projects', 'mapped_transaction_percentage']
    .filter(c => COLUMNS.includes(c));
  let matched = 0, byteIdentical = 0; const problems: string[] = [];
  for (const l of legacy) {
    const k = `${l.quarter}|${l.entity_id ?? l.developer_number}`, m = mine.get(k);
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
  const extra = rows.filter(r => !legacy.some(l => l.quarter === r.quarter && (l.entity_id ?? l.developer_number) === r.entity_id));
  console.log(`\nreconciliation against ${reconcilePath}`);
  console.log(`  ${matched}/${legacy.length} legacy rows match (counts and values exactly, price per sqm to 1e-9), ${byteIdentical} byte-identical apart from source_as_of`);
  const extraDevs = [...new Set(extra.map(r => r.entity_id))];
  console.log(`  ${extra.length} generated row(s) not in the legacy panel${extraDevs.length ? ` — developer(s) ${extraDevs.join(', ')}` : ''}`);
  const legacyAsOf = [...new Set(legacy.map(l => l.source_as_of).filter(Boolean))];
  if (legacyAsOf.length) console.log(`  legacy source_as_of ${legacyAsOf.join(', ')}; generated ${asOf}`);
  for (const p of problems.slice(0, 10)) console.log(`  MISMATCH ${p}`);
  if (problems.length) { console.log(`  ${problems.length} mismatch(es) — this panel does not reproduce the legacy one`); process.exit(1); }
}
