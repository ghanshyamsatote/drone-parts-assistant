import { adapters } from '../sources/registry.js';
import type { StockStatus } from '../types.js';

// Turns outbox events into Telegram HTML messages.

export interface PendingAlert {
  event_id: number;
  kind: string;
  from_status: StockStatus | null;
  to_status: StockStatus | null;
  old_price: number | null;
  new_price: number | null;
  product_id: number;
  title: string;
  url: string;
  source: string;
}

const HEADLINE: Record<string, string> = {
  back_in_stock: '🟢 Back in stock',
  preorder_opened: '🟡 Pre-order open',
  price_drop: '🔻 Price drop',
  new_listing: '🆕 New listing',
};

const STATUS_LABEL: Record<StockStatus, string> = {
  in_stock: 'in stock', out_of_stock: 'out of stock', pre_order: 'pre-order', unknown: 'unknown',
};

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const rupees = (n: number | null) => (n == null ? '' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
export const sourceName = (id: string) => adapters.find((a) => a.id === id)?.name ?? id;

export function formatAlert(a: PendingAlert): string {
  const lines = [`<b>${HEADLINE[a.kind] ?? a.kind}</b>`, `<a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>`];

  const meta = [sourceName(a.source)];
  if (a.kind === 'price_drop' && a.old_price != null) meta.push(`<s>${rupees(a.old_price)}</s> → <b>${rupees(a.new_price)}</b>`);
  else if (a.new_price != null) meta.push(rupees(a.new_price));
  lines.push(meta.join(' · '));

  if ((a.kind === 'back_in_stock' || a.kind === 'preorder_opened') && a.from_status) {
    lines.push(`<i>was: ${STATUS_LABEL[a.from_status]}</i>`);
  }
  return lines.join('\n');
}

/** Several alerts for one chat become one digest message instead of a burst. */
export function formatDigest(alerts: PendingAlert[]): string {
  if (alerts.length === 1) return formatAlert(alerts[0]);
  return [`<b>📦 ${alerts.length} updates on your watchlist</b>`, ...alerts.map(formatAlert)].join('\n\n');
}
