import { getJson } from '../http.js';
import type { Listing, PageObservation, SourceAdapter } from '../types.js';

// Works for any WooCommerce store with the public Store API enabled
// (/wp-json/wc/store/v1). Gives clean JSON incl. the store's own stock label.
// Watch out: "Available on backorder" comes with is_in_stock = true — the
// extractor must treat that as pre-order, not in stock.

interface WooProduct {
  name: string;
  permalink: string;
  is_in_stock: boolean;
  stock_availability?: { text: string; class: string };
  prices: { price: string; currency_minor_unit: number };
  categories?: { name: string }[];
  add_to_cart?: { text: string };
}

// Woo returns HTML-encoded names (&amp; &#038; &#8211; ...), sometimes double-encoded.
const NAMED: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeOnce(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e: string) => {
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return NAMED[e.toLowerCase()] ?? match;
  });
}

// Some titles were typed with a broken entity ("&amp" without ";"), which
// arrives as "& amp" — collapse that too.
const decode = (s: string) => decodeOnce(decodeOnce(s)).replace(/&\s*amp\b/g, '&');

export class WooCommerceAdapter implements SourceAdapter {
  readonly hosts: string[];

  constructor(readonly id: string, readonly name: string, private baseUrl: string) {
    this.hosts = [new URL(baseUrl).host.replace(/^www\./, '')];
  }

  private api(params: string) {
    return getJson<WooProduct[]>(`${this.baseUrl}/wp-json/wc/store/v1/products?${params}`);
  }

  async search(query: string): Promise<Listing[]> {
    const items = await this.api(`search=${encodeURIComponent(query)}&per_page=25`);
    return items.map((p) => ({ title: decode(p.name), url: p.permalink }));
  }

  async fetchProduct(url: string): Promise<PageObservation> {
    // https://site/product/<slug>/  ->  look the product up by slug
    const slug = new URL(url).pathname.split('/').filter(Boolean).pop();
    const [p] = await this.api(`slug=${encodeURIComponent(slug ?? '')}`);
    if (!p) throw new Error(`Product not found via Store API: ${url}`);

    const label = [p.stock_availability?.text, p.add_to_cart?.text && `button: ${p.add_to_cart.text}`]
      .filter(Boolean).join(' | ');

    return {
      url: p.permalink,
      title: decode(p.name),
      price: Number(p.prices.price) / 10 ** p.prices.currency_minor_unit,
      category: p.categories?.[0] ? decode(p.categories[0].name) : null,
      signals: { platformInStock: p.is_in_stock, availabilityText: label || undefined },
    };
  }
}
