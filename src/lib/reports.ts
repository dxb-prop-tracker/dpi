// Report editions written by `npm run report` (ingest/build-report.ts) — read at build time.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'data/reports');
export type Report = any;
export type Kind = 'weekly' | 'monthly' | 'yearly';

const cache = new Map<string, { key: string; report: Report }[]>();
export function listReports(kind: Kind = 'weekly'): { key: string; date: string; report: Report }[] {
  if (cache.has(kind)) return cache.get(kind)! as any;
  const dir = path.join(ROOT, kind);
  const out = !fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse()
    .map(f => ({ key: f.slice(0, -5), date: f.slice(0, -5), report: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  cache.set(kind, out);
  return out;
}
export const latestReport = (kind: Kind = 'weekly') => listReports(kind)[0] ?? null;
export const reportUrl = (kind: Kind, key: string) => `/reports/${kind}/${key}/`;

export const fmtDate = (iso?: string | null, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }) =>
  iso ? new Date(iso.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' }) : '—';
export const fmtDay = (iso?: string | null) => fmtDate(iso, { day: 'numeric', month: 'long' });
export const n = (x: number | null | undefined) => x == null ? '—' : Math.round(x).toLocaleString('en-US');
export const signed = (x: number | null | undefined, d = 0) => x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(d);
export const monthName = (m: string) => new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
export const statusWord = (s?: string | null) => !s ? '—' : ({ ACTIVE: 'Active', FINISHED: 'Finished', PENDING: 'Pending', NOT_STARTED: 'Not started', CANCELLED: 'Cancelled', CONDITIONAL_ACTIVATING: 'Conditional activating', FRIEZED: 'Frozen' } as Record<string, string>)[s] ?? s;
