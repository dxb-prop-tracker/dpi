# Dubai Property Intelligence — source bundle for Ali

Bundle date: 10 September 2026, **second issue**. This replaces the bundle sent earlier the same day,
which contained the duplicate-counting bug you found. Everything below describes the corrected code.

## What this is (and isn't)

It is not a Python project. The site is **TypeScript**: Astro 5 builds static pages at build time by
querying a local SQLite database (`better-sqlite3`); the ingestion and report scripts are TypeScript
run with `tsx`. If you read Python, the TypeScript reads the same way — the logic is all in plain
SQL and small functions.

Nothing in this bundle contains data or credentials. `data/portal.db`, the raw CSVs, the `.dda.json`
API credentials, logs and the built site are all excluded. With the DLD bulk files you already have
from the Dropbox folder, `npm run ingest:dld` rebuilds the database from scratch.

## Start here: the bug you found, and the fix

The three feeds write the same transaction number in two shapes and disagree about the date:

| Feed | Transaction number | Date it carries |
|---|---|---|
| Bulk dump (Dubai Pulse) | `G-P-Y-S` e.g. `1-11-2026-26618` | the next **working** day, for anything registered from about 16:00 |
| Open-data API | `G-P-Y-S` | same as the bulk dump |
| DLD website export | `P-S-Y` e.g. `11-26618-2026` | the day the sale actually happened |

Our duplicate check compared transaction number **and date**, so a sale that both feeds carried under
two dates was stored twice. Measured across the 20,477 duplicated transactions, the gap is +1 day when
the register's own date is Sunday to Thursday, +2 on Saturday and +3 on Friday — every weekend
registration lands on the Monday. It is a batch cut-off, not a timezone.

The fix is in three parts and they are the first thing worth reading:

- **`ingest/tx-key.ts`** — one canonical key for a transaction across all feeds: `procedure|year|serial|group`.
  Verified against the whole register: 1.77m bulk rows produce no collisions at all, and the leading
  digit of the four-part form maps exactly to the group name (1 Sales, 2 Mortgages, 3 Gifts).
- **`tx_key` column + `ux_tx_key` UNIQUE index** (`ingest/db.ts`) — the database itself now refuses a
  second copy of a transaction, whatever date it carries. No amount of loader carelessness can undo it.
- **`feed_date` column** — the date the dump/API filed the row under, kept separately from
  `instance_date` (the register's own date) purely so the withdrawal check can compare like with like.

`ingest/fix-duplicates.ts` (`npm run fix:dups`, `--dry` to preview) is the one-off repair: it merged
20,477 transactions, removed 21,454 duplicate rows, corrected 20,006 dates to the register's own date,
restored fils on 2,621 amounts and filled 1,657 rows with names the website export lacks.

## Where the pieces are

| Folder / file | What it does | Your equivalent to compare |
|---|---|---|
| `ingest/tx-key.ts` | **New.** The canonical transaction key described above, plus the rule that an unrecognised number shape is reported, never guessed at. | Your row identity |
| `ingest/selfcheck.ts` | **New.** `npm run check` — invariants that run at the end of every refresh and fail the build rather than publish: no duplicate keys, the unique index present, every row keyed, no withdrawal that the feed never filed, no month wildly out of scale, and your figures as fixed anchors (Aug 2025 = 18,302, 2025 = 214,606, Jan 2026 = 16,883, Mar 2026 = 13,852). | — |
| `ingest/fix-duplicates.ts` | **New.** The one-off repair, with a dry-run mode. | — |
| `ingest/fetch-dda.ts` | Daily pull from the Digital Dubai open-data API (production credentials, UAE-only): transactions and rent contracts day by day, projects/developers/service charges as whole dumps. Retries, half-dead-connection handling, "give up after 3 failed days", truncated-JSON detection. | Your collector against the DLD public gateway |
| `ingest/fetch-dda.ts` → `refresh()` | Withdrawal detection, **rewritten**: for each complete day (≥3 days old, ≥90% of rows returned) a row we hold **under that feed day** whose canonical key the feed no longer returns is marked withdrawn. Previously it compared `instance_date`, so a sale whose date moved was recorded as withdrawn — which is where the 283 and 294 "withdrawals" in our last two runs came from. | Your gained/restated logic |
| `ingest/db.ts` | Schema. `vintage(kind, id, first_seen, withdrawn_on)` — every transaction, rent contract, project and developer carries the date we first saw it and, if the register stopped returning it, the date it went. | Your vintage/snapshot store |
| `ingest/ingest-dld.ts` | Loads the bulk CSVs into SQLite. Now keys every row and reports how many the database already held, so a dump that repeats transaction numbers cannot silently drop rows. | — |
| `ingest/ingest-dldweb.ts` | Loads the DLD website export. Where we already hold the sale it **corrects** it — takes the register's own date and the fils — instead of skipping or duplicating it. | — |
| `ingest/ingest-register-extract.ts` | Reads your `Dubai_Project_Register_YYYY-MM-DD.xlsx` extract into dated `project_observation` rows (status, percent complete, completion date) — every reading is kept, never overwritten. | — |
| `ingest/derive.ts` | Derived tables: resale pairs (same unit sold twice), delay flags, area medians. | — |
| `ingest/build-report.ts` | The three report cadences. `movedReport()` is the vintage-to-vintage diff — what your "The register moved" PDF does. | Your register report script |
| `ingest/report-lib.ts` | The market pack: headline vs previous period and year-on-year, monthly series, the same slice across seven years, YTD across years, price bands, biggest deals, area/developer/project leagues, rents, gross yields, resale outcomes, supply pipeline. Medians are true medians via SQLite window functions. | — |
| `src/lib/developers.ts` | Developer profiles: planned vs delivered by year, past-due projects, slippage, sales momentum, resale outcomes. | — |
| `data/issuers/*.json` | Credit dossiers for the three sukuk issuers (Binghatti, Sobha, Arada): accounts, ratios, bonds, maturity wall, ratings history, our view. Hand-researched, dated. | — |
| `src/pages/**` | The pages. Every chart and table has a "What this shows / How to read it" caption. | Your Azure dashboard |
| `scripts/daily-refresh.sh` | The 15:00 Dubai launchd job: fetch → ingest → derive → **check** → report → build → PDF → upload. | — |

## The four report errors you listed, and what changed

1. **Developer shares.** The table showed one share computed against ALL sales under a heading that said
   "share of linked sales". It now carries both, each labelled: Azizi in August is 31.9% of linked sales
   and 20.9% of all sales, with 7,894 of the month's 12,067 sales linking to a registered developer.
2. **Two past-due totals on one page.** The tile counted active projects past their date (67,846); the
   chart counted live projects whose completion YEAR had passed (39,043). There is now one population —
   live, meaning active plus pending plus not-started — and one test, completion date in the past:
   74,124 units in 285 projects, everywhere on the page.
3. **Bars that summed to nothing.** The completion-year chart excluded the 60,679 units the register
   carries with no completion date. That column is now shown and labelled, so the bars sum to 357,289,
   which is the tile above them.
4. **"Due within a year" containing past-due projects.** Fixed by (2): everything overdue since January
   had been sitting in the current-year bar. "Due within twelve months" is now 76,451 units, none late.

## Where our numbers still differ from yours, by construction

1. **Source.** We pull the Digital Dubai API; you pull the DLD public gateway. Same register, different
   feeds: our `dld_projects` dataset has carried `load_timestamp 2026-06-15` in every daily dump since
   June — the API's project register is stale, while your gateway extract of 30 August was fresh. Our
   project-status and percent-complete readings therefore come from the June API dump plus your extract,
   and progress jumps between the two sources are flagged `suspect` rather than counted.
2. **Off-plan.** August 2026: 8,149 for us against 8,270 for you — we are now 1.5% BELOW you, on what
   should be the same `reg_type_en = 'Off-Plan Properties'` flag. Worth finding those rows together.
3. **Pipeline scope.** Our 1,433 live projects are 860 active, 391 not started, 170 pending, 12
   conditional. Our 860 active is close to your 842, so we are reading the same register with a wider
   filter, not one twice the size.
4. **Medians, not means.** All AED/sqm figures are medians of `actual_worth / procedure_area` per row;
   apartments and villas are computed separately.
5. **Rents.** "New" contracts are `contract_reg_type_en LIKE 'New%'` (renewals `Renew%`); rent medians
   cover flats and villas only.

## Running it

```
npm install
npm run ingest:dld            # bulk CSVs from data/dld/ → data/portal.db (takes a while)
npm run fix:dups              # only needed on a database built before 10 Sep 2026
npm run derive && npm run check
npm run report -- --backfill --force
npm run build && npm run preview   # http://localhost:4321
```

`npm run check` is the one to run first if anything ever looks wrong. The API pull
(`npm run fetch:dda -- --refresh`) needs the `.dda.json` credentials and a UAE IP; you don't need it to
run the site from the bulk files.

## What we'd like from you

Your collector for the project register (whatever produces `Dubai_Project_Register_*.xlsx`) is the
piece we don't have a fresh source for. If it can run daily and drop the file in the Dropbox folder,
`npm run ingest:register` picks it up unchanged — and our stale-register problem goes away.
