import * as cheerio from 'cheerio';

// HTML helpers shared by adapters that scrape pages.

export interface JsonLdProduct {
  name?: string;
  price: number | null;
  availability?: string; // normalised: "InStock", "OutOfStock", "PreOrder", ...
  category?: string;
}

/**
 * Pull the schema.org Product block out of a page. Most stores emit this for
 * Google Shopping, which makes it the most stable thing to scrape: themes
 * change, but SEO markup rarely does.
 */
export function extractJsonLdProduct(html: string): JsonLdProduct | null {
  const $ = cheerio.load(html);
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let data: unknown;
    try {
      data = JSON.parse($(el).text());
    } catch {
      continue; // some sites ship broken JSON-LD; skip it
    }
    const nodes = ([] as any[]).concat(data).flatMap((d: any) => d?.['@graph'] ?? d);
    const product = nodes.find((n: any) => [].concat(n?.['@type']).some((t: string) => /Product/i.test(t)));
    if (!product) continue;

    const offer = [].concat(product.offers ?? [])[0] as any;
    const rawPrice = offer?.price ?? offer?.lowPrice;
    return {
      name: product.name,
      price: rawPrice != null && !isNaN(Number(rawPrice)) ? Number(rawPrice) : null,
      // "https://schema.org/OutOfStock" -> "OutOfStock"
      availability: offer?.availability ? String(offer.availability).split('/').pop() : undefined,
      category: typeof product.category === 'string' ? product.category : undefined,
    };
  }
  return null;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * A short piece of visible text from the area of the page that talks about
 * availability. This is what the LLM sees when rules can't decide — kept
 * small on purpose (cost + less noise for a small model).
 */
export function stockSnippet(html: string, maxLen = 800): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, header, footer, nav').remove();

  const selectors = [
    '[class*="stock"]', '[id*="stock"]', '[class*="availability"]',
    '[class*="preorder"]', '[class*="pre-order"]',
    'form[action*="cart"] button', 'button[name="add"]', '.product-form',
  ].join(',');
  const parts = [...new Set($(selectors).map((_, e) => clean($(e).text())).get().filter((t) => t && t.length < 300))];
  if (parts.length) return parts.join(' | ').slice(0, maxLen);

  // Fallback: text windows around availability keywords.
  const body = clean($('body').text());
  const windows: string[] = [];
  for (const m of body.matchAll(/(in stock|out of stock|sold out|pre-?order|back ?order|notify me|add to cart)/gi)) {
    windows.push(body.slice(Math.max(0, m.index! - 80), m.index! + 80));
    if (windows.length >= 5) break;
  }
  return windows.join(' … ').slice(0, maxLen);
}
