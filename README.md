# Dubai Property Intelligence — starter

A working implementation of the blueprint: DLD register as the system of record, listings only from
permitted sources, validated price drops, delay history, developer scorecards, and rule-correct
mortgage and RoI calculators. Every page is server-rendered at build time from a per-page query, so
nothing exposes the whole dataset and everything is indexable.

## 1. Run it locally (5 minutes)

Requirements: Node 22+ (https://nodejs.org). Then:

```bash
npm install          # installs Astro, SQLite driver, CSV parser
npm run seed         # generates SYNTHETIC sample data and runs the full pipeline
npm run dev          # opens http://localhost:4321
```

`npm run build` writes the static site to `dist/`. `npm run preview` serves that folder.

## 2. Replace the sample data with real data

### Fastest route: the Dubai Pulse bulk files (recommended)
The full DLD open-data dump (transactions since 1975, all Ejari contracts, the complete project and developer
registers, Mollak service charges) lives in Dropbox under `ALI TAMMAM/DLD Open Data`. With Dropbox synced on your Mac:

```bash
npm run prepare:pulse -- "$HOME/Dropbox/ALI TAMMAM/DLD Open Data"   # merges parts, filters rents to 2024+, ~10 min
npm run ingest:dld                                                    # ~8 min
npm run build                                                         # ~8 min for ~5,700 pages
npm run dev
```

### Alternative: the DLD website downloads (recorded prices, rents, projects)
1. Register at https://www.dubaipulse.gov.ae (free tier) or download the current-year CSVs from
   https://dubailand.gov.ae/en/open-data/real-estate-data/.
2. Save them as `data/dld/transactions.csv`, `data/dld/projects.csv`, `data/dld/rents.csv`.
   The DLD site sometimes serves an Excel workbook under a `.csv` name — that's fine, the loader detects it,
   renames it to `.xlsx` and converts it automatically. You can also drop `.xlsx` files in directly.
   Note: the DLD site filters Projects by start date (current year by default); widen the date range to get
   the full register. Transactions/rents are limited to the current year on the site; older years via Dubai Pulse.
3. Run `npm run check:dld` to see which columns were recognised. Both the DLD-website format (UPPERCASE
   headers) and the Dubai Pulse format (lowercase) are built in; add alternatives to the `M` map at the top of
   `ingest/ingest-dld.ts` if a new header appears.
4. `npm run ingest:dld` — safe to re-run daily; it appends a new project observation each run, which is
   how the delay history accumulates.

### Listings (asking prices)
No scraping. The full feed schema and cadence requirements are in `docs/FEED_SPEC.md`, with a
ready-to-send provider outreach draft in `docs/feed-outreach-draft.md`.
Each scan is a CSV at `data/listings/scan-YYYY-MM-DD.csv` with columns
`source,source_id,permit_number,url,area_name_en,project_name_en,building_name_en,unit_number,rooms_en,area_sqm,is_off_plan,asking_price`.
Produce it from a partnered feed export or from your agent-submission portal. Agent contact details are
deliberately not accepted (PDPL). `npm run ingest:listings` ingests any scans not yet loaded and records
absences, which the validator needs.

### Detect drops
`npm run drops` rebuilds the `validated_drop` table using the rules in `ingest/detect-drops.ts`
(continuity, identity, magnitude, off-plan segregation, comp anchor, distress score). Tune `RULES` there.

`npm run pipeline` runs all three in order. Then `npm run build`.

## 3. Turn it into a live website (Azure Static Web Apps)

1. Push this folder to a GitHub repository (`main` branch).
2. Azure portal → Create resource → **Static Web App** → plan Free (upgrade to Standard for a custom
   domain SLA) → Deployment source: **Other** (we bring our own workflow).
3. On the SWA Overview page click **Manage deployment token** and copy it.
4. GitHub repo → Settings → Secrets → Actions → new secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.
5. The workflow in `.github/workflows/azure-static-web-apps.yml` builds and deploys on every push and every
   morning at 06:30 Dubai. Replace its "Seed sample data" step with a step that downloads your DLD CSVs and
   listing scans (e.g. from Azure Blob Storage) before `npm run build`.
6. Custom domain: SWA → Custom domains → add, then set the CNAME at your registrar.

Any other static host (Cloudflare Pages, Netlify, Vercel) works the same way: build command `npm run build`,
output directory `dist`.

## 4. Where things are

| Path | What |
|---|---|
| `ingest/db.ts` | SQLite schema — append-only observation tables are the core design |
| `ingest/ingest-dld.ts` | DLD CSV → database, with column mapping |
| `ingest/ingest-listings.ts` | Listing scans → database, entity resolution (exact → fuzzy → manual queue) |
| `ingest/detect-drops.ts` | Validation rules and distress score |
| `ingest/seed-sample.ts` | Synthetic data generator (delete once real data flows) |
| `src/lib/db.ts` | Build-time queries, one per page section |
| `src/pages/dubai/[area]/[project]/index.astro` | The project hub — the product |
| `src/pages/drops/` | Validated drop feed and permanent per-drop URLs |
| `src/pages/rent/` | Ejari rental section: rents by area/bedroom, new-vs-renewal spread, yields |
| `src/pages/listings/` | Inventory pressure by area (fills when a listing feed lands) |
| `src/pages/tools/rent.astro` | RERA rent-increase cap calculator (Decree 43/2013 slabs on Ejari averages) |
| `src/pages/developers/` | Developer slippage scorecard |
| `docs/FEED_SPEC.md` | Listing-feed spec + provider outreach draft next to it |
| `src/components/Mortgage.astro`, `Roi.astro` | Calculators (rule table with review date in Mortgage.astro) |
| `staticwebapp.config.json` | Azure SWA routing, caching and headers |

## 5. What to build next (from the blueprint)

Watchlists and alerts (needs auth + a small API — Azure Functions), Stripe Pro tier, agent submission
portal with Trakheesi permit validation via the DLD API gateway, Mollak service charges, developer
price-list ingestion for the off-plan comparator, Arabic UI.
