import { getJson } from '../http.js';
import type { Listing, PageObservation, SourceAdapter } from '../types.js';

// Works for ANY Shopify store. Shopify exposes two public JSON endpoints:
//   /search/suggest.json        -> product search
//   /products/<handle>.js       -> full product incl. per-variant availability
// We use these instead of the HTML because Shopify theme HTML contains
// template strings like "Sold out" and "Pre-order" on every page, which
// makes keyword scraping unreliable.

interface ShopifyProduct {
  title: string;
  available: boolean;
  price: number; // paise
  type: string;
  tags: string[];
  variants: { title: string; available: boolean; price: number }[];
}

export class ShopifyAdapter implements SourceAdapter {
  readonly hosts: string[];

  constructor(readonly id: string, readonly name: string, private baseUrl: string) {
    this.hosts = [new URL(baseUrl).host.replace(/^www\./, '')];
  }

  async search(query: string): Promise<Listing[]> {
    const url = `${this.baseUrl}/search/suggest.json?q=${encodeURIComponent(query)}` +
      `&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
    const data = await getJson<any>(url);
    return (data.resources?.results?.products ?? []).map((p: any) => ({
      title: p.title,
      url: `${this.baseUrl}${String(p.url).split('?')[0]}`, // drop search tracking params
    }));
  }

  async fetchProduct(url: string): Promise<PageObservation> {
    const clean = url.split('?')[0].replace(/\/$/, '');
    const p = await getJson<ShopifyProduct>(`${clean}.js`);

    const preorderTag = p.tags.find((t) => /pre-?order/i.test(t));
    const variants = p.variants.length > 1
      ? p.variants.map((v) => `${v.title}: ${v.available ? 'available' : 'sold out'}`).join(', ')
      : '';

    return {
      url: clean,
      title: p.title,
      price: p.price / 100,
      category: p.type || null,
      signals: {
        platformInStock: p.available, // true if ANY variant is purchasable
        availabilityText: [preorderTag && `tag: ${preorderTag}`, variants].filter(Boolean).join(' | ') || undefined,
      },
    };
  }
}
