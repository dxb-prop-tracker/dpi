// Apply schema additions to an existing database and report what is tracked. Safe to run any time.
import { openDb } from './db';
const db = openDb();
const v = db.prepare(`SELECT kind, COUNT(*) n, MIN(first_seen) lo, MAX(first_seen) hi FROM vintage GROUP BY kind`).all() as any[];
console.log('schema up to date. vintages:', v.length ? v.map(x => `${x.kind} ${x.n.toLocaleString()} (${x.lo} → ${x.hi})`).join(' · ') : 'none yet');
db.close();
