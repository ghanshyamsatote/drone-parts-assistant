import { z } from 'zod';
import { chatJson } from '../llm/client.js';
import type { PageObservation } from '../sources/types.js';
import { STOCK_STATUSES, type StockStatus } from '../types.js';

// The two LLM jobs in the extraction pipeline. Both use a small cheap model
// with tight prompts, a closed set of outputs, and zod validation.

// ---------- 1. Stock status (only when rules couldn't decide) ----------

const StatusSchema = z.object({
  status: z.enum(STOCK_STATUSES),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});

const STATUS_PROMPT = `You classify the stock status of a product on an Indian electronics store.
Return JSON: {"status": "in_stock"|"out_of_stock"|"pre_order"|"unknown", "confidence": 0..1, "reason": "<short>"}

Rules:
- "pre_order": pre-order, backorder, coming soon, ships later / with an ETA.
- If the product has variants and ANY variant is purchasable now, it is "in_stock".
- Structured data (schema.org) can be stale or describe a single variant; prefer explicit
  page text like "30 in stock" over it when they conflict.
- Ignore generic template text that is not about this product.
- If the evidence is insufficient, answer "unknown". Never guess.`;

const MIN_CONFIDENCE = 0.6;

export async function classifyByLlm(obs: PageObservation): Promise<{ status: StockStatus; reason: string }> {
  // Send only what's needed: title + signals + a short snippet (cost, and
  // less noise for a small model).
  const evidence = JSON.stringify({ title: obs.title, signals: obs.signals, pageText: obs.pageText?.slice(0, 800) });
  try {
    const r = await chatJson(
      [{ role: 'system', content: STATUS_PROMPT }, { role: 'user', content: evidence }],
      StatusSchema,
    );
    // Low confidence -> unknown. A missed alert is better than a false one.
    if (r.confidence < MIN_CONFIDENCE) return { status: 'unknown', reason: `low confidence (${r.confidence}): ${r.reason}` };
    return { status: r.status, reason: r.reason };
  } catch (err) {
    return { status: 'unknown', reason: `LLM failed: ${(err as Error).message.slice(0, 150)}` };
  }
}

// ---------- 2. Product attributes (once per product, batched) ----------

export const CATEGORIES = [
  'flight_controller', 'companion_computer', 'hat_carrier_board', 'single_board_computer',
  'gps_module', 'rf_telemetry', 'power_module', 'sensor', 'camera', 'accessory', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

const AttributeSchema = z.object({
  category: z.enum(CATEGORIES).catch('other'),
  brand: z.string().nullable().catch(null),
  specs: z.record(z.string(), z.coerce.string()).catch({}),
});
// Keyed by id ("p0", "p1", ...), not a positional array: with a list, small
// models skip or merge near-duplicate items and silently shift every row
// after it. With explicit keys a miss is visible and can be retried.
const AttributesSchema = z.record(z.string(), AttributeSchema);

export interface ProductAttributes {
  category: Category;
  brand: string | null;
  specs: Record<string, string>;
}

const ATTR_PROMPT = `You extract attributes of drone / robotics electronics from product titles.
You get a JSON object mapping ids to product titles. For EVERY id return:
- category: one of ${CATEGORIES.join(', ')}
  (a HAT, baseboard or carrier board is "hat_carrier_board", even if it is for a Raspberry Pi or Pixhawk;
   cables, cases, coolers, buzzers, power supplies are "accessory")
- brand: manufacturer name if present, else null
- specs: short key facts from the title only, e.g. {"ram":"8GB","processor":"STM32H7","variant":"Standard Set"}
Similar-looking titles are different products: answer each id separately.
Return a JSON object with exactly the same ids:
{"p0": {"category":"...","brand":"...","specs":{...}}, "p1": {...}}`;

const BATCH_SIZE = 20;

async function attributeBatch(titles: Map<string, string>): Promise<Map<string, ProductAttributes>> {
  const r = await chatJson(
    [
      { role: 'system', content: ATTR_PROMPT },
      { role: 'user', content: JSON.stringify(Object.fromEntries(titles)) },
    ],
    AttributesSchema,
  );
  return new Map(Object.entries(r).filter(([id]) => titles.has(id)));
}

/**
 * Titles only, many per call: attributes don't change between daily checks,
 * so we extract them once when a product is first discovered. Ids the model
 * skipped get one retry; anything still missing stays null.
 */
export async function extractAttributes(titles: string[]): Promise<(ProductAttributes | null)[]> {
  const out: (ProductAttributes | null)[] = titles.map(() => null);
  for (let start = 0; start < titles.length; start += BATCH_SIZE) {
    const pending = new Map(titles.slice(start, start + BATCH_SIZE).map((t, i) => [`p${start + i}`, t]));
    for (let pass = 0; pass < 2 && pending.size; pass++) {
      try {
        for (const [id, attrs] of await attributeBatch(pending)) {
          out[Number(id.slice(1))] = attrs;
          pending.delete(id);
        }
      } catch (err) {
        console.warn(`[llm] attribute batch failed: ${(err as Error).message.slice(0, 150)}`);
      }
    }
  }
  return out;
}
