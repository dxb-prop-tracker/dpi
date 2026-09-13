// Build-time prose: plain-English sentences generated from the data, in a buyer's order.
// Rules, not guesses: every sentence states its sample size or its date, and says nothing
// when the data is too thin to support it.
import { areaLabel } from './db';
export const roomsText = (r: string | null | undefined) => { const s = (r ?? '').trim(); const m = s.match(/^(\d+)\s*B\/R/i); if (m) return `${m[1]}-bedroom`; if (/^studio/i.test(s)) return 'studio'; if (/^penthouse/i.test(s)) return 'penthouse'; return s ? s.toLowerCase() : 'unclassified'; };
// Community + area without repeating ourselves ("Jumeirah Village Circle (JVC (Jumeirah Village Circle))").
export const placeText = (master: string | null | undefined, area: string) => { const a = short(area); const m = (master ?? '').trim(); if (!m) return a; if (a.toLowerCase().includes(m.toLowerCase()) || m.toLowerCase().includes(a.toLowerCase())) return a; return `${m} (${a})`; };

const n = (v: number | null | undefined, dp = 0) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: dp });
export const aedM = (v: number | null | undefined) => v == null ? '—' : v >= 1e9 ? `AED ${(v / 1e9).toFixed(1)}bn` : v >= 1e6 ? `AED ${(v / 1e6).toFixed(2)}m` : `AED ${n(v)}`;
const pctText = (x: number, dp = 0) => `${Math.abs(x * 100).toFixed(dp)}%`;
export const short = (area: string) => areaLabel(area).split(' · ')[0];
const dateText = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  if (isNaN(+d)) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const daysSince = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / 86400000);
const monthsBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / (30.4 * 86400000));
const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];

// ---- 1. What is this project? ----
export function projectIntro(p: any, latest: any): string {
  const homes = (p.units ?? 0) + (p.villas ?? 0);
  const kind = p.villas && !p.units ? 'villa community' : p.buildings > 1 ? `${p.buildings}-building development` : 'development';
  const where = placeText(p.master_project_en, p.area_name_en);
  const parts: string[] = [];
  parts.push(`${p.name_en} is a ${homes ? n(homes) + '-home ' : ''}${kind} in ${where}${p.developer ? `, built by ${p.developer}` : ''}.`);
  const st = latest?.status;
  const start = dateText(p.project_start_date), due = dateText(latest?.completion_date);
  if (st === 'FINISHED') parts.push(`The register records it as completed${due ? ` on ${due}` : ''}.`);
  else if (st === 'CANCELLED') parts.push(`The register records it as cancelled${p.cancellation_date ? ` on ${dateText(p.cancellation_date)}` : ''}.`);
  else if (st === 'ACTIVE') parts.push(`It is being built now${start ? `, having started on ${start}` : ''}${due ? `, and is registered to finish by ${due}` : ''}.`);
  else if (st) parts.push(`It is registered but building has not started${due ? `; the registered finish date is ${due}` : ''}.`);
  if (p.escrow_agent_en) parts.push(`Buyers' money is held in a government-supervised escrow account (${p.escrow_agent_en}).`);
  if (p.project_value) parts.push(`Registered project value: ${aedM(p.project_value)}.`);
  return parts.join(' ');
}

// ---- 2. Is it actually being built? ----
export function buildVerdict(latest: any, hist: any[]): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; label: string } {
  if (!latest) return { text: 'The register has no construction reading for this project yet.', tone: 'muted', label: 'No reading' };
  const st = latest.status, pct = latest.percent_completed, obs = latest.observed_at;
  if (st === 'FINISHED') return { text: `Inspectors certified this project complete${latest.completion_date ? ` on ${dateText(latest.completion_date)}` : ''}.`, tone: 'ok', label: 'Completed' };
  if (st === 'CANCELLED') return { text: 'This project has been cancelled on the register.', tone: 'bad', label: 'Cancelled' };
  const ago = obs ? daysSince(obs) : null;
  let text = pct != null ? `Inspectors last certified this project ${n(pct, pct % 1 ? 1 : 0)}% complete${obs ? `, as at ${dateText(obs)}${ago != null && ago > 0 ? ` (${ago} days ago)` : ''}` : ''}.` : `The register lists it as ${String(st ?? '').toLowerCase().replace(/_/g, ' ')}.`;
  let tone: 'ok' | 'warn' | 'bad' | 'muted' = 'ok', label = 'On the register\'s timetable';
  if (latest.completion_date) {
    const late = monthsBetween(latest.completion_date, new Date().toISOString().slice(0, 10));
    if (late > 0 && (pct ?? 0) < 100) { tone = late > 6 ? 'bad' : 'warn'; label = `${late} month${late === 1 ? '' : 's'} past its registered finish date`; text += ` That finish date has passed: the project is ${late} month${late === 1 ? '' : 's'} beyond the date registered with the DLD, and inspectors have not certified it complete.`; }
    else if ((pct ?? 0) < 100 && latest.completion_date) {
      const left = -late;
      if (pct != null && left <= 6 && pct < 60) { tone = 'warn'; label = 'Behind the curve'; text += ` With ${left} month${left === 1 ? '' : 's'} to the registered finish date and ${n(pct)}% certified, building work looks behind the timetable the developer registered.`; }
      else text += ` The registered finish date is ${dateText(latest.completion_date)}.`;
    }
  }
  const first = hist.find(h => h.completion_date)?.completion_date;
  if (first && latest.completion_date && first !== latest.completion_date) {
    const slip = monthsBetween(first, latest.completion_date);
    if (slip > 0) text += ` The finish date has moved ${slip} month${slip === 1 ? '' : 's'} later since we first recorded it (${dateText(first)}).`;
  }
  return { text, tone, label };
}

// ---- 3. What does it sell for? ----
export function salesSummary(rows: any[], txCount: number, areaName: string, areaPsm?: number | null): string {
  const cls = rows.filter(r => !r.unclassified);
  const n12 = cls.reduce((s, r) => s + r.n, 0);
  if (!n12) return txCount ? `No home in this project has changed hands in the last 12 months; the register holds ${n(txCount)} earlier sales.` : 'The Land Department has not recorded a sale in this project yet.';
  const wPsm = cls.reduce((s, r) => s + r.psm * r.n, 0) / n12;
  const top = [...cls].sort((a, b) => b.n - a.n)[0];
  let s = `${n(n12)} home${n12 === 1 ? '' : 's'} sold here in the last 12 months at an average recorded price of AED ${n(wPsm)} per square metre`;
  if (areaPsm && wPsm) { const d = wPsm / areaPsm - 1; s += Math.abs(d) < 0.02 ? `, in line with ${short(areaName)} as a whole` : `, ${pctText(d)} ${d > 0 ? 'above' : 'below'} the ${short(areaName)} average`; }
  s += `. The most traded type is the ${roomsText(top.rooms)} (${n(top.n)} sales, averaging ${aedM(top.price)}).`;
  return s;
}

// ---- 4. Is that a fair price? ----
export function compsVerdict(self: any, others: any[], community: string | null): string {
  let kind: 'ready' | 'off-plan' = 'ready', mine: number | null = null, peers: number[] = [];
  for (const k of ['ready', 'off-plan'] as const) {
    const m = k === 'ready' ? (self.secN >= 5 ? self.secPsm : null) : (self.offN >= 5 ? self.offPsm : null);
    const ps = others.filter(o => (k === 'ready' ? o.secN >= 5 : o.offN >= 5)).map(o => k === 'ready' ? o.secPsm : o.offPsm);
    if (m && ps.length >= 3) { kind = k; mine = m; peers = ps; break; }
  }
  if (!mine || peers.length < 3) return `Too few comparable sales nearby in the last 12 months to call this fairly priced or not — the table shows what there is.`;
  const avg = peers.reduce((a, b) => a + b, 0) / peers.length;
  const d = mine / avg - 1;
  const where = community ? community : 'the same registry area';
  if (Math.abs(d) < 0.03) return `On ${kind} sales, this project trades in line with the ${peers.length} most active projects in ${where} (AED ${n(mine)} vs AED ${n(avg)} per sqm).`;
  return `On ${kind} sales, this project trades ${pctText(d)} ${d > 0 ? 'above' : 'below'} the average of the ${peers.length} most active projects in ${where} (AED ${n(mine)} vs AED ${n(avg)} per sqm). ${d > 0 ? 'A premium is not wrong in itself — but it should be earned by the building, not the brochure.' : 'A discount can mean value, or it can mean the market knows something; check the delay history above.'}`;
}

// ---- 5. What could it earn? ----
export function yieldSentence(y: any, areaName: string): string | null {
  if (!y || !y.rpsm || !y.spsm || y.rn < 30 || y.sn < 10) return null;
  const gy = y.rpsm / y.spsm;
  return `A finished home in ${short(areaName)} typically changes hands at AED ${n(y.spsm)} per square metre (${n(y.sn)} recorded sales). Tenants pay around AED ${n(y.rpsm)} a year for each square metre (${n(y.rn)} registered contracts). That works out at a gross rental return of about ${pctText(gy, 1)} a year before service charges.`;
}

// ---- Area / market summaries (Rightmove-style opening paragraph) ----
export function areaSummary(a: any, resale: any, y: any): string {
  const parts: string[] = [];
  const name = short(a.name);
  if (a.psm90 && a.n90 >= 30) {
    let s = `Homes in ${name} sold at an average recorded price of AED ${n(a.psm90)} per square metre over the last three months`;
    if (a.psmLy && a.nLy >= 30) { const d = a.psm90 / a.psmLy - 1; s += `, ${pctText(d, 1)} ${d >= 0 ? 'up' : 'down'} on the same period a year earlier`; }
    parts.push(s + '.');
  }
  if (a.tx12m) parts.push(`${n(a.tx12m)} sales were registered in the last 12 months, worth ${aedM(a.valueBn * 1e9)}${a.offplanPct != null ? `, ${a.offplanPct}% of them off-plan` : ''}.`);
  if (resale?.n >= 30) parts.push(`Of ${n(resale.n)} homes resold on the same specification in the last year, ${resale.lossPct}% went for less than the seller paid.`);
  const ys = yieldSentence(y, a.name); if (ys) parts.push(ys);
  return parts.join(' ');
}

export function marketSummary(series: any[], rs: any, rents: any, gains: any): string {
  const last = series.at(-1), ya = series.find(r => r.m === `${+last.m.slice(0, 4) - 1}${last.m.slice(4)}`);
  const parts: string[] = [];
  if (last?.psm) { let s = `The middle recorded price for a Dubai apartment was AED ${n(last.psm)} per square metre in ${new Date(last.m + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`; if (ya?.psm) { const d = last.psm / ya.psm - 1; s += `, ${pctText(d, 1)} ${d >= 0 ? 'higher' : 'lower'} than a year earlier`; } parts.push(s + '.'); }
  if (rs?.n) parts.push(`Of ${n(rs.n)} same-specification resales in the last year, ${Math.round(100 * rs.losses / rs.n)}% were sold at a loss.`);
  if (rents?.rentNew && rents?.rentRenew) parts.push(`New tenants pay ${pctText(rents.rentNew / rents.rentRenew - 1)} more than sitting tenants renewing.`);
  if (gains) parts.push(`Buyers who bought off-plan and resold in the last two years made a median gain of ${gains.median >= 0 ? '+' : '−'}${pctText(gains.median)} after about ${gains.holdMonths} months (${n(gains.n)} resales; a quarter made less than ${gains.q1 >= 0 ? '+' : '−'}${pctText(gains.q1)}).`);
  return parts.join(' ');
}

export function gainsSentence(g: any, where: string): string | null {
  if (!g) return null;
  return `Of the homes in ${where} bought off-plan and resold in the last two years, buyers made a median gain of ${g.median >= 0 ? '+' : '−'}${pctText(g.median)} over about ${g.holdMonths} months, based on ${n(g.n)} resales. A quarter made less than ${g.q1 >= 0 ? '+' : '−'}${pctText(g.q1)}; a quarter made more than +${pctText(g.q3)}. ${g.losses ? `${n(g.losses)} of them (${Math.round(100 * g.losses / g.n)}%) sold for less than they paid.` : 'None sold at a loss.'}`;
}

export { list, dateText, n as num };
