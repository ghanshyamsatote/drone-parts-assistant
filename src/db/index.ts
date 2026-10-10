import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

// SQLite via Node's built-in driver: zero setup, one file, no native build.
// Plenty for a single-process take-home; the repo layer below is the only
// place that touches SQL, so moving to Postgres later is contained.
mkdirSync(dirname(config.DB_PATH), { recursive: true });
export const db = new DatabaseSync(config.DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS watches (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('url','query')),
    value       TEXT NOT NULL,
    label       TEXT NOT NULL,
    chat_id     TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, value, chat_id)
  );

  -- Every product page we have ever seen, with its CURRENT state cached
  -- here so search/filter queries don't need to scan snapshot history.
  CREATE TABLE IF NOT EXISTS products (
    id               INTEGER PRIMARY KEY,
    source           TEXT NOT NULL,
    url              TEXT NOT NULL UNIQUE,
    title            TEXT NOT NULL,
    category         TEXT,
    current_status   TEXT NOT NULL DEFAULT 'unknown',
    current_price    REAL,
    first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked_at  TEXT,
    last_changed_at  TEXT
  );

  -- Which products a watch is responsible for (a query watch can match many).
  CREATE TABLE IF NOT EXISTS watch_products (
    watch_id    INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    PRIMARY KEY (watch_id, product_id)
  );

  -- Append-only history of observations.
  CREATE TABLE IF NOT EXISTS snapshots (
    id          INTEGER PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    price       REAL,
    method      TEXT NOT NULL,
    evidence    TEXT,
    checked_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_product ON snapshots(product_id, checked_at);

  -- Telegram chats that want alerts.
  CREATE TABLE IF NOT EXISTS subscribers (
    chat_id     TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Outbox: every meaningful change the monitor detects. The monitor only
  -- WRITES here; the notifier reads and delivers. If Telegram is down,
  -- events simply wait — nothing is lost and the monitor never blocks.
  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY,
    product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    snapshot_id  INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
    kind         TEXT NOT NULL,  -- back_in_stock | preorder_opened | price_drop | new_listing | went_out_of_stock
    from_status  TEXT,
    to_status    TEXT,
    old_price    REAL,
    new_price    REAL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per (event, chat) delivered. The primary key makes sending
  -- idempotent: a retry or a re-run can never notify a chat twice.
  CREATE TABLE IF NOT EXISTS deliveries (
    event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    chat_id   TEXT NOT NULL,
    sent_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (event_id, chat_id)
  );

  -- One row per monitoring run, for observability ("when did it last run?").
  CREATE TABLE IF NOT EXISTS runs (
    id                INTEGER PRIMARY KEY,
    started_at        TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at       TEXT,
    products_checked  INTEGER NOT NULL DEFAULT 0,
    llm_calls         INTEGER NOT NULL DEFAULT 0,
    errors            INTEGER NOT NULL DEFAULT 0,
    events            INTEGER NOT NULL DEFAULT 0
  );

  DROP TABLE IF EXISTS alerts; -- replaced by events + deliveries
`);

// Tiny additive migrations: CREATE TABLE IF NOT EXISTS doesn't add columns
// to a table that already exists, so new columns are added here.
function ensureColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
ensureColumn('products', 'brand', 'TEXT');
ensureColumn('products', 'attributes', 'TEXT'); // JSON specs extracted by the LLM
ensureColumn('watches', 'last_run_at', 'TEXT'); // null = never run -> first run is a silent baseline

// The table's UNIQUE (kind, value, chat_id) does NOT stop duplicate global
// watches: chat_id is NULL for those, and in SQL NULL != NULL. This index
// treats NULL as '' and ignores case ("Pixhawk 6X" == "pixhawk 6x").
// The DELETE removes duplicates created before the index existed.
db.exec(`
  DELETE FROM watches WHERE id NOT IN (
    SELECT MIN(id) FROM watches GROUP BY kind, lower(value), COALESCE(chat_id, '')
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_watches ON watches (kind, lower(value), COALESCE(chat_id, ''));
`);
