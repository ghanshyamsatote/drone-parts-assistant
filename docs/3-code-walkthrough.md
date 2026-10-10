# 3. Code Walkthrough: Every File, In Reading Order

Read the parts in order: each part uses the ones before it. Open each file in VS Code while you read. Every section ends with **▶ Try it**, a command that shows that code working.

| Part | Folder | Question it answers |
|---|---|---|
| 1 | config, types | What are the settings and the basic data shapes? |
| 2 | `src/db/` | How is everything stored? |
| 3 | `src/sources/` | How do we read the store websites? |
| 4 | `src/extract/`, `src/llm/` | How do we decide "in stock or not"? |
| 5 | `src/monitor/` | How does the daily check work and detect changes? |
| 6 | `src/notify/` | How are alerts sent to Telegram? |
| 7 | `src/chat/`, `src/bot.ts` | How does the AI chat work? |
| 8 | `src/scripts/` | Command-line tools for testing and the demo |
| 9 | `tests/` | Unit tests |

---

## Part 1: Foundation

### `package.json`
The list of libraries and the `npm run ...` commands.

| Library | Used for |
|---|---|
| `zod` | Checking that data has the right shape (settings, LLM answers, tool arguments) |
| `dotenv` | Loading the `.env` file into `process.env` |
| `cheerio` | Reading HTML (like jQuery, but on the server) |
| `grammy` | Telegram bot library |
| `node-cron` | Scheduling the daily job |
| `tsx` (dev) | Runs TypeScript files directly, with no build step |
| `typescript` (dev) | Type checking (`npm run typecheck`) |

No database library is needed: Node 24 has SQLite built in (`node:sqlite`). The LLM is called with plain `fetch`, so no SDK either.

### `tsconfig.json`
TypeScript settings. Important ones: `"strict": true` (catches more bugs), `"module": "NodeNext"` (modern imports, which is why imports end in `.js` even for `.ts` files), and `"types": ["node"]` (TypeScript 7 needs this to know about Node's built-ins).

### `src/config.ts`
Reads settings from `.env` and **checks them once at startup** with zod.

```ts
const schema = z.object({
  CHECK_CRON: z.string().default('0 9 * * *'),
  REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  LLM_MODEL: z.string().default('gemini-3.5-flash-lite'),
  ...
});
export const config = schema.parse(process.env);
```
- `z.coerce.number()`: `.env` values are always text; this converts `"2000"` to `2000`.
- `.default(...)`: the value used if the setting is missing.
- If a value is wrong, the program stops immediately with a clear error, instead of failing in the middle of a run.

### `src/types.ts`
Shared data shapes. The most important line in the project:

```ts
export const STOCK_STATUSES = ['in_stock', 'out_of_stock', 'pre_order', 'unknown'] as const;
```
Every part of the system must use one of these 4 values. Rules, LLM answers and the database all fit into this fixed set, so the rest of the code never deals with free text like "Back soon!".

Also defined: `Watch` (kind `url` or `query`), `Product` (with `current_status`, `current_price`), `Snapshot` (one check result, with `method`: `rule` / `llm` / `error` / `simulated`).

---

## Part 2: Database (`src/db/`)

### `src/db/index.ts`: the tables
Opens `data/assistant.db` and creates the tables if they don't exist. Read the SQL comments; each table is explained there. (See also the table list in [2-how-it-works.md](2-how-it-works.md).)

Things worth noticing:
- `PRAGMA foreign_keys = ON`: deleting a product also deletes its snapshots (`ON DELETE CASCADE`).
- `snapshots` has an index on `(product_id, checked_at)` so history lookups are fast.
- `deliveries` has `PRIMARY KEY (event_id, chat_id)`: the database itself makes it impossible to record the same alert to the same chat twice.
- `ensureColumn(...)`: a tiny "migration". `CREATE TABLE IF NOT EXISTS` doesn't add new columns to an existing table, so new columns are added with `ALTER TABLE`.
- **The NULL bug fix** at the bottom:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS uq_watches ON watches (kind, lower(value), COALESCE(chat_id, ''));
  ```
  Global watches have `chat_id = NULL`. In SQL, `NULL` is never equal to `NULL`, so the normal `UNIQUE` constraint allowed duplicates. `COALESCE(chat_id, '')` turns NULL into `''` so duplicates are blocked. `lower(value)` makes "Pixhawk 6X" and "pixhawk 6x" the same watch.

### `src/db/repo.ts`: all the queries
**The only file that contains SQL.** Everything else calls these functions. If you ever move to Postgres, only this file changes.

| Function | What it does |
|---|---|
| `addWatch(kind, value, label, chatId)` | Add a watch (or re-activate it if it exists). Uses `chat_id IS ?`, a NULL-safe compare |
| `listWatches(chatId?)` | Active watches: a chat sees its own + the global ones |
| `deactivateWatch(id, chatId)` | Remove a user's own watch (global ones are protected by `AND chat_id = ?`) |
| `ensureProduct({source, url, title})` | Insert a product **only if new**. Returns `created: true/false` |
| `updateProductTitle` | Replace the title with the real one from the product page (Robu search titles come from URLs) |
| `setProductAttributes` | Save the LLM's category / brand / specs |
| `productsForWatches(ids)` | All products covered by some watches |
| **`recordSnapshot(productId, obs)`** | **The heart of state tracking**, explained below |
| `insertEvent` | Write a change into the outbox |
| `startRun` / `finishRun` | Record each monitoring run |
| `forceProductStatus` | Demo helper used by `npm run simulate` |

**`recordSnapshot` in detail:**
```ts
const previous = product.current_status;          // remember the old status
INSERT INTO snapshots (...)                       // always save history
const changed = obs.status !== 'unknown' && obs.status !== previous;
UPDATE products SET
  current_status = CASE WHEN ? = 'unknown' THEN current_status ELSE ? END,   // ← key rule
  current_price  = COALESCE(?, current_price),                              // keep old price if none
  ...
return { snapshotId, previous, previousPrice, changed };
```
The `CASE WHEN ... 'unknown'` line means a failed check is written to history but **does not change** the current status. That prevents false alerts after a network glitch.

**▶ Try it:** `npm run db:seed` prints the watches table.

---

## Part 3: Reading the stores (`src/sources/`)

Read the files in this order.

### `src/sources/types.ts`: the contract
Every store adapter must provide:
```ts
interface SourceAdapter {
  id: string;            // "robu", "zbotic"...
  hosts: string[];       // which websites it handles
  search(query): Promise<Listing[]>;              // find products → [{url, title}]
  fetchProduct(url): Promise<PageObservation>;    // read one product → signals
}
```
`PageObservation` holds the **raw facts**: `title`, `price`, and `signals` (`schemaAvailability`, `platformInStock`, `availabilityText`), plus `pageText` (a short text snippet for the LLM). There's no final status here; deciding is the extractor's job.

### `src/sources/http.ts`: polite downloading
All adapters download through this file. It adds:
1. **Per-site speed limit** (`waitForTurn`): at most 1 request every 2 seconds per store (Robu: 4s). Different stores still run at the same time.
2. **Timeout** (20s): one slow site can't freeze the run.
3. **Retries** with growing waits (1s, 2s, 4s) for errors like 429 (too many requests) or 500 (server error).
4. **Two transports:** Node's `fetch` (normal) or the system `curl` (for Robu).

Why curl for Robu? Robu uses Cloudflare, which blocked Node's connection "fingerprint" with `403` no matter what headers we sent, while curl was accepted. Even with curl, about 1 in 3 requests got a random 403 that worked on retry, so `isRetryable` treats 403 as temporary **only for curl**.

`setHostDelay('robu.in', 4000)`: Robu gets a slower speed limit.

### `src/sources/html.ts`: HTML helpers
- `extractJsonLdProduct(html)`: many stores put a hidden JSON block in their pages for Google (schema.org "Product"). It contains `availability` (e.g. `https://schema.org/OutOfStock`) and the price. This is more stable than reading the visible page, because stores rarely change what Google reads.
- `stockSnippet(html)`: takes a **short** (max 800 characters) piece of visible text from the stock/cart area of the page. It's sent to the LLM only if needed: short means cheaper and less confusing for a small model.

### `src/sources/match.ts`: our own search filter
Store search is fuzzy: searching "Pixhawk 6X" on Evelta returns buzzers. `matchesQuery(title, query)` keeps a result only if:
- every word of the query is in the title ("controller" also matches "controllers"), and
- **numbers must come right after their word**: "Raspberry Pi **5**" matches "Raspberry Pi 5 Case" but **not** "IR camera 5 MP for Raspberry Pi" (a real bug found in testing).

### The adapters (`src/sources/adapters/`)

| File | Store type | How it reads |
|---|---|---|
| `shopify.ts` | Any Shopify store (ThinkRobotics) | Search: `/search/suggest.json`. Product: `/products/<name>.js` gives `available` and every variant |
| `woocommerce.ts` | Any WooCommerce store (Zbotic) | Store API `/wp-json/wc/store/v1/products`. Gets `is_in_stock` and the store's label ("Available on backorder"). Prices come in paise, so we divide by 100 |
| `bigcommerce.ts` | Any BigCommerce store (Evelta) | Search: parse the search results page with cheerio. Product: JSON-LD + text snippet |
| `robu.ts` | Robu only | Search: Robu's search page is built by JavaScript in the browser (empty HTML), so we use its **sitemap** (a list of all 40,000+ product URLs), cached for 24 hours. Product: JSON-LD via curl |
| `jsonld.ts` | **Any other website** | Generic fallback: JSON-LD + text. Lets users watch a URL from a store we've never seen |

Look at `robu.ts` → `productUrls()`: if one sitemap page fails, it keeps that page's URLs from the previous cache, so one failed request doesn't remove Robu from the run.

### `src/sources/registry.ts`: the list of stores
```ts
export const adapters: SourceAdapter[] = [
  new RobuAdapter(),
  new ShopifyAdapter('thinkrobotics', 'ThinkRobotics', 'https://thinkrobotics.com'),
  new WooCommerceAdapter('zbotic', 'Zbotic', 'https://zbotic.in'),
  new BigCommerceAdapter('evelta', 'Evelta', 'https://evelta.com'),
];
```
- **Adding a store on Shopify/Woo/BigCommerce = one line here.**
- `adapterForUrl(url)` picks the adapter by website name, or the generic JSON-LD one.
- `searchAllSources(query)` searches all stores **at the same time** with `Promise.allSettled`. If one store fails, the others still return results, and the error is reported separately. Then `matchesQuery` filters, and at most 10 results per store are kept.

**▶ Try it:**
```bash
npm run probe -- search "pixhawk 6x"
npm run probe -- fetch https://zbotic.in/product/cuav-pixhawk-v6x-v2-flight-controller/
```
The `fetch` output shows the raw `signals` and then the `extraction` (Part 4).

---

## Part 4: Deciding the status (`src/extract/`, `src/llm/`)

### `src/extract/rules.ts`: decisions without AI
`classifyByRules(obs)` returns a status, or `null` if it can't decide safely. The order matters:

1. **Store label says pre-order/backorder** → `pre_order`. (Zbotic says `is_in_stock: true` for backorders. The label is more honest.)
2. **Platform JSON boolean** (Shopify/Woo) → `in_stock` or `out_of_stock`.
3. **schema.org availability** → mapped status, **unless the page text disagrees**. Evelta: schema says OutOfStock but the text says "30 in stock", so return `null` (let the LLM decide).
4. **Only text:** decide only if it points to exactly one status.
5. Otherwise `null`.

`textHints(text)` finds which statuses a text mentions (it can be several, which is how conflicts are detected). One detail: "**not in stock**" contains the words "in stock", so it is removed before looking for in-stock words. Otherwise "This item is not in stock" would count as an in-stock hint.

### `src/llm/client.ts`: talking to the LLM
- `chat(body)` sends a request to any **OpenAI-compatible** API (Gemini, Groq, Ollama, OpenAI). Switching provider = changing `LLM_BASE_URL` and `LLM_MODEL` in `.env`.
- Calls are spaced at least 1 second apart (free-tier limits), and 429/500 errors are retried after 5s, 10s, then 20s.
- `temperature: 0` = the most predictable answers.
- `chatJson(messages, schema)` asks for JSON, cuts out the `{...}` part (small models sometimes add text around it), and **validates it with zod**. If it doesn't match, it throws, and the caller chooses a safe fallback.

### `src/extract/llm.ts`: the two LLM jobs
**Job 1, `classifyByLlm(obs)`:** only called when rules return `null`.
- Sends the title + signals + an 800-character snippet, with a strict prompt (`STATUS_PROMPT`).
- The answer must be `{status, confidence, reason}`, where status is one of the 4 values (zod checks it).
- `confidence < 0.6` → `unknown`. Any error → `unknown`. *Never guess.*

**Job 2, `extractAttributes(titles)`:** category, brand and specs from product **titles**.
- Runs **once per new product**, not every day (attributes don't change).
- **20 titles in one request** (cheaper than 20 requests).
- Titles are sent with IDs: `{"p0": "title", "p1": "title"}`, and the answer must use the same IDs. Why not a simple list? In testing, the model skipped one item in a list and every answer after it shifted to the wrong product. With IDs a missing answer is visible, and missing IDs are asked again once.
- `CATEGORIES` is the fixed category list used by chat filters (e.g. `flight_controller`).

### `src/extract/index.ts`: the decision pipeline
```ts
const rule = classifyByRules(obs);
if (rule) return { status: rule.status, method: 'rule', ... };   // free
const llm = await classifyByLlm(obs);                            // only if needed
return { status: llm.status, method: 'llm', ... };
```
The `method` is saved in each snapshot, so you can always see who decided.

**▶ Try it:**
```bash
npm run probe -- fetch https://evelta.com/raspberry-pi-5-with-2-4-8gb-ram/   # often method: 'llm' (conflicting signals)
npm run probe -- attrs "raspberry pi 5"                                     # LLM categories for search results
npm test                                                                    # rules tests in tests/rules.test.ts
```

---

## Part 5: The daily check (`src/monitor/`)

### `src/monitor/changes.ts`: is this change worth an alert?
`classifyChange(input)` is a **pure function**: no database, no internet, just input → output. That makes it easy to test (`tests/changes.test.ts`).

| Situation | Result |
|---|---|
| New status is `unknown` | nothing |
| New product, baseline run | nothing (no day-1 alert storm) |
| New product, later run, buyable | `new_listing` |
| Previous status was `unknown` | nothing (this is its baseline) |
| → `in_stock` | `back_in_stock` |
| → `pre_order` | `preorder_opened` |
| → `out_of_stock` | `went_out_of_stock` (recorded, **not** alerted) |
| Price dropped ≥ 5% and still buyable | `price_drop` |

`ALERT_KINDS` lists which kinds send a Telegram message.

### `src/monitor/run.ts`: one monitoring run
`runCheck(options)` does Journey A (see guide 2):

1. **Discover:** `discover(watch)` runs each query watch on all stores and calls `ensureProduct` + `linkWatchProduct`. It remembers which products are **new** and which are **baseline** (watch never ran before: `last_run_at` is null).
2. **Check:** products are grouped by store with `Map.groupBy`. Stores run **in parallel** (`Promise.all`), while products inside one store run **one after another**, to be polite.
3. `checkProduct(p)` does fetch → `extractStatus` → `recordSnapshot` → `classifyChange` → `insertEvent`. Errors are caught per product: the snapshot is saved as `unknown`/`error` and the run continues.
4. **Enrich:** products without a category get `extractAttributes`.
5. `markWatchRun` (ends the baseline) and `finishRun` (stats).

Options: `watchIds` (only some watches), `productIds` (only some products, fast), `discover: false`.

### `src/monitor/scheduler.ts`: the timer
- `cron.schedule(config.CHECK_CRON, ...)` runs `monitorAndNotify` daily (Indian time).
- Every 10 minutes it calls `deliverPending` to retry alerts that failed to send.
- `running` flag: if a run is still going, the next one is skipped (no overlap).

**▶ Try it:** `npm run check -- --watch 3` (checks the Pixhawk 6X watch; you'll see `rule`/`llm` per product).

---

## Part 6: Alerts (`src/notify/`)

### `src/notify/types.ts`
```ts
interface Notifier { channel: string; send(chatId, html): Promise<void>; }
```
Any channel (Telegram, WhatsApp, email) just needs these two members.

### `src/notify/telegram.ts`
- `getBot()` creates **one** grammY `Bot` for the whole program (alerts and chat share it).
- `TelegramNotifier.send()` sends HTML messages. If Telegram says "too many requests", it waits exactly as long as Telegram asks (`retry_after`) and tries again.

### `src/notify/format.ts`
Builds the message text: `formatAlert` (one alert) and `formatDigest` (several alerts for one chat become **one** message, so the user isn't spammed). `escapeHtml` makes sure product titles with `<` or `&` don't break Telegram's HTML.

### `src/notify/deliver.ts`: the outbox drain
`deliverPending(notifier)`:
1. One SQL query finds every (event, chat) pair **not yet in `deliveries`**:
   - the event kind is alert-worthy,
   - the chat has an active watch covering the product (global watch → every subscriber),
   - the event is less than 3 days old (don't send old news after downtime),
   - the event happened after the chat subscribed.
2. Group by chat, send in chunks of 10.
3. **After** Telegram accepts → insert into `deliveries`. On failure → nothing recorded, so it's retried later.

**▶ Try it:** `npm run notify` (prints `Delivered 0` if nothing is pending; that proves no duplicates).

---

## Part 7: The AI chat (`src/chat/`, `src/bot.ts`)

### `src/chat/tools.ts`: what the LLM is allowed to do
Each tool has 3 parts:
```ts
search_products: tool({
  description: '...when to use it...',          // the LLM reads this to choose
  schema: z.object({ category: z.enum(CATEGORIES).optional(), max_price: z.number().optional(), ... }),
  run: (args) => { ...SQL query... return results; },
}),
```
- **One zod schema, two jobs:** `toolDefinitions()` turns it into the JSON schema sent to the LLM (`z.toJSONSchema`), and `runTool()` uses it to **validate** the LLM's arguments before running anything.
- Invalid arguments or errors are returned to the LLM as `{ error: "..." }` so it can fix its call, and the program doesn't crash.
- `cleanSchema()` removes JSON-schema keywords that Gemini's API rejects.
- `view(p)` returns only the fields the LLM needs (fewer tokens).
- `add_watch` saves the watch, then calls `ctx.onWatchAdded(...)`, which starts the first check in the background.

### `src/chat/agent.ts`: the conversation loop
```
messages = [SYSTEM_PROMPT, ...last 6 exchanges, user message]
repeat up to 5 times:
    ask LLM (with tools)
    if it answers with text → done, return it
    if it asks for tools → run each tool, add the results to messages, loop again
```
- `SYSTEM_PROMPT` holds the rules for the LLM: always use tools, emoji per status, Telegram HTML only, short answers.
- On the last round tools are withheld, so the LLM **must** answer.
- The assistant message is kept **exactly** as returned, because Gemini attaches a hidden "signature" to tool calls that must be sent back.
- `history` (a `Map` in memory) keeps the last 6 exchanges per chat, so "compare the two cheapest" knows what "the two" are. It resets when the bot restarts.

### `src/bot.ts`: the main program
- `/start` → `addSubscriber` + welcome/help. `/help`, `/reset`.
- Any text message → "typing…" indicator → `handleMessage` (agent) → reply.
- `firstCheck(...)` runs after `add_watch`: `runCheck({watchIds: [id]})`, then sends "✅ Now watching…" with the results.
- `sendHtml`: if the LLM wrote broken HTML and Telegram rejects it, send it again as plain text.
- `startScheduler(...)` starts the daily job inside the same program.

**▶ Try it:** `npm run chat -- "in-stock flight controllers under 20000" "compare the two cheapest"` (the agent in your terminal, with no Telegram needed; you'll see `[agent] search_products(...)` lines).

---

## Part 8: Scripts (`src/scripts/`)

| Script | Command | Purpose |
|---|---|---|
| `seed.ts` | `npm run db:seed` | Create the DB + the 5 default watches (safe to run again) |
| `check.ts` | `npm run check [-- --watch N / --product N / --no-discover]` | Run a monitoring pass now + send alerts |
| `simulate.ts` | `npm run simulate -- list` / `-- <id> out_of_stock` | Demo: rewind a product's status so the next real check sees a change |
| `notify.ts` | `npm run notify` | Send pending alerts once |
| `probe.ts` | `npm run probe -- search "..."` / `fetch <url>` / `attrs "..."` | Debug adapters and extraction |
| `chat.ts` | `npm run chat -- "message" "follow-up"` | Test the chat agent without Telegram |
| `stats.ts` | `npm run stats` | Look inside the database (watches, runs, events, deliveries) |

**Why is `simulate` honest?** It only changes our *memory* of the product (sets it to out_of_stock). The check that follows **really downloads the store page** and really sees "in stock". The alert is produced by the real code path.

---

## Part 9: Tests (`tests/`)

| File | Tests | Covers |
|---|---|---|
| `rules.test.ts` | 10 | Extraction rules, using real signals from each store |
| `match.test.ts` | 11 | Search filter, including the "camera 5 MP" bug |
| `changes.test.ts` | 13 | Every alert rule (restock, pre-order, price drop, baseline...) |

They run offline in under a second: `npm test`. Built with Node's own test runner (`node:test`), so no extra library is needed.

---

✅ You've now read every file. Next: [4-testing.md](4-testing.md) to test each part yourself.
