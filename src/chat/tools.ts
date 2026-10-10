import { z } from 'zod';
import { db } from '../db/index.js';
import { addWatch, deactivateWatch, getProduct, listWatches, productHistory } from '../db/repo.js';
import { CATEGORIES } from '../extract/llm.js';
import { matchesQuery } from '../sources/match.js';
import { adapters, searchAllSources } from '../sources/registry.js';
import { STOCK_STATUSES, type Product } from '../types.js';

// Tools the chat agent may call. Each tool = zod schema (validates the
// LLM's arguments AND generates the JSON schema the LLM sees) + a handler.
// The LLM never touches SQL or the web directly, and never makes up data:
// everything it says about products comes from these results.

export interface ToolContext {
  chatId: string;
  /** Called after add_watch: runs the first check in the background. */
  onWatchAdded: (watchId: number, label: string) => void;
}

interface Tool<S extends z.ZodType> {
  description: string;
  schema: S;
  run: (args: z.infer<S>, ctx: ToolContext) => unknown | Promise<unknown>;
}
const tool = <S extends z.ZodType>(t: Tool<S>) => t;

const SOURCE_IDS = adapters.map((a) => a.id) as [string, ...string[]];

// Compact product view for the LLM: fewer tokens, nothing it doesn't need.
function view(p: Product) {
  return {
    id: p.id,
    title: p.title,
    store: adapters.find((a) => a.id === p.source)?.name ?? p.source,
    status: p.current_status,
    price_inr: p.current_price,
    category: p.category,
    url: p.url,
    last_checked: p.last_checked_at,
  };
}

const STATUS_ORDER = `CASE current_status WHEN 'in_stock' THEN 0 WHEN 'pre_order' THEN 1 WHEN 'out_of_stock' THEN 2 ELSE 3 END`;

export const tools = {
  search_products: tool({
    description:
      'Search products we already track (fast, from our database, with current stock status and price). ' +
      'Use for any "find / show / which / cheapest / in stock" question. Combine filters freely.',
    schema: z.object({
      query: z.string().optional().describe('Words that must appear in the title, e.g. "pixhawk 6x", "pi 5 hat"'),
      category: z.enum(CATEGORIES).optional(),
      status: z.enum(STOCK_STATUSES).optional(),
      max_price: z.number().optional().describe('INR'),
      min_price: z.number().optional().describe('INR'),
      store: z.enum(SOURCE_IDS).optional(),
      sort: z.enum(['availability', 'price_asc', 'price_desc']).optional(),
      limit: z.number().int().min(1).max(15).optional(),
    }),
    run: (a) => {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (a.category) { where.push('category = ?'); params.push(a.category); }
      if (a.status) { where.push('current_status = ?'); params.push(a.status); }
      if (a.store) { where.push('source = ?'); params.push(a.store); }
      if (a.max_price != null) { where.push('current_price <= ?'); params.push(a.max_price); }
      if (a.min_price != null) { where.push('current_price >= ?'); params.push(a.min_price); }
      const order = a.sort === 'price_asc' ? 'current_price ASC'
        : a.sort === 'price_desc' ? 'current_price DESC'
        : `${STATUS_ORDER}, current_price ASC`;

      const rows = db.prepare(
        `SELECT * FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
      ).all(...params) as unknown as Product[];
      // Title matching reuses the same relevance rules as discovery.
      const hits = a.query ? rows.filter((p) => matchesQuery(`${p.title} ${p.brand ?? ''}`, a.query!)) : rows;
      return { total_matches: hits.length, products: hits.slice(0, a.limit ?? 8).map(view) };
    },
  }),

  product_details: tool({
    description: 'Full details for one tracked product: status, price, specs, and its recent check history.',
    schema: z.object({ product_id: z.number().int() }),
    run: ({ product_id }) => {
      const p = getProduct(product_id);
      if (!p) return { error: `No product with id ${product_id}` };
      return {
        ...view(p),
        brand: p.brand,
        specs: p.attributes ? JSON.parse(p.attributes) : null,
        first_seen: p.first_seen_at,
        last_status_change: p.last_changed_at,
        history: productHistory(p.id, 10).map((s) => ({ at: s.checked_at, status: s.status, price: s.price, how: s.method })),
      };
    },
  }),

  compare_products: tool({
    description: 'Side-by-side comparison of 2-5 tracked products (price, status, store, specs).',
    schema: z.object({ product_ids: z.array(z.number().int()).min(2).max(5) }),
    run: ({ product_ids }) =>
      product_ids.map((id) => {
        const p = getProduct(id);
        return p ? { ...view(p), brand: p.brand, specs: p.attributes ? JSON.parse(p.attributes) : null } : { id, error: 'not found' };
      }),
  }),

  live_search: tool({
    description:
      'Search the retailer websites RIGHT NOW for products we do not track yet. Slower; returns titles and ' +
      'links only (no stock status until the product is watched). Use when search_products finds nothing.',
    schema: z.object({ query: z.string().min(2) }),
    run: async ({ query }) => {
      const { listings, errors } = await searchAllSources(query, 5);
      return { results: listings.slice(0, 15), failed_stores: errors.map((e) => e.source) };
    },
  }),

  add_watch: tool({
    description:
      'Start monitoring for this user. kind "url" for a specific product page link (any store); ' +
      'kind "query" for a search term checked on every store, which also catches NEW matching listings. ' +
      'The first check runs in the background and the user gets the result in a follow-up message.',
    schema: z.object({
      kind: z.enum(['url', 'query']),
      value: z.string().min(2).describe('The product URL, or the search term'),
      label: z.string().optional().describe('Short human name for the watch'),
    }),
    run: ({ kind, value, label }, ctx) => {
      if (kind === 'url') {
        try {
          const u = new URL(value);
          if (!/^https?:$/.test(u.protocol)) throw new Error();
        } catch {
          return { error: 'That is not a valid http(s) URL.' };
        }
      }
      const w = addWatch(kind, value.trim(), label?.trim() || value.trim(), ctx.chatId);
      ctx.onWatchAdded(w.id, w.label);
      return { ok: true, watch_id: w.id, label: w.label, note: 'First check started; results will follow in a separate message.' };
    },
  }),

  list_watches: tool({
    description: "List what is being monitored for this user (their own watches plus the global default ones).",
    schema: z.object({}),
    run: (_a, ctx) =>
      listWatches(ctx.chatId).map((w) => {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM watch_products WHERE watch_id = ?`).get(w.id) as { n: number };
        return { watch_id: w.id, kind: w.kind, value: w.value, label: w.label, owner: w.chat_id ? 'you' : 'global default', products: n.n };
      }),
  }),

  remove_watch: tool({
    description: "Stop one of the user's own watches (global default watches can't be removed).",
    schema: z.object({ watch_id: z.number().int() }),
    run: ({ watch_id }, ctx) =>
      deactivateWatch(watch_id, ctx.chatId)
        ? { ok: true }
        : { error: 'Not found among your watches (global default watches cannot be removed).' },
  }),
};

export type ToolName = keyof typeof tools;

/** JSON-schema tool definitions in the OpenAI "tools" format. */
export function toolDefinitions() {
  return Object.entries(tools).map(([name, t]) => ({
    type: 'function' as const,
    function: { name, description: t.description, parameters: cleanSchema(z.toJSONSchema(t.schema)) },
  }));
}

// Some providers (Gemini's OpenAI-compatible endpoint) reject JSON-schema
// keywords they don't support, so strip them.
function cleanSchema(s: any): any {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (s && typeof s === 'object') {
    const { $schema, additionalProperties, ...rest } = s;
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, cleanSchema(v)]));
  }
  return s;
}

/** Validate the LLM's arguments and run the tool. Errors go back to the LLM as data. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
  const t = tools[name as ToolName] as Tool<z.ZodType> | undefined;
  if (!t) return { error: `Unknown tool ${name}` };
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return { error: 'Arguments were not valid JSON' };
  }
  const parsed = t.schema.safeParse(args);
  if (!parsed.success) return { error: `Invalid arguments: ${parsed.error.message.slice(0, 300)}` };
  try {
    return await t.run(parsed.data, ctx);
  } catch (err) {
    return { error: (err as Error).message.slice(0, 300) };
  }
}
