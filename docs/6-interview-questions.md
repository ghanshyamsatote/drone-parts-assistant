# 6. Interview Questions & Answers

Questions a reviewer is likely to ask, with answers based on what this project actually does. Say them in your own words, and point to the file when you can.

---

## Data acquisition

**Q: How do you get data from the stores? Why not just scrape the HTML?**
I first checked what each store runs: Shopify, WooCommerce, BigCommerce, and a custom Next.js site. Each exposes something more reliable than HTML: Shopify and Woo have public JSON APIs, and Evelta and Robu put schema.org JSON-LD in their pages for Google. HTML themes are noisy: ThinkRobotics pages contain "In stock", "Sold out" and "Pre-order" template text on every page, so keyword scraping would be wrong. *(src/sources/adapters/)*

**Q: How would you add a new store?**
If it runs Shopify, WooCommerce or BigCommerce, it's one line in `registry.ts`. Otherwise I write one class implementing `SourceAdapter` with two methods, `search` and `fetchProduct`. Nothing else changes, because extraction, change detection and alerts work on the adapter's output. Any unknown site already works for URL watches through the generic JSON-LD adapter.

**Q: Why didn't you use a headless browser like Playwright?**
It wasn't needed, and it would be about 10x slower and heavier. The one store with client-rendered search (Robu) has a sitemap listing every product, and its product pages are server-rendered with JSON-LD. I'd add a browser only as a fallback if a store gave no structured data at all.

**Q: Tell me about a hard problem you hit.**
Robu returned 403 to Node regardless of headers, while curl with the same User-Agent worked. That pointed to Cloudflare fingerprinting the TLS connection, not the headers. Even with curl, about 1 in 3 requests got a random 403 that succeeded on retry. So I added a curl transport for that host only, treated 403 as retryable only on that transport, slowed that host to 4 seconds between requests, and made the sitemap loader keep the previous cache for any page that still fails. Robu's robots.txt allows product pages and sitemaps for all bots, so this is permitted access. *(src/sources/http.ts, adapters/robu.ts)*

**Q: How are you polite to the stores?**
Per-host rate limits (2s, 4s for Robu), one product at a time per store, a 24h sitemap cache, a timeout and limited retries, robots.txt respected, and only one run per day by default.

**Q: Store search returns junk. How do you handle it?**
My own relevance filter: every query word must be in the title, and model numbers must follow their name, so "Raspberry Pi 5" doesn't match "IR camera 5 MP for Raspberry Pi". That case was a real bug found in testing, and it's now a regression test. *(src/sources/match.ts, tests/match.test.ts)*

---

## LLM usage

**Q: Where do you use the LLM and why?**
Three narrow jobs:
1. **Stock status, only when rules can't decide**, e.g. Evelta's JSON-LD says out of stock (for one variant) while the page says "30 in stock".
2. **Product attributes** (category, brand, specs) from titles, so chat can filter "flight controllers under ₹20k". Done once per product, 20 titles per call.
3. **The chat agent**, which turns natural language into tool calls.

**Q: Why not send every page to the LLM?**
Cost, speed and predictability. Most pages have clear structured data, which plain rules handle for free and deterministically. In the first full run, 104 of 107 products were decided by rules and 3 by the LLM.

**Q: How do you stop the LLM from giving wrong or made-up answers?**
- The status must be one of 4 values, and zod validates the JSON.
- Temperature 0.
- Low confidence (< 0.6) or invalid output → `unknown`, and `unknown` never triggers an alert or overwrites a known status.
- In chat, the LLM can only call 7 tools; it never writes SQL or invents product facts. Tool arguments are validated with zod.

**Q: Why a small model? Which one?**
The brief asks for a small, cheap model, and these tasks are easy when the input is short and the output constrained. I use Gemini Flash-Lite (free tier) through the OpenAI-compatible API, so switching to Groq, Ollama or OpenAI is just two lines in `.env`. That paid off: Google retired the first model name during the project, and the fix was a config change.

**Q: Any LLM problems you hit?**
For attribute extraction I first sent a numbered list. The model skipped a near-duplicate title, and every answer after it shifted to the wrong product. I switched to an object keyed by IDs and re-ask for any missing IDs. *(src/extract/llm.ts)*

---

## State & change detection

**Q: How do you detect changes?**
Each check adds a snapshot (history, never edited), and the product row keeps the current status. `recordSnapshot` returns the previous status, and a pure function, `classifyChange`, decides if the transition matters: back in stock, pre-order opened, price drop ≥ 5%, new listing, or went out of stock (recorded but not alerted). *(src/db/repo.ts, src/monitor/changes.ts)*

**Q: How do you avoid false alerts?**
- A failed check records `unknown` but doesn't overwrite the current status. Otherwise in_stock → unknown → in_stock would be a fake "back in stock".
- The first run of each watch is a silent baseline, with no alert storm on day 1.
- Price drops under 5% are ignored as noise.
- An uncertain LLM answer → `unknown`.

**Q: What if Telegram is down when a change is detected?**
The monitor never sends directly. It writes events to an outbox table, and the notifier delivers them and records each delivery. If sending fails, nothing is recorded, and the scheduler retries every 10 minutes. *(src/notify/deliver.ts)*

**Q: Can a user get the same alert twice?**
Not after it's recorded: `deliveries` has a primary key on (event, chat), and the notifier only sends pairs that aren't there. There's one tiny window: if the process crashed after Telegram accepted the message but before recording it, it would be re-sent once. That's at-least-once delivery, which I chose deliberately, because a duplicate alert is better than a lost one.

**Q: Why SQLite and no ORM?**
One process, a few thousand rows, no server to run. Node 24 has SQLite built in. All SQL is in one repository file, so moving to Postgres or adding an ORM is contained. With six tables and some SQLite-specific upsert/CASE logic, an ORM would add setup without much benefit.

**Q: Tell me about a bug you found.**
Re-running the seed created duplicate global watches, even with a UNIQUE constraint. Global watches have `chat_id = NULL`, and in SQL `NULL` is never equal to `NULL`, so UNIQUE didn't apply. The fix was a unique index on `COALESCE(chat_id, '')` plus a NULL-safe lookup (`chat_id IS ?`). *(src/db/index.ts)*

---

## Messaging & chat

**Q: Why Telegram and not WhatsApp?**
Telegram bots are free and take two minutes to create. WhatsApp needs Meta Business verification or Twilio. The delivery side is a `Notifier` interface, so WhatsApp is one more class; the outbox, recipients and formatting are reused. *(src/notify/types.ts)*

**Q: How does the chat work?**
A tool-calling loop. The LLM gets a system prompt, the recent conversation, the message, and 7 tool definitions. It picks a tool, my code validates the arguments and runs the query, and the results go back to the LLM, which writes the reply. Max 5 rounds; on the last round tools are withheld so it must answer. *(src/chat/agent.ts)*

**Q: How do users add products without a code change?**
The `add_watch` tool saves a URL or a search term in the `watches` table. The daily run reads that table, so the new watch is included automatically. The first check runs in the background and the result arrives as a follow-up message, so the chat doesn't block.

**Q: How do you keep tool schemas and validation in sync?**
One zod schema per tool does both jobs: `z.toJSONSchema` generates what the LLM sees, and the same schema validates the LLM's arguments. Invalid arguments are returned to the LLM as an error so it can correct itself. *(src/chat/tools.ts)*

---

## Trade-offs & next steps

**Q: What are the limitations?**
- Robu discovery uses sitemap slugs, so it's cruder than real search.
- Cloudflare could tighten its rules at any time.
- Variants are tracked at the product level.
- Single process: chat memory is in-memory, and the lock is in-process.
- Category watches depend on how stores word titles ("companion computer" matched nothing, so I used "Jetson Orin").
- No user authentication.

**Q: What would you do with more time / for production?**
- Postgres + a job queue (e.g. BullMQ) for multiple workers and retries.
- Per-variant tracking ("tell me when the 8GB is back").
- Price history and "lowest in 30 days" alerts.
- A WhatsApp notifier.
- Monitoring/metrics on run errors per store, with an alert when a store's adapter starts failing (a sign the site changed).
- A headless-browser fallback adapter for stores with no structured data.
- Persistent chat memory.

**Q: How did you test it?**
34 offline unit tests for the core decision logic (extraction rules, search matching, change classification), with fixtures taken from real store responses. Plus probe commands to test each adapter live, a terminal chat command, and an end-to-end simulate → check → Telegram flow.
