// Invariants the data must satisfy. Runs at the end of every refresh (npm run check), and fails the
// run loudly if any of them breaks, because the alternative is finding out from a reader.
//
// It exists because of the June-August 2026 duplication: the same sale arrived from two feeds under two
// different dates, our duplicate check compared dates, and the site over-counted sales by 30-40% for
// three months. Nothing here is clever; it is the set of statements that were quietly false back then.
import { openDb } from './db';
import { txKey, txNumber } from './tx-key';

let failed = 0, warned = 0;
const ok = (name: string, detail = '') => console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name: string, detail: string) => { failed++; console.log(`  FAIL  ${name} — ${detail}`); };
const warn = (name: string, detail: string) => { warned++; console.log(`  warn  ${name} — ${detail}`); };

// 1. The key itself: the three feeds write one sale three ways and must land on one key.
const BURJ = ['1-11-2026-26618', '11-26618-2026', '1-11-2026-26618#a2026090323965', 'w#11-26618-2026#1'];
const keys = new Set(BURJ.map(id => txKey(id, 'Sales')));
if (keys.size === 1 && [...keys][0] === '11|2026|26618|Sales') ok('transaction key', `all four id shapes → ${[...keys][0]}`);
else bad('transaction key', `expected one key, got ${[...keys].join(' / ')}`);
if (txNumber('w#11-26618-2026#1') === '11-26618-2026' && txNumber('1-11-2026-26618#a123') === '1-11-2026-26618') ok('number parsing');
else bad('number parsing', 'suffix stripping is wrong');
if (txKey('1-11-2026-26618', 'Sales') !== txKey('2-11-2026-26618', 'Mortgages')) ok('groups stay apart', 'a sale and a mortgage of the same serial are two things');
else bad('groups stay apart', 'sale and mortgage collapse onto one key');
if (txKey('nonsense', 'Sales') === null) ok('unreadable numbers rejected', 'never guessed at');
else bad('unreadable numbers rejected', 'txKey invented a key');

const db = openDb(true);

// 2. No sale stored twice, and the index that guarantees it is actually there.
const dup = db.prepare(`SELECT COUNT(*) n FROM (SELECT tx_key FROM transaction_ WHERE tx_key IS NOT NULL GROUP BY tx_key HAVING COUNT(*)>1)`).get() as any;
dup.n === 0 ? ok('no duplicate transactions') : bad('no duplicate transactions', `${dup.n} transaction numbers appear more than once`);
const idx = db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='ux_tx_key'`).get() as any;
idx.n === 1 ? ok('unique index present', 'ux_tx_key') : bad('unique index present', 'ux_tx_key is missing — duplicates can return');
const unkeyed = db.prepare(`SELECT COUNT(*) n FROM transaction_ WHERE tx_key IS NULL`).get() as any;
unkeyed.n === 0 ? ok('every row keyed') : warn('every row keyed', `${unkeyed.n} rows have no key and are not duplicate-checked`);

// 3. Anchors. Closed months from the bulk register do not move; if one of these changes, something
// upstream rewrote history and every published report is suspect. Cross-checked with Ali's independent
// pull of the DLD public gateway on 10 September 2026.
const anchors: [string, string, number][] = [
  ['Aug 2025 sales', `trans_group_en='Sales' AND instance_date LIKE '2025-08%'`, 18302],
  ['2025 sales', `trans_group_en='Sales' AND instance_date LIKE '2025%'`, 214606],
  ['Jan 2026 sales', `trans_group_en='Sales' AND instance_date LIKE '2026-01%'`, 16883],
  ['Mar 2026 sales', `trans_group_en='Sales' AND instance_date LIKE '2026-03%'`, 13852],
];
for (const [name, where, expect] of anchors) {
  const got = (db.prepare(`SELECT COUNT(*) n FROM transaction_ WHERE ${where}`).get() as any).n;
  got === expect ? ok(name, `${got.toLocaleString()}`) : bad(name, `expected ${expect.toLocaleString()}, found ${got.toLocaleString()}`);
}

// 4. Shape checks on the live months: a month that suddenly runs far above the year's own average is
// the shape the duplication had, and is worth stopping for even when the cause is different.
const months = db.prepare(`SELECT substr(instance_date,1,7) m, COUNT(*) n FROM transaction_
  WHERE trans_group_en='Sales' AND instance_date >= date('now','-13 months') AND instance_date < date('now','start of month')
  GROUP BY 1 ORDER BY 1`).all() as any[];
if (months.length >= 6) {
  const med = [...months.map(r => r.n)].sort((a, b) => a - b)[Math.floor(months.length / 2)];
  const wild = months.filter(r => r.n > med * 1.6);
  wild.length === 0 ? ok('no month out of scale', `median ${med.toLocaleString()} sales`)
    : warn('no month out of scale', `${wild.map(r => `${r.m} ${r.n.toLocaleString()}`).join(', ')} against a median of ${med.toLocaleString()} — check for double counting`);
}

// 5. A sale can only be withdrawn if the register stopped returning it, never because its date moved.
const gone = db.prepare(`SELECT COUNT(*) n FROM vintage v WHERE v.kind='tx' AND v.withdrawn_on IS NOT NULL
  AND EXISTS (SELECT 1 FROM transaction_ t WHERE t.transaction_id=v.id AND t.feed_date IS NULL)`).get() as any;
gone.n === 0 ? ok('withdrawals are real') : bad('withdrawals are real', `${gone.n} rows marked withdrawn that the feed never filed`);

// 6. Every row carries a vintage. Without one we cannot say what our copy of the register held on a past
// date; until 16 September 2026 only 0.5% of transactions had one. ingest/vintage-sweep.ts runs after every
// ingest step, so a gap here means some path now writes rows after the sweep, or the sweep was taken out.
const baselined = (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='vintage_baseline'`).get() as any).n === 1;
if (!baselined) bad('every row has a vintage', 'vintage_baseline is missing — ingest/vintage-sweep.ts has never run');
else {
  const gaps: string[] = [];
  for (const [kind, table, id] of [['tx', 'transaction_', 'transaction_id'], ['rent', 'rent_contract', 'contract_id'],
    ['project', 'project', 'project_number'], ['developer', 'developer', 'developer_number']]) {
    const n = (db.prepare(`SELECT COUNT(*) n FROM ${table} s WHERE s.${id} IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM vintage v WHERE v.kind='${kind}' AND v.id=s.${id})`).get() as any).n;
    if (n) gaps.push(`${n.toLocaleString()} ${kind}`);
  }
  gaps.length === 0 ? ok('every row has a vintage', 'tx, rent, project, developer')
    : bad('every row has a vintage', `${gaps.join(', ')} row(s) without one — run npm run vintage, then find the path that skipped it`);
}

console.log(failed ? `\n${failed} check(s) FAILED${warned ? `, ${warned} warning(s)` : ''} — do not publish this build.`
  : `\nAll checks passed${warned ? `, ${warned} warning(s)` : ''}.`);
process.exit(failed ? 1 : 0);
