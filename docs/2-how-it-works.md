# 2. How It Works: The Big Picture

The whole system is **3 journeys** that share **one database**. Understand these 3 and you understand the project.

1. **Journey A, the monitoring run:** every day, check all products and detect changes.
2. **Journey B, the alert:** turn a detected change into a Telegram message.
3. **Journey C, the chat message:** a user asks something and the AI answers using the database.

---

## The database (the shared memory)

Everything is stored in one SQLite file: `data/assistant.db`. Think of the tables like this:

```
watches ──< watch_products >── products ──< snapshots
 "what to track"   (links)     "real pages"   "history of checks"
                                   │
                                   └──< events ──< deliveries
                                       "changes"   "who got which alert"
subscribers  = Telegram chats that receive alerts
runs         = one row per monitoring run (when, how many, errors)
```

| Table | One row means | Example |
|---|---|---|
| `watches` | "Track this" | query "Pixhawk 6X" (global) or URL `https://robu.in/product/...` (user's own) |
| `products` | One product page + its **current** status and price | Zbotic, "Holybro Pixhawk 6X Pro...", in_stock, ₹94,498.95 |
| `watch_products` | "This watch covers this product" | watch "Pixhawk 6X" → 16 products |
| `snapshots` | One check result (never edited, only added) | 2026-10-10 05:35, in_stock, ₹94,498.95, decided by `rule` |
| `events` | One detected change (the **outbox**) | back_in_stock: out_of_stock → in_stock |
| `deliveries` | "This chat already got this event" | event 4 → chat 12345 |
| `subscribers` | A Telegram chat that sent /start | chat 12345 |
| `runs` | One monitoring run | run 1: 107 products, 3 LLM calls, 0 errors |

---

## Journey A: the monitoring run

**Started by:** the scheduler (daily at 9:00 AM) or you (`npm run check`).
**Code:** `src/monitor/run.ts` → `runCheck()`

```
 1. DISCOVER        For each query watch ("Pixhawk 6X"):
                    search all 4 stores in parallel ─► filter results ─► save new products
                    (sources/registry.ts → searchAllSources)

 2. FETCH           For each tracked product: get the product page/API data
                    (sources/adapters/*.ts → fetchProduct)
                    Result = "signals" (raw facts), NOT a decision yet

 3. EXTRACT         Turn signals into ONE status:
                    rules first (free) ─► if unclear, ask the LLM
                    (extract/index.ts → extractStatus)

 4. SAVE            Add a snapshot; update the product's current status
                    (db/repo.ts → recordSnapshot)

 5. DETECT          Compare old vs new status: is it worth an alert?
                    (monitor/changes.ts → classifyChange)
                    If yes ─► write an EVENT into the outbox

 6. ENRICH          New products: the LLM reads titles and adds category/brand/specs
                    (extract/llm.ts → extractAttributes)
```

### A real example, step by step

Product: *Holybro Pixhawk 6X Pro Flight Controller (FC only)* on **Zbotic**. Yesterday it was `out_of_stock`.

| Step | What happens | Data |
|---|---|---|
| 2. Fetch | The WooCommerce adapter calls Zbotic's Store API | `{ platformInStock: true, availabilityText: "In stock" }`, price 94498.95 |
| 3. Extract | Rules: no pre-order words, platform says available → **in_stock** (no LLM needed) | `{ status: in_stock, method: rule }` |
| 4. Save | New snapshot. `previous` = out_of_stock | product.current_status = in_stock |
| 5. Detect | out_of_stock → in_stock = **back_in_stock** | event written to `events` |

### Why "signals first, decision later"?

Each store gives different information:

| Store | What we get |
|---|---|
| ThinkRobotics (Shopify) | JSON: `available: true`, plus every variant ("4GB: sold out") |
| Zbotic (WooCommerce) | JSON: `is_in_stock: true` **and** a label like "Available on backorder" |
| Evelta (BigCommerce) | schema.org data in the HTML + visible text ("30 in stock") |
| Robu | schema.org data in the HTML |

Adapters only collect these facts. **One place** (the extractor) decides. So adapters stay simple, and all decision logic can be tested in one file.

### Why rules first, LLM second?

```
Zbotic: is_in_stock = true, label "Available on backorder"
        → Rule: backorder words ⇒ pre_order ✔ (no LLM)

Robu:   schema.org = OutOfStock, no other text
        → Rule: out_of_stock ✔ (no LLM)

Evelta: schema.org = OutOfStock, BUT page text says "30 in stock"
        → Signals CONFLICT ⇒ rules return null ⇒ LLM reads it ⇒ in_stock
```

In the first real run, **104 of 107** products were decided by rules and only **3** needed the LLM. The result is cheap, fast and predictable.

### Safety rules (to avoid wrong alerts)

1. **`unknown` never overwrites a real status.** If a site times out, we record "unknown" in history but keep "in_stock" as the current status. Otherwise: in_stock → unknown → in_stock = a fake "back in stock" alert.
2. **Baseline:** the first run of a watch never alerts (otherwise day 1 = 100 alerts).
3. **LLM unsure** (confidence < 0.6) or invalid answer → `unknown` → no alert. *A missed alert is better than a false alert.*

---

## Journey B: the alert

**Started by:** the end of `npm run check`, the end of the daily run, or every 10 minutes (retry).
**Code:** `src/notify/deliver.ts` → `deliverPending()`

```
events table (outbox)
   │  find events that some subscribed chat has NOT received yet
   ▼
group by chat ─► format message (notify/format.ts) ─► send via Telegram (notify/telegram.ts)
   │
   ▼  only after Telegram says OK
deliveries table: (event, chat) recorded ─► never sent again
```

**Who receives an event?** Every chat that has an active watch covering that product. Global watches (from the seed) go to **all** subscribers.

**Why an outbox instead of sending directly from the monitor?**
- If Telegram is down, the events just wait and are retried every 10 minutes. Nothing is lost.
- The monitor doesn't care how messages are sent, so adding WhatsApp later = one new class.
- The `deliveries` table guarantees no duplicates: run it 10 times, each alert is sent once.

The message you received:
```
🟢 Back in stock                                     ← event.kind
Holybro Pixhawk 6X Pro Flight Controller (FC only)    ← product.title (link)
Zbotic · ₹94,498.95                                  ← product.source + event.new_price
was: out of stock                                    ← event.from_status
```

---

## Journey C: the chat message

**Started by:** a user typing in Telegram.
**Code:** `src/bot.ts` → `src/chat/agent.ts` → `src/chat/tools.ts`

```
User: "show me in-stock flight controllers under 20000"
  │
  ▼
bot.ts receives it ─► agent.ts sends to the LLM: [system rules] + [recent chat] + [message] + [list of 7 tools]
  │
  ▼
LLM answers: "call search_products({category: 'flight_controller', status: 'in_stock', max_price: 20000})"
  │
  ▼
tools.ts: validate the arguments (zod) ─► run SQL on the products table ─► return results as JSON
  │
  ▼
agent.ts sends the results back to the LLM ─► LLM writes a short reply with prices and links
  │
  ▼
bot.ts sends the reply to Telegram
```

**The key idea:** the LLM never invents product data. It only:
1. understands what the user wants, and picks a tool + arguments,
2. turns the tool's real results into a friendly reply.

### The 7 tools

| Tool | Example user message |
|---|---|
| `search_products` | "in-stock flight controllers under 20000" |
| `product_details` | "history of #71" |
| `compare_products` | "compare the two cheapest" |
| `live_search` | (when nothing is found in our database) search the stores right now |
| `add_watch` | "watch https://robu.in/product/..." or "watch Jetson Orin Nano" |
| `list_watches` | "what am I watching?" |
| `remove_watch` | "stop watching #12" |

### Adding a watch (the "dynamic watchlist")

```
"watch https://robu.in/product/holybro-pixhawk-6c-mini-flight-controller/"
  → LLM calls add_watch({kind: "url", value: "https://..."})
  → saved in the watches table (no code change, no restart)
  → bot replies immediately: "I'm now watching..."
  → in the background: runCheck({watchIds: [new watch]})  (= Journey A for one watch)
  → a second message arrives: "✅ Now watching ... 🔴 out of stock · ₹28,269"
```

From the next day on, the daily run includes this watch automatically.

---

## Summary: which file does what

| Job | File |
|---|---|
| Settings | `src/config.ts` |
| Database tables / queries | `src/db/index.ts`, `src/db/repo.ts` |
| Read stores | `src/sources/adapters/*.ts`, `src/sources/http.ts` |
| Search all stores + filter | `src/sources/registry.ts`, `src/sources/match.ts` |
| Decide status | `src/extract/rules.ts`, `src/extract/llm.ts` |
| Call the LLM | `src/llm/client.ts` |
| Daily run | `src/monitor/run.ts`, `src/monitor/scheduler.ts` |
| Is this change alert-worthy? | `src/monitor/changes.ts` |
| Send alerts | `src/notify/deliver.ts`, `format.ts`, `telegram.ts` |
| Chat | `src/chat/agent.ts`, `src/chat/tools.ts`, `src/bot.ts` |

Next: [3-code-walkthrough.md](3-code-walkthrough.md) reads each file in detail.
