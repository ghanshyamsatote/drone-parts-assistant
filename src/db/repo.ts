import { db } from './index.js';
import type { Product, Snapshot, StockStatus, Watch, WatchKind } from '../types.js';

// The repository is the ONLY module that writes SQL. Everything else
// (monitor, chat agent, bot) calls these functions.

// ---------- watches ----------

export function addWatch(kind: WatchKind, value: string, label: string, chatId: string | null): Watch {
  // Look up first instead of relying on ON CONFLICT: chat_id can be NULL,
  // and NULLs never conflict in a plain UNIQUE constraint (see uq_watches).
  // `IS` compares NULL-safely. Re-adding a removed watch reactivates it.
  const find = () => db
    .prepare(`SELECT * FROM watches WHERE kind = ? AND lower(value) = lower(?) AND chat_id IS ?`)
    .get(kind, value, chatId) as unknown as Watch | undefined;

  const existing = find();
  if (existing) {
    db.prepare(`UPDATE watches SET active = 1, label = ? WHERE id = ?`).run(label, existing.id);
  } else {
    db.prepare(`INSERT INTO watches (kind, value, label, chat_id) VALUES (?, ?, ?, ?)`).run(kind, value, label, chatId);
  }
  return find()!;
}

export function listWatches(chatId?: string): Watch[] {
  // A chat sees its own watches plus the global seed watches.
  const rows = chatId === undefined
    ? db.prepare(`SELECT * FROM watches WHERE active = 1 ORDER BY id`).all()
    : db.prepare(`SELECT * FROM watches WHERE active = 1 AND (chat_id = ? OR chat_id IS NULL) ORDER BY id`).all(chatId);
  return rows as unknown as Watch[];
}

export function deactivateWatch(id: number, chatId: string): boolean {
  // Users may only remove their own watches, not the global seed ones.
  return db.prepare(`UPDATE watches SET active = 0 WHERE id = ? AND chat_id = ?`).run(id, chatId).changes > 0;
}

// ---------- products ----------

/**
 * Insert a discovered product if we haven't seen it. Never overwrites: search
 * titles can be worse than the real page title (Robu's come from URL slugs),
 * so the title is updated from the product page via updateProductTitle.
 */
export function ensureProduct(p: { source: string; url: string; title: string }): { product: Product; created: boolean } {
  const res = db
    .prepare(`INSERT OR IGNORE INTO products (source, url, title) VALUES (?, ?, ?)`)
    .run(p.source, p.url, p.title);
  const product = db.prepare(`SELECT * FROM products WHERE url = ?`).get(p.url) as unknown as Product;
  return { product, created: res.changes > 0 };
}

export function updateProductTitle(id: number, title: string): void {
  db.prepare(`UPDATE products SET title = ? WHERE id = ?`).run(title, id);
}

export function setProductAttributes(id: number, a: { category: string; brand: string | null; specs: Record<string, string> }): void {
  db.prepare(`UPDATE products SET category = ?, brand = ?, attributes = ? WHERE id = ?`)
    .run(a.category, a.brand, JSON.stringify(a.specs), id);
}

export function linkWatchProduct(watchId: number, productId: number): void {
  db.prepare(`INSERT OR IGNORE INTO watch_products (watch_id, product_id) VALUES (?, ?)`).run(watchId, productId);
}

export function getProduct(id: number): Product | undefined {
  return db.prepare(`SELECT * FROM products WHERE id = ?`).get(id) as unknown as Product | undefined;
}

/** Distinct products tracked by the given (active) watches. */
export function productsForWatches(watchIds: number[]): Product[] {
  if (!watchIds.length) return [];
  return db.prepare(
    `SELECT DISTINCT p.* FROM products p
     JOIN watch_products wp ON wp.product_id = p.id
     WHERE wp.watch_id IN (${watchIds.map(() => '?').join(',')})
     ORDER BY p.source, p.id`,
  ).all(...watchIds) as unknown as Product[];
}

/** For demos/tests: rewind a product's state so the next real check produces a transition. */
export function forceProductStatus(id: number, status: StockStatus): void {
  db.prepare(`UPDATE products SET current_status = ? WHERE id = ?`).run(status, id);
  db.prepare(`INSERT INTO snapshots (product_id, status, price, method, evidence) VALUES (?, ?, NULL, 'simulated', 'forced for demo')`)
    .run(id, status);
}

export function markWatchRun(id: number): void {
  db.prepare(`UPDATE watches SET last_run_at = datetime('now') WHERE id = ?`).run(id);
}

// ---------- snapshots ----------

/**
 * Store an observation and update the product's cached current state.
 * Returns the previous status so the caller can decide whether this is a change.
 *
 * Key rule: an 'unknown' result (fetch failed, page unparseable) is recorded
 * in history but does NOT overwrite the current status. Otherwise a single
 * timeout would flip "in stock" -> "unknown" -> "in stock" and fire a
 * bogus "back in stock" alert.
 */
export function recordSnapshot(
  productId: number,
  obs: { status: StockStatus; price: number | null; method: Snapshot['method']; evidence?: string | null },
): { snapshotId: number; previous: StockStatus; previousPrice: number | null; changed: boolean } {
  const product = getProduct(productId);
  if (!product) throw new Error(`Unknown product ${productId}`);
  const previous = product.current_status;
  const previousPrice = product.current_price;

  const res = db
    .prepare(`INSERT INTO snapshots (product_id, status, price, method, evidence) VALUES (?, ?, ?, ?, ?)`)
    .run(productId, obs.status, obs.price, obs.method, obs.evidence ?? null);

  const changed = obs.status !== 'unknown' && obs.status !== previous;
  db.prepare(
    `UPDATE products SET
       last_checked_at = datetime('now'),
       current_status  = CASE WHEN ? = 'unknown' THEN current_status ELSE ? END,
       current_price   = COALESCE(?, current_price),
       last_changed_at = CASE WHEN ? THEN datetime('now') ELSE last_changed_at END
     WHERE id = ?`,
  ).run(obs.status, obs.status, obs.price, changed ? 1 : 0, productId);

  return { snapshotId: Number(res.lastInsertRowid), previous, previousPrice, changed };
}

// ---------- events (outbox) & runs ----------

export interface NewEvent {
  productId: number;
  snapshotId: number | null;
  kind: string;
  fromStatus: StockStatus | null;
  toStatus: StockStatus | null;
  oldPrice: number | null;
  newPrice: number | null;
}

export function insertEvent(e: NewEvent): number {
  return Number(db.prepare(
    `INSERT INTO events (product_id, snapshot_id, kind, from_status, to_status, old_price, new_price)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.productId, e.snapshotId, e.kind, e.fromStatus, e.toStatus, e.oldPrice, e.newPrice).lastInsertRowid);
}

export function startRun(): number {
  return Number(db.prepare(`INSERT INTO runs DEFAULT VALUES`).run().lastInsertRowid);
}

export function finishRun(id: number, s: { checked: number; llmCalls: number; errors: number; events: number }): void {
  db.prepare(
    `UPDATE runs SET finished_at = datetime('now'), products_checked = ?, llm_calls = ?, errors = ?, events = ? WHERE id = ?`,
  ).run(s.checked, s.llmCalls, s.errors, s.events, id);
}

export function productHistory(productId: number, limit = 10): Snapshot[] {
  return db
    .prepare(`SELECT * FROM snapshots WHERE product_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?`)
    .all(productId, limit) as unknown as Snapshot[];
}

// ---------- subscribers ----------

export function addSubscriber(chatId: string): void {
  db.prepare(`INSERT OR IGNORE INTO subscribers (chat_id) VALUES (?)`).run(chatId);
}

export function listSubscribers(): string[] {
  return (db.prepare(`SELECT chat_id FROM subscribers`).all() as { chat_id: string }[]).map((r) => r.chat_id);
}
