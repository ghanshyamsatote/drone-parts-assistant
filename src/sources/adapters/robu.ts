import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../config.js';
import { getText, setHostDelay } from '../http.js';
import { observeHtmlPage } from './jsonld.js';
import type { Listing, PageObservation, SourceAdapter } from '../types.js';

// Robu.in is a Next.js storefront behind Cloudflare. Its search results are
// rendered in the browser (nothing useful in the HTML) and its GraphQL proxy
// only accepts the site's own queries. But:
//   - product pages are server-rendered with schema.org JSON-LD, and
//   - the product sitemap lists every product URL (slug = product name).
// So: discovery = keyword match over sitemap slugs (cached for a day),
//     status    = JSON-LD on the product page.
// Trade-off: slug matching is cruder than real search, but it needs no
// headless browser, which would be 10x slower and heavier.
// Robu's robots.txt allows product pages and sitemaps for all user agents.

const BASE = 'https://robu.in';
const CACHE_FILE = join(dirname(config.DB_PATH), 'cache', 'robu-sitemap.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_PARTIAL_MS = 60 * 60 * 1000; // if some pages failed, try again in an hour

// Robu's Cloudflare starts returning 403 when requests come faster than ~3s.
setHostDelay('robu.in', 4000);

interface SitemapCache {
  fetchedAt: number;
  pages: Record<string, string[]>; // sitemap page URL -> product URLs on it
}

const slugToTitle = (url: string) =>
  (new URL(url).pathname.split('/').filter(Boolean).pop() ?? '').replace(/-/g, ' ');
const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

function readCache(): SitemapCache | null {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export class RobuAdapter implements SourceAdapter {
  readonly id = 'robu';
  readonly name = 'Robu.in';
  readonly hosts = ['robu.in'];

  private async productUrls(): Promise<string[]> {
    const cache = readCache();
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return Object.values(cache.pages).flat();

    // Refresh page by page. A page that fails keeps its previous contents,
    // so one blocked request degrades results slightly instead of losing Robu.
    const index = locs(await getText(`${BASE}/sitemap.xml`, 'curl')).filter((u) => u.includes('products-sitemap'));
    const pages: SitemapCache['pages'] = {};
    let failed = 0;
    for (const page of index) {
      try {
        pages[page] = locs(await getText(page, 'curl')).filter((u) => u.includes('/product/'));
      } catch {
        failed++;
        if (cache?.pages[page]) pages[page] = cache.pages[page];
      }
    }
    if (failed === index.length) throw new Error('All Robu sitemap pages failed');
    if (failed) console.warn(`[robu] ${failed}/${index.length} sitemap pages failed; using stale data for those`);

    const fetchedAt = failed ? Date.now() - CACHE_TTL_MS + RETRY_PARTIAL_MS : Date.now();
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt, pages } satisfies SitemapCache));
    return Object.values(pages).flat();
  }

  async search(): Promise<Listing[]> {
    // Returns all slugs; the registry's relevance filter narrows them down.
    return (await this.productUrls()).map((url) => ({ url, title: slugToTitle(url) }));
  }

  fetchProduct(url: string): Promise<PageObservation> {
    return observeHtmlPage(url, 'curl'); // Cloudflare rejects Node's TLS fingerprint
  }
}
