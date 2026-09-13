// One-off repair (safe to re-run): early ingests stamped register observations with the
// date the script RAN, not the date the register data was extracted (its load_timestamp).
// Re-reading an old register file therefore created "newer" readings of older data —
// e.g. a June register reading dated 31 Aug, sitting after a genuine 30 Aug reading and
// making finished projects look like they regressed.
//
// This deletes every register-sourced ('dld') observation and lets the fixed loader
// recreate them correctly dated from the file itself. Observations from other sources
// (Ali's register extracts, the API) are untouched.
//
// Usage: npm run fix:obs   (chains into `ingest:dld --only projects` automatically)

import { openDb } from './db';

const db = openDb();
const before = (db.prepare(`SELECT COUNT(*) c FROM project_observation WHERE source='dld'`).get() as any).c;
db.prepare(`DELETE FROM project_observation WHERE source='dld'`).run();
console.log(`Removed ${before} run-date-stamped register observations; re-ingesting the register with true dates...`);
db.close();
