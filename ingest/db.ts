// Shared SQLite connection + schema. Append-only observation tables are the core design:
// nothing is ever overwritten, so delay history and price history are preserved.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DB_PATH = path.resolve(process.cwd(), 'data/portal.db');

export function openDb(readonly = false) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH, { readonly });
  db.pragma('journal_mode = WAL');
  if (!readonly) migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS developer (
    developer_number TEXT PRIMARY KEY,
    name_en TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS project (
    project_number TEXT PRIMARY KEY,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    slug TEXT NOT NULL,
    area_name_en TEXT NOT NULL,
    area_slug TEXT NOT NULL,
    developer_number TEXT,
    master_project_en TEXT,
    escrow_agent_en TEXT,
    project_start_date TEXT,
    project_value REAL,
    units INTEGER,
    villas INTEGER,
    buildings INTEGER,
    cancellation_date TEXT,
    UNIQUE(area_slug, slug)
  );

  -- Every observed value of status / completion date / percent complete, with the time we saw it.
  CREATE TABLE IF NOT EXISTS project_observation (
    id INTEGER PRIMARY KEY,
    project_number TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    status TEXT,
    percent_completed REAL,
    completion_date TEXT,
    source TEXT NOT NULL,
    UNIQUE(project_number, observed_at, source)
  );

  CREATE TABLE IF NOT EXISTS transaction_ (
    transaction_id TEXT PRIMARY KEY,
    instance_date TEXT NOT NULL,
    trans_group_en TEXT,
    procedure_name_en TEXT,
    reg_type_en TEXT,          -- Existing Properties / Off-Plan Properties
    property_type_en TEXT,
    property_sub_type_en TEXT,
    property_usage_en TEXT,
    area_name_en TEXT,
    building_name_en TEXT,
    project_number TEXT,
    project_name_en TEXT,
    rooms_en TEXT,
    procedure_area REAL,       -- sqm
    actual_worth REAL,         -- AED
    meter_sale_price REAL      -- AED / sqm
  );
  CREATE INDEX IF NOT EXISTS ix_tx_project ON transaction_(project_number, instance_date);
  CREATE INDEX IF NOT EXISTS ix_tx_area ON transaction_(area_name_en, instance_date);

  CREATE TABLE IF NOT EXISTS rent_contract (
    contract_id TEXT PRIMARY KEY,
    contract_start_date TEXT,
    contract_reg_type_en TEXT, -- New / Renew
    annual_amount REAL,
    area_name_en TEXT,
    project_name_en TEXT,
    project_number TEXT,
    ejari_property_type_en TEXT,
    rooms_en TEXT,
    actual_area REAL
  );
  CREATE INDEX IF NOT EXISTS ix_rent_project ON rent_contract(project_number, contract_start_date);
  CREATE INDEX IF NOT EXISTS ix_rent_area ON rent_contract(area_name_en, contract_start_date);

  -- Listings come ONLY from partnered feeds or agent submissions carrying a Trakheesi permit.
  -- Agent contact data is never stored here; the click-out URL carries it.
  CREATE TABLE IF NOT EXISTS listing (
    listing_id TEXT PRIMARY KEY,   -- source:source_id
    source TEXT NOT NULL,
    permit_number TEXT,
    permit_validated INTEGER DEFAULT 0,
    url TEXT,
    area_name_en TEXT,
    project_number TEXT,
    building_name_en TEXT,
    unit_number TEXT,
    rooms_en TEXT,
    area_sqm REAL,
    is_off_plan INTEGER DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    resolution_confidence REAL DEFAULT 0,
    resolution_method TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_listing_project ON listing(project_number);

  CREATE TABLE IF NOT EXISTS listing_price_observation (
    id INTEGER PRIMARY KEY,
    listing_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    asking_price REAL NOT NULL,
    seen INTEGER NOT NULL DEFAULT 1,   -- 0 = scan ran but listing was absent
    UNIQUE(listing_id, observed_at)
  );

  -- Mollak service-charge budgets (per building / property group / category / year).
  CREATE TABLE IF NOT EXISTS service_charge (
    id INTEGER PRIMARY KEY,
    budget_year INTEGER, project_id TEXT, project_name TEXT, master_community TEXT, management_company TEXT,
    property_group TEXT, category TEXT, usage TEXT, cost REAL,
    UNIQUE(budget_year, project_id, property_group, category, usage)
  );
  CREATE INDEX IF NOT EXISTS ix_sc_project ON service_charge(project_name, budget_year);

  -- Vintages: when a row first appeared in OUR copy of the register and, for sales, when the register
  -- stopped returning it (a cancelled or corrected entry). Rows with no vintage predate this tracking.
  CREATE TABLE IF NOT EXISTS vintage (
    kind TEXT NOT NULL,            -- tx | rent | developer | project
    id TEXT NOT NULL,
    first_seen TEXT NOT NULL,      -- YYYY-MM-DD
    withdrawn_on TEXT,             -- YYYY-MM-DD, sales only
    PRIMARY KEY(kind, id)
  );
  CREATE INDEX IF NOT EXISTS ix_vintage_seen ON vintage(kind, first_seen);
  CREATE INDEX IF NOT EXISTS ix_vintage_gone ON vintage(kind, withdrawn_on);
  CREATE INDEX IF NOT EXISTS ix_tx_date ON transaction_(instance_date);

  -- One row per data refresh: what was fetched, what was new, what went wrong. Feeds the report's integrity panel.
  CREATE TABLE IF NOT EXISTS refresh_run (
    run_date TEXT PRIMARY KEY,     -- YYYY-MM-DD (last run of the day wins)
    started_at TEXT, finished_at TEXT,
    tx_fetched INTEGER, tx_new INTEGER, tx_withdrawn INTEGER, tx_days_failed INTEGER,
    rent_fetched INTEGER, rent_new INTEGER,
    register_rows INTEGER, register_stamp TEXT,
    notes TEXT
  );

  -- Derived. Rebuilt by detect-drops.ts on every run.
  CREATE TABLE IF NOT EXISTS validated_drop (
    listing_id TEXT PRIMARY KEY,
    project_number TEXT,
    area_name_en TEXT,
    first_price REAL,
    current_price REAL,
    drop_count INTEGER,
    cumulative_pct REAL,
    last_drop_at TEXT,
    days_tracked INTEGER,
    recorded_median_psm REAL,
    asking_psm REAL,
    gap_to_recorded_pct REAL,
    distress_score INTEGER,
    validation_notes TEXT
  );
  `);
  // Transaction identity and feed date. tx_key is the canonical number (see ingest/tx-key.ts) and is
  // the ONLY thing a duplicate check may use — the three feeds disagree about the date, so matching on
  // date let the same sale in twice. feed_date is the date the bulk dump / API filed the row under
  // (the next working day for late registrations); the withdrawal check compares days on that, while
  // instance_date carries the register's own date. Populated by `npm run fix:dups`, which also adds
  // the unique index once the existing duplicates are merged away.
  const txCols = (db.prepare(`PRAGMA table_info(transaction_)`).all() as any[]).map(c => c.name);
  if (!txCols.includes('tx_key')) db.exec(`ALTER TABLE transaction_ ADD COLUMN tx_key TEXT`);
  if (!txCols.includes('feed_date')) db.exec(`ALTER TABLE transaction_ ADD COLUMN feed_date TEXT`);
  // lands (14 Sep 2026): the register counts a villa community's homes as PLOTS (no_of_lands / CNT_LAND) —
  // Sobha Reserve is 339 lands, 0 units, 0 villas. A project's home capacity is units + villas, or the
  // plots where both are zero; without this column a villa developer's whole book capped to nothing.
  const prCols = (db.prepare(`PRAGMA table_info(project)`).all() as any[]).map(c => c.name);
  if (!prCols.includes('lands')) db.exec(`ALTER TABLE project ADD COLUMN lands INTEGER`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_tx_feed ON transaction_(feed_date)`);

  // Vintage backfill: sales added by the API refresh carry their run date in the id ('…#a20260903…').
  db.exec(`INSERT OR IGNORE INTO vintage(kind,id,first_seen)
    SELECT 'tx', transaction_id, substr(transaction_id, instr(transaction_id,'#a')+2, 4)||'-'||substr(transaction_id, instr(transaction_id,'#a')+6, 2)||'-'||substr(transaction_id, instr(transaction_id,'#a')+8, 2)
    FROM transaction_ WHERE transaction_id LIKE '%#a2%'`);
}

export function slugify(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
