import type { PageObservation } from '../sources/types.js';
import type { StockStatus } from '../types.js';

// Deterministic classification. Free, instant, and predictable — so it runs
// first. It returns null when the signals are missing or contradict each
// other; only then do we pay for an LLM call.

export interface RuleResult {
  status: StockStatus;
  reason: string;
}

const SCHEMA_MAP: Record<string, StockStatus> = {
  InStock: 'in_stock', LimitedAvailability: 'in_stock', OnlineOnly: 'in_stock', InStoreOnly: 'in_stock',
  OutOfStock: 'out_of_stock', SoldOut: 'out_of_stock', Discontinued: 'out_of_stock',
  PreOrder: 'pre_order', PreSale: 'pre_order', BackOrder: 'pre_order',
};

const PREORDER_RE = /pre-?order|back ?order|coming soon|pre-?sale|available for order|expected (to )?ship/i;
const OUT_RE = /out of stock|not in stock|sold out|currently unavailable|notify me/i;
const IN_RE = /\bin stock\b|add to cart|buy now/i;

/** Which statuses a piece of text hints at (it can hint at several). */
export function textHints(text = ''): Set<StockStatus> {
  const hints = new Set<StockStatus>();
  if (PREORDER_RE.test(text)) hints.add('pre_order');
  if (OUT_RE.test(text)) hints.add('out_of_stock');
  // "not in stock" contains "in stock", so remove it before looking for in-stock words.
  if (IN_RE.test(text.replace(/not in stock/gi, ''))) hints.add('in_stock');
  return hints;
}

export function classifyByRules(obs: PageObservation): RuleResult | null {
  const { schemaAvailability, platformInStock, availabilityText } = obs.signals;

  // 1. The store's own label wins for pre-order: platforms report
  //    backorders as "in stock" (Woo: is_in_stock=true + "Available on backorder").
  if (availabilityText && PREORDER_RE.test(availabilityText)) {
    return { status: 'pre_order', reason: `store label: "${availabilityText}"` };
  }

  // 2. Platform boolean from a JSON API (Shopify, Woo) — clean and reliable.
  if (platformInStock !== undefined) {
    return platformInStock
      ? { status: 'in_stock', reason: `platform API: available${availabilityText ? ` (${availabilityText})` : ''}` }
      : { status: 'out_of_stock', reason: `platform API: not available${availabilityText ? ` (${availabilityText})` : ''}` };
  }

  // 3. schema.org JSON-LD — trusted unless the visible page text disagrees.
  //    (Evelta: JSON-LD "OutOfStock" while the page shows "30 in stock" for
  //    other variants. A contradiction like that goes to the LLM.)
  const schemaStatus = schemaAvailability ? SCHEMA_MAP[schemaAvailability] : undefined;
  if (schemaStatus) {
    const hints = textHints(obs.pageText);
    const contradicted = hints.size > 0 && !hints.has(schemaStatus);
    if (!contradicted) return { status: schemaStatus, reason: `schema.org availability: ${schemaAvailability}` };
    return null;
  }

  // 4. Only free text: decide only if it points to exactly one status.
  const hints = textHints(obs.pageText);
  if (hints.size === 1) {
    const [status] = hints;
    return { status, reason: 'page text (single unambiguous signal)' };
  }
  return null;
}
