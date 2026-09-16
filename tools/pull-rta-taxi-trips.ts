// Pull RTA's monthly taxi fleet and trips by operator from the Digital Dubai data platform and write it,
// with a manifest, to data/exports/rta_monthly_taxi_trips.csv for the DTC engine in salik-nowcast.
//
// This is not DLD data and nothing in dpi reads it. It lives here because dpi holds the .dda.json credentials
// and runs on the Mac, and the API only answers from inside the UAE.
//
// The file is what the API returned, nothing more: months RTA has not published are absent, never filled.
// The manifest lists which months carry a Dubai Taxi row, so a gap is visible without opening the CSV.
// A failed or short download never replaces the previous export.
//
// Usage:  npm run pull:rta
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENTITY = 'rta';
const DATASET = 'rta_taxis_and_number_of_trips_by_carrier_company_month-open-api';
const COLUMNS = ['report_date', 'fleet_name', 'fleet_size', 'trips_num', 'load_timestamp'];
const OUT = path.resolve('data/exports/rta_monthly_taxi_trips.csv');
const MANIFEST = OUT.replace(/\.csv$/, '.manifest.json');
const MIN_ROWS = 300; // ~7 years of monthly rows over several operators; far fewer means staging or a truncated pull

const CRED_FILE = path.resolve('.dda.json');
if (!fs.existsSync(CRED_FILE)) { console.error(`Missing ${CRED_FILE} — see ingest/fetch-dda.ts`); process.exit(1); }
const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
const BASE: string = (cred.base ?? 'https://stg-apis.data.dubai').replace(/\/$/, '');
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const WAITS = [5000, 15000, 40000, 90000];

async function token(): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}/secure/ssis/dubaiai/gatewaytoken/1.0.0/getAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-DDA-SecurityApplicationIdentifier': cred.appIdentifier, Connection: 'close' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: cred.clientId, client_secret: cred.clientSecret }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    const j: any = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok && j.access_token) return j.access_token;
    // Never echo the response body: a refused token request is reported by status only.
    if (r && [400, 401, 403].includes(r.status)) throw new Error(`token request refused (HTTP ${r.status}) — check .dda.json`);
    if (attempt >= WAITS.length) throw new Error(`token request failed (${r ? 'HTTP ' + r.status : 'no connection'})`);
    await sleep(WAITS[attempt]);
  }
}

async function page(t: string, n: number): Promise<any[]> {
  const u = new URL(`${BASE}/secure/ddads/openapi/1.0.0/${ENTITY}/${DATASET}`);
  u.searchParams.set('page', String(n)); u.searchParams.set('pageSize', '1000');
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${t}`, Connection: 'close' }, signal: AbortSignal.timeout(60000) }).catch(() => null);
    const status = r?.status ?? 0;
    if (status === 204) return [];
    if (status === 200) {
      const body: any = await r!.json().catch(() => null);
      if (body && Array.isArray(body.results)) return body.results;
    }
    if (attempt >= WAITS.length) throw new Error(`page ${n}: ${status ? 'HTTP ' + status : 'no connection'} after ${WAITS.length} retries`);
    console.log(`  page ${n}: ${status ? 'HTTP ' + status : 'no connection'} — retry ${attempt + 1}/${WAITS.length}`);
    await sleep(WAITS[attempt]);
  }
}

const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function main() {
  const t = await token();
  const rows: any[] = [];
  for (let n = 1; n <= 50; n++) {
    const got = await page(t, n);
    rows.push(...got);
    if (got.length < 1000) break;
    await sleep(1100);
  }
  if (rows.length < MIN_ROWS) throw new Error(`only ${rows.length} rows (need ${MIN_ROWS}) — keeping the previous export`);
  const missing = COLUMNS.filter(c => !(c in rows[0]));
  if (missing.length) throw new Error(`columns missing from the API: ${missing.join(', ')} — keeping the previous export`);

  // Every row the API returns is kept. RTA has restated some operator-months by loading a second row beside the
  // original; both stay, keyed by load_timestamp, so a model can read the figure as it stood on a given date.
  const seen = new Set<string>();
  const perMonth = new Map<string, number>();
  const out = rows.map(r => {
    const month = String(r.report_date).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`unparseable report_date ${JSON.stringify(r.report_date)}`);
    const fleet = String(r.fleet_name).trim();
    const key = `${month}|${fleet}|${r.load_timestamp}`;
    if (seen.has(key)) throw new Error(`duplicate row for ${key}`);
    seen.add(key);
    perMonth.set(`${month}|${fleet}`, (perMonth.get(`${month}|${fleet}`) ?? 0) + 1);
    return { ...r, month, fleet_name: fleet };
  }).sort((a, b) => (a.month + a.fleet_name + a.load_timestamp).localeCompare(b.month + b.fleet_name + b.load_timestamp));
  const restated = [...perMonth.values()].filter(n => n > 1).length;
  const csv = ['month,fleet_name,fleet_size,trips_num,load_timestamp']
    .concat(out.map(r => [r.month, r.fleet_name, r.fleet_size, r.trips_num, r.load_timestamp].map(esc).join(',')))
    .join('\n') + '\n';

  const dubaiTaxiMonths = out.filter(r => /^dubai taxi/i.test(String(r.fleet_name).trim())).map(r => r.month).sort();
  const first = dubaiTaxiMonths[0], last = dubaiTaxiMonths[dubaiTaxiMonths.length - 1];
  const absent: string[] = [];
  for (let d = new Date(first + '-01T00:00:00Z'); d.toISOString().slice(0, 7) <= last; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const m = d.toISOString().slice(0, 7);
    if (!dubaiTaxiMonths.includes(m)) absent.push(m);
  }
  const manifest = {
    dataset: `${ENTITY}/${DATASET}`,
    source: 'Digital Dubai data platform (RTA)',
    pulled_at: new Date().toISOString(),
    rows_received: rows.length,
    rows_written: out.length,
    operator_months_restated: restated,
    key: ['month', 'fleet_name', 'load_timestamp'],
    dubai_taxi: { first_month: first, last_month: last, months_absent: absent },
    latest_load_timestamp: out.map(r => String(r.load_timestamp)).sort().pop(),
    sha256: crypto.createHash('sha256').update(csv).digest('hex'),
    note: 'Months RTA has not published are absent from the CSV and listed under months_absent. Nothing is filled.',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + '.tmp', csv);
  fs.renameSync(OUT + '.tmp', OUT);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`RTA taxi trips: ${out.length} rows (${restated} operator-months restated, all versions kept); Dubai Taxi ${first}..${last}, ${absent.length} months absent → ${path.relative(process.cwd(), OUT)}`);
}

main().catch(e => { console.error(`pull:rta failed: ${e?.message ?? e}`); process.exit(1); });
