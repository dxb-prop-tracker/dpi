// Months of supply: how long the unsold stock would take to clear at the current rate of sale.
//
//   npm run supply    ->  public/data/supply.json
//
// The classic property-cycle measure, and the most honest answer there is to "should I buy now" —
// because it is arithmetic on the register and contains no opinion at all. Six months is generally
// considered balanced; above that is a market with more sellers than buyers. Published per area and
// per project so a reader can see where they are rather than be told.
//
// Two definitions worth arguing about, both stated on the page rather than buried:
//   absorption  units sold in the last ABSORB_DAYS, divided by that many months. A shorter window is
//               more current and noisier; a longer one is steadier and staler.
//   unsold      registered units minus registered off-plan sales. This OVERSTATES unsold wherever the
//               sale record does not name the project, which is common — so the figure is a ceiling
//               on unsold stock, not a count of it, and the page says so.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';

const OUT = path.resolve(process.cwd(), 'public/data');
const ABSORB_DAYS = 180;
const MIN_AREA_UNSOLD = 200;      // below this an area's ratio is noise
const MIN_AREA_ABSORB = 3;        // units a month

function main() {
  const db = openDb();
  const months = ABSORB_DAYS / 30.44;

  const rows = db.prepare(`
    WITH live AS (
      SELECT p.project_number pn, p.name_en nm, p.slug, p.area_name_en area, p.area_slug aslug, p.units units
      FROM project p
      WHERE p.units > 0 AND p.cancellation_date IS NULL
        AND EXISTS (SELECT 1 FROM project_observation o WHERE o.project_number = p.project_number
                    AND COALESCE(o.percent_completed, 0) < 100)),
    sold AS (SELECT project_number pn, COUNT(*) n FROM transaction_
             WHERE trans_group_en='Sales' AND reg_type_en='Off-Plan Properties' GROUP BY 1),
    recent AS (SELECT project_number pn, COUNT(*) n FROM transaction_
               WHERE trans_group_en='Sales' AND instance_date >= date('now','-${ABSORB_DAYS} days') GROUP BY 1)
    SELECT l.*, COALESCE(s.n,0) soldn, COALESCE(r.n,0) recentn
    FROM live l LEFT JOIN sold s ON s.pn=l.pn LEFT JOIN recent r ON r.pn=l.pn`).all() as any[];

  let totalUnsold = 0, totalAbsorb = 0;
  const projects = rows.map(r => {
    const unsold = Math.max(0, r.units - r.soldn);
    const absorb = r.recentn / months;
    totalUnsold += unsold; totalAbsorb += absorb;
    return {
      pn: r.pn, name: r.nm, area: r.area, url: `/dubai/${r.aslug}/${r.slug}/`,
      units: r.units, soldToDate: r.soldn, unsoldCeiling: unsold,
      absorptionPerMonth: Math.round(absorb * 10) / 10,
      monthsOfSupply: absorb > 0 ? Math.round((unsold / absorb) * 10) / 10 : null,
    };
  });

  const byArea = new Map<string, { area: string; unsold: number; absorb: number; projects: number }>();
  for (const r of rows) {
    const cur = byArea.get(r.area) ?? { area: r.area, unsold: 0, absorb: 0, projects: 0 };
    cur.unsold += Math.max(0, r.units - r.soldn);
    cur.absorb += r.recentn / months;
    cur.projects++;
    byArea.set(r.area, cur);
  }
  const areas = [...byArea.values()]
    .filter(a => a.unsold >= MIN_AREA_UNSOLD && a.absorb >= MIN_AREA_ABSORB)
    .map(a => ({ ...a, absorb: Math.round(a.absorb * 10) / 10,
                 monthsOfSupply: Math.round((a.unsold / a.absorb) * 10) / 10 }))
    .sort((x, y) => y.monthsOfSupply - x.monthsOfSupply);

  const out = {
    generatedAt: new Date().toISOString(), absorptionWindowDays: ABSORB_DAYS,
    liveProjects: rows.length,
    unsoldCeiling: totalUnsold,
    absorptionPerMonth: Math.round(totalAbsorb),
    monthsOfSupply: totalAbsorb > 0 ? Math.round((totalUnsold / totalAbsorb) * 10) / 10 : null,
    note: 'Unsold is registered units minus registered off-plan sales, so it is a CEILING on unsold stock: where the sale record does not name the project, sales cannot be matched and the unsold figure reads high. Absorption is sales in the last 180 days over that many months. Areas below 200 unsold units or 3 sales a month are omitted as too thin to read.',
    areas,
    projects: projects.filter(p => p.monthsOfSupply != null).sort((a, b) => (b.monthsOfSupply ?? 0) - (a.monthsOfSupply ?? 0)),
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'supply.json'), JSON.stringify(out));
  console.log(`supply: ${out.liveProjects.toLocaleString()} live projects, ` +
    `${out.unsoldCeiling.toLocaleString()} unsold (ceiling), ${out.absorptionPerMonth.toLocaleString()}/month ` +
    `-> ${out.monthsOfSupply} months of supply market-wide`);
  console.log(`  ${areas.length} areas readable; slowest ${areas[0]?.area} ${areas[0]?.monthsOfSupply}, ` +
    `fastest ${areas[areas.length - 1]?.area} ${areas[areas.length - 1]?.monthsOfSupply}`);
}

main();
