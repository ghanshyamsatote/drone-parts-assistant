# 5. Demo Video: Step-by-Step Script

The brief asks the video to show:
1. ✅ The monitoring job running (a forced run)
2. ✅ A stock/pre-order alert arriving in Telegram
3. ✅ Live chat: searching/filtering products, and adding a product to the watchlist by chat

Target length: **4–6 minutes**. Screen recording with your voice explaining is perfect.

---

## Before you press record (10 minutes)

- [ ] Setup is complete ([1-setup.md](1-setup.md)), including one full `npm run check` (baseline).
- [ ] Bot keys work: `npm run bot` starts with no errors.
- [ ] You sent `/start` to the bot on **this** database.
- [ ] Pick your demo product now:
  ```bash
  npm run simulate -- list
  ```
  Write down one `in_stock` product id: ________ (and a `pre_order` id if there is one: ________)
- [ ] Do a practice run of Part 2 below once, so you know it works.
- [ ] Screen layout: **VS Code on the left** (terminal visible, bigger font: `Ctrl +`), **Telegram on the right** (Telegram Desktop or web.telegram.org, so the phone isn't needed).
- [ ] Close other notifications. Clear the Telegram chat if you want a clean screen.
- [ ] Two terminals open in VS Code: **Terminal 1** for the bot, **Terminal 2** for commands.

---

## Part 1: Introduction and architecture (45s)

**Show:** `README.md` in VS Code, preview mode (`Ctrl+Shift+V`), scrolled to the architecture diagram.

**Say (example):**
> "This is an AI shopping assistant for drone parts. It monitors four Indian stores (Robu, ThinkRobotics, Zbotic and Evelta) and alerts on Telegram when a product comes back in stock or opens for pre-order. Users can also chat with it to search and to add products to watch.
> Each store has an adapter that collects raw facts. Simple rules decide the status for clear cases, and a small, cheap LLM is used only when the signals are unclear. Changes go into an outbox table, and a notifier sends them to Telegram."

---

## Part 2: Forced monitoring run plus alert (1.5 min) ⭐

**Terminal 1:**
```bash
npm run bot
```
**Say:** "The bot is running. It also schedules the daily monitoring job at 9 AM."

**Terminal 2.** First show a broader run, so the monitoring is visible:
```bash
npm run check -- --watch 3
```
**Say while it runs:** "This is a forced run of the daily job for the Pixhawk 6X watch. It searches all four stores, then checks every product. Each line shows the status and who decided it: `rule` means plain code decided for free. The LLM is only used when signals conflict."

Point at the final line, e.g. `{ rule: 16 }`, and *"No alert-worthy changes"*: "Nothing changed in the last few minutes, so no alerts, which is correct."

**Now the alert.** Real restocks take days, so simulate:
```bash
npm run simulate -- <your id> out_of_stock
```
**Say:** "Real restocks can take weeks, so I rewind this product in our database to out of stock. Only our memory changes; the next check really downloads the store page."
```bash
npm run check -- --product <your id>
```
Point at: `→ back_in_stock` and `Telegram: delivered 1.`

**Switch to Telegram:** show **🟢 Back in stock ...**

**Say:** "The real page says in stock, the change detector saw out of stock to in stock, and the alert arrived. If I run the notifier again..."
```bash
npm run notify
```
"...it delivers zero. Alerts are never sent twice."

*(Optional: repeat with a `pre_order` product to show "🟡 Pre-order open".)*

---

## Part 3: Live chat (2 min)

In Telegram, type each message and wait for the answer. Keep the bot terminal visible, so the `[agent] search_products(...)` lines show which tool the AI chose.

1. `show me in-stock flight controllers under 20000`
   **Say:** "The LLM translated my sentence into a database search with filters: category, status and max price. It never invents products; everything comes from the database."
2. `compare the two cheapest`
   **Say:** "It remembers the conversation and compares them."
3. `is the Pixhawk 6X available anywhere?`
4. `history of #<id of your demo product>`
   **Say:** "Here's the check history, including the change we just made."
5. `watch https://robu.in/product/holybro-pixhawk-6c-mini-flight-controller/`
   **Say:** "Now I add a new product just by chatting, with no code change and no restart. The first check runs in the background..." Wait for the **✅ Now watching** message. "...and here's the current status. From now on it's part of the daily check."
6. `what am I watching?`

---

## Part 4: Closing (30s)

**Optional:** run `npm run stats` and show the runs table: "In the full run, 104 of 107 products were decided by rules and only 3 needed the LLM."

**Say:**
> "Key design choices: structured data instead of fragile HTML scraping, rules first with a small LLM only for ambiguous cases, an outbox so alerts are never lost or duplicated, and adapters so new stores take one line. Limitations and trade-offs are in the README. Thank you."

---

## If something goes wrong while recording

| Problem | Quick fix |
|---|---|
| No alert in Telegram | Did you `/start` on this database? Run `npm run notify` |
| `check --product` shows `out_of_stock` (no alert) | That product really went out of stock. Pick another id from `npm run simulate -- list` |
| The chat answer is slow | Free LLM tier rate limits. Wait a few seconds, or cut it in editing |
| `409 Conflict` from Telegram | Two bots are running. Close the other terminal/process |
| A store shows ERROR | Fine to mention: "one store failed, and the others continued". That shows the resilience design |
