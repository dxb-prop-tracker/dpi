# Listing feed specification

What we need from a listing-data provider (Bayut, Property Finder, or any licensed source), and exactly how it plugs in. Internal Use Only.

## What we ingest

One **scan file per delivery**: a snapshot of all live sale listings at a point in time, dropped into `data/listings/` as:

```
data/listings/scan-YYYY-MM-DD.csv
```

CSV, UTF-8, header row, one row per live listing:

| column | required | example | notes |
|---|---|---|---|
| source | yes | `bayut` | provider slug, stable |
| source_id | yes | `bayut-8837121` | provider's own listing id, stable across the listing's life |
| permit_number | strongly wanted | `7128- 4128- 0- 5219` | Trakheesi advertising permit — this is what lets us tie the listing to the DLD register |
| url | yes | `https://…` | public listing URL (click-out; we never rehost content) |
| area_name_en | yes | `Marsa Dubai` or `Dubai Marina` | provider naming is fine; we alias-match |
| project_name_en | wanted | `Ciel` | |
| building_name_en | wanted | `Ciel Tower` | |
| unit_number | no | | if provided, improves matching; never published |
| rooms_en | yes | `2 B/R` / `Studio` | provider naming is fine |
| area_sqm | yes | `112.4` | built-up, sqm |
| is_off_plan | yes | `1`/`0` | |
| asking_price | yes | `2450000` | AED, current asking |

**Cadence:** daily preferred, weekly minimum. Price-cut detection needs at least two scans at the old price and one after the cut, so weekly cadence means a cut takes ~2–3 weeks to validate; daily means ~3 days.

**Delta vs full snapshot:** full snapshot required. A listing absent from a scan is recorded as unseen — that's how we detect withdrawals and sold stock, and it's the denominator for the months-of-inventory metric.

**What we do NOT want:** agent names, phone numbers, emails, or any personal data (PDPL — we store none of it). Images optional and unused today.

## What happens after ingestion

1. `npm run ingest:listings` loads every new scan; each price is an append-only observation — history is never overwritten.
2. Entity resolution ties each listing to a DLD project (exact name → fuzzy within area → manual queue).
3. `npm run drops` validates cuts: seen at the old price on ≥2 consecutive scans, seen ≥1 scan after the cut, cut ≥2% and ≥AED 25,000, off-plan compared only against off-plan. Validated cuts get a distress score and publish on `/drops/` and on the project's page next to its recorded sales.
4. `/listings/` computes per-area inventory pressure: live listings, cut share, average cut, months of inventory vs recorded sales.

## Commercial notes for the provider conversation

- We link out to every listing (nofollow but real traffic) — the portal keeps the lead.
- We need the **permit_number** field populated; it is mandatory on their platforms already.
- Ask about: API vs SFTP drop, historical backfill (even 6 months of price histories would seed the drops section on day one), rent listings as a phase 2, and per-area coverage stats so we can quote true inventory.
