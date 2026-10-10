import {
  ensureProduct, finishRun, getProduct, insertEvent, linkWatchProduct, listWatches, markWatchRun,
  productsForWatches, recordSnapshot, setProductAttributes, startRun, updateProductTitle,
} from '../db/repo.js';
import { adapterForUrl, searchAllSources } from '../sources/registry.js';
import { extractStatus } from '../extract/index.js';
import { extractAttributes } from '../extract/llm.js';
import { classifyChange, type ChangeKind } from './changes.js';
import type { Product, Watch } from '../types.js';

// One monitoring run:
//   1. discover  – run query watches against every source, register new products
//   2. check     – fetch each tracked product, extract status, store a snapshot
//   3. detect    – classify the transition, write events to the outbox
//   4. enrich    – LLM attributes for products that don't have them yet
// The notifier (separate step) delivers events from the outbox.

export interface RunOptions {
  watchIds?: number[]; // limit to some watches (e.g. a just-added one)
  discover?: boolean;  // default true
  productIds?: number[]; // re-check only these products (no discovery) — fast demo/debug runs
  log?: (line: string) => void;
}

export interface RunEvent {
  kind: ChangeKind;
  productId: number;
  title: string;
  source: string;
  url: string;
  from: string;
  to: string;
  price: number | null;
}

export interface RunSummary {
  runId: number;
  checked: number;
  byMethod: Record<string, number>;
  errors: number;
  events: RunEvent[];
  seconds: number;
}

export async function runCheck(opts: RunOptions = {}): Promise<RunSummary> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const started = Date.now();
  const runId = startRun();

  const watches = listWatches().filter((w) => !opts.watchIds || opts.watchIds.includes(w.id));
  const newIds = new Set<number>();
  const baselineIds = new Set<number>();

  const onlyProducts = opts.productIds !== undefined;

  // ---- 1. discover ----
  if (opts.discover !== false && !onlyProducts) {
    for (const w of watches) await discover(w, newIds, baselineIds, log);
  }

  // ---- 2 + 3. check & detect ----
  // Sites are checked in parallel; products of one site run one after another
  // (the HTTP layer also spaces requests per host).
  const products = productsForWatches(watches.map((w) => w.id))
    .filter((p) => !onlyProducts || opts.productIds!.includes(p.id));
  const bySource = Map.groupBy(products, (p) => p.source);
  log(`Checking ${products.length} products across ${bySource.size} sources...`);

  const byMethod: Record<string, number> = {};
  const events: RunEvent[] = [];
  await Promise.all([...bySource.values()].map(async (group) => {
    for (const p of group) {
      const res = await checkProduct(p, newIds.has(p.id), baselineIds.has(p.id), log);
      byMethod[res.method] = (byMethod[res.method] ?? 0) + 1;
      events.push(...res.events);
    }
  }));

  // ---- 4. enrich ----
  const missing = products.map((p) => getProduct(p.id)!).filter((p) => !p.category);
  if (missing.length) {
    log(`Extracting attributes for ${missing.length} new products (LLM, batched)...`);
    const attrs = await extractAttributes(missing.map((p) => p.title));
    missing.forEach((p, i) => attrs[i] && setProductAttributes(p.id, attrs[i]));
  }

  // A product-only run didn't run the watches' searches, so it doesn't end their baseline.
  if (!onlyProducts) watches.forEach((w) => markWatchRun(w.id));
  const errors = byMethod.error ?? 0;
  finishRun(runId, { checked: products.length, llmCalls: byMethod.llm ?? 0, errors, events: events.length });

  return { runId, checked: products.length, byMethod, errors, events, seconds: Math.round((Date.now() - started) / 1000) };
}

async function discover(w: Watch, newIds: Set<number>, baselineIds: Set<number>, log: (l: string) => void) {
  const isBaseline = !w.last_run_at;
  const register = (source: string, url: string, title: string) => {
    const { product, created } = ensureProduct({ source, url, title });
    linkWatchProduct(w.id, product.id);
    if (created) newIds.add(product.id);
    if (created && isBaseline) baselineIds.add(product.id);
  };

  if (w.kind === 'url') {
    register(adapterForUrl(w.value).id, w.value, w.label);
    return;
  }
  const { listings, errors } = await searchAllSources(w.value);
  for (const l of listings) register(l.source, l.url, l.title);
  for (const e of errors) log(`  ! [${e.source}] search "${w.value}" failed: ${e.error}`);
  log(`Watch #${w.id} "${w.label}": ${listings.length} listings${isBaseline ? ' (baseline run, no alerts)' : ''}`);
}

async function checkProduct(p: Product, isNew: boolean, isBaseline: boolean, log: (l: string) => void) {
  const shorten = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}...` : t);
  try {
    const obs = await adapterForUrl(p.url).fetchProduct(p.url);
    if (obs.title && obs.title !== p.title) updateProductTitle(p.id, obs.title);

    const ex = await extractStatus(obs);
    const snap = recordSnapshot(p.id, { status: ex.status, price: ex.price, method: ex.method, evidence: ex.evidence });
    const kinds = classifyChange({
      previous: snap.previous, current: ex.status, previousPrice: snap.previousPrice, price: ex.price, isNew, isBaseline,
    });

    const events: RunEvent[] = kinds.map((kind) => {
      insertEvent({
        productId: p.id, snapshotId: snap.snapshotId, kind,
        fromStatus: snap.previous, toStatus: ex.status, oldPrice: snap.previousPrice, newPrice: ex.price,
      });
      return { kind, productId: p.id, title: obs.title, source: p.source, url: p.url, from: snap.previous, to: ex.status, price: ex.price };
    });

    const price = ex.price != null ? ` ₹${ex.price.toLocaleString('en-IN')}` : '';
    log(`  [${p.source}] ${ex.status.padEnd(12)} (${ex.method})${price}  ${shorten(obs.title)}${kinds.length ? `  → ${kinds.join(', ')}` : ''}`);
    return { method: ex.method as string, events };
  } catch (err) {
    const msg = (err as Error).message.slice(0, 200);
    recordSnapshot(p.id, { status: 'unknown', price: null, method: 'error', evidence: msg });
    log(`  [${p.source}] ERROR  ${shorten(p.title)}: ${msg}`);
    return { method: 'error', events: [] as RunEvent[] };
  }
}
