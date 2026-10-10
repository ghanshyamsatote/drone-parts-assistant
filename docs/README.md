# 📘 Start Here: Project Guide

These guides explain the whole project: what every file does, how the pieces connect, how to test everything, and how to record the demo video.

## Read the guides in this order

| # | Guide | What you will learn | Time |
|---|---|---|---|
| 1 | [1-setup.md](1-setup.md) | Install and run the project on a new laptop | 15 min |
| 2 | [2-how-it-works.md](2-how-it-works.md) | The big picture: the 3 "journeys" through the system | 20 min |
| 3 | [3-code-walkthrough.md](3-code-walkthrough.md) | Every file, in the order you should read it | 1–2 hours |
| 4 | [4-testing.md](4-testing.md) | How to test each part, and what output to expect | 30 min |
| 5 | [5-demo-video.md](5-demo-video.md) | Step-by-step script for the video | 15 min |
| 6 | [6-interview-questions.md](6-interview-questions.md) | Questions the interviewer may ask, with answers | 30 min |

**Tip:** while reading guide 3, open each file in VS Code next to the guide. After each section, run the matching test from guide 4. Reading and running together is the fastest way to understand.

## The project in one picture

```
           ┌───────────── every day 9:00 AM (scheduler) ─────────────┐
           ▼                                                          │
  Watchlist ──► Source adapters ──► Extractor ──► Change detector ──► Outbox ──► Notifier ──► 📱 Telegram
  (database)    (read 4 stores)    (rules, then    (did status          (events    (sends
                                    LLM if unsure)   change?)            table)     alerts)

  📱 Telegram user ◄──► Chat agent (LLM + 7 tools that read/write the database)
```

## The project in one sentence

Every day the system visits product pages on 4 Indian stores, works out whether each product is in stock, compares that with yesterday, and sends a Telegram message when something becomes available. Users can also chat with the bot to search products and add new things to watch.

## Folder map

```
ShoppingAsistance/
├── README.md            ← main README (for reviewers): architecture, decisions, trade-offs
├── docs/                ← THESE guides (for you)
├── .env.example         ← template for secrets/settings (copy to .env)
├── package.json         ← dependencies + npm commands
├── tsconfig.json        ← TypeScript settings
├── src/
│   ├── config.ts        ← reads .env settings
│   ├── types.ts         ← shared types (StockStatus, Product, Watch...)
│   ├── db/              ← database (SQLite): tables + all SQL queries
│   ├── sources/         ← reading the store websites (one adapter per store)
│   ├── extract/         ← deciding the stock status (rules + LLM)
│   ├── llm/             ← tiny client to call the LLM (Gemini)
│   ├── monitor/         ← the daily check + change detection + scheduler
│   ├── notify/          ← sending alerts to Telegram
│   ├── chat/            ← the AI chat agent and its tools
│   ├── bot.ts           ← the main program (Telegram bot + scheduler)
│   └── scripts/         ← small command-line tools (check, simulate, probe...)
├── tests/               ← unit tests
└── data/                ← created at runtime: database file + cache (not in git)
```

## Words used in these guides

| Word | Meaning |
|---|---|
| **Watch** | Something a user asked us to track: a **URL** (one product page) or a **query** (a search term like "Pixhawk 6X", searched on every store) |
| **Product** | One real product page on one store |
| **Snapshot** | One observation: "on this date this product was in stock at ₹X". Stored forever (history) |
| **Status** | One of exactly 4 values: `in_stock`, `out_of_stock`, `pre_order`, `unknown` |
| **Adapter** | Code that knows how to read one kind of store (Shopify, WooCommerce...) |
| **Signal** | A raw fact from a page, e.g. "schema.org says OutOfStock" or "store label says Available on backorder" |
| **Rule** | Plain code (no AI) that turns signals into a status |
| **LLM** | Large Language Model (Gemini). Used only where rules can't decide, and for chat |
| **Event** | A detected change, e.g. "back in stock". Saved in the `events` table (the **outbox**) |
| **Outbox** | The events table. The monitor writes to it; the notifier reads from it and sends messages |
| **Baseline** | The first run of a watch. Everything is recorded silently, with no alerts |
| **Tool** | A function the chat LLM is allowed to call (e.g. `search_products`) |
