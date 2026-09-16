// Every row gets a vintage, whichever path brought it in. Runs in the daily refresh after every ingest
// step, and after each manual ingest (npm run ingest:web, ingest:register, ingest:dld).
//
// Until 16 September 2026 vintages were written only by the paths that remembered to: the API refresh,
// the gateway and ingest-dld. The website export (ingest-dldweb.ts) wrote none, and nothing had stamped the
// 1.78m-row bulk register, so 0.5% of transactions carried a first_seen. That made it impossible to say what
// our copy of the register looked like on any past date — the question a development triangle asks — and it
// hid what happened on 13 September, when the gateway added 368 projects and about 6,000 transactions we
// already held became attributable to a developer overnight. A sweep at the end of ingest cannot forget.
//
// The first run for each kind is a BASELINE, not a sighting. Stamping today on 1.78m rows we have held since
// August would tell the weekly edition that the whole register arrived this week. So the baseline writes the
// value every reader already assumes for a row with no vintage:
//   tx, rent, developer  '1970-01-01' — the pre-tracking sentinel fetch-dda already writes for withdrawals;
//                        build-report treats it exactly as it treats a missing row (present, never "gained")
//   project              its earliest project_observation, which is the fallback build-report uses today
// and records the date it was taken in vintage_baseline. Every run after that stamps rows it has not seen
// before with the date of the run. A first_seen is therefore "first present in our copy at or before this
// date", accurate to the refresh, not to the minute a manual ingest ran.
import { openDb } from './db';

const db = openDb();
const today = new Date().toISOString().slice(0, 10);

db.exec(`CREATE TABLE IF NOT EXISTS vintage_baseline (
  kind TEXT PRIMARY KEY,   -- tx | rent | project | developer
  taken_on TEXT NOT NULL,  -- YYYY-MM-DD: rows without a vintage on this date were stamped as pre-tracking
  rows_stamped INTEGER NOT NULL
)`);

const KINDS: { kind: string; table: string; id: string; baseline: string }[] = [
  { kind: 'tx', table: 'transaction_', id: 'transaction_id', baseline: `'1970-01-01'` },
  { kind: 'rent', table: 'rent_contract', id: 'contract_id', baseline: `'1970-01-01'` },
  { kind: 'developer', table: 'developer', id: 'developer_number', baseline: `'1970-01-01'` },
  { kind: 'project', table: 'project', id: 'project_number',
    baseline: `COALESCE((SELECT MIN(o.observed_at) FROM project_observation o WHERE o.project_number = src.project_number), '1970-01-01')` },
];

const hasBaseline = db.prepare(`SELECT taken_on FROM vintage_baseline WHERE kind = ?`);
const recordBaseline = db.prepare(`INSERT INTO vintage_baseline(kind, taken_on, rows_stamped) VALUES(?, ?, ?)`);
const notes: string[] = [];

const sweep = db.transaction(() => {
  for (const k of KINDS) {
    const base = hasBaseline.get(k.kind) as { taken_on: string } | undefined;
    const value = base ? `'${today}'` : k.baseline;
    const res = db.prepare(`INSERT OR IGNORE INTO vintage(kind, id, first_seen)
      SELECT '${k.kind}', src.${k.id}, ${value} FROM ${k.table} src WHERE src.${k.id} IS NOT NULL`).run();
    if (!base) {
      recordBaseline.run(k.kind, today, res.changes);
      notes.push(`${k.kind} baseline ${res.changes}`);
      console.log(`  ${k.kind.padEnd(9)} baseline taken: ${res.changes.toLocaleString()} rows stamped as pre-tracking`);
    } else {
      if (res.changes) notes.push(`${k.kind} new ${res.changes}`);
      console.log(`  ${k.kind.padEnd(9)} ${res.changes.toLocaleString()} row(s) first seen today (baseline ${base.taken_on})`);
    }
  }
});
console.log(`vintage sweep ${today}`);
sweep();

// Leave a line in today's integrity record if the refresh has already opened one.
if (notes.length) {
  db.prepare(`UPDATE refresh_run SET notes = COALESCE(notes || ' | ', '') || ? WHERE run_date = ?`)
    .run(`vintage: ${notes.join(', ')}`, today);
}
