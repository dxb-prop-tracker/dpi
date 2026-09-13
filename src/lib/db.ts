// Build-time data access. Every page runs its own scoped query; nothing ships the whole dataset.
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const db = new Database(path.resolve(process.cwd(), 'data/portal.db'), { readonly: true });

export const q = {
  // Areas come from BOTH the project register and the transaction file, so an area with sales but no
  // 2026-registered project still gets a page.
  areas: () => db.prepare(`
    SELECT name, slug, SUM(projects) AS projects FROM (
      SELECT area_name_en AS name, area_slug AS slug, COUNT(*) AS projects FROM project GROUP BY area_slug
      UNION ALL
      SELECT area_name_en AS name, lower(replace(replace(replace(replace(area_name_en,' ','-'),'''','-'),'.','-'),'--','-')) AS slug, 0 FROM transaction_ WHERE area_name_en IS NOT NULL GROUP BY area_name_en
    ) GROUP BY slug ORDER BY name`).all() as any[],
  txProjectsInArea: (name: string) => db.prepare(`
    SELECT t.project_name_en AS project, p.slug AS project_slug, COUNT(*) AS n,
      SUM(CASE WHEN t.reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END) AS offplan,
      ROUND(AVG(t.meter_sale_price)) AS psm, ROUND(AVG(t.actual_worth)) AS price, MAX(t.instance_date) AS last
    FROM transaction_ t LEFT JOIN project p ON p.project_number=t.project_number
    WHERE t.area_name_en=? AND t.trans_group_en='Sales' AND t.instance_date>=date('now','-365 days') AND t.project_name_en IS NOT NULL AND t.project_name_en<>'' AND t.meter_sale_price>0
    GROUP BY t.project_name_en ORDER BY n DESC LIMIT 40`).all(name) as any[],
  areaStats: (slug: string) => db.prepare(`
    SELECT p.area_name_en AS name, p.area_slug AS slug,
      (SELECT COUNT(*) FROM project WHERE area_slug=p.area_slug) AS projects,
      (SELECT COUNT(*) FROM transaction_ t WHERE t.area_name_en=p.area_name_en AND t.trans_group_en='Sales' AND t.instance_date>=date('now','-365 days')) AS tx12m,
      (SELECT COUNT(*) FROM transaction_ t WHERE t.area_name_en=p.area_name_en AND t.trans_group_en='Sales' AND t.instance_date BETWEEN date('now','-730 days') AND date('now','-365 days')) AS txPrev12m,
      (SELECT ROUND(SUM(actual_worth)/1e9,2) FROM transaction_ t WHERE t.area_name_en=p.area_name_en AND t.trans_group_en='Sales' AND t.instance_date>=date('now','-365 days')) AS valueBn,
      (SELECT ROUND(100.0*SUM(CASE WHEN reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END)/COUNT(*)) FROM transaction_ t WHERE t.area_name_en=p.area_name_en AND t.trans_group_en='Sales' AND t.instance_date>=date('now','-365 days')) AS offplanPct,
      (SELECT ROUND(AVG(meter_sale_price)) FROM transaction_ t WHERE t.area_name_en=p.area_name_en AND t.trans_group_en='Sales' AND t.property_type_en='Unit' AND t.instance_date>=date('now','-90 days') AND meter_sale_price>0 AND rooms_en IS NOT NULL AND rooms_en<>'') AS psm90,
      (SELECT COUNT(*) FROM transaction_ t WHERE t.area_name_en=p.area_name_en AND t.trans_group_en='Sales' AND t.property_type_en='Unit' AND t.instance_date>=date('now','-90 days') AND meter_sale_price>0) AS n90,
      (SELECT COUNT(*) FROM transaction_ t WHERE t.area_name_en=p.area_name_en AND t.trans_group_en='Sales' AND t.property_type_en='Unit' AND t.instance_date BETWEEN date('now','-455 days') AND date('now','-365 days') AND meter_sale_price>0) AS nLy,
      (SELECT ROUND(AVG(meter_sale_price)) FROM transaction_ t WHERE t.area_name_en=p.area_name_en AND t.trans_group_en='Sales' AND t.property_type_en='Unit' AND t.instance_date BETWEEN date('now','-455 days') AND date('now','-365 days') AND meter_sale_price>0) AS psmLy,
      (SELECT COUNT(*) FROM validated_drop v WHERE v.area_name_en=p.area_name_en) AS drops,
      (SELECT ROUND(MAX(cumulative_pct)*100,1) FROM validated_drop v WHERE v.area_name_en=p.area_name_en) AS maxDrop
    FROM (SELECT area_name_en, area_slug FROM project WHERE area_slug=? UNION ALL SELECT area_name_en, ? FROM transaction_ WHERE lower(replace(replace(replace(replace(area_name_en,' ','-'),'''','-'),'.','-'),'--','-'))=? LIMIT 1) p LIMIT 1`).get(slug, slug, slug) as any,
  projectsInArea: (slug: string) => db.prepare(`
    SELECT p.*, d.name_en AS developer, d.slug AS developer_slug,
      (SELECT status FROM project_observation o WHERE o.project_number=p.project_number ORDER BY observed_at DESC LIMIT 1) AS status,
      (SELECT percent_completed FROM project_observation o WHERE o.project_number=p.project_number ORDER BY observed_at DESC LIMIT 1) AS pct,
      (SELECT completion_date FROM project_observation o WHERE o.project_number=p.project_number ORDER BY observed_at DESC LIMIT 1) AS completion,
      (SELECT COUNT(*) FROM validated_drop v WHERE v.project_number=p.project_number) AS drops,
      (SELECT ROUND(AVG(meter_sale_price)) FROM transaction_ t WHERE t.project_number=p.project_number AND instance_date>=date('now','-90 days') AND meter_sale_price>0) AS psm90
    FROM project p LEFT JOIN developer d ON d.developer_number=p.developer_number WHERE p.area_slug=? ORDER BY p.name_en`).all(slug) as any[],
  allProjects: () => db.prepare(`SELECT project_number, slug, area_slug FROM project`).all() as any[],
  project: (area: string, slug: string) => db.prepare(`SELECT p.*, d.name_en AS developer, d.slug AS developer_slug FROM project p LEFT JOIN developer d ON d.developer_number=p.developer_number WHERE p.area_slug=? AND p.slug=?`).get(area, slug) as any,
  projectHistory: (pn: string) => db.prepare(`SELECT observed_at, status, percent_completed, completion_date, source FROM project_observation WHERE project_number=? ORDER BY observed_at`).all(pn) as any[],
  recordedByRooms: (pn: string) => db.prepare(`
    SELECT COALESCE(NULLIF(rooms_en,''),'Unclassified') AS rooms, COUNT(*) AS n, ROUND(AVG(meter_sale_price)) AS psm, ROUND(AVG(actual_worth)) AS price, MAX(instance_date) AS last,
      CASE WHEN rooms_en IS NULL OR rooms_en IN ('','NA') THEN 1 ELSE 0 END AS unclassified
    FROM transaction_ WHERE project_number=? AND trans_group_en='Sales' AND meter_sale_price>0 AND property_type_en IN ('Unit','Villa') AND instance_date>=date('now','-365 days') GROUP BY rooms ORDER BY unclassified, n DESC`).all(pn) as any[],
  recentTx: (pn: string, n = 15) => db.prepare(`SELECT instance_date, reg_type_en, building_name_en, rooms_en, procedure_area, actual_worth, meter_sale_price FROM transaction_ WHERE project_number=? AND trans_group_en='Sales' ORDER BY instance_date DESC LIMIT ?`).all(pn, n) as any[],
  rentsByRooms: (pn: string) => db.prepare(`SELECT rooms_en AS rooms, COUNT(*) AS n, ROUND(AVG(annual_amount)) AS rent FROM rent_contract WHERE project_number=? AND ejari_property_type_en IN ('Flat','Villa') AND annual_amount>5000 AND contract_start_date>=date('now','-365 days') GROUP BY rooms_en`).all(pn) as any[],
  askingByRooms: (pn: string) => db.prepare(`
    SELECT l.rooms_en AS rooms, COUNT(*) AS n, ROUND(AVG(o.asking_price)) AS asking, ROUND(AVG(o.asking_price/NULLIF(l.area_sqm,0))) AS psm
    FROM listing l JOIN listing_price_observation o ON o.listing_id=l.listing_id
    WHERE l.project_number=? AND o.seen=1 AND o.observed_at=(SELECT MAX(observed_at) FROM listing_price_observation WHERE listing_id=l.listing_id)
    GROUP BY l.rooms_en`).all(pn) as any[],
  dropsForProject: (pn: string) => db.prepare(`SELECT v.*, l.rooms_en, l.area_sqm, l.url, l.permit_number, l.is_off_plan FROM validated_drop v JOIN listing l USING(listing_id) WHERE v.project_number=? ORDER BY distress_score DESC`).all(pn) as any[],
  allDrops: () => db.prepare(`SELECT v.*, l.rooms_en, l.area_sqm, l.url, l.permit_number, l.is_off_plan, p.name_en AS project, p.slug AS project_slug, p.area_slug FROM validated_drop v JOIN listing l USING(listing_id) LEFT JOIN project p USING(project_number) ORDER BY distress_score DESC`).all() as any[],
  drop: (id: string) => db.prepare(`SELECT v.*, l.*, p.name_en AS project, p.slug AS project_slug, p.area_slug FROM validated_drop v JOIN listing l USING(listing_id) LEFT JOIN project p USING(project_number) WHERE v.listing_id=?`).get(id) as any,
  priceHistory: (id: string) => db.prepare(`SELECT observed_at, asking_price, seen FROM listing_price_observation WHERE listing_id=? ORDER BY observed_at`).all(id) as any[],
  developers: () => db.prepare(`
    SELECT d.*, COUNT(p.project_number) AS projects,
      ROUND(AVG((SELECT (julianday(MAX(completion_date))-julianday(MIN(completion_date)))/30.4 FROM project_observation o WHERE o.project_number=p.project_number)),1) AS avgSlipMonths,
      SUM((SELECT COUNT(*) FROM validated_drop v WHERE v.project_number=p.project_number)) AS drops
    FROM developer d LEFT JOIN project p ON p.developer_number=d.developer_number GROUP BY d.developer_number ORDER BY d.name_en`).all() as any[],
  developerStats: () => db.prepare(`
    SELECT d.developer_number, d.name_en, d.slug, COUNT(p.project_number) AS projects,
      SUM(CASE WHEN o.status='FINISHED' THEN 1 ELSE 0 END) AS finished,
      SUM(CASE WHEN o.status IN ('ACTIVE','NOT_STARTED','PENDING') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN o.status IN ('ACTIVE','NOT_STARTED','PENDING') AND o.completion_date < date('now') THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN o.status='CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
      (SELECT COUNT(*) FROM transaction_ t WHERE t.project_number IN (SELECT project_number FROM project WHERE developer_number=d.developer_number) AND t.trans_group_en='Sales' AND t.instance_date>=date('now','-365 days')) AS sales12m,
      (SELECT ROUND(SUM(actual_worth)/1e9,2) FROM transaction_ t WHERE t.project_number IN (SELECT project_number FROM project WHERE developer_number=d.developer_number) AND t.trans_group_en='Sales' AND t.instance_date>=date('now','-365 days')) AS valueBn,
      (SELECT COUNT(*) FROM delay_flag f WHERE f.project_number IN (SELECT project_number FROM project WHERE developer_number=d.developer_number)) AS flagged
    FROM developer d JOIN project p ON p.developer_number=d.developer_number
    LEFT JOIN (SELECT project_number, status, completion_date FROM project_observation o1 WHERE observed_at=(SELECT MAX(observed_at) FROM project_observation WHERE project_number=o1.project_number)) o ON o.project_number=p.project_number
    GROUP BY d.developer_number HAVING projects>0 ORDER BY sales12m DESC`).all() as any[],
  developer: (slug: string) => db.prepare(`SELECT * FROM developer WHERE slug=?`).get(slug) as any,
  developerProjects: (dn: string) => db.prepare(`
    SELECT p.*, o.status, o.percent_completed AS pct, o.completion_date AS completion,
      CASE WHEN o.status IN ('ACTIVE','NOT_STARTED','PENDING') AND o.completion_date < date('now') THEN 1 ELSE 0 END AS overdue,
      (SELECT COUNT(*) FROM transaction_ t WHERE t.project_number=p.project_number AND t.trans_group_en='Sales' AND t.instance_date>=date('now','-365 days')) AS sales12m,
      (SELECT ROUND(AVG(meter_sale_price)) FROM transaction_ t WHERE t.project_number=p.project_number AND t.trans_group_en='Sales' AND t.property_type_en='Unit' AND t.instance_date>=date('now','-90 days') AND meter_sale_price>0) AS psm90
    FROM project p LEFT JOIN (SELECT project_number, status, percent_completed, completion_date FROM project_observation o1 WHERE observed_at=(SELECT MAX(observed_at) FROM project_observation WHERE project_number=o1.project_number)) o USING(project_number)
    WHERE developer_number=? ORDER BY sales12m DESC, name_en`).all(dn) as any[],
  serviceCharges: (projectName: string) => db.prepare(`
    SELECT budget_year AS year, property_group AS building, usage, ROUND(SUM(cost)) AS total, management_company AS manager
    FROM service_charge WHERE UPPER(project_name)=UPPER(?) GROUP BY budget_year, property_group, usage ORDER BY budget_year DESC, property_group LIMIT 30`).all(projectName) as any[],
  headline: () => db.prepare(`SELECT (SELECT COUNT(*) FROM validated_drop) AS drops, (SELECT COUNT(*) FROM listing) AS listings, (SELECT COUNT(*) FROM project) AS projects, (SELECT COUNT(*) FROM transaction_ WHERE trans_group_en='Sales') AS tx, (SELECT ROUND(SUM(actual_worth)/1e9,1) FROM transaction_ WHERE trans_group_en='Sales') AS valueBn, (SELECT MIN(instance_date) FROM transaction_) AS txFrom, (SELECT MAX(instance_date) FROM transaction_) AS txTo, (SELECT MAX(observed_at) FROM listing_price_observation) AS lastScan`).get() as any,
};

// Areas joined with their stats — expensive; memoized because the homepage and the areas index both need it.
let _areasStats: any[] | null = null;
export const areasWithStats = () => _areasStats ??= q.areas().map(a => ({ ...a, ...q.areaStats(a.slug) }));

export const aed = (n: number | null | undefined) => n == null ? '—' : 'AED ' + Math.round(n).toLocaleString('en-US');
export const pct = (n: number | null | undefined, dp = 1) => n == null ? '—' : (n * 100).toFixed(dp) + '%';

// Presentation helpers (keep comparison operators out of Astro templates).
export const gapClass = (g: number | null | undefined) => 'num ' + ((g ?? 0) < 0 ? 'down' : 'up');
export const gapText = (g: number | null | undefined) => g == null ? '—' : (g > 0 ? '+' : '') + pct(g);
export const scoreClass = (s: number) => 'badge ' + (s >= 50 ? 'hot' : '');
export const signClass = (v: number | null | undefined) => (v ?? 0) > 0 ? 'up' : 'down';
export const yoy = (a: number | null, b: number | null, na = 30, nb = 30) => a && b && na >= 30 && nb >= 30 ? ((a / b - 1) * 100).toFixed(1) + '%' : '—';

// Listing ids contain ':' (source:id) which breaks routing when URL-encoded; use a safe form in URLs.
export const dropUrl = (listingId: string) => `/drops/${listingId.replace(/:/g, '__')}/`;
export const fromDropUrl = (id: string) => id.replace(/__/g, ':');

// ---------- Common-name aliases for DLD area names (DLD uses cadastral names) ----------
export const AREA_ALIAS: Record<string, string> = {
  'Marsa Dubai': 'Dubai Marina', 'Al Barsha South Fourth': 'JVC (Jumeirah Village Circle)', 'Al Barsha South Fifth': 'JVT (Jumeirah Village Triangle)',
  'Al Thanyah Fifth': 'JLT (Jumeirah Lakes Towers)', 'Burj Khalifa': 'Downtown Dubai', 'Al Hebiah Third': 'DAMAC Hills', 'Al Hebiah Fourth': 'Dubai Sports City / Tilal Al Ghaf',
  'Al Thanayah Fourth': 'Emirates Living (Springs / Meadows)', 'Wadi Al Safa 6': 'Arabian Ranches',
  'Al Hebiah First': 'Motor City', 'Al Barshaa South Third': 'Arjan', 'Madinat Al Mataar': 'Dubai South', "Me'Aisem First": 'Dubai Production City (IMPZ)',
  'Al Khairan First': 'Dubai Creek Harbour', 'Hadaeq Sheikh Mohammed Bin Rashid': 'Dubai Hills Estate', 'Jabal Ali First': 'Al Furjan / Discovery Gardens',
  'Al Warsan First': 'International City', 'Nadd Hessa': 'Dubai Silicon Oasis', 'Al Merkadh': 'Sobha Hartland / MBR City', 'Nad Al Shiba First': 'Meydan',
  'Al Yelayiss 2': 'Town Square', 'Al Jadaf': 'Al Jaddaf', 'Palm Deira': 'Dubai Islands', 'Madinat Dubai Almelaheyah': 'Dubai Maritime City',
  'Al Thanyah Third': 'The Greens / The Views', 'Al Safouh First': 'Al Sufouh', 'Wadi Al Safa 5': 'Dubailand Residence Complex / Liwan', 'Al Yufrah 1': 'The Valley',
  'Zaabeel Second': 'Za\'abeel / Design District', 'Al Kifaf': 'Al Kifaf / Wasl 1', 'Saih Shuaib 2': 'Dubai Investment Park South / Expo City',
};
export const areaLabel = (name: string) => AREA_ALIAS[name] ? `${AREA_ALIAS[name]} · ${name}` : name;
export const STATUS_LABEL: Record<string, string> = { ACTIVE: 'Under construction', NOT_STARTED: 'Not started', PENDING: 'Pending', PENDING_COMING_SOON: 'Coming soon', CONDITIONAL_ACTIVATING: 'Conditionally activating', FINISHED: 'Completed', CANCELLED: 'Cancelled', 'ON HOLD': 'On hold' };
export const statusLabel = (s: string | null | undefined) => (s && STATUS_LABEL[s]) || s || '—';
export const roomsLabel = (r: string | null | undefined) => (r && r !== 'NA' && r.trim()) ? r : 'Unclassified';

// Developer corporate groups: DLD registers each SPV separately; roll the big names up for the scorecard.
export const devGroup = (name: string) => {
  const n = name.toUpperCase();
  for (const g of ['EMAAR', 'DAMAC', 'NAKHEEL', 'SOBHA', 'AZIZI', 'BINGHATTI', 'ELLINGTON', 'IMTIAZ', 'DANUBE', 'SAMANA', 'MERAAS', 'DUBAI PROPERTIES', 'DEYAAR', 'OMNIYAT', 'SELECT GROUP', 'ARADA', 'OBJECT ONE', 'REPORTAGE', 'TIGER', 'MAG ', 'AL HABTOOR', 'WASL', 'DUBAI SOUTH', 'ALDAR', 'NSHAMA', 'MAJID AL FUTTAIM', 'IMAN', 'PEACE HOMES', 'BEYOND', 'AMIS', 'DUGASTA', 'SEVEN', 'BLOOM', 'LEOS', 'VINCITORE', 'ELLINGTON'])
    if (n.includes(g)) return g.trim().charAt(0) + g.trim().slice(1).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace('Damac', 'DAMAC').replace('Mag', 'MAG').replace('Amis', 'AMIS').replace('Leos', 'LEOS');
  return name;
};

export const q2 = {
  resaleSummary: () => db.prepare(`SELECT COUNT(*) n, SUM(change_pct<0) losses, ROUND(AVG(change_pct)*100,1) avgPct, MAX(sold_on) latest FROM resale_pair WHERE sold_on>=date('now','-365 days')`).get() as any,
  losses: (limit = 100) => db.prepare(`
    SELECT r.*, p.name_en AS project, p.slug AS project_slug, p.area_slug FROM resale_pair r JOIN project p USING(project_number)
    WHERE r.sold_on>=date('now','-365 days') AND r.change_pct<0 AND r.ambiguity<=1 ORDER BY r.sold_on DESC, r.change_pct LIMIT ?`).all(limit) as any[],
  lossesForProject: (pn: string) => db.prepare(`SELECT * FROM resale_pair WHERE project_number=? AND sold_on>=date('now','-730 days') ORDER BY sold_on DESC LIMIT 40`).all(pn) as any[],
  lossesByArea: () => db.prepare(`
    SELECT area_name_en AS area, COUNT(*) n, SUM(change_pct<0) losses, ROUND(100.0*SUM(change_pct<0)/COUNT(*)) lossPct, ROUND(AVG(change_pct)*100,1) avgPct
    FROM resale_pair WHERE sold_on>=date('now','-365 days') GROUP BY 1 HAVING n>=50 ORDER BY lossPct DESC`).all() as any[],
  areaResale: (area: string) => db.prepare(`SELECT COUNT(*) n, SUM(change_pct<0) losses, ROUND(100.0*SUM(change_pct<0)/NULLIF(COUNT(*),0)) lossPct, ROUND(AVG(change_pct)*100,1) avgPct FROM resale_pair WHERE area_name_en=? AND sold_on>=date('now','-365 days')`).get(area) as any,
  delayFlags: (limit = 60) => db.prepare(`SELECT f.*, p.name_en AS project, p.slug AS project_slug, p.area_slug, d.name_en AS developer FROM delay_flag f JOIN project p USING(project_number) LEFT JOIN developer d ON d.developer_number=p.developer_number ORDER BY risk_score DESC, sales_12m DESC LIMIT ?`).all(limit) as any[],
  delayFlag: (pn: string) => db.prepare(`SELECT * FROM delay_flag WHERE project_number=?`).get(pn) as any,
  obsCount: () => (db.prepare(`SELECT COUNT(DISTINCT observed_at) c FROM project_observation`).get() as any).c as number,
  projectTx: (pn: string, n: number) => db.prepare(`SELECT instance_date, reg_type_en, procedure_name_en, building_name_en, rooms_en, procedure_area, actual_worth, meter_sale_price FROM transaction_ WHERE project_number=? AND trans_group_en='Sales' ORDER BY instance_date DESC LIMIT ?`).all(pn, n) as any[],
  projectTxCount: (pn: string) => (db.prepare(`SELECT COUNT(*) c FROM transaction_ WHERE project_number=? AND trans_group_en='Sales'`).get(pn) as any).c as number,
};

// ---------- Rents (Ejari) + listings inventory ----------
// Residential filter: Ejari property types that are homes; amount guard kills data-entry outliers.
const RES = `ejari_property_type_en IN ('Flat','Villa','Studio','Complex Villas') AND annual_amount BETWEEN 5000 AND 5000000`;
// Same slug expression the areas() union uses, so /rent/<slug>/ matches /dubai/<slug>/.
const SLUG = `lower(replace(replace(replace(replace(area_name_en,' ','-'),'''','-'),'.','-'),'--','-'))`;

let _rentAreas: any[] | null = null; // memoized: every /rent/ page reads it during the build

export const q3 = {
  rentSummary: () => db.prepare(`
    SELECT COUNT(*) n, SUM(contract_reg_type_en='New') nNew,
      ROUND(AVG(CASE WHEN contract_reg_type_en='New' THEN annual_amount END)) rentNew,
      ROUND(AVG(CASE WHEN contract_reg_type_en='Renew' THEN annual_amount END)) rentRenew,
      MAX(contract_start_date) latest
    FROM rent_contract WHERE ${RES} AND contract_start_date>=date('now','-365 days')`).get() as any,
  rentAreas: () => _rentAreas ??= db.prepare(`
    SELECT area_name_en AS area, ${SLUG} AS slug, COUNT(*) n, SUM(contract_reg_type_en='New') nNew,
      ROUND(AVG(CASE WHEN contract_reg_type_en='New' THEN annual_amount END)) rentNew,
      ROUND(AVG(CASE WHEN contract_reg_type_en='Renew' THEN annual_amount END)) rentRenew,
      ROUND(AVG(CASE WHEN contract_reg_type_en='New' AND actual_area BETWEEN 20 AND 2000 THEN annual_amount/actual_area END)) rpsm,
      (SELECT COUNT(*) FROM rent_contract r2 WHERE r2.area_name_en=r.area_name_en AND ${RES.replace(/ejari_property_type_en/g, 'r2.ejari_property_type_en').replace(/annual_amount/g, 'r2.annual_amount')} AND r2.contract_reg_type_en='New' AND r2.actual_area BETWEEN 20 AND 2000 AND r2.contract_start_date BETWEEN date('now','-730 days') AND date('now','-365 days')) nLy,
      (SELECT ROUND(AVG(r2.annual_amount/r2.actual_area)) FROM rent_contract r2 WHERE r2.area_name_en=r.area_name_en AND ${RES.replace(/ejari_property_type_en/g, 'r2.ejari_property_type_en').replace(/annual_amount/g, 'r2.annual_amount')} AND r2.contract_reg_type_en='New' AND r2.actual_area BETWEEN 20 AND 2000 AND r2.contract_start_date BETWEEN date('now','-730 days') AND date('now','-365 days')) rpsmLy,
      (SELECT ROUND(AVG(t.meter_sale_price)) FROM transaction_ t WHERE t.area_name_en=r.area_name_en AND t.trans_group_en='Sales' AND t.property_type_en='Unit' AND t.meter_sale_price>0 AND t.rooms_en IS NOT NULL AND t.rooms_en<>'' AND t.instance_date>=date('now','-365 days')) salePsm
    FROM rent_contract r WHERE ${RES} AND contract_start_date>=date('now','-365 days')
    GROUP BY 1 HAVING n>=200 ORDER BY n DESC`).all() as any[],
  rentAreaRooms: (area: string) => db.prepare(`
    SELECT COALESCE(NULLIF(rooms_en,''), CASE WHEN ejari_property_type_en='Studio' THEN 'Studio' ELSE 'Unclassified' END) AS rooms,
      COUNT(*) n, SUM(contract_reg_type_en='New') nNew,
      ROUND(AVG(CASE WHEN contract_reg_type_en='New' THEN annual_amount END)) rentNew,
      ROUND(AVG(CASE WHEN contract_reg_type_en='Renew' THEN annual_amount END)) rentRenew,
      ROUND(AVG(CASE WHEN actual_area BETWEEN 20 AND 2000 THEN annual_amount/actual_area END)) rpsm
    FROM rent_contract WHERE area_name_en=? AND ${RES} AND contract_start_date>=date('now','-365 days')
    GROUP BY 1 HAVING n>=20 ORDER BY n DESC`).all(area) as any[],
  rentAreaRoomsLy: (area: string) => db.prepare(`
    SELECT COALESCE(NULLIF(rooms_en,''), CASE WHEN ejari_property_type_en='Studio' THEN 'Studio' ELSE 'Unclassified' END) AS rooms,
      COUNT(*) n, ROUND(AVG(CASE WHEN contract_reg_type_en='New' THEN annual_amount END)) rentNew
    FROM rent_contract WHERE area_name_en=? AND ${RES} AND contract_start_date BETWEEN date('now','-730 days') AND date('now','-365 days')
    GROUP BY 1`).all(area) as any[],
  salesByRooms: (area: string) => db.prepare(`
    SELECT rooms_en AS rooms, COUNT(*) n, ROUND(AVG(actual_worth)) price
    FROM transaction_ WHERE area_name_en=? AND trans_group_en='Sales' AND property_type_en='Unit' AND actual_worth>0 AND rooms_en IS NOT NULL AND rooms_en<>'' AND instance_date>=date('now','-365 days')
    GROUP BY 1 HAVING n>=20`).all(area) as any[],
  rentTopProjects: (area: string) => db.prepare(`
    SELECT r.project_name_en AS project, p.slug AS project_slug, p.area_slug, COUNT(*) n,
      ROUND(AVG(CASE WHEN contract_reg_type_en='New' THEN annual_amount END)) rentNew,
      ROUND(AVG(CASE WHEN contract_reg_type_en='Renew' THEN annual_amount END)) rentRenew
    FROM rent_contract r LEFT JOIN project p ON p.project_number=r.project_number
    WHERE r.area_name_en=? AND ${RES} AND contract_start_date>=date('now','-365 days') AND r.project_name_en IS NOT NULL AND r.project_name_en<>''
    GROUP BY r.project_name_en ORDER BY n DESC LIMIT 30`).all(area) as any[],
  rentCount: (area: string) => (db.prepare(`SELECT COUNT(*) c FROM rent_contract WHERE area_name_en=? AND ${RES} AND contract_start_date>=date('now','-365 days')`).get(area) as any).c as number,
  // Average NEW-contract rent per area/type/bedrooms — the market average the RERA slabs compare against.
  reraTable: () => db.prepare(`
    SELECT area_name_en AS area,
      CASE WHEN ejari_property_type_en IN ('Villa','Complex Villas') THEN 'Villa' ELSE 'Flat' END AS type,
      COALESCE(NULLIF(rooms_en,''), CASE WHEN ejari_property_type_en='Studio' THEN 'Studio' ELSE NULL END) AS rooms,
      COUNT(*) n, ROUND(AVG(annual_amount)) avg
    FROM rent_contract WHERE ${RES} AND contract_reg_type_en='New' AND contract_start_date>=date('now','-365 days')
      AND COALESCE(NULLIF(rooms_en,''), CASE WHEN ejari_property_type_en='Studio' THEN 'Studio' ELSE NULL END) IS NOT NULL
    GROUP BY 1,2,3 HAVING n>=20 ORDER BY area, type, rooms`).all() as any[],
  // ---- Listings inventory (fills when the licensed feed / agent submissions land) ----
  listingSummary: () => db.prepare(`
    SELECT (SELECT COUNT(*) FROM listing) tracked,
      (SELECT MAX(observed_at) FROM listing_price_observation) lastScan,
      (SELECT COUNT(DISTINCT observed_at) FROM listing_price_observation) scans,
      (SELECT COUNT(*) FROM listing_price_observation o WHERE seen=1 AND observed_at=(SELECT MAX(observed_at) FROM listing_price_observation)) active`).get() as any,
  inventoryByArea: () => db.prepare(`
    WITH last AS (SELECT MAX(observed_at) m FROM listing_price_observation),
    cur AS (SELECT l.listing_id, l.area_name_en, o.asking_price FROM listing l JOIN listing_price_observation o ON o.listing_id=l.listing_id, last WHERE o.observed_at=last.m AND o.seen=1),
    firsts AS (SELECT o.listing_id, o.asking_price fp FROM listing_price_observation o WHERE o.observed_at=(SELECT MIN(observed_at) FROM listing_price_observation WHERE listing_id=o.listing_id))
    SELECT c.area_name_en AS area, COUNT(*) active, ROUND(AVG(c.asking_price)) avgAsk,
      SUM(c.asking_price < f.fp*0.98) cut,
      ROUND(AVG(CASE WHEN c.asking_price < f.fp*0.98 THEN (c.asking_price/f.fp-1)*100 END),1) avgCutPct,
      (SELECT COUNT(*) FROM transaction_ t WHERE t.area_name_en=c.area_name_en AND t.trans_group_en='Sales' AND t.instance_date>=date('now','-365 days')) sales12m
    FROM cur c JOIN firsts f USING(listing_id) WHERE c.area_name_en IS NOT NULL
    GROUP BY 1 ORDER BY active DESC`).all() as any[],
};

// RERA Decree 43/2013 slabs, applied against the average market rent for similar property.
export const reraSlab = (pctBelow: number) => pctBelow <= 10 ? 0 : pctBelow <= 20 ? 5 : pctBelow <= 30 ? 10 : pctBelow <= 40 ? 15 : 20;

// ---------- Time series for charts + the search index ----------
let _sparkAreas: Map<string, number[]> | null = null;


// Median AED/sqm per period via window functions (SQLite >= 3.25). Means are wrecked by a handful of
// mis-keyed register rows (a 2012 "peak" of 27k/sqm); the median is what the market pages should show.
const APT = `trans_group_en='Sales' AND property_type_en='Unit' AND meter_sale_price>0 AND rooms_en IS NOT NULL AND rooms_en<>''`;
const medianSeries = (periodExpr: string, where: string, params: any[], sinceExpr: string) => db.prepare(`
  WITH s AS (
    SELECT ${periodExpr} m, meter_sale_price v,
      ROW_NUMBER() OVER (PARTITION BY ${periodExpr} ORDER BY meter_sale_price) rn,
      COUNT(*) OVER (PARTITION BY ${periodExpr}) cnt
    FROM transaction_ WHERE ${APT} AND ${where} AND ${sinceExpr}
  ), med AS (SELECT m, cnt np, ROUND(AVG(v)) psm FROM s WHERE rn IN ((cnt+1)/2, (cnt+2)/2) GROUP BY m),
  vol AS (SELECT ${periodExpr} m, COUNT(*) n FROM transaction_ WHERE trans_group_en='Sales' AND ${where} AND ${sinceExpr} GROUP BY 1)
  SELECT vol.m, med.psm, COALESCE(med.np,0) np, vol.n FROM vol LEFT JOIN med USING(m) ORDER BY vol.m`).all(...params, ...params) as any[];

export const q4 = {
  // City-wide monthly series: price line from classified apartment sales, volume from all sales.
  monthlyMarket: (months = 24) => medianSeries(`strftime('%Y-%m', instance_date)`, '1=1', [], `instance_date>=date('now','start of month','-${months - 1} months') AND instance_date<date('now','start of month','+1 month')`),
  monthlyArea: (area: string, months = 24) => medianSeries(`strftime('%Y-%m', instance_date)`, 'area_name_en=?', [area], `instance_date>=date('now','start of month','-${months - 1} months') AND instance_date<date('now','start of month','+1 month')`),
  monthlyProject: (pn: string, months = 36) => db.prepare(`
    SELECT strftime('%Y-%m', instance_date) m, ROUND(AVG(meter_sale_price)) psm, COUNT(*) n
    FROM transaction_ WHERE trans_group_en='Sales' AND project_number=? AND meter_sale_price>0 AND instance_date>=date('now','start of month','-${months - 1} months') AND instance_date<date('now','start of month','+1 month')
    GROUP BY 1 ORDER BY 1`).all(pn) as any[],
  // 12-month AED/sqm sparkline per area, one grouped query for the whole table.
  sparkAreas: () => {
    if (_sparkAreas) return _sparkAreas;
    const rows = db.prepare(`
      SELECT area_name_en a, strftime('%Y-%m', instance_date) m, ROUND(AVG(meter_sale_price)) psm, COUNT(*) n
      FROM transaction_ WHERE trans_group_en='Sales' AND property_type_en='Unit' AND meter_sale_price>0 AND rooms_en IS NOT NULL AND rooms_en<>''
        AND instance_date>=date('now','start of month','-11 months')
      GROUP BY 1,2 HAVING n>=5 ORDER BY 1,2`).all() as any[];
    _sparkAreas = new Map();
    for (const r of rows) {
      if (!_sparkAreas.has(r.a)) _sparkAreas.set(r.a, []);
      _sparkAreas.get(r.a)!.push(r.psm);
    }
    return _sparkAreas;
  },
  searchIndex: () => {
    const areas = db.prepare(`
      SELECT name, slug FROM (
        SELECT area_name_en AS name, area_slug AS slug FROM project GROUP BY area_slug
        UNION SELECT area_name_en, lower(replace(replace(replace(replace(area_name_en,' ','-'),'''','-'),'.','-'),'--','-')) FROM transaction_ WHERE area_name_en IS NOT NULL GROUP BY area_name_en
      ) GROUP BY slug`).all() as any[];
    const projects = db.prepare(`SELECT project_number pn, name_en n, slug, area_slug, area_name_en area FROM project`).all() as any[];
    const devs = db.prepare(`SELECT d.name_en n, d.slug FROM developer d WHERE EXISTS (SELECT 1 FROM project p WHERE p.developer_number=d.developer_number)`).all() as any[];
    return [
      ...areas.map(a => ({ t: 'Area', n: AREA_ALIAS[a.name] ? `${AREA_ALIAS[a.name]} (${a.name})` : a.name, u: `/dubai/${a.slug}/` })),
      // pn rides along so the watchlist can follow a project by its register number, which is stable
      // where a display name is not.
      ...projects.map(p => ({ t: 'Project', pn: p.pn, n: p.n, x: AREA_ALIAS[p.area] ?? p.area, u: `/dubai/${p.area_slug}/${p.slug}/` })),
      ...devs.map(d => ({ t: 'Developer', n: d.n, u: `/developers/${d.slug}/` })),
    ];
  },
};

// ---- q5: project location & like-for-like nearby comps ----
// One grouped pass over the last 12 months of priced sales feeds every comps table in the build.
const ROOM_ORDER = ['Studio', '1 B/R', '2 B/R', '3 B/R', '4 B/R', '5 B/R', '6 B/R', '7 B/R', 'PENTHOUSE'];
let _projAgg: Map<string, any> | null = null;
let _projRooms: Map<string, Map<string, any>> | null = null;
const projAgg = () => {
  if (_projAgg) return _projAgg;
  _projAgg = new Map();
  for (const r of db.prepare(`
    SELECT project_number pn, COUNT(*) n,
      ROUND(AVG(CASE WHEN reg_type_en='Existing Properties' THEN meter_sale_price END)) secPsm,
      SUM(CASE WHEN reg_type_en='Existing Properties' THEN 1 ELSE 0 END) secN,
      ROUND(AVG(CASE WHEN reg_type_en='Off-Plan Properties' THEN meter_sale_price END)) offPsm,
      SUM(CASE WHEN reg_type_en='Off-Plan Properties' THEN 1 ELSE 0 END) offN
    FROM transaction_
    WHERE trans_group_en='Sales' AND project_number IS NOT NULL AND project_number<>''
      AND property_type_en IN ('Unit','Villa') AND meter_sale_price>0
      AND instance_date>=date('now','-365 days')
    GROUP BY 1`).all() as any[]) _projAgg.set(r.pn, r);
  return _projAgg;
};
const projRooms = () => {
  if (_projRooms) return _projRooms;
  _projRooms = new Map();
  for (const r of db.prepare(`
    SELECT project_number pn, rooms_en rooms, COUNT(*) n, ROUND(AVG(actual_worth)) price
    FROM transaction_
    WHERE trans_group_en='Sales' AND project_number IS NOT NULL AND project_number<>''
      AND property_type_en IN ('Unit','Villa') AND meter_sale_price>0 AND actual_worth>0
      AND rooms_en IS NOT NULL AND rooms_en NOT IN ('','NA')
      AND instance_date>=date('now','-365 days')
    GROUP BY 1,2`).all() as any[]) {
    if (!_projRooms.has(r.pn)) _projRooms.set(r.pn, new Map());
    _projRooms.get(r.pn)!.set(r.rooms, r);
  }
  return _projRooms;
};
export const q5 = {
  location: (pn: string) => db.prepare(`SELECT metro, landmark, mall FROM project_location WHERE project_number=?`).get(pn) as any,
  // Like-for-like set: same master community first (that's what "nearby" means to a buyer),
  // same registry area as the fallback when the register has no community.
  comps: (p: any) => {
    const agg = projAgg(), rooms = projRooms();
    const load = (r: any) => ({ ...r, ...(agg.get(r.pn) ?? {}), roomStats: rooms.get(r.pn) });
    const active = (rows: any[]) => rows.map(load).filter(r => (r.n ?? 0) >= 5);
    const master = (p.master_project_en ?? '').trim();
    const byMaster = db.prepare(`SELECT project_number pn, name_en name, slug, area_slug FROM project WHERE master_project_en=? AND project_number<>?`);
    const byArea = db.prepare(`SELECT project_number pn, name_en name, slug, area_slug FROM project WHERE area_name_en=? AND project_number<>?`);
    // Widen in honest steps: exact community → sibling phases ("Springs - 6" → all "Springs - *") → whole registry area.
    let community: string | null = master || null;
    let others = master ? active(byMaster.all(master, p.project_number) as any[]) : [];
    if (master && others.length < 3 && master.includes(' - ')) {
      const base = master.split(' - ')[0].trim();
      const sib = db.prepare(`SELECT project_number pn, name_en name, slug, area_slug FROM project WHERE (master_project_en=? OR master_project_en LIKE ?) AND project_number<>?`)
        .all(base, base + ' - %', p.project_number) as any[];
      const widened = active(sib);
      if (widened.length > others.length) { others = widened; community = base + ' (all phases)'; }
    }
    if (others.length < 3) {
      const widened = active(byArea.all(p.area_name_en, p.project_number) as any[]);
      if (widened.length > others.length) { others = widened; community = null; }
    }
    const self = load({ pn: p.project_number, name: p.name_en, slug: p.slug, area_slug: p.area_slug, self: true });
    others = others.sort((a, b) => (b.n ?? 0) - (a.n ?? 0)).slice(0, 10);
    // Columns: the three most-transacted bedroom types across the whole set.
    const tally = new Map<string, number>();
    for (const r of [self, ...others]) if (r.roomStats) for (const [k, v] of r.roomStats as Map<string, any>) tally.set(k, (tally.get(k) ?? 0) + v.n);
    const roomCols = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0])
      .sort((a, b) => ROOM_ORDER.indexOf(a) - ROOM_ORDER.indexOf(b));
    return { community, self, others, roomCols };
  },
};
export const mapsUrl = (p: any) =>
  'https://www.google.com/maps/search/?api=1&query=' +
  encodeURIComponent([p.name_en, (p.master_project_en ?? '').trim() || p.area_name_en, 'Dubai'].filter(Boolean).join(', '));

// ---- q6: editorial data (long history, held gains, provenance dates, project images) ----
const UNIT_SALE = `trans_group_en='Sales' AND property_type_en IN ('Unit','Villa') AND meter_sale_price>0 AND rooms_en IS NOT NULL AND rooms_en NOT IN ('','NA')`;
let _yearly: any[] | null = null;
const _yieldMemo = new Map<string, any>();
let _dates: any | null = null;
export const q6 = {
  // Yearly average recorded AED/sqm for homes, back to the first year with a meaningful sample.
  yearlyMarket: () => _yearly ??= medianSeries(`substr(instance_date,1,4)`, '1=1', [], `instance_date>='2007-01-01'`).filter(r => r.np >= 200).map(r => ({ ...r, y: r.m })),
  yearlyArea: (area: string) => medianSeries(`substr(instance_date,1,4)`, 'area_name_en=?', [area], `instance_date>='2007-01-01'`).filter(r => r.np >= 30).map(r => ({ ...r, y: r.m })),
  // Off-plan buyers who later resold: what they actually made, median and quartiles, last 24 months of resales.
  heldGains: (area?: string) => {
    const rows = db.prepare(`SELECT change_pct c, hold_days h FROM resale_pair WHERE bought_reg='Off-Plan Properties' AND ambiguity<=1 AND sold_on>=date('now','-730 days') AND hold_days>=90 ${area ? 'AND area_name_en=?' : ''}`).all(...(area ? [area] : [])) as any[];
    if (rows.length < 20) return null;
    const c = rows.map(r => r.c).sort((a, b) => a - b), h = rows.map(r => r.h).sort((a, b) => a - b);
    const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
    return { n: rows.length, median: q(c, .5), q1: q(c, .25), q3: q(c, .75), holdMonths: Math.round(q(h, .5) / 30.4), losses: c.filter(x => x < 0).length };
  },
  // Provenance: when each record was last read, for the methodology footer.
  readDates: () => _dates ??= {
    txTo: (db.prepare(`SELECT MAX(instance_date) d FROM transaction_`).get() as any).d,
    txN: (db.prepare(`SELECT COUNT(*) c FROM transaction_ WHERE trans_group_en='Sales'`).get() as any).c,
    rentTo: (db.prepare(`SELECT MAX(contract_start_date) d FROM rent_contract WHERE contract_start_date<=date('now')`).get() as any).d,
    rentN: (db.prepare(`SELECT COUNT(*) c FROM rent_contract`).get() as any).c,
    registerAt: (db.prepare(`SELECT MAX(observed_at) d FROM project_observation`).get() as any).d,
    registerN: (db.prepare(`SELECT COUNT(*) c FROM project`).get() as any).c,
    lastScan: (db.prepare(`SELECT MAX(observed_at) d FROM listing_price_observation`).get() as any).d,
  },
  // Area-level rent per sqm and sale per sqm for the yield sentence (flats, last 12 months).
  areaYield: (area: string) => { if (_yieldMemo.has(area)) return _yieldMemo.get(area); const v = db.prepare(`
    SELECT
      (SELECT ROUND(AVG(annual_amount/actual_area)) FROM rent_contract WHERE area_name_en=? AND ${RES} AND actual_area BETWEEN 20 AND 2000 AND contract_start_date>=date('now','-365 days')) rpsm,
      (SELECT COUNT(*) FROM rent_contract WHERE area_name_en=? AND ${RES} AND contract_start_date>=date('now','-365 days')) rn,
      (SELECT ROUND(AVG(meter_sale_price)) FROM transaction_ WHERE area_name_en=? AND ${UNIT_SALE} AND reg_type_en='Existing Properties' AND instance_date>=date('now','-365 days')) spsm,
      (SELECT COUNT(*) FROM transaction_ WHERE area_name_en=? AND ${UNIT_SALE} AND reg_type_en='Existing Properties' AND instance_date>=date('now','-365 days')) sn`).get(area, area, area, area) as any; _yieldMemo.set(area, v); return v; },
  // Latest observation per project, for cards.
  latestObs: (pn: string) => db.prepare(`SELECT status, percent_completed, completion_date, observed_at FROM project_observation WHERE project_number=? ORDER BY observed_at DESC LIMIT 1`).get(pn) as any,
};
// Optional photo slot: drop public/img/projects/<project_number>.webp|jpg|png in and it appears on the project page and cards.
const IMG_DIR = path.resolve(process.cwd(), 'public/img/projects');
export const projectImage = (pn: string): string | null => {
  for (const ext of ['webp', 'jpg', 'jpeg', 'png']) if (fs.existsSync(path.join(IMG_DIR, `${pn}.${ext}`))) return `/img/projects/${pn}.${ext}`;
  return null;
};
