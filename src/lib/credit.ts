// The credit section's data layer.
//
// It reads exactly the files the Excel model reads — public/data/issuers/<id>-register.csv,
// -handover.csv and -meta.json, written by `npm run issuer:data` at the start of every daily
// refresh — so a figure on the website and the same figure in the downloaded workbook come from one
// source and cannot drift apart. If the two ever disagree, the cause is arithmetic in one of them,
// never a stale copy of the data.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.cwd(), 'public/data/issuers');

export type Project = {
  project_number: string; project: string; area: string; status: string;
  certified_pct: number | null; registered_completion: string | null; last_read: string | null;
  units: number; sold_units: number; avg_ticket_aed: number; unsold: number;
  contracted_aed_m: number; sold_pct: number | null;
  offplan_sales_all: number; offplan_value_aed_m: number; all_sales: number;
  sales_12m: number; value_12m_aed_m: number; sales_prior_12m: number; sales_90d: number;
  avg_psm_12m: number | null; mortgages_12m: number; resales_24m: number; resales_at_loss: number;
  avg_resale_change_pct: number | null; avg_hold_days: number | null; escrow_agent: string;
  first_sale: string | null; last_sale: string | null; project_start: string | null;
  is_live: boolean; ready_sales_since_bs: number; mortgages_since_bs: number;
  reading_current: boolean;   // latest register reading taken this year (the API load is October-2025 content)
};

const num = (v: string | undefined) => { const n = Number(v); return v === '' || v == null || Number.isNaN(n) ? null : n; };

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() ?? [];
  return rows.filter(r => r.some(v => v !== '')).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const read = (f: string) => { const p = path.join(DIR, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };

export function forecastData(id: string) {
  const t = read(`${id}-forecast.json`);
  return t ? JSON.parse(t) : null;
}

export function creditData(id: string) {
  const regText = read(`${id}-register.csv`);
  if (!regText) return null;
  const meta = JSON.parse(read(`${id}-meta.json`) ?? '{}');
  const projects: Project[] = parseCsv(regText).map(r => {
    const units = num(r.units) ?? 0, sold = num(r.sold_units) ?? 0, tick = num(r.avg_ticket_aed) ?? 0;
    return {
      project_number: r.project_number, project: r.project, area: r.area, status: r.status,
      certified_pct: num(r.certified_pct), registered_completion: r.registered_completion || null,
      last_read: r.last_read || null, reading_current: r.reading_current === '1', units, sold_units: sold, avg_ticket_aed: tick,
      unsold: Math.max(0, units - sold), contracted_aed_m: (sold * tick) / 1e6,
      sold_pct: units > 0 ? (sold / units) * 100 : null,
      offplan_sales_all: num(r.offplan_sales_all) ?? 0, offplan_value_aed_m: (num(r.offplan_value_aed) ?? 0) / 1e6,
      all_sales: num(r.all_sales) ?? 0, sales_12m: num(r.sales_12m) ?? 0,
      value_12m_aed_m: (num(r.value_12m_aed) ?? 0) / 1e6, sales_prior_12m: num(r.sales_prior_12m) ?? 0,
      sales_90d: num(r.sales_90d) ?? 0, avg_psm_12m: num(r.avg_psm_12m), mortgages_12m: num(r.mortgages_12m) ?? 0,
      resales_24m: num(r.resales_24m) ?? 0, resales_at_loss: num(r.resales_at_loss) ?? 0,
      avg_resale_change_pct: num(r.avg_resale_change_pct), avg_hold_days: num(r.avg_hold_days),
      escrow_agent: r.escrow_agent, first_sale: r.first_sale || null, last_sale: r.last_sale || null,
      project_start: r.project_start || null, is_live: r.is_live === '1',
      ready_sales_since_bs: num(r.ready_sales_since_bs) ?? 0, mortgages_since_bs: num(r.mortgages_since_bs) ?? 0,
    };
  });
  const handText = read(`${id}-handover.csv`);
  const handover = handText ? parseCsv(handText).map(r => ({
    project: r.project, units: num(r.units) ?? 0, sold_units: num(r.sold_units) ?? 0,
    contracted_aed_m: num(r.contracted_aed_m) ?? 0, certified_pct: num(r.certified_pct),
    registered_completion: r.registered_completion || null, status: r.status,
    ready_sales_since_bs: num(r.ready_sales_since_bs) ?? 0, mortgages_since_bs: num(r.mortgages_since_bs) ?? 0,
    completed_after_balance_sheet: r.completed_after_balance_sheet === '1',
  })) : [];
  return { meta, projects, live: projects.filter(p => p.is_live), handover };
}

// The scenario presets come from the one engine file, so the website, the workbook and the tests
// cannot hold three different copies of the same numbers.
// @ts-ignore — plain JavaScript module, deliberately, so it runs unchanged in the browser
import { SCENARIOS as ENGINE_SCENARIOS } from '../engine/escrow.mjs';
export const SCENARIOS = ENGINE_SCENARIOS as { name: string; delay: number; pastdue: number; undated: number;
  cancel: number; sell: number; price: number; book: number; hand: number; ret: number; cap: number }[];

export const SCENARIO_NOTES: Record<string, string> = {
  delay: 'Handover delay added to every registered completion date (months). The register date is what the developer filed.',
  pastdue: 'Months to completion for towers already past their registered date — the register has no useful date for them.',
  undated: 'Months to completion for towers carrying no registered date at all.',
  cancel: 'Share of remaining contracted value never collected, because buyers default on instalments.',
  sell: 'Share of currently unsold units that sell, and start paying, before handover.',
  price: 'Price change applied to the average ticket on those future sales.',
  book: 'Share of the price collected at sale. Between booking and handover, collections track certified progress.',
  hand: 'Share of the price collected at handover — the final instalment.',
  ret: 'RERA retention, held until a year after completion. Treated as unavailable cash.',
  cap: 'Maximum certified progress per month. A tower cannot be certified faster than it can be built.',
};
