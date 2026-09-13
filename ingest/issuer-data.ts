// Publishes, for every bond-issuing developer we cover, the register data the credit workbook reads.
//
//   npm run issuer:data                 all issuers in data/issuers/
//   npm run issuer:data -- binghatti    one of them
//
// Output per issuer, written to public/data/issuers/ so the site serves it and to the shared Dropbox
// folder when that exists on this machine:
//   <id>-register.csv    one row per project — the sheet the workbook's Register data tab reads
//   <id>-handover.csv    towers that could have handed over since the last balance sheet date
//   <id>-meta.json       as-of dates, row counts, issuer-level totals, and the market denominator
//
// The workbook never queries the database. It reads these files, so a refresh is a file copy and the
// model itself is never touched. Keep the column order stable: the workbook addresses columns by
// position, and reordering them would silently move every number.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';

const OUT_SITE = path.resolve('public/data/issuers');
const DROPBOX = [
  path.join(process.env.HOME || '', 'Library/CloudStorage/Dropbox/ALI TAMMAM/Code/credit/data'),
  path.join(process.env.HOME || '', 'Dropbox/ALI TAMMAM/Code/credit/data'),
].find(p => fs.existsSync(path.dirname(p))) || null;

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const today = new Date().toISOString().slice(0, 10);
const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

const csv = (rows: any[][]) => rows.map(r => r.map(v => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n') + '\n';

const AGENTS: [string, string][] = [['بنك دبي', 'Dubai Islamic Bank'], ['الإمارات دبي', 'Emirates NBD'], ['الشارقه', 'Sharjah Islamic Bank'],
  ['ابوظبى الاسلامي', 'Abu Dhabi Islamic Bank'], ['أبوظبي الأول', 'First Abu Dhabi Bank'], ['أبوظبي ا', 'First Abu Dhabi Bank'],
  ['الفجيره', 'National Bank of Fujairah'], ['العربي', 'Arab Bank'], ['المشرق', 'Mashreq'], ['أبوظبي التجاري', 'Abu Dhabi Commercial Bank']];
const agent = (a: string | null) => { const t = a ?? ''; for (const [k, v] of AGENTS) if (t.includes(k)) return v; return t || ''; };

const COLS = ['project_number', 'project', 'area', 'status', 'certified_pct', 'registered_completion', 'first_seen_completion',
  'last_read', 'units', 'sold_units', 'avg_ticket_aed', 'offplan_sales_all', 'offplan_value_aed', 'all_sales',
  'sales_12m', 'value_12m_aed', 'sales_prior_12m', 'sales_90d', 'avg_psm_12m', 'mortgages_12m',
  'resales_24m', 'resales_at_loss', 'avg_resale_change_pct', 'avg_hold_days', 'escrow_agent',
  'first_sale', 'last_sale', 'project_start', 'is_live', 'ready_sales_since_bs', 'mortgages_since_bs'];

function issuerRows(db: any, devs: string[], balanceSheet: string) {
  const marks = devs.map(() => '?').join(',');
  const y1 = ago(365), y2 = ago(730), d90 = ago(90);
  return db.prepare(`
    WITH ol AS (SELECT o.project_number pn, o.status, o.percent_completed pct, o.completion_date cd, o.observed_at
                FROM project_observation o WHERE o.id=(SELECT id FROM project_observation x WHERE x.project_number=o.project_number ORDER BY observed_at DESC, id DESC LIMIT 1)),
         of_ AS (SELECT project_number pn, MIN(completion_date) first_cd FROM project_observation WHERE completion_date IS NOT NULL GROUP BY 1),
         sa AS (SELECT project_number pn, COUNT(*) n_all, MIN(instance_date) first_sale, MAX(instance_date) last_sale,
                  SUM(CASE WHEN reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END) n_off,
                  SUM(CASE WHEN reg_type_en='Off-Plan Properties' THEN actual_worth ELSE 0 END) v_off
                FROM transaction_ WHERE trans_group_en='Sales' GROUP BY 1),
         s12 AS (SELECT project_number pn, COUNT(*) n12, SUM(actual_worth) v12, AVG(meter_sale_price) psm12,
                   SUM(CASE WHEN instance_date>=? THEN 1 ELSE 0 END) n90
                 FROM transaction_ WHERE trans_group_en='Sales' AND instance_date>=? GROUP BY 1),
         sp AS (SELECT project_number pn, COUNT(*) nprev FROM transaction_ WHERE trans_group_en='Sales' AND instance_date>=? AND instance_date<? GROUP BY 1),
         m12 AS (SELECT project_number pn, COUNT(*) m12 FROM transaction_ WHERE trans_group_en='Mortgages' AND instance_date>=? GROUP BY 1),
         bs AS (SELECT project_number pn,
                  SUM(CASE WHEN trans_group_en='Sales' AND reg_type_en='Existing Properties' AND instance_date>=? THEN 1 ELSE 0 END) ready_bs,
                  SUM(CASE WHEN trans_group_en='Mortgages' AND instance_date>=? THEN 1 ELSE 0 END) mort_bs
                FROM transaction_ GROUP BY 1),
         rs AS (SELECT project_number pn, COUNT(*) rn, SUM(CASE WHEN change_pct<0 THEN 1 ELSE 0 END) rloss,
                  AVG(change_pct)*100 rchg, AVG(hold_days) rhold
                FROM resale_pair WHERE sold_on>=? AND ambiguity=0 AND NOT (ABS(change_pct)<0.0001 AND hold_days<60) GROUP BY 1)
    SELECT p.project_number, p.name_en project, p.area_name_en area, ol.status, ol.pct certified_pct,
      ol.cd registered_completion, of_.first_cd first_seen_completion, ol.observed_at last_read,
      p.units, MIN(IFNULL(p.units, sa.n_off), IFNULL(sa.n_off,0)) sold_units,
      CASE WHEN sa.n_off>0 THEN sa.v_off/sa.n_off END avg_ticket_aed,
      sa.n_off offplan_sales_all, sa.v_off offplan_value_aed, sa.n_all all_sales,
      s12.n12 sales_12m, s12.v12 value_12m_aed, sp.nprev sales_prior_12m, s12.n90 sales_90d, s12.psm12 avg_psm_12m,
      m12.m12 mortgages_12m, rs.rn resales_24m, rs.rloss resales_at_loss, rs.rchg avg_resale_change_pct, rs.rhold avg_hold_days,
      p.escrow_agent_en escrow_agent, sa.first_sale, sa.last_sale, p.project_start_date project_start,
      CASE WHEN ol.status IN ('ACTIVE','PENDING','NOT_STARTED','CONDITIONAL_ACTIVATING') THEN 1 ELSE 0 END is_live,
      IFNULL(bs.ready_bs,0) ready_sales_since_bs, IFNULL(bs.mort_bs,0) mortgages_since_bs
    FROM project p
    LEFT JOIN ol ON ol.pn=p.project_number LEFT JOIN of_ ON of_.pn=p.project_number
    LEFT JOIN sa ON sa.pn=p.project_number LEFT JOIN s12 ON s12.pn=p.project_number LEFT JOIN sp ON sp.pn=p.project_number
    LEFT JOIN m12 ON m12.pn=p.project_number LEFT JOIN bs ON bs.pn=p.project_number LEFT JOIN rs ON rs.pn=p.project_number
    WHERE p.developer_number IN (${marks})
    ORDER BY is_live DESC, ol.cd, p.name_en`).all(d90, y1, y2, y1, y1, balanceSheet, balanceSheet, y2, ...devs);
}

function main() {
  const db = openDb(true);
  fs.mkdirSync(OUT_SITE, { recursive: true });
  if (DROPBOX) fs.mkdirSync(DROPBOX, { recursive: true });

  const registerRead = (db.prepare(`SELECT MAX(observed_at) d FROM project_observation`).get() as any).d;
  const txRead = (db.prepare(`SELECT MAX(instance_date) d FROM transaction_`).get() as any).d;
  const dubai12m = db.prepare(`SELECT COUNT(*) n, SUM(actual_worth) v FROM transaction_ WHERE trans_group_en='Sales' AND instance_date>=?`).get(ago(365)) as any;

  const files = fs.readdirSync(path.resolve('data/issuers')).filter(f => f.endsWith('.json') && !f.includes('-register') && !f.includes('-handover'));
  for (const f of files) {
    const iss = JSON.parse(fs.readFileSync(path.resolve('data/issuers', f), 'utf8'));
    if (only.length && !only.includes(iss.id)) continue;
    const devs: string[] = iss.dldDevelopers ?? [];
    if (!devs.length) { console.log(`${iss.id}: no DLD developer numbers in the dossier — skipped`); continue; }
    const balanceSheet: string = iss.balanceSheetDate ?? '2026-06-30';

    const rows = issuerRows(db, devs, balanceSheet) as any[];
    const table = [COLS, ...rows.map(r => COLS.map(c => {
      const v = (r as any)[c];
      if (c === 'escrow_agent') return agent(v);
      if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 100) / 100;
      return v;
    }))];
    fs.writeFileSync(path.join(OUT_SITE, `${iss.id}-register.csv`), csv(table));

    // Towers that could have handed over since the balance sheet date: anything finished with a
    // completion date after it, plus every live tower at 60%+ certified. The workbook's Handover
    // check tab reads this; the ready-sale and mortgage columns are the corroboration.
    const cand = rows.filter(r => (r.status === 'FINISHED' && r.registered_completion && r.registered_completion >= '2026-01-01')
      || (r.is_live && (r.certified_pct ?? 0) >= 60)
      || (r.is_live && r.registered_completion && r.registered_completion <= today && (r.certified_pct ?? 0) >= 30));
    const HCOLS = ['project', 'units', 'sold_units', 'contracted_aed_m', 'certified_pct', 'registered_completion', 'status',
      'ready_sales_since_bs', 'mortgages_since_bs', 'completed_after_balance_sheet'];
    const hand = [HCOLS, ...cand.map(r => [r.project, r.units, r.sold_units,
      Math.round((r.sold_units ?? 0) * (r.avg_ticket_aed ?? 0) / 1e6),
      r.certified_pct, r.registered_completion, r.status, r.ready_sales_since_bs, r.mortgages_since_bs,
      (r.status === 'FINISHED' && r.registered_completion && r.registered_completion > balanceSheet) ? 1 : 0])];
    fs.writeFileSync(path.join(OUT_SITE, `${iss.id}-handover.csv`), csv(hand));

    const live = rows.filter(r => r.is_live);
    const meta = {
      issuer: iss.id, brand: iss.brand, dldDevelopers: devs, balanceSheetDate: balanceSheet,
      generatedAt: new Date().toISOString(), registerLastRead: registerRead, transactionsLastRead: txRead,
      projects: rows.length, liveProjects: live.length,
      liveUnits: live.reduce((s, r) => s + (r.units ?? 0), 0),
      liveSoldUnits: live.reduce((s, r) => s + (r.sold_units ?? 0), 0),
      liveContractedAedM: Math.round(live.reduce((s, r) => s + (r.sold_units ?? 0) * (r.avg_ticket_aed ?? 0), 0) / 1e6),
      pastDueProjects: live.filter(r => r.registered_completion && r.registered_completion < today).length,
      sales12m: rows.reduce((s, r) => s + (r.sales_12m ?? 0), 0),
      value12mAedM: Math.round(rows.reduce((s, r) => s + (r.value_12m_aed ?? 0), 0) / 1e6),
      dubaiSales12m: dubai12m.n, dubaiValue12mAedM: Math.round(dubai12m.v / 1e6),
      completedSinceBalanceSheet: rows.filter(r => r.status === 'FINISHED' && r.registered_completion && r.registered_completion > balanceSheet)
        .map(r => ({ project: r.project, completed: r.registered_completion, units: r.units, contractedAedM: Math.round((r.sold_units ?? 0) * (r.avg_ticket_aed ?? 0) / 1e6) })),
    };
    fs.writeFileSync(path.join(OUT_SITE, `${iss.id}-meta.json`), JSON.stringify(meta, null, 1));

    if (DROPBOX) for (const n of [`${iss.id}-register.csv`, `${iss.id}-handover.csv`, `${iss.id}-meta.json`])
      fs.copyFileSync(path.join(OUT_SITE, n), path.join(DROPBOX, n));

    console.log(`${iss.id}: ${rows.length} projects (${live.length} live), ${meta.liveContractedAedM.toLocaleString()} AED m contracted, ` +
      `${meta.completedSinceBalanceSheet.length} completed since ${balanceSheet}`);
  }
  console.log(`register last read ${registerRead}, transactions to ${txRead}${DROPBOX ? `\ncopied to ${DROPBOX}` : '\n(no Dropbox folder found on this machine — site copy only)'}`);
}

main();
