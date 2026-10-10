# 4. How to Test Everything

Test from the inside out: small pieces first, then the whole system. Each test says **what it proves** and **what you should see**.

> Before starting: finish [1-setup.md](1-setup.md) (`.env` filled, `npm run db:seed` done, first `npm run check` done).

| # | Test | Command | Internet? | Time |
|---|---|---|---|---|
| 1 | Unit tests | `npm test` | no | 1s |
| 2 | Store adapters | `npm run probe -- search/fetch` | yes | 10s |
| 3 | Extraction (rules + LLM) | `npm run probe -- fetch` / `attrs` | yes | 10s |
| 4 | Monitoring run | `npm run check -- --watch 3` | yes | 1 min |
| 5 | Change → alert (the demo) | `simulate` + `check --product` | yes | 10s |
| 6 | No duplicate alerts | `npm run notify` | yes | 2s |
| 7 | Chat agent (terminal) | `npm run chat -- "..."` | yes | 20s |
| 8 | Chat in Telegram | `npm run bot` + phone | yes | 5 min |
| 9 | Look inside the database | `npm run stats` | no | 1s |
| 10 | Scheduler | change `CHECK_CRON` | yes | 5 min |

---

## Test 1: Unit tests (offline)

```bash
npm test
```
**Proves:** the decision logic is correct: extraction rules (`tests/rules.test.ts`), the search filter (`tests/match.test.ts`), and alert rules (`tests/changes.test.ts`).

**Expect:** `tests 34`, `pass 34`, `fail 0`.

**Learn more:** open `tests/changes.test.ts`. Each test is one sentence of business logic, like `'out_of_stock -> in_stock = back_in_stock'`. Try breaking a rule in `src/monitor/changes.ts` (e.g. change `0.05` to `0.5`) and run `npm test` to watch a test fail. Then undo it.

---

## Test 2: Store adapters

```bash
npm run probe -- search "pixhawk 6x"
```
**Proves:** all 4 stores are searched in parallel and irrelevant results are filtered out.

**Expect:** a table of results from `robu` and `zbotic` (Evelta and ThinkRobotics don't sell the 6X, so they show nothing, which is correct). The first time, Robu takes about 90s to download its sitemap; after that it's cached for 24h.

```bash
npm run probe -- fetch https://thinkrobotics.com/products/raspberry-pi-5
```
**Proves:** one adapter reads one product.

**Expect:** `adapter: thinkrobotics`, then `signals: { platformInStock: true, availabilityText: '2GB: available, 4GB: sold out, ...' }`.

Try one URL from each store:

| Store | Example URL | Signal you should see |
|---|---|---|
| Robu | `https://robu.in/product/holybro-pixhawk-6x-autopilot-flight-controller/` | `schemaAvailability` |
| Zbotic | `https://zbotic.in/product/cuav-pixhawk-v6x-v2-flight-controller/` | `platformInStock` + `availabilityText` |
| Evelta | `https://evelta.com/raspberry-pi-5-with-2-4-8gb-ram/` | `schemaAvailability` + `pageText` |
| ThinkRobotics | `https://thinkrobotics.com/products/raspberry-pi-5` | `platformInStock` + variants |

(Stock changes daily, so your statuses may differ from these examples.)

---

## Test 3: Extraction (rules first, LLM second)

The same `fetch` command prints an `extraction:` block at the end:

```
extraction: { status: 'pre_order', method: 'rule', evidence: 'store label: "Available on backorder | ..."' }
```

**Proves:** the decision and **who** made it (`method: 'rule'` or `'llm'`). `evidence` explains why.

- Zbotic "Available on backorder" → `pre_order` by **rule** (even though the store's API says "in stock").
- Evelta Raspberry Pi 5 → often `method: 'llm'`, because schema.org and the page text disagree.

```bash
npm run probe -- attrs "flight controller"
```
**Proves:** the LLM extracts category/brand/specs from titles in one batched call. **Expect:** a table where every row has a `category` like `flight_controller`.

---

## Test 4: A monitoring run

```bash
npm run check -- --watch 3
```
**Proves:** Journey A (discover → fetch → extract → save → detect) for the "Pixhawk 6X" watch.

**Expect:** one line per product:
```
  [zbotic] in_stock     (rule) ₹94,498.95  Holybro Pixhawk 6X Pro Flight Controller (FC only)
  [robu] out_of_stock (rule) ₹33,047  Holybro Pixhawk 6X Autopilot Flight Controller ...
Run #5: 16 products in 45s { rule: 16 }
No alert-worthy changes.
```
"No alert-worthy changes" is normal: stock rarely changes within minutes.

Other options:
```bash
npm run check                    # everything (~4–5 min)
npm run check -- --no-discover   # re-check known products only, skip searching
npm run check -- --product 71    # only one product (seconds)
```

---

## Test 5: Change detection → Telegram alert ⭐ (this is the demo)

Make sure you sent `/start` to your bot on this database (see setup step 8).

**Step 1: find a product that is in stock right now:**
```bash
npm run simulate -- list
```
Pick an `id` from the table (any row with status `in_stock`). Product IDs are different on every computer.

**Step 2: pretend it was out of stock:**
```bash
npm run simulate -- <id> out_of_stock
```
This only changes our database's memory. It also prints the next command to run.

**Step 3: run a real check of that product:**
```bash
npm run check -- --product <id>
```
**Expect:**
```
  [zbotic] in_stock     (rule) ₹94,498.95  Holybro Pixhawk 6X Pro ...  → back_in_stock
1 alert-worthy change(s) written to the outbox:
Telegram: delivered 1.
```
📱 **And on your phone:** "🟢 Back in stock ...".

**Proves:** the real code path, end to end: the real store page was downloaded, a rule decided `in_stock`, `classifyChange` saw out_of_stock → in_stock, an event went into the outbox, and the notifier sent it.

**Variation, pre-order:** pick a product whose status is `pre_order` in `npm run simulate -- list`, simulate `out_of_stock`, then check it. You get "🟡 Pre-order open".

---

## Test 6: Alerts are never sent twice

Right after test 5:
```bash
npm run notify
```
**Expect:** `Delivered 0 alert(s).`

**Proves:** the `deliveries` table works. The alert from test 5 is recorded, so it's never sent again, no matter how many times this runs.

---

## Test 7: Chat agent in the terminal (no Telegram)

```bash
npm run chat -- "show me in-stock flight controllers under 20000" "compare the two cheapest"
```
**Expect:** for each message, an `[agent] tool_name({...})` line (which tool the LLM chose, with which arguments), then the answer.
```
[agent] search_products({"max_price":20000,"category":"flight_controller","status":"in_stock"})
[agent] compare_products({"product_ids":[81,86]})
```
**Proves:** the LLM turns English into correct tool calls, and remembers the conversation ("the two cheapest").

More to try:
```bash
npm run chat -- "is the pixhawk 6x available anywhere?"
npm run chat -- "show the history of #<id>"
npm run chat -- "any pre-order items?"
npm run chat -- "cheapest Raspberry Pi 5 HAT in stock"
```

> Watches added from the terminal belong to a fake chat called `cli`. For real watches, use Telegram (test 8).

---

## Test 8: Chat in Telegram

```bash
npm run bot
```
Then in Telegram:

| Send | Expect | Proves |
|---|---|---|
| `/help` | list of examples | bot is running |
| `show me in-stock flight controllers under 20000` | list with 🟢, prices, links, [#ids] | search + filter |
| `compare the two cheapest` | side-by-side | compare + memory |
| `is the Pixhawk 6X available anywhere?` | status per store | status question |
| `history of #<id>` | dated list of checks | history |
| `watch https://robu.in/product/holybro-pixhawk-6c-mini-flight-controller/` | quick reply, then **a second message** "✅ Now watching..." | dynamic watchlist (URL) |
| `watch Jetson Orin Nano` | reply, then results after about a minute | dynamic watchlist (search) |
| `what am I watching?` | your watches | list |
| `stop watching #<watch id>` | confirmation | remove |

The terminal running the bot shows each `[agent] ...` tool call, which is useful to see what the LLM did.

---

## Test 9: Look inside the database

```bash
npm run stats
```
Shows: active watches (and how many products each covers), products per store and status, recent runs, recent events with **how many chats received each**, and the checks that needed the LLM.

Things to notice:
- `runs`: the first run has `events: 0` (baseline, by design).
- `events`: an event from **before** you sent `/start` shows `delivered_to: 0`. Chats never receive old news.

---

## Test 10: The scheduler

The bot runs the monitoring job daily at 9:00 AM. To see it happen sooner:

1. In `.env`, set `CHECK_CRON=*/5 * * * *` (every 5 minutes).
2. Restart the bot (`Ctrl+C`, then `npm run bot`).
3. Within 5 minutes the terminal shows `[scheduler] monitoring run started ...` and later `[scheduler] run #N: ... products ...`.
4. **Set it back** to `CHECK_CRON=0 9 * * *` afterwards.

The cron format is `minute hour day month weekday`. `0 9 * * *` = 09:00 every day.

---

## When something fails

- Read the error line; most messages say what's wrong (missing key, HTTP status).
- `npm run probe -- fetch <url>` isolates one store problem.
- `npm run stats` → the `errors` column in runs.
- See the "Problems and fixes" table in [1-setup.md](1-setup.md).
