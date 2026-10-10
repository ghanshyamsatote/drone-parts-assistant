import type { StockStatus } from '../types.js';

// Decides which transitions are worth telling someone about.
// Pure function, no I/O — the most important business rule, fully unit-tested.

export type ChangeKind = 'back_in_stock' | 'preorder_opened' | 'price_drop' | 'new_listing' | 'went_out_of_stock';

/** Kinds that trigger a push alert. went_out_of_stock is only recorded (history / chat). */
export const ALERT_KINDS: ReadonlySet<ChangeKind> = new Set(['back_in_stock', 'preorder_opened', 'price_drop', 'new_listing']);

export const PRICE_DROP_THRESHOLD = 0.05; // ignore drops under 5% (rounding, coupon noise)

export interface ChangeInput {
  previous: StockStatus;
  current: StockStatus;
  previousPrice: number | null;
  price: number | null;
  /** first time we've ever seen this product */
  isNew: boolean;
  /** first run of the watch that found it: record silently, don't alert */
  isBaseline: boolean;
}

export function classifyChange(c: ChangeInput): ChangeKind[] {
  // We couldn't tell what the page says -> not a change (see recordSnapshot).
  if (c.current === 'unknown') return [];

  if (c.isNew) {
    // Day 1 of a watch would otherwise send an alert for every existing product.
    if (c.isBaseline) return [];
    // A listing that just appeared in search results. Only interesting if you can buy/order it.
    return c.current === 'in_stock' || c.current === 'pre_order' ? ['new_listing'] : [];
  }

  // Known product whose earlier checks all failed: this is its baseline.
  if (c.previous === 'unknown') return [];

  const kinds: ChangeKind[] = [];
  if (c.current !== c.previous) {
    if (c.current === 'in_stock') kinds.push('back_in_stock');
    else if (c.current === 'pre_order') kinds.push('preorder_opened');
    else if (c.current === 'out_of_stock') kinds.push('went_out_of_stock');
  }

  if (
    c.price != null && c.previousPrice != null &&
    c.current !== 'out_of_stock' &&
    c.price < c.previousPrice * (1 - PRICE_DROP_THRESHOLD)
  ) {
    kinds.push('price_drop');
  }
  return kinds;
}
