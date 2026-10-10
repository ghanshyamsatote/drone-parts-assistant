import { getText, type Transport } from '../http.js';
import { extractJsonLdProduct, stockSnippet } from '../html.js';
import type { Listing, PageObservation, SourceAdapter } from '../types.js';

/**
 * Fallback adapter for ANY site: reads schema.org JSON-LD plus a text snippet.
 * This is what lets a user add a URL from a store we've never seen — no code
 * needed. Other adapters reuse `observeHtmlPage` for their product pages.
 */
export async function observeHtmlPage(url: string, transport: Transport = 'fetch'): Promise<PageObservation> {
  const html = await getText(url, transport);
  const ld = extractJsonLdProduct(html);
  const titleTag = html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim();
  return {
    url,
    title: ld?.name ?? titleTag ?? url,
    price: ld?.price ?? null,
    category: ld?.category ?? null,
    signals: { schemaAvailability: ld?.availability },
    pageText: stockSnippet(html),
  };
}

export class GenericJsonLdAdapter implements SourceAdapter {
  readonly id = 'web';
  readonly name = 'Other website';
  readonly hosts: string[] = [];

  async search(): Promise<Listing[]> {
    return []; // we can't search a site we know nothing about
  }

  fetchProduct(url: string): Promise<PageObservation> {
    return observeHtmlPage(url);
  }
}
