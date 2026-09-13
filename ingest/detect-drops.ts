// Drop detection + validation. Implements §5.3 of the blueprint.
// A drop is PUBLISHED only if it passes every rule; the headline count is the validated count.
import { openDb } from './db.js';

const RULES = {
  minScansBefore: 2,      // continuity: seen in >=2 consecutive scans before the change
  minScansAfter: 1,       // ...and >=1 after
  minPct: 0.02,           // magnitude: >=2%
  minAed: 25_000,         // ...and >= AED 25k (secondary market)
  compWindowDays: 90,     // recorded-comp anchor window
};

const db = openDb();
db.exec('DELETE FROM validated_drop');

const listings = db.prepare(`SELECT * FROM listing`).all() as any[];
const obsFor = db.prepare(`SELECT observed_at, asking_price, seen FROM listing_price_observation WHERE listing_id=? ORDER BY observed_at`);
const compPsm = db.prepare(`
  SELECT meter_sale_price AS psm FROM transaction_
  WHERE project_number=? AND trans_group_en LIKE 'Sales%' AND meter_sale_price>0
    AND (?='' OR rooms_en=?) AND instance_date >= date('now', ?)
  ORDER BY psm`);
const areaDom = db.prepare(`SELECT AVG(julianday('now')-julianday(first_seen_at)) d FROM listing WHERE area_name_en=?`);
const projDelay = db.prepare(`
  SELECT (julianday(MAX(completion_date)) - julianday(MIN(completion_date)))/30.4 AS slip_months
  FROM project_observation WHERE project_number=? AND completion_date IS NOT NULL`);
const ins = db.prepare(`INSERT INTO validated_drop VALUES(@listing_id,@project_number,@area,@first,@current,@count,@cum,@last,@days,@recMed,@askPsm,@gap,@score,@notes)`);

const median = (a: number[]) => a.length ? a[Math.floor(a.length / 2)] : null;
let published = 0, rejected: Record<string, number> = {};

db.transaction(() => {
  for (const l of listings) {
    const obs = obsFor.all(l.listing_id) as { observed_at: string; asking_price: number; seen: number }[];
    const seenObs = obs.filter(o => o.seen);
    if (seenObs.length < RULES.minScansBefore + 1) { rejected['too-few-scans'] = (rejected['too-few-scans'] ?? 0) + 1; continue; }

    // Walk observations; count validated drops.
    let streak = 0, drops: { at: string; from: number; to: number }[] = [], notes: string[] = [];
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (!o.seen) { streak = 0; continue; }
      const prev = i > 0 ? obs[i - 1] : null;
      if (prev && prev.seen && o.asking_price < prev.asking_price) {
        const pct = (prev.asking_price - o.asking_price) / prev.asking_price;
        const aed = prev.asking_price - o.asking_price;
        const after = obs.slice(i + 1).filter(x => x.seen).length + 1; // this observation counts as seen-after
        const passMag = l.is_off_plan ? pct >= RULES.minPct : (pct >= RULES.minPct && aed >= RULES.minAed);
        if (streak >= RULES.minScansBefore && after >= RULES.minScansAfter && passMag) drops.push({ at: o.observed_at, from: prev.asking_price, to: o.asking_price });
        else notes.push(`unvalidated cut ${o.observed_at} (streak ${streak}, ${(pct * 100).toFixed(1)}%)`);
      }
      streak++;
    }
    if (!drops.length) { rejected['no-validated-drop'] = (rejected['no-validated-drop'] ?? 0) + 1; continue; }
    if (!seenObs.at(-1) || obs.at(-1)!.seen === 0) { rejected['currently-delisted'] = (rejected['currently-delisted'] ?? 0) + 1; continue; }

    const first = seenObs[0].asking_price, current = seenObs.at(-1)!.asking_price;
    const cum = (first - current) / first;
    const days = Math.round((Date.parse(seenObs.at(-1)!.observed_at) - Date.parse(seenObs[0].observed_at)) / 86400000);

    // Comp anchor
    let recMed: number | null = null, askPsm: number | null = null, gap: number | null = null;
    if (l.project_number) {
      const psms = (compPsm.all(l.project_number, l.rooms_en ?? '', l.rooms_en ?? '', `-${RULES.compWindowDays} days`) as any[]).map(x => x.psm);
      recMed = median(psms);
      if (!recMed) recMed = median((compPsm.all(l.project_number, '', '', '-365 days') as any[]).map(x => x.psm));
      if (recMed && l.area_sqm) { askPsm = current / l.area_sqm; gap = (askPsm - recMed) / recMed; }
    }

    // Distress score 0–100
    const dom = (areaDom.get(l.area_name_en) as any)?.d ?? days;
    const slip = l.project_number ? ((projDelay.get(l.project_number) as any)?.slip_months ?? 0) : 0;
    let score = 0;
    score += Math.min(30, drops.length * 10);                       // number of validated drops
    score += Math.min(25, cum * 100 * 1.5);                         // cumulative % cut
    score += days > dom * 1.5 ? 15 : days > dom ? 8 : 0;            // long DOM vs area
    score += gap != null ? (gap < -0.05 ? 20 : gap < 0 ? 10 : 0) : 0; // asking below recorded comps
    score += Math.min(10, slip);                                    // developer delay months
    ins.run({ listing_id: l.listing_id, project_number: l.project_number, area: l.area_name_en, first, current, count: drops.length, cum,
      last: drops.at(-1)!.at, days, recMed, askPsm, gap, score: Math.round(score), notes: notes.join('; ') || null });
    published++;
  }
})();

console.log(`validated drops published: ${published}`);
console.log('rejected:', rejected);
db.close();
