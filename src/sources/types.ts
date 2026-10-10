// Contract every retailer adapter implements. Adding a site = writing one
// class that satisfies this interface and registering it in registry.ts.

/** A search hit: just enough to identify a product page. */
export interface Listing {
  url: string;
  title: string;
}

/**
 * Raw facts gathered from a product page. Adapters do NOT decide the final
 * stock status — they report signals, and the extractor (rules + LLM
 * fallback) interprets them. This keeps adapters dumb and easy to write.
 */
export interface PageObservation {
  url: string;
  title: string;
  price: number | null; // INR, in rupees
  category: string | null;
  signals: {
    /** schema.org availability from JSON-LD, e.g. "InStock", "PreOrder" */
    schemaAvailability?: string;
    /** platform's own boolean, e.g. Shopify `available`, Woo `is_in_stock` */
    platformInStock?: boolean;
    /** the store's own human label, e.g. "Available on backorder" */
    availabilityText?: string;
  };
  /** Short visible-text snippet near the buy area, for the LLM fallback. */
  pageText?: string;
}

export interface SourceAdapter {
  /** Stable id stored in the DB, e.g. "robu" */
  readonly id: string;
  readonly name: string;
  /** Hostnames this adapter handles (without "www.") */
  readonly hosts: string[];

  /** Find product pages for a free-text query. May return loosely relevant hits. */
  search(query: string): Promise<Listing[]>;

  /** Gather facts about one product page. */
  fetchProduct(url: string): Promise<PageObservation>;
}
