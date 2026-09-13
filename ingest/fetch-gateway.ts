// The live DLD register, read from the keyless gateway the Land Department's own open-data page
// uses: POST https://gateway.dubailand.gov.ae/open-data/projects. This is the only CURRENT reading
// of certified progress — the data.dubai API dataset is a stale load (October-2025 content), and
// Ali's xlsx extracts carried no project numbers, so only 466 of 842 rows could be matched by name.
//
//   npm run register:gateway            read the register, store one observation per project,
//                                       dated by the register's own INSPECTION_DATE
//   npm run register:gateway -- --dry   fetch and report, write nothing to the database
//
// Contract (from Ali's collector, verified 13 Sep 2026 from Dubai): JSON body, dates MM/DD/YYYY,
// every P_ field present or the gateway answers with an HTML page; ~1 request per 6 seconds or
// Cloudflare answers instead; the unauthenticated gateway clamps every window to the current
// calendar year, so the widest read is the four date types (1 start, 2 end, 3 adoption,
// 4 completion) over this year, de-duplicated on PROJECT_NUMBER. A project with no 2026 date
// on any of the four is invisible here — that limit is reported, never papered over.
//
// Answers only from inside the UAE. Run on the Mac.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDb, slugify } from './db';

const BASE = 'https://gateway.dubailand.gov.ae/open-data/';
const HEADERS = {
  'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://dubailand.gov.ae', 'Referer': 'https://dubailand.gov.ae/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
const THROTTLE_MS = 6000, TAKE = 500, SOURCE = 'gateway';
const dry = process.argv.includes('--dry');
const today = new Date().toISOString().slice(0, 10);
const year = new Date().getFullYear();
const mdy = (y: number, m: number, d: number) => `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const normArea = (v: any) => String(v ?? '').trim().toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()) || 'Unknown';
const iso = (v: any) => { const s = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

let lastCall = 0;
async function post(command: string, params: Record<string, string>): Promise<{ rows: any[]; total: number | null }> {
  const wait = THROTTLE_MS - (Date.now() - lastCall); if (wait > 0) await sleep(wait);
  for (let attempt = 0; attempt < 3; attempt++) {
    lastCall = Date.now();
    try {
      const r = await fetch(BASE + command, { method: 'POST', headers: HEADERS, body: JSON.stringify(params) });
      const raw = await r.text();
      if (raw.trimStart().startsWith('<')) throw new Error('html error page (throttled or wrong P_ fields)');
      const data = JSON.parse(raw);
      const rows: any[] = data?.response?.result ?? data?.result ?? [];
      const total = rows.length ? Number(rows[0].TOTAL ?? NaN) : 0;
      return { rows, total: Number.isFinite(total) ? total : null };
    } catch (e: any) {
      if (attempt === 2) throw e;
      console.warn(`  ${command}: ${e.message} — retry ${attempt + 1}`); await sleep(THROTTLE_MS * 2);
    }
  }
  throw new Error('unreachable');
}

// One window, all pages. The gateway pages over an unstable sort (Ali, 10 Sep 2026), so a page can
// repeat a row and miss another; we page until a short page, de-duplicate on PROJECT_NUMBER, and
// report distinct rows against the gateway's own TOTAL so a short read is visible, not silent.
async function window(dateType: string) {
  const base = { P_FROM_DATE: mdy(year, 1, 1), P_TO_DATE: mdy(year, 12, 31), P_DATE_TYPE: dateType,
    P_PRJ_TYPE_ID: '', P_PRJ_STATUS: '', P_ZONE_ID: '', P_AREA_ID: '', P_SORT: '' };
  const seen = new Map<string, any>(); let total: number | null = null; let skip = 0; let raw = 0;
  for (let page = 0; page < 200; page++) {
    const { rows, total: t } = await post('projects', { ...base, P_TAKE: String(TAKE), P_SKIP: String(skip) });
    if (t != null) total = t;
    for (const r of rows) seen.set(String(r.PROJECT_NUMBER), r);
    raw += rows.length; skip += rows.length;
    if (rows.length < TAKE) break;
  }
  return { rows: [...seen.values()], total, raw };
}

async function main() {
  const all = new Map<string, any>(); const report: string[] = [];
  for (const dt of ['1', '2', '3', '4']) {
    const w = await window(dt);
    for (const r of w.rows) { const k = String(r.PROJECT_NUMBER); const prev = all.get(k); all.set(k, { ...(prev ?? {}), ...r, _DATE_TYPES: [...(prev?._DATE_TYPES ?? []), dt] }); }
    report.push(`date type ${dt}: ${w.rows.length} distinct of gateway total ${w.total ?? '?'} (${w.raw} raw rows)`);
    if (w.total != null && w.rows.length < 0.9 * w.total) report.push(`  WARNING short window: ${w.rows.length} < 90% of ${w.total}`);
  }
  const rows = [...all.values()];
  console.log(report.join('\n')); console.log(`${rows.length} distinct projects across the four windows`);
  fs.mkdirSync('data/register', { recursive: true });
  const snap = path.join('data/register', `gateway-${today}.json.gz`);
  fs.writeFileSync(snap, zlib.gzipSync(JSON.stringify({ fetchedAt: new Date().toISOString(), year, rows })));
  console.log(`snapshot ${snap}`);
  if (dry) return;

  const db = openDb();
  const known = db.prepare(`SELECT 1 FROM project WHERE project_number=?`);
  const slugTaken = db.prepare(`SELECT 1 FROM project WHERE area_slug=? AND slug=? AND project_number<>?`);
  const insProj = db.prepare(`INSERT OR IGNORE INTO project(project_number,name_en,slug,area_name_en,area_slug,developer_number,master_project_en,escrow_agent_en,project_start_date,project_value,units,villas,buildings) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insDev = db.prepare(`INSERT OR IGNORE INTO developer(developer_number,name_en,slug) VALUES(?,?,?)`);
  const insObs = db.prepare(`INSERT OR IGNORE INTO project_observation(project_number,observed_at,status,percent_completed,completion_date,source) VALUES(?,?,?,?,?,?)`);
  const insSeen = db.prepare(`INSERT OR IGNORE INTO vintage(kind,id,first_seen) VALUES('project',?,?)`);
  let newProjects = 0, obs = 0, undatedInspection = 0, overHundred = 0;
  db.transaction(() => {
    for (const r of rows) {
      const pn = String(r.PROJECT_NUMBER); const dev = r.DEVELOPER_NUMBER != null ? String(r.DEVELOPER_NUMBER) : null;
      if (dev && r.DEVELOPER_EN) insDev.run(dev, String(r.DEVELOPER_EN).trim(), slugify(String(r.DEVELOPER_EN)) || dev);
      if (!known.get(pn)) {
        const name = String(r.PROJECT_EN ?? pn).trim(); const area = normArea(r.AREA_EN); const areaSlug = slugify(area) || 'unknown';
        let slug = slugify(name) || pn; if (slugTaken.get(areaSlug, slug, pn)) slug = `${slug}-${pn}`;
        // Unit counts from the gateway are doubled on finished towers (Ali's audit); the register
        // extract carries the right ones. A new project here is by definition not in the extract, so
        // take the gateway's count only while the tower is unfinished, and leave it blank otherwise.
        const finished = String(r.PROJECT_STATUS ?? '').toUpperCase() === 'FINISHED';
        insProj.run(pn, name, slug, area, areaSlug, dev, r.MASTER_PROJECT_EN || null, null, iso(r.START_DATE), r.PROJECT_VALUE ?? null,
          finished ? null : (r.CNT_UNIT ?? null), finished ? null : (r.CNT_VILLA ?? null), r.CNT_BUILDING ?? null);
        insSeen.run(pn, today); newProjects++;
      }
      // The reading is dated by the register's own inspection date — the day an inspector certified
      // the percentage — not by the day we happened to download it. No inspection date: dated today,
      // counted, and reported, because a reading we cannot date is a reading we should not trust silently.
      const when = iso(r.INSPECTION_DATE) ?? today; if (!iso(r.INSPECTION_DATE)) undatedInspection++;
      const completion = iso(r.COMPLETION_DATE) ?? iso(r.END_DATE);
      // The gateway's certified % can be a per-building SUM (Jouri Hills reads 222.6%), not a
      // percentage. Above 100 it is not a reading: the status and dates are kept, the percentage is
      // not (Ali's audit rule, 13 Sep 2026 — never cap it to 100, that would invent a number).
      let pct: number | null = r.PERCENT_COMPLETED == null ? null : Number(r.PERCENT_COMPLETED);
      if (pct != null && (!Number.isFinite(pct) || pct > 100)) { pct = null; overHundred++; }
      obs += insObs.run(pn, when, r.PROJECT_STATUS ?? null, pct, completion, SOURCE).changes;
    }
  })();
  db.close();
  console.log(`${newProjects} projects new to the database, ${obs} new observations (source '${SOURCE}'), ${undatedInspection} rows had no inspection date and were dated today, ${overHundred} rows carried a certified % above 100 and were stored without one`);
  console.log('Now run: npm run issuer:data && npm run credit:books');
}
main().catch(e => { console.error(e); process.exit(1); });
