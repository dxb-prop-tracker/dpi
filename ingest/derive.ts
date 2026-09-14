// Derived tables computed from the register alone (no listing feed needed). Run after ingest:dld.
//  1. resale_pair  — consecutive recorded sales of the same unit identity (project + building + rooms + exact area).
//                    Pairs where the later sale is below the earlier one are "registry-confirmed losses":
//                    real sellers who exited below their own entry price. Stronger than any asking-price cut.
//  2. delay_flag   — projects with recent sales, low completion %, and a planned completion date that is
//                    imminent or already passed. Distress precedes price cuts; this is the leading indicator.
import { openDb } from './db.js';

const db = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS resale_pair (
    id INTEGER PRIMARY KEY,
    project_number TEXT, area_name_en TEXT, building_name_en TEXT, rooms_en TEXT, procedure_area REAL,
    bought_on TEXT, bought_for REAL, bought_reg TEXT,
    sold_on TEXT, sold_for REAL, sold_reg TEXT,
    hold_days INTEGER, change_pct REAL, ambiguity INTEGER,  -- ambiguity = other sales of the same identity in the window
    property_type TEXT, bought_proc TEXT, sold_proc TEXT     -- v2.0 (14 Sep 2026): Unit or Villa; the register procedure on each leg
  );
  CREATE INDEX IF NOT EXISTS ix_rp_project ON resale_pair(project_number, sold_on);
  CREATE INDEX IF NOT EXISTS ix_rp_area ON resale_pair(area_name_en, sold_on);
  CREATE TABLE IF NOT EXISTS delay_flag (
    project_number TEXT PRIMARY KEY, area_name_en TEXT, status TEXT, percent_completed REAL, completion_date TEXT,
    months_to_completion REAL, sales_12m INTEGER, value_12m REAL, offplan_12m INTEGER, risk_score INTEGER, reason TEXT
  );
  DELETE FROM resale_pair; DELETE FROM delay_flag;
`);
for (const c of ['property_type TEXT', 'bought_proc TEXT', 'sold_proc TEXT'])
  try { db.exec(`ALTER TABLE resale_pair ADD COLUMN ${c}`); } catch { /* already there */ }

// ---- 1. resale pairs ----
// v2.0 (14 Sep 2026). "The same home" is area + building + property type + rooms + size; a home
// with no building name is keyed on its project instead. Villas are in, and so are homes with no
// register project number (12.5% of sales — the older villa communities, which never had one).
// Both were missing from v1.0, and both mattered: villas have risen about 2.3x since 2012 against
// 1.2x for apartments, so an apartments-in-registered-projects index read as a market index
// understated Dubai by a third (tests/rsi_decompose.py has the proof, rule by rule).
// Legs are 'Sell' (a completed home changing hands) and 'Sell - Pre registration' (an off-plan
// purchase, kept for the cohort tables). 'Delayed Sell' is a developer's PRELIMINARY sale — a
// contract price registered on a later date — and 'Sale On Payment Plan' likewise; neither is a
// market price on its date, so neither is a leg (Ali's finding, 13 Sep 2026).
const rows = db.prepare(`
  SELECT project_number, area_name_en, building_name_en, rooms_en, procedure_area, instance_date, actual_worth, reg_type_en,
         property_type_en, procedure_name_en,
         COALESCE(NULLIF(TRIM(building_name_en),''), 'project:' || COALESCE(project_number,'')) AS bkey
  FROM transaction_
  WHERE trans_group_en='Sales' AND procedure_name_en IN ('Sell','Sell - Pre registration')
    AND property_type_en IN ('Unit','Villa') AND procedure_area>10 AND actual_worth>150000
    AND instance_date>='2010-01-01' AND rooms_en IS NOT NULL AND rooms_en<>''
    AND (NULLIF(TRIM(building_name_en),'') IS NOT NULL OR project_number IS NOT NULL)
  ORDER BY area_name_en, bkey, property_type_en, rooms_en, procedure_area, instance_date`).all() as any[];
const ins = db.prepare(`INSERT INTO resale_pair(project_number,area_name_en,building_name_en,rooms_en,procedure_area,bought_on,bought_for,bought_reg,sold_on,sold_for,sold_reg,hold_days,change_pct,ambiguity,property_type,bought_proc,sold_proc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
let pairs = 0, losses = 0;
const sameHome = (x: any, y: any) => x.area_name_en === y.area_name_en && x.bkey === y.bkey && x.property_type_en === y.property_type_en && x.rooms_en === y.rooms_en && x.procedure_area === y.procedure_area;
db.transaction(() => {
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && sameHome(rows[j], rows[i])) j++;
    const grp = rows.slice(i, j);
    // Identities with many sales (e.g. 40 identical studios) are ambiguous; cap and record the group size.
    if (grp.length >= 2 && grp.length <= 12) {
      for (let k = 1; k < grp.length; k++) {
        const a = grp[k - 1], b = grp[k];
        const days = Math.round((Date.parse(b.instance_date) - Date.parse(a.instance_date)) / 86400000);
        if (days < 30) continue; // same-day / bulk transfers are not resales
        const chg = b.actual_worth / a.actual_worth - 1;
        if (chg < -0.6 || chg > 3) continue; // outside a plausible resale range: partial-value registrations, data errors
        ins.run(a.project_number ?? b.project_number, a.area_name_en, a.building_name_en, a.rooms_en, a.procedure_area, a.instance_date, a.actual_worth, a.reg_type_en, b.instance_date, b.actual_worth, b.reg_type_en, days, chg, grp.length - 2,
          a.property_type_en, a.procedure_name_en, b.procedure_name_en);
        pairs++; if (chg < 0) losses++;
      }
    }
    i = j;
  }
})();
console.log(`resale pairs: ${pairs} (losses: ${losses})`);

// ---- 2. delay flags ----
const flagged = db.prepare(`
  INSERT INTO delay_flag
  SELECT p.project_number, p.area_name_en, o.status, o.percent_completed, o.completion_date,
    ROUND((julianday(o.completion_date) - julianday('now'))/30.4, 1) AS m,
    t.n, t.v, t.op,
    0, ''
  FROM project p
  -- one reading per project: the newest, and on a tie of dates the register itself (gateway) over the
  -- workbook copy over the API load — a project can carry two readings on one date since the
  -- workbook's readings are dated by inspection (14 Sep 2026), and a date-only match returned both
  JOIN (SELECT project_number, status, percent_completed, completion_date FROM project_observation o1
        WHERE o1.id=(SELECT id FROM project_observation x WHERE x.project_number=o1.project_number
                     ORDER BY observed_at DESC, CASE source WHEN 'gateway' THEN 0 WHEN 'register-extract' THEN 1 ELSE 2 END, id DESC LIMIT 1)) o USING(project_number)
  JOIN (SELECT project_number, COUNT(*) n, SUM(actual_worth) v, SUM(CASE WHEN reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END) op
        FROM transaction_ WHERE trans_group_en='Sales' AND instance_date>=date('now','-365 days') GROUP BY project_number) t USING(project_number)
  WHERE o.status IN ('ACTIVE','NOT_STARTED','PENDING') AND o.completion_date IS NOT NULL AND t.n>=20
    AND ( (julianday(o.completion_date) - julianday('now'))/30.4 < 6 )
    AND COALESCE(o.percent_completed,0) < 70`).run();
// score: how far behind the naive build curve the project is, weighted by money at stake
db.exec(`
  UPDATE delay_flag SET
    risk_score = MIN(100, CAST(
      (CASE WHEN months_to_completion < 0 THEN 40 ELSE 40 - months_to_completion*6 END)
      + (70 - COALESCE(percent_completed,0)) * 0.5
      + MIN(25, sales_12m / 20.0) AS INTEGER)),
    reason = CASE WHEN months_to_completion < 0 THEN 'completion date passed, ' ELSE printf('%.0f months to completion, ', months_to_completion) END
             || printf('%.0f%% complete, %d sales in 12m', COALESCE(percent_completed,0), sales_12m)`);
console.log(`delay flags: ${flagged.changes}`);
db.close();
