import { ShopifyAdapter } from './adapters/shopify.js';
import { WooCommerceAdapter } from './adapters/woocommerce.js';
import { BigCommerceAdapter } from './adapters/bigcommerce.js';
import { RobuAdapter } from './adapters/robu.js';
import { GenericJsonLdAdapter } from './adapters/jsonld.js';
import { matchesQuery } from './match.js';
import type { Listing, SourceAdapter } from './types.js';

// The ONLY place that knows which retailers exist.
// Adding another Shopify/Woo/BigCommerce store is a one-line change here.
export const adapters: SourceAdapter[] = [
  new RobuAdapter(),
  new ShopifyAdapter('thinkrobotics', 'ThinkRobotics', 'https://thinkrobotics.com'),
  new WooCommerceAdapter('zbotic', 'Zbotic', 'https://zbotic.in'),
  new BigCommerceAdapter('evelta', 'Evelta', 'https://evelta.com'),
];

const generic = new GenericJsonLdAdapter();

export function adapterForUrl(url: string): SourceAdapter {
  const host = new URL(url).host.replace(/^www\./, '');
  return adapters.find((a) => a.hosts.includes(host)) ?? generic;
}

export interface SourcedListing extends Listing {
  source: string;
}

/**
 * Search every retailer in parallel and apply our own relevance filter.
 * One site failing (timeout, blocked, layout change) never breaks the others —
 * its error is returned alongside the results so the caller can log it.
 */
export async function searchAllSources(query: string, perSource = 10) {
  const results = await Promise.allSettled(adapters.map((a) => a.search(query)));
  const listings: SourcedListing[] = [];
  const errors: { source: string; error: string }[] = [];

  results.forEach((r, i) => {
    const source = adapters[i].id;
    if (r.status === 'rejected') {
      errors.push({ source, error: String(r.reason?.message ?? r.reason) });
      return;
    }
    const seen = new Set<string>();
    r.value
      .filter((l) => matchesQuery(l.title, query) && !seen.has(l.url) && seen.add(l.url))
      .slice(0, perSource)
      .forEach((l) => listings.push({ ...l, source }));
  });

  return { listings, errors };
}
