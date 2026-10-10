// The only statuses the system understands. Everything (rules, LLM output,
// DB values) is forced into this closed set, so the rest of the code never
// has to deal with free-text like "Back soon!" or "Ships in 3 weeks".
export const STOCK_STATUSES = ['in_stock', 'out_of_stock', 'pre_order', 'unknown'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

// A watch is what a user asked us to track.
//  - 'url':   one specific product page
//  - 'query': a search term run against every source, so NEW matching
//             products get discovered automatically (e.g. "Pixhawk 6X")
export type WatchKind = 'url' | 'query';

export interface Watch {
  id: number;
  kind: WatchKind;
  value: string;
  label: string;
  chat_id: string | null; // null = global seed watch, alerts all subscribers
  active: number;
  created_at: string;
  last_run_at: string | null;
}

export interface Product {
  id: number;
  source: string;
  url: string;
  title: string;
  category: string | null;
  brand: string | null;
  attributes: string | null; // JSON specs from the LLM
  current_status: StockStatus;
  current_price: number | null;
  first_seen_at: string;
  last_checked_at: string | null;
  last_changed_at: string | null;
}

// One observation of a product page. Snapshots are append-only, which gives
// us full history for free ("when was this last in stock?").
export interface Snapshot {
  id: number;
  product_id: number;
  status: StockStatus;
  price: number | null;
  method: 'rule' | 'llm' | 'error' | 'simulated';
  evidence: string | null; // the text that led to the decision, for debugging
  checked_at: string;
}
