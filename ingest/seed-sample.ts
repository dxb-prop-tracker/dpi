// Generates SYNTHETIC sample data so the site builds before DLD/feed access exists.
// Writes CSVs in the exact shape the real ingesters expect, then runs the pipeline.
// Nothing here is real market data.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const d = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

const areas = [
  { name: 'The Meadows', psm: 17500, offplan: false },
  { name: 'Dubai Marina', psm: 21000, offplan: false },
  { name: 'Jumeirah Village Circle', psm: 11500, offplan: true },
];
const devs = [['D001', 'Emaar Properties'], ['D002', 'Nakheel'], ['D003', 'Damac Properties'], ['D004', 'Sobha Realty'], ['D005', 'Binghatti']];
const rooms = ['1 B/R', '2 B/R', '3 B/R', '4 B/R'];

fs.mkdirSync('data/dld', { recursive: true }); fs.mkdirSync('data/listings', { recursive: true });
if (fs.existsSync('data/portal.db')) fs.rmSync('data/portal.db');
for (const f of fs.readdirSync('data/listings')) fs.rmSync(path.join('data/listings', f));

// projects
const projects: any[] = []; let pn = 1000;
for (const a of areas) for (let i = 1; i <= 4; i++) {
  const dev = pick(devs); const off = a.offplan && i > 1;
  projects.push({ project_number: String(pn++), project_name_en: `${a.name.split(' ').at(-1)} ${['Heights', 'Residences', 'Gardens', 'Views'][i - 1]}`, area_name_en: a.name,
    developer_number: dev[0], developer_name_en: dev[1], master_project_en: a.name, escrow_agent_name_en: 'Sample Bank', project_start_date: d(900 + i * 100),
    completion_date: off ? d(-(200 + i * 90)) : d(300), percent_completed: off ? 30 + i * 12 : 100, project_status: off ? 'ACTIVE' : 'FINISHED', psm: a.psm, off });
}
const csv = (rows: any[], cols: string[]) => cols.join(',') + '\n' + rows.map(r => cols.map(c => `"${r[c] ?? ''}"`).join(',')).join('\n');
fs.writeFileSync('data/dld/projects.csv', csv(projects, ['project_number', 'project_name_en', 'area_name_en', 'developer_number', 'developer_name_en', 'master_project_en', 'escrow_agent_name_en', 'project_start_date', 'completion_date', 'percent_completed', 'project_status']));

// transactions
const tx: any[] = []; let tid = 1;
for (const p of projects) for (let i = 0; i < 40; i++) {
  const r = pick(rooms); const sqm = 60 + rooms.indexOf(r) * 55 + rnd() * 30; const psm = p.psm * (0.85 + rnd() * 0.3);
  tx.push({ transaction_id: `T${tid++}`, instance_date: d(Math.floor(rnd() * 360)), trans_group_en: 'Sales', procedure_name_en: 'Sell', reg_type_en: p.off ? 'Off-Plan Properties' : 'Existing Properties',
    property_type_en: 'Unit', property_sub_type_en: 'Flat', property_usage_en: 'Residential', area_name_en: p.area_name_en, building_name_en: p.project_name_en + ' Tower 1',
    project_number: p.project_number, project_name_en: p.project_name_en, rooms_en: r, procedure_area: sqm.toFixed(1), actual_worth: Math.round(sqm * psm), meter_sale_price: Math.round(psm) });
}
fs.writeFileSync('data/dld/transactions.csv', csv(tx, ['transaction_id', 'instance_date', 'trans_group_en', 'procedure_name_en', 'reg_type_en', 'property_type_en', 'property_sub_type_en', 'property_usage_en', 'area_name_en', 'building_name_en', 'project_number', 'project_name_en', 'rooms_en', 'procedure_area', 'actual_worth', 'meter_sale_price']));

// rents
const rents: any[] = []; let cid = 1;
for (const p of projects.filter(x => !x.off)) for (let i = 0; i < 30; i++) {
  const r = pick(rooms); const sqm = 60 + rooms.indexOf(r) * 55; const yieldPct = 0.05 + rnd() * 0.03;
  rents.push({ contract_id: `C${cid++}`, contract_start_date: d(Math.floor(rnd() * 360)), contract_reg_type_en: pick(['New', 'Renew']), annual_amount: Math.round(sqm * p.psm * yieldPct),
    area_name_en: p.area_name_en, project_name_en: p.project_name_en, project_number: p.project_number, ejari_property_type_en: 'Flat', rooms_en: r, actual_area: sqm });
}
fs.writeFileSync('data/dld/rents.csv', csv(rents, ['contract_id', 'contract_start_date', 'contract_reg_type_en', 'annual_amount', 'area_name_en', 'project_name_en', 'project_number', 'ejari_property_type_en', 'rooms_en', 'actual_area']));

// listings across 10 weekly scans, with a mix of clean drops, delist/relist noise and tiny cuts
const listings: any[] = [];
for (const p of projects) for (let i = 0; i < 6; i++) {
  const r = pick(rooms); const sqm = 60 + rooms.indexOf(r) * 55 + rnd() * 30;
  const base = Math.round(sqm * p.psm * (1.0 + rnd() * 0.25)); // asking premium over recorded
  const kind = pick(['stable', 'stable', 'drop1', 'drop2', 'drop3', 'noise', 'tiny']);
  listings.push({ id: `L${p.project_number}-${i}`, p, r, sqm: sqm.toFixed(1), base, kind, permit: String(10000000 + Math.floor(rnd() * 8999999)) });
}
for (let s = 9; s >= 0; s--) {
  const rows: any[] = [];
  for (const l of listings) {
    let price = l.base; let present = true; const k = 9 - s; // scan index 0..9
    if (l.kind === 'drop1' && k >= 5) price = Math.round(l.base * 0.94);
    if (l.kind === 'drop2') price = k >= 7 ? Math.round(l.base * 0.88) : k >= 4 ? Math.round(l.base * 0.95) : l.base;
    if (l.kind === 'drop3') price = k >= 8 ? Math.round(l.base * 0.82) : k >= 6 ? Math.round(l.base * 0.9) : k >= 3 ? Math.round(l.base * 0.96) : l.base;
    if (l.kind === 'noise') { present = k !== 4 && k !== 5; if (k >= 6) price = Math.round(l.base * 0.9); } // delist, relist cheaper
    if (l.kind === 'tiny' && k >= 5) price = l.base - 5000;
    if (!present) continue;
    rows.push({ source: 'agentportal', source_id: l.id, permit_number: l.permit, url: `https://example.com/listing/${l.id}`, area_name_en: l.p.area_name_en, project_name_en: l.p.project_name_en,
      building_name_en: l.p.project_name_en + ' Tower 1', unit_number: '', rooms_en: l.r, area_sqm: l.sqm, is_off_plan: l.p.off ? 1 : 0, asking_price: price });
  }
  fs.writeFileSync(`data/listings/scan-${d(s * 7)}.csv`, csv(rows, ['source', 'source_id', 'permit_number', 'url', 'area_name_en', 'project_name_en', 'building_name_en', 'unit_number', 'rooms_en', 'area_sqm', 'is_off_plan', 'asking_price']));
}
console.log(`sample: ${projects.length} projects, ${tx.length} transactions, ${rents.length} rents, ${listings.length} listings × 10 scans`);
execSync('npm run pipeline', { stdio: 'inherit' });
