import { z } from 'zod';
import { config } from '../config.js';

// Minimal client for any OpenAI-compatible chat endpoint (Gemini, Groq,
// Ollama, OpenAI...). Plain fetch — no SDK — so switching provider is just
// LLM_BASE_URL + LLM_MODEL in .env.
//
// Free tiers have low rate limits, so calls are spaced out and 429s are
// retried with backoff.

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const MIN_INTERVAL_MS = 1000;
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(body: Record<string, unknown>): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  if (!config.LLM_API_KEY) throw new Error('LLM_API_KEY is not set');

  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + MIN_INTERVAL_MS;
    if (slot > now) await sleep(slot - now);

    const res = await fetch(new URL('chat/completions', config.LLM_BASE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.LLM_API_KEY}` },
      body: JSON.stringify({ model: config.LLM_MODEL, temperature: 0, ...body }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      return data.choices[0].message;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(5000 * 2 ** attempt); // 5s, 10s, 20s
      continue;
    }
    throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/**
 * Ask for JSON and validate it against a zod schema. Small models sometimes
 * wrap JSON in ```fences``` or add a sentence, so we extract the outermost
 * {...} before parsing. Anything that doesn't validate throws — callers
 * decide the safe fallback (usually status "unknown").
 */
export async function chatJson<T>(messages: ChatMessage[], schema: z.ZodType<T>): Promise<T> {
  const msg = await chat({ messages, response_format: { type: 'json_object' } });
  const text = msg.content ?? '';
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return schema.parse(JSON.parse(json));
}
