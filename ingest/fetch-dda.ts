// Pull DLD datasets from the Digital Dubai data platform API (DDA iPaaS) and write them
// as CSVs that `npm run ingest:dld` already understands.
//
// IMPORTANT: the API only accepts requests from inside the UAE. Run this on the Mac.
//
// Credentials: create a file named `.dda.json` in the project root (it is git-ignored):
//   {
//     "base": "https://stg-apis.data.dubai",
//     "appIdentifier": "<x-DDA-SecurityApplicationIdentifier>",
//     "clientId": "<client_id>",
//     "clientSecret": "<client_secret>"
//   }
//
// Usage:
//   npm run fetch:dda -- --health                          check credentials + connectivity
//   npm run fetch:dda -- --probe                           discover which DLD datasets exist
//   npm run fetch:dda -- --fetch <entity> <dataset>        download one dataset to data/dld/
//     [--filter "expr"] [--pageSize 1000] [--max 200000] [--out name.csv]
import fs from 'node:fs';
import path from 'node:path';
import { txKey } from './tx-key';

const CRED_FILE = path.resolve('.dda.json');
if (!fs.existsSync(CRED_FILE)) {
  console.error(`Missing ${CRED_FILE}. Create it with base, appIdentifier, clientId, clientSecret (see comments at the top of ingest/fetch-dda.ts).`);
  process.exit(1);
}
const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
const BASE: string = (cred.base ?? 'https://stg-apis.data.dubai').replace(/\/$/, '');

let token: string | null = null;
let tokenExp = 0;
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
// The gateway occasionally gives up assembling a page of a big table (HTTP 408 "Read timed out"),
// or rate-limits (429), or hiccups (5xx), or the connection drops altogether. Those are transient:
// wait and try again, backing off (about 10 minutes of patience in total), before giving up.
const RETRY_WAITS = [5000, 15000, 40000, 90000, 180000, 300000];

async function getToken(): Promise<string> {
  if (token && Date.now() < tokenExp - 60_000) return token;
  // Tokens last an hour, so a long run renews mid-way — that renewal must survive a network blip too.
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${BASE}/secure/ssis/dubaiai/gatewaytoken/1.0.0/getAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-DDA-SecurityApplicationIdentifier': cred.appIdentifier, Connection: 'close' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: cred.clientId, client_secret: cred.clientSecret }),
        signal: AbortSignal.timeout(30000),
      });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) {
        token = j.access_token;
        tokenExp = Date.now() + (j.expires_in ?? 3600) * 1000;
        return token!;
      }
      if (r.status === 400 || r.status === 401 || r.status === 403) throw new Error(`token request refused (${r.status}): ${JSON.stringify(j).slice(0, 300)} — check .dda.json`);
      throw new Error(`token request failed (${r.status})`);
    } catch (e: any) {
      if (/refused/.test(String(e?.message)) || attempt >= RETRY_WAITS.length) throw e;
      console.log(`  token request failed (${e?.message ?? e}) — retrying in ${RETRY_WAITS[attempt] / 1000}s (${attempt + 1}/${RETRY_WAITS.length})`);
      await sleep(RETRY_WAITS[attempt]);
    }
  }
}
async function api(pathname: string, params: Record<string, string | number> = {}) {
  const t = await getToken();
  const u = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    let status = 0, text = '';
    try {
      // 'Connection: close' — one fresh TCP connection per request. A kept-alive connection to the gateway
      // can go half-dead after a timeout, after which every reuse hangs until our own 60s abort ("network").
      const r = await fetch(u, { headers: { Authorization: `Bearer ${t}`, Connection: 'close' }, signal: AbortSignal.timeout(60000) });
      status = r.status; text = await r.text();
    } catch (e: any) {
      status = 0; text = String(e?.message ?? e);
    }
    // A 200 whose body does not parse is a truncated or corrupted download, not an empty page: retry it.
    let parsed: any = null, broken = false;
    if (status === 200) { try { parsed = JSON.parse(text); } catch { broken = true; } }
    const transient = status === 0 || status === 408 || status === 429 || status >= 500 || broken;
    if (transient && attempt < RETRY_WAITS.length) {
      if (broken) console.log(`  truncated response on ${params.page ? 'page ' + params.page : pathname.split('/').pop()} (${text.length.toLocaleString()} bytes) — retrying in ${RETRY_WAITS[attempt] / 1000}s (${attempt + 1}/${RETRY_WAITS.length})`);
      else
      console.log(`  ${status || 'network'} on ${params.page ? 'page ' + params.page : pathname.split('/').pop()} — retrying in ${RETRY_WAITS[attempt] / 1000}s (${attempt + 1}/${RETRY_WAITS.length})`);
      await sleep(RETRY_WAITS[attempt]);
      continue;
    }
    if (broken) return { status: 0, body: { raw: text.slice(0, 300) } }; // still broken after all retries: report as a failure, never as "no rows"
    let j: any = parsed; if (j == null) { try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; } }
    return { status, body: j };
  }
}

const csvEsc = (v: any) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

  if (args.includes('--health')) {
    const h = await api('/secure/ddads/healthcheck/1.0.0/health');
    console.log(h.status, JSON.stringify(h.body, null, 1));
    return;
  }

  if (args.includes('--probe')) {
    // Dataset naming follows '<entity>_<name>-open-api' (per the ICD's own error example).
    // Try the DLD datasets the portal publishes; print whichever respond.
    const candidates: [string, string][] = [];
    const names = ['transactions', 'rent_contracts', 'projects', 'developers', 'units', 'buildings', 'brokers', 'offices', 'valuation', 'land_registry', 'oa_service_charges', 'free_zones', 'map_requests', 'real_estate_permits', 'valuator_licensing', 'lkp_areas'];
    for (const n of names) candidates.push(['dld', `dld_${n}-open-api`], ['dld', `${n}-open-api`], ['dld', n]);
    const found: string[] = [];
    for (const [e, d] of candidates) {
      const r = await api(`/secure/ddads/openapi/1.0.0/${e}/${d}`, { limit: 1 });
      const ok = r.status === 200 && (r.body?.results || Array.isArray(r.body));
      console.log(`${ok ? 'FOUND ' : '  --  '} ${e}/${d} (${r.status}${r.body?.message ? ': ' + String(r.body.message).slice(0, 80) : ''})`);
      if (ok) {
        found.push(`${e}/${d}`);
        const row = r.body?.results?.[0] ?? (Array.isArray(r.body) ? r.body[0] : null);
        if (row) console.log('        columns:', Object.keys(row).join(', ').slice(0, 300));
      }
      await sleep(1100); // 60 req/min rate limit
    }
    console.log(`\nprobe done. Found: ${found.length ? found.join(' · ') : 'none — the granted dataset names may differ; check the portal profile page for the exact names and pass them to --fetch.'}`);
    return;
  }

  const fi = args.indexOf('--fetch');
  if (fi >= 0) {
    const entity = args[fi + 1], dataset = args[fi + 2];
    if (!entity || !dataset) { console.error('usage: --fetch <entity> <dataset> [--filter expr] [--pageSize n] [--max n] [--out file.csv]'); process.exit(1); }
    const pageSize = Number(flag('--pageSize') ?? 1000);
    const max = Number(flag('--max') ?? 500000);
    const filter = flag('--filter');
    const outName = flag('--out') ?? `${dataset.replace(/[^a-z0-9_]+/gi, '_')}.csv`;
    const outDir = path.resolve('data/dld'); fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, outName);
    let page = 1, total = 0, headers: string[] | null = null;
    const ws = fs.createWriteStream(outPath);
    for (;;) {
      const params: Record<string, string | number> = { page, pageSize };
      if (filter) params.filter = filter;
      const r = await api(`/secure/ddads/openapi/1.0.0/${entity}/${dataset}`, params);
      if (r.status === 204) break;
      if (r.status !== 200) { console.error(`page ${page}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); break; }
      const rows: any[] = r.body?.results ?? (Array.isArray(r.body) ? r.body : []);
      if (!rows.length) break;
      if (!headers) { headers = Object.keys(rows[0]); ws.write(headers.join(',') + '\n'); }
      for (const row of rows) ws.write(headers.map(h => csvEsc(row[h])).join(',') + '\n');
      total += rows.length;
      process.stdout.write(`\rpage ${page} · ${total.toLocaleString()} rows`);
      if (rows.length < pageSize || total >= max) break;
      page++;
      await sleep(1100); // stay under 60 req/min
    }
    ws.end();
    console.log(`\nwrote ${total.toLocaleString()} rows → ${outPath}`);
    if (total) console.log('Next: npm run ingest:dld && npm run derive && npm run build');
    return;
  }

  if (args.includes('--refresh')) { await refresh(); return; }

  console.log('usage: npm run fetch:dda -- --health | --probe | --refresh | --fetch <entity> <dataset> [options]');
}

// ---------------- daily refresh ----------------
// Transactions and rents are appended to the database incrementally (ordered newest-first,
// stopping at the last watermark). The small registers (projects, developers, service charges)
// are re-downloaded whole for `ingest:dld --only` to re-read — that daily re-read is what
// accumulates the delay history.
const normArea = (v: any) => String(v ?? '').trim().toLowerCase().replace(/\b[a-z]/g, (c: string) => c.toUpperCase()) || 'Unknown';
const pnum = (v: any) => { if (v == null || v === '') return null; const n = Number(String(v).trim()); return Number.isFinite(n) ? String(Math.trunc(n)) : String(v).trim(); };
const normRooms = (v: any) => { const s = String(v ?? '').trim(); const m = s.match(/^(\d+)\s*bed/i); if (m) return `${m[1]} B/R`; if (/^studio/i.test(s)) return 'Studio'; return s || null; };
const num = (v: any) => (v === '' || v == null ? null : Number(String(v).replace(/,/g, '')));
const iso = (v: any) => (v ? String(v).trim().slice(0, 10) : null);
const STATE = path.resolve('data/dda-state.json');

async function firstRow(dataset: string) {
  const r = await api(`/secure/ddads/openapi/1.0.0/dld/${dataset}`, { limit: 1 });
  return r.status === 200 ? r.body?.results?.[0] ?? null : null;
}

async function* newestFirst(dataset: string, orderCol: string, cutoff: string, pageSize = 1000, maxPages = 400) {
  for (let page = 1; page <= maxPages; page++) {
    const r = await api(`/secure/ddads/openapi/1.0.0/dld/${dataset}`, { page, pageSize, order_by: orderCol, order_dir: 'desc' });
    if (r.status !== 200) { if (page === 1) throw new Error(`${dataset}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); break; }
    const rows: any[] = r.body?.results ?? [];
    if (!rows.length) break;
    let past = false;
    for (const row of rows) {
      if (String(row[orderCol] ?? '') < cutoff) { past = true; break; }
      yield row;
    }
    if (past || rows.length < pageSize) break;
    await sleep(1100);
  }
}

// ---- Day-sliced pulls ----
// Sorting the whole table server-side ("newest first") times out once we page past ~10,000 rows.
// Asking for one day at a time (filter=<date column>=<day>) keeps every request shallow and fast.
// The ICD does not spell out the filter syntax, so the first call tries the plausible forms and
// keeps whichever one returns rows that all carry the requested day.
type FilterForm = (c: string, v: string) => string;
// Quoted equality is the form the gateway accepted for transactions (instance_date='YYYY-MM-DD'),
// so it is tried first; the others are fallbacks in case another dataset is typed differently.
const FILTER_FORMS: FilterForm[] = [
  (c, v) => `${c}='${v}'`, (c, v) => `${c}=${v}`, (c, v) => `${c}=="${v}"`, (c, v) => `${c}=='${v}'`, (c, v) => `${c}:${v}`, (c, v) => `${c} eq '${v}'`, (c, v) => `${c} LIKE '${v}%'`,
];
const filterForm = new Map<string, FilterForm>();
let lastGoodForm: FilterForm | null = null;
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayStr(new Date(Date.parse(day) + n * 86400000));
// Find a filter syntax that really filters: the rows that come back must all carry the requested value.
// (An ignored filter returns the unfiltered first page, which fails that check.)
async function detectFilterValue(dataset: string, col: string, sample: string, key = dataset): Promise<FilterForm | null> {
  if (filterForm.has(key)) return filterForm.get(key)!;
  const forms = lastGoodForm ? [lastGoodForm, ...FILTER_FORMS.filter(f => f !== lastGoodForm)] : FILTER_FORMS;
  for (const f of forms) {
    const r = await api(`/secure/ddads/openapi/1.0.0/dld/${dataset}`, { pageSize: 5, filter: f(col, sample) });
    const rows: any[] = r.status === 200 ? (r.body?.results ?? []) : [];
    await sleep(1100);
    if (rows.length && rows.every(x => String(x[col] ?? '').slice(0, sample.length) === sample)) {
      filterForm.set(key, f); lastGoodForm = f;
      return f;
    }
  }
  return null;
}
async function detectFilter(dataset: string, col: string): Promise<FilterForm | null> {
  if (filterForm.has(dataset)) return filterForm.get(dataset)!;
  // Try a few recent days so a weekend with no registrations does not fool the detection.
  for (let back = 2; back <= 8; back++) {
    const f = await detectFilterValue(dataset, col, addDays(dayStr(new Date()), -back));
    if (f) { console.log(`${dataset}: day filter works as "${f(col, 'YYYY-MM-DD')}"`); return f; }
  }
  return null;
}
// Yields every row of every day, plus one { $day, ok, n } marker after each day so the consumer knows
// whether that day came back complete (only then may missing rows be treated as withdrawn).
type DayMark = { $day: string; ok: boolean; n: number };
async function* daySlices(dataset: string, col: string, fromDay: string, toDay: string, pageSize = 1000): AsyncGenerator<any | DayMark> {
  const f = await detectFilter(dataset, col);
  if (!f) throw new Error(`${dataset}: could not find a working filter syntax for ${col}`);
  const days = Math.round((Date.parse(toDay) - Date.parse(fromDay)) / 86400000) + 1;
  let d = 0, failedInARow = 0;
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    d++;
    let n = 0, failed = false;
    for (let page = 1; page <= 200; page++) {
      const r = await api(`/secure/ddads/openapi/1.0.0/dld/${dataset}`, { page, pageSize, filter: f(col, day) });
      if (r.status !== 200 && r.status !== 204) { console.log(`  ${day}: ${r.status ? 'HTTP ' + r.status : 'no connection'} on page ${page} — skipping the rest of this day`); failed = true; break; }
      const rows: any[] = r.status === 200 ? (r.body?.results ?? []) : [];
      n += rows.length;
      for (const row of rows) yield row;
      await sleep(1100);
      if (rows.length < pageSize) break;
    }
    console.log(`  ${day}: ${n.toLocaleString()} rows (day ${d} of ${days})`);
    yield { $day: day, ok: !failed, n } as DayMark;
    // Three days in a row with nothing but errors means the gateway (or the connection) is down, not a bad page.
    // Stop the run cleanly rather than grinding through the remaining days; the rolling window re-pulls them next time.
    failedInARow = failed ? failedInARow + 1 : 0;
    if (failedInARow >= 3) throw new Error(`${dataset}: the API has been unreachable for three days' worth of requests — giving up this run. The next run re-pulls everything from ${fromDay}.`);
  }
}
const tick = (s: string) => { if (process.stdout.isTTY) process.stdout.write(`\r${s}`); };

// Re-download a register whole. The file on disk is only replaced when the download ended cleanly
// (the gateway said "no more rows") — a table cut short by a timeout must never overwrite a complete
// register, or projects would silently drop out of the delay history.
// Big tables (service charges, ~90k rows) are pulled in slices — one budget year per pass — because
// paging deep into an unsliced table is what the gateway times out on.
async function dumpWhole(dataset: string, outName: string, requireCols: string[], minRows = 0, slice?: { col: string; values: string[] }): Promise<number> {
  const probe = await firstRow(dataset);
  if (!probe) { console.log(`${dataset}: empty or unavailable — keeping the existing file`); return 0; }
  const missing = requireCols.filter(c => !(c in probe));
  if (missing.length) { console.log(`${dataset}: missing columns [${missing.join(', ')}] — NOT replacing ${outName} (the Dropbox file stays authoritative)`); return 0; }
  const headers = Object.keys(probe);
  const outDir = path.resolve('data/dld'); fs.mkdirSync(outDir, { recursive: true });
  const tmp = path.join(outDir, outName + '.tmp');
  const ws = fs.createWriteStream(tmp);
  ws.write(headers.join(',') + '\n');
  let total = 0, clean = true;
  // Which filters to run: one per slice value when a working filter syntax is found, otherwise a single unfiltered pass.
  let passes: (string | undefined)[] = [undefined];
  if (slice) {
    const f = await detectFilterValue(dataset, slice.col, String(probe[slice.col] ?? ''), `${dataset}#${slice.col}`);
    if (f) { passes = slice.values.map(v => f(slice.col, v)); console.log(`${dataset}: pulling in ${passes.length} slices by ${slice.col}`); }
    else console.log(`${dataset}: no working filter for ${slice.col} — pulling in one pass`);
  }
  outer: for (const filter of passes) {
    for (let page = 1; ; page++) {
      const params: Record<string, string | number> = { page, pageSize: 1000 };
      if (filter) params.filter = filter;
      const r = await api(`/secure/ddads/openapi/1.0.0/dld/${dataset}`, params);
      if (r.status !== 200 && r.status !== 204) { console.log(`${dataset}: HTTP ${r.status} on page ${page}${filter ? ' of ' + filter : ''} — download incomplete`); clean = false; break outer; }
      const rows: any[] = r.status === 200 ? (r.body?.results ?? []) : [];
      for (const row of rows) ws.write(headers.map(h => csvEsc(row[h])).join(',') + '\n');
      total += rows.length;
      tick(`${dataset}: ${total.toLocaleString()} rows…`);
      if (rows.length < 1000) break;
      await sleep(1100);
    }
    if (filter) await sleep(1100);
  }
  await new Promise(res => ws.end(res));
  tick('');
  if (!clean) { fs.unlinkSync(tmp); console.log(`${dataset}: keeping the existing ${outName} (the download stopped at ${total.toLocaleString()} rows)`); return 0; }
  // Read back what was written: the line count must match the rows received and the file must carry no NUL bytes
  // (a silently dropped chunk on a network drive shows up as a run of zeros with the right file length).
  const written = fs.readFileSync(tmp);
  const lines = written.reduce((c, b) => c + (b === 10 ? 1 : 0), 0) - 1;
  if (lines < total || written.includes(0)) { fs.unlinkSync(tmp); console.log(`${dataset}: the file on disk does not match what was downloaded (${lines.toLocaleString()} lines for ${total.toLocaleString()} rows${written.includes(0) ? ', zero bytes present' : ''}) — keeping the existing ${outName}`); return 0; }
  if (total >= Math.max(1, minRows)) { fs.renameSync(tmp, path.join(outDir, outName)); console.log(`${dataset}: ${total.toLocaleString()} rows → data/dld/${outName}`); }
  else { fs.unlinkSync(tmp); console.log(`${dataset}: only ${total.toLocaleString()} rows (need ${minRows}) — the API copy looks like sample/staging data, keeping the existing ${outName}`); }
  return total;
}

async function refresh() {
  const dbPath = path.resolve('data/portal.db');
  if (!fs.existsSync(dbPath)) { console.error('No data/portal.db — run the full pipeline once first (npm run go).'); process.exit(1); }
  const { openDb } = await import('./db');
  const db = openDb(); // applies schema additions (vintage, refresh_run, date index) if missing
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const todayIso = daysAgo(0);
  const stamp = todayIso.replace(/-/g, '');
  const startedAt = new Date().toISOString();
  const run = { tx_fetched: 0, tx_new: 0, tx_withdrawn: 0, tx_days_failed: 0, rent_fetched: 0, rent_new: 0, notes: [] as string[] };
  const saveRun = () => db.prepare(`INSERT INTO refresh_run(run_date,started_at,finished_at,tx_fetched,tx_new,tx_withdrawn,tx_days_failed,rent_fetched,rent_new,notes)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_date) DO UPDATE SET finished_at=excluded.finished_at, tx_fetched=excluded.tx_fetched, tx_new=excluded.tx_new, tx_withdrawn=excluded.tx_withdrawn,
    tx_days_failed=excluded.tx_days_failed, rent_fetched=excluded.rent_fetched, rent_new=excluded.rent_new, notes=excluded.notes`)
    .run(todayIso, startedAt, new Date().toISOString(), run.tx_fetched, run.tx_new, run.tx_withdrawn, run.tx_days_failed, run.rent_fetched, run.rent_new, run.notes.join(' | ') || null);
  const vintage = db.prepare(`INSERT OR IGNORE INTO vintage(kind,id,first_seen) VALUES(?,?,?)`);

  // ---- transactions (incremental) ----
  {
    const probe = await firstRow('dld_transactions-open-api');
    if (!probe) throw new Error('transactions dataset unreachable');
    // Rolling window: re-pull the last WINDOW days of transaction dates every run. Off-plan sales are
    // often registered weeks after their instance_date, so a pure "since last run" pull would miss them;
    // the duplicate check makes re-pulling cheap and safe.
    const WINDOW_TX = 45;
    const today = daysAgo(0);
    const fromDay = daysAgo(WINDOW_TX);
    const orderCol = 'instance_date';
    console.log(`transactions: day by day, ${fromDay} .. ${today}`);
    // Identity is the canonical transaction number and NOTHING else (ingest/tx-key.ts), looked up on the
    // unique tx_key index. The API dates a sale registered from about 16:00 to the next working day, while
    // the register's own screen and the website export date it to the day it happened, so a check that
    // compared dates stored the same sale twice — that is what inflated June-August 2026 by 30-40%.
    // Never put instance_date, or any amount, back into this lookup.
    const heldByKey = db.prepare(`SELECT transaction_id, building_name_en, project_number, project_name_en, rooms_en,
      procedure_area, meter_sale_price FROM transaction_ WHERE tx_key=?`);
    // A row we already hold from the thinner website export keeps its (correct) date and amount and gains the
    // names the API carries. COALESCE only fills blanks — a value we already have is never overwritten.
    const enrich = db.prepare(`UPDATE transaction_ SET feed_date=COALESCE(feed_date,?),
      building_name_en=COALESCE(building_name_en,?), project_number=COALESCE(project_number,?),
      project_name_en=COALESCE(project_name_en,?), rooms_en=COALESCE(rooms_en,?),
      procedure_area=COALESCE(procedure_area,?), meter_sale_price=COALESCE(meter_sale_price,?) WHERE transaction_id=?`);
    const ins = db.prepare(`INSERT OR IGNORE INTO transaction_
      (transaction_id, instance_date, trans_group_en, procedure_name_en, reg_type_en, property_type_en,
       property_sub_type_en, property_usage_en, area_name_en, building_name_en, project_number, project_name_en,
       rooms_en, procedure_area, actual_worth, meter_sale_price, tx_key, feed_date)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Withdrawal check, per completed day: a sale we hold for that day whose transaction number the register no
    // longer returns has been cancelled or corrected at DLD. It is never deleted — it is marked withdrawn, so the
    // report can show restatements and history stays reproducible. Guards: the day must have come back complete,
    // be at least 3 days old (late loading), and return at least 90% of the rows we hold (a thin day is a bad pull).
    const dayRows = db.prepare(`SELECT transaction_id, tx_key FROM transaction_ WHERE feed_date=?`);
    const goneNow = db.prepare(`INSERT INTO vintage(kind,id,first_seen,withdrawn_on) VALUES('tx',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET withdrawn_on=COALESCE(vintage.withdrawn_on, excluded.withdrawn_on)`);
    const backAgain = db.prepare(`UPDATE vintage SET withdrawn_on=NULL WHERE kind='tx' AND id=? AND withdrawn_on IS NOT NULL`);
    let seen = 0, added = 0, upgraded = 0, withdrawn = 0, unkeyed = 0, hi = fromDay, i = 0;
    let dayKeys = new Set<string>();
    for await (const r of daySlices('dld_transactions-open-api', orderCol, fromDay, today)) {
      if (r && r.$day) {
        const mark = r as DayMark;
        if (!mark.ok) run.tx_days_failed++;
        else if (mark.$day <= daysAgo(3)) {
          // Like for like: rows the feed filed under that day (feed_date) against the transaction numbers
          // the feed returned for it. Comparing instance_date here would report every sale whose date we
          // corrected to the register's own date as a withdrawal.
          const heldRows = dayRows.all(mark.$day) as { transaction_id: string; tx_key: string | null }[];
          if (heldRows.length && mark.n >= 0.9 * heldRows.length) {
            for (const h of heldRows) {
              if (h.tx_key && dayKeys.has(h.tx_key)) backAgain.run(h.transaction_id);
              else { goneNow.run(h.transaction_id, '1970-01-01', todayIso); withdrawn++; }
            }
          } else if (heldRows.length) run.notes.push(`${mark.$day}: register returned ${mark.n} rows against ${heldRows.length} held — withdrawal check skipped`);
        }
        dayKeys = new Set();
        continue;
      }
      seen++; i++;
      const ord = String(r[orderCol] ?? ''); if (ord > hi) hi = ord;
      const tid = String(r.transaction_id ?? '').trim(); if (!tid) continue;
      const s = (v: any) => { const t = String(v ?? '').trim(); return t || null; };
      const key = txKey(tid, s(r.trans_group_en));
      if (!key) { unkeyed++; continue; }   // an unrecognised number shape is reported, never guessed at
      dayKeys.add(key);
      const area = num(r.procedure_area), worth = num(r.actual_worth);
      let psm = num(r.meter_sale_price); if (psm == null && area && worth) psm = Math.round(worth / area);
      const date = iso(r.instance_date);
      const bld = s(r.building_name_en);
      const mine = heldByKey.get(key) as any;
      if (mine) {   // already held from the bulk dump or the website export: fill its blanks, keep its date
        if (mine.building_name_en == null || mine.project_number == null || mine.rooms_en == null || mine.procedure_area == null) upgraded++;
        enrich.run(date, bld, pnum(r.project_number), s(r.project_name_en), s(r.rooms_en), area, psm, mine.transaction_id);
        continue;
      }
      const areaName = normArea(r.area_name_en);
      const reg = /off/i.test(r.reg_type_en || '') ? 'Off-Plan Properties' : r.reg_type_en ? 'Existing Properties' : null;
      const newId = `${tid}#a${stamp}${i}`;
      ins.run(newId, date, s(r.trans_group_en), s(r.procedure_name_en), reg,
        s(r.property_type_en), s(r.property_sub_type_en), s(r.property_usage_en), areaName,
        bld, pnum(r.project_number), s(r.project_name_en), s(r.rooms_en), area, worth, psm, key, date);
      vintage.run('tx', newId, todayIso);
      added++;
    }
    console.log(`transactions: ${seen.toLocaleString()} fetched, ${added.toLocaleString()} new, ${upgraded.toLocaleString()} existing rows filled out${withdrawn ? `, ${withdrawn} withdrawn by the register` : ''}${unkeyed ? `, ${unkeyed} skipped (unreadable number)` : ''}`);
    run.tx_fetched = seen; run.tx_new = added; run.tx_withdrawn = withdrawn;
    if (unkeyed) run.notes.push(`${unkeyed} rows had a transaction number we could not parse`);
    if (hi > (state.tx ?? '')) state.tx = hi;
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); // checkpoint: a later failure must not redo this
    saveRun();
  }

  // ---- rents (incremental; contract_id dedupes naturally) ----
  // A rents failure must not stop the register downloads that follow: log it and carry on.
  try {
    const probe = await firstRow('dld_rent_contracts-open-api');
    if (!probe) throw new Error('rents dataset unreachable');
    const WINDOW_RENT = 30;
    const today = daysAgo(0);
    const fromDay = daysAgo(WINDOW_RENT);
    const orderCol = 'contract_start_date';
    console.log(`rents: day by day, ${fromDay} .. ${today}`);
    const ins = db.prepare(`INSERT OR IGNORE INTO rent_contract VALUES(?,?,?,?,?,?,?,?,?,?)`);
    let seen = 0, added = 0, hi = fromDay;
    for await (const r of daySlices('dld_rent_contracts-open-api', orderCol, fromDay, today, 500)) {
      if (r && r.$day) continue;
      seen++;
      const key = String(r[orderCol] ?? ''); if (key > hi) hi = key;
      const cid = String(r.contract_id ?? '').trim(); if (!cid) continue;
      const res = ins.run(cid, iso(r.contract_start_date), r.contract_reg_type_en || null, num(r.annual_amount), normArea(r.area_name_en),
        r.project_name_en || null, pnum(r.project_number), r.ejari_property_type_en || null, normRooms(r.ejari_property_sub_type_en ?? r.rooms_en ?? r.rooms), num(r.actual_area));
      if (res.changes) { vintage.run('rent', cid, todayIso); added++; }
    }
    console.log(`rents: ${seen.toLocaleString()} fetched, ${added.toLocaleString()} new`);
    run.rent_fetched = seen; run.rent_new = added;
    if (hi > (state.rent ?? '')) state.rent = hi;
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    saveRun();
  } catch (e: any) {
    console.log(`rents: skipped this run — ${e?.message ?? e}. Sales and registers continue; rents will be retried on the next refresh.`);
    run.notes.push(`rents skipped: ${String(e?.message ?? e).slice(0, 120)}`); saveRun();
  }

  // ---- link fresh rows to projects by name where the number is missing ----
  db.exec(`UPDATE transaction_ SET project_number=(SELECT project_number FROM project p WHERE UPPER(TRIM(p.name_en))=UPPER(TRIM(transaction_.project_name_en))) WHERE (project_number IS NULL OR project_number='') AND project_name_en IS NOT NULL;
           UPDATE rent_contract SET project_number=(SELECT project_number FROM project p WHERE UPPER(p.name_en)=UPPER(rent_contract.project_name_en)) WHERE (project_number IS NULL OR project_number='') AND project_name_en IS NOT NULL;`);
  db.close();

  // ---- small registers: full re-download so ingest:dld --only re-reads them ----
  // projects.csv is only replaced when the API version carries the delay-tracking columns
  // AND the area name — otherwise the delay history would be polluted / areas wrecked.
  // A register that shrinks dramatically is staging/sample data, not the register — never let it replace the real file.
  const projRows = await dumpWhole('dld_projects-open-api', 'projects.csv', ['project_number', 'project_status', 'percent_completed', 'area_name_en'], 2000);
  if (projRows) {
    // Note the register's own extraction stamp so the report can say how fresh (or stale) the register feed is.
    const head = fs.readFileSync(path.resolve('data/dld/projects.csv'), 'utf8').split('\n', 3);
    const cols = head[0].split(','); const li = cols.indexOf('load_timestamp');
    const stampVal = li >= 0 && head[1] ? head[1].split(',')[li]?.slice(0, 10) : null;
    const db2 = openDb(); db2.prepare(`UPDATE refresh_run SET register_rows=?, register_stamp=? WHERE run_date=?`).run(projRows, stampVal, todayIso); db2.close();
    if (stampVal) console.log(`register feed extraction date: ${stampVal}`);
  }
  await dumpWhole('dld_developers-open-api', 'developers.csv', ['developer_number', 'developer_name_en'], 1500);
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear + 2 - 2015 }, (_, i) => String(2015 + i)); // 2015 .. next year
  await dumpWhole('dld_oa_service_charges-open-api', 'service_charges.csv', ['project_name', 'budget_year'], 20000, { col: 'budget_year', values: years });

  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  console.log(`\nrefresh done. Watermarks saved. Next: npm run ingest:dld -- --only projects,developers,service_charges && npm run derive && npm run build`);
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
