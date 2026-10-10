import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

// Polite HTTP client shared by all adapters:
//  - per-host rate limit (REQUEST_DELAY_MS between requests to the same site;
//    different sites still run in parallel)
//  - timeout, so one hanging site can't stall the whole run
//  - retry with backoff on 429 / 5xx / network errors only
//  - two transports: Node's fetch (default) and the system curl. Some sites
//    behind Cloudflare (Robu) reject Node's TLS fingerprint outright while
//    accepting curl; adapters opt into curl explicitly.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_S = 20;

export type Transport = 'fetch' | 'curl';

export class HttpError extends Error {
  constructor(public status: number, public url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

const nextSlot = new Map<string, number>();
const hostDelay = new Map<string, number>();

/** Override the request spacing for one host (some sites rate-limit harder). */
export function setHostDelay(host: string, ms: number): void {
  hostDelay.set(host, ms);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const execFileAsync = promisify(execFile);

async function waitForTurn(host: string): Promise<void> {
  // Reserve the next free slot for this host *before* sleeping, so
  // concurrent callers queue up instead of all firing at once.
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + (hostDelay.get(host) ?? config.REQUEST_DELAY_MS));
  if (slot > now) await sleep(slot - now);
}

async function viaFetch(url: string, accept: string) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9' },
    signal: AbortSignal.timeout(TIMEOUT_S * 1000),
  });
  return { status: res.status, body: await res.text() };
}

async function viaCurl(url: string, accept: string) {
  // -w appends the status code on its own line so we can read it back.
  const { stdout } = await execFileAsync(
    config.CURL_BIN,
    ['-sSL', '--compressed', '-A', USER_AGENT, '-H', `Accept: ${accept}`, '-m', String(TIMEOUT_S), '-w', '\n%{http_code}', url],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const cut = stdout.lastIndexOf('\n');
  return { status: Number(stdout.slice(cut + 1)), body: stdout.slice(0, cut) };
}

// The curl transport is used for Cloudflare-fronted sites, which hand out
// random 403s (~1 in 3 for Robu) that succeed on the next try. So there a
// 403 counts as transient; with plain fetch a 403 is a real "forbidden".
function isRetryable(status: number, transport: Transport): boolean {
  return status === 429 || status >= 500 || (transport === 'curl' && status === 403);
}

async function request(url: string, accept: string, transport: Transport): Promise<string> {
  const host = new URL(url).host;
  const retries = transport === 'curl' ? 3 : 2;
  for (let attempt = 0; ; attempt++) {
    await waitForTurn(host);
    let error: unknown;
    try {
      const { status, body } = await (transport === 'curl' ? viaCurl : viaFetch)(url, accept);
      if (status >= 200 && status < 300) return body;
      error = new HttpError(status, url);
      if (!isRetryable(status, transport)) throw error;
    } catch (err) {
      if (err instanceof HttpError && !isRetryable(err.status, transport)) throw err;
      error = err; // network error / timeout: retryable
    }
    if (attempt >= retries) throw error;
    await sleep(1000 * 2 ** attempt); // 1s, 2s, 4s (on top of the per-host spacing)
  }
}

export function getText(url: string, transport: Transport = 'fetch'): Promise<string> {
  return request(url, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', transport);
}

export async function getJson<T = unknown>(url: string, transport: Transport = 'fetch'): Promise<T> {
  return JSON.parse(await request(url, 'application/json', transport)) as T;
}
