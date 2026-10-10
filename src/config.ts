import 'dotenv/config';
import { z } from 'zod';

// All runtime settings come from .env, validated once at startup.
// If something is malformed we fail fast with a clear message instead of
// crashing halfway through a monitoring run.
const schema = z.object({
  DB_PATH: z.string().default('./data/assistant.db'),
  CHECK_CRON: z.string().default('0 9 * * *'),
  REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  // curl used for Cloudflare-protected stores (Robu). On Windows, Git's curl
  // works better than the built-in one: C:/Program Files/Git/mingw64/bin/curl.exe
  CURL_BIN: z.string().default('curl'),

  LLM_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai/'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('gemini-3.5-flash-lite'),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
});

export const config = schema.parse(process.env);
