import * as cheerio from 'cheerio';
import { getText } from '../http.js';
import { observeHtmlPage } from './jsonld.js';
import type { Listing, PageObservation, SourceAdapter } from '../types.js';

// BigCommerce (Stencil themes) has no public product JSON API, but the
// search page is server-rendered and product pages carry JSON-LD.

export class BigCommerceAdapter implements SourceAdapter {
  readonly hosts: string[];

  constructor(readonly id: string, readonly name: string, private baseUrl: string) {
    this.hosts = [new URL(baseUrl).host.replace(/^www\./, '')];
  }

  async search(query: string): Promise<Listing[]> {
    const html = await getText(`${this.baseUrl}/search.php?search_query=${encodeURIComponent(query)}&section=product`);
    const $ = cheerio.load(html);
    return $('article.card .card-title a')
      .map((_, a) => ({ title: $(a).text().trim(), url: $(a).attr('href') ?? '' }))
      .get()
      .filter((l) => l.url.startsWith('http'));
  }

  fetchProduct(url: string): Promise<PageObservation> {
    return observeHtmlPage(url);
  }
}
