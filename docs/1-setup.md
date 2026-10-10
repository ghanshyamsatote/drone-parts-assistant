# 1. Setup on a New Laptop

Follow these steps in order. They work on Windows (PowerShell in VS Code), macOS and Linux.

## Step 1: Install the tools (one time)

| Tool | Why | Check it works |
|---|---|---|
| **Node.js 24 or newer** (<https://nodejs.org>) | Runs the project. Version 24+ is needed for the built-in SQLite database | `node --version` shows `v24...` or higher |
| **Git** (<https://git-scm.com>) | To clone the repo. On Windows it also installs a `curl` that works with Robu | `git --version` |
| **VS Code** | To read the code and run terminals | – |

## Step 2: Get the code

```bash
git clone <your-github-repo-url>
cd ShoppingAsistance
npm install
```

`npm install` downloads the libraries listed in `package.json` into `node_modules/`.

## Step 3: Create your `.env` file (secrets and settings)

The `.env` file holds your keys. It is **never** uploaded to GitHub (`.gitignore` excludes it), so on a new laptop you create it again.

```powershell
# Windows PowerShell
copy .env.example .env
```
```bash
# macOS / Linux
cp .env.example .env
```

Open `.env` in VS Code and fill in:

```
LLM_API_KEY=<your Gemini key from https://aistudio.google.com/apikey>
TELEGRAM_BOT_TOKEN=<your bot token from @BotFather>
```

Everything else can stay as it is.

> **Windows only:** if Robu checks fail later with `HTTP 403`, add this line to `.env`:
> `CURL_BIN=C:/Program Files/Git/mingw64/bin/curl.exe`
> (Windows' built-in curl is blocked more often by Robu's Cloudflare than Git's curl.)

## Step 4: Create the database and the default watchlist

```bash
npm run db:seed
```

Expected output: a table with 5 watches (Raspberry Pi 5, Pi 5 HATs, Pixhawk 6X, flight controllers, Jetson Orin). This creates `data/assistant.db`.

## Step 5: Check everything is OK

```bash
npm run typecheck     # no output = no TypeScript errors
npm test              # should end with: pass 34, fail 0
```

## Step 6: Do the first monitoring run (the baseline)

```bash
npm run check
```

- This takes about **4–5 minutes** the first time (it visits about 110 product pages slowly and politely, and downloads Robu's sitemap).
- Every watch says `(baseline run, no alerts)`. That's correct: the first run only records the current state.
- At the end: `Run #1: ~110 products ... { rule: ..., llm: ... }`

## Step 7: Start the bot

```bash
npm run bot
```

Expected:
```
[scheduler] monitoring scheduled: "0 9 * * *" (Asia/Kolkata)
Bot running. Send /start to your bot in Telegram. Ctrl+C to stop.
```

**Leave this terminal open.** The bot only works while this program runs.

## Step 8: Subscribe in Telegram

Open your bot in Telegram and send `/start`. You should get "👋 Subscribed! ..." plus a help message.

> The database on the new laptop is fresh, so you **must** send `/start` again even if you did it before on the other computer.

✅ **Setup complete.** Continue with [2-how-it-works.md](2-how-it-works.md), or jump to [5-demo-video.md](5-demo-video.md) to record.

---

## Problems and fixes

| Problem | Fix |
|---|---|
| `node:sqlite` not found / syntax errors | Node is too old. Install Node 24+ |
| `LLM HTTP 404 ... model ... no longer available` | Google retired the model name. Put the model it suggests in `.env` as `LLM_MODEL=...` |
| `LLM HTTP 400/401/403` | Wrong or expired Gemini key in `.env` |
| `LLM HTTP 429` | Free-tier rate limit. The code waits and retries; if it keeps failing, wait a minute |
| `TELEGRAM_BOT_TOKEN is not set` | Fill it in `.env` and save the file |
| Telegram `401 Unauthorized` | Token was revoked or mistyped. Get the current one from @BotFather |
| `[robu] ... HTTP 403` many times | Set `CURL_BIN` (see Step 3). A few random 403s are normal; they are retried automatically |
| Bot doesn't answer | Is `npm run bot` still running? Only ONE bot process may run per token (two cause a "409 Conflict" error) |
| No alert arrives | Did you send `/start` on this database? Is the bot token correct? Run `npm run notify` to retry |
