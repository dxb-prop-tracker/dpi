// B16 — the escrow release rule, two ways, on the same register rows (14 Sep 2026).
// Value rule (both engines today): released = collected × certified progress.
// Cost rule (what the DLD says the trustee pays out): construction cost certified to date (a share of the
// tower's value) plus marketing up to 5% of sales, never more than what the escrow holds.
// Usage: node tools/release_rule.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { SCENARIOS, projectRow, collectedShare } from '../src/engine/escrow.mjs';
const reported = { sobha: 4470, binghatti: 10184 };
const issuerPct = { '2948':85, '2717':92, '2826':81, '2793':80, '2583':80, '2482':100, '2564':100 };
function csv(t){const L=t.trim().split('\n');const h=L[0].split(',');return L.slice(1).map(l=>{const c=[];let cur='',q=false;for(const ch of l){if(ch=='"'){q=!q}else if(ch==','&&!q){c.push(cur);cur=''}else cur+=ch}c.push(cur);return Object.fromEntries(h.map((k,i)=>[k,c[i]]))})}
for (const iss of ['sobha','binghatti']) {
  const rows = csv(fs.readFileSync(path.join(ROOT, `public/data/issuers/${iss}-register.csv`),'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, `public/data/issuers/${iss}-meta.json`),'utf8'));
  const asOf = new Date(meta.registerLastRead+'T00:00:00Z'); const s = {...SCENARIOS[0], book: iss==="binghatti" ? 0.20 : 0.10};
  for (const mode of ['register', 'issuer']) {
    for (const costShare of [0.55, 0.65]) {
      let col=0, relValue=0, relCost=0;
      for (const r of rows) { if (r.is_live!=='1') continue;
        let cert=+r.certified_pct||0; if (mode==='issuer' && iss==='sobha' && issuerPct[r.project_number]!=null) cert=issuerPct[r.project_number];
        const p = projectRow({units:+r.units||0, sold:+r.sold_units||0, ticket:+r.avg_ticket_aed||0, cert, completion:r.registered_completion?new Date(r.registered_completion+'T00:00:00Z'):null, asOf, s});
        col += p.collectedToDate; relValue += p.releasedToDate;
        // cost-based release: construction cost certified to date (costShare of the tower's value incl. unsold, but escrow only holds sold collections) + marketing up to 5% of sales, capped at what is collected
        const towerValue = (+r.units||+r.sold_units||0) * (+r.avg_ticket_aed||0) / 1e6;
        const costToDate = costShare * towerValue * cert/100;
        const marketing = 0.05 * p.contracted;
        relCost += Math.min(p.collectedToDate, costToDate + marketing);
      }
      if (costShare===0.55 || mode==='issuer') console.log(`${iss} ${mode} readings, cost ${costShare}: collected ${col.toFixed(0)} | value-rule held ${(col-relValue).toFixed(0)} | cost-rule held ${(col-relCost).toFixed(0)} | reported ${reported[iss]}`);
      if (iss==='binghatti' && mode==='issuer') break;
    }
  }
}
