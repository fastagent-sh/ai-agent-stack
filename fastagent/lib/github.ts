import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const API = "https://api.github.com";

/** A status the server chose, as opposed to a connection that broke. Only the latter is worth retrying. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Repo = {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  license: { spdx_id?: string } | null;
  topics?: string[];
  fork: boolean;
  archived: boolean;
  pushed_at: string;
  created_at: string;
};

/**
 * The primary rate limit is 5,000 requests an hour, and the index passed it: 1,319 projects at four
 * calls each is 5,276, so the last layer measured zero and was silently dropped from the page. Waiting
 * for the window to reset is slow but correct; skipping a layer is neither.
 */
let resumeAt = 0;

async function respectRateLimit(response: Response) {
  const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? "1");
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? "0") * 1000;
  if (remaining > 20 || !reset) return false;
  const wait = Math.min(Math.max(reset - Date.now(), 0) + 2000, 65 * 60_000);
  resumeAt = Math.max(resumeAt, Date.now() + wait);
  console.error(`  rate limit reached; waiting ${Math.round(wait / 1000)}s for the window to reset`);
  return true;
}

/**
 * Conditional requests. GitHub does not charge the rate limit for a 304, and most repositories do not
 * change between daily runs, so carrying ETags is the difference between 5,300 calls (over the hourly
 * limit, which cost a whole layer) and a few hundred.
 */
const etagPath = () => resolve(process.env.AI_AGENT_STACK_CACHE ?? ".", "data/.etag-cache.json");
let etags: Record<string, { etag: string; body: unknown }> | undefined;

async function loadEtags(): Promise<Record<string, { etag: string; body: unknown }>> {
  if (!etags) etags = existsSync(etagPath()) ? JSON.parse(await readFile(etagPath(), "utf8")) : {};
  return etags ?? {};
}

/** Only small bodies are worth carrying: caching every 100-issue array overflowed V8's string limit. */
const CACHEABLE_BYTES = 40_000;
const MAX_ENTRIES = 20_000;

export async function saveEtags() {
  if (!etags) return;
  const entries = Object.entries(etags).slice(-MAX_ENTRIES);
  await writeFile(etagPath(), JSON.stringify(Object.fromEntries(entries)));
}

export async function api<T = any>(path: string, attempts = 3): Promise<T> {
  const cache = await loadEtags();
  const headers: Record<string, string> = { "user-agent": "ai-agent-stack", accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (cache[path]) headers["if-none-match"] = cache[path].etag;
  for (let attempt = 0; ; attempt++) {
    if (resumeAt > Date.now()) await new Promise((done) => setTimeout(done, resumeAt - Date.now()));
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      // Connections drop under concurrency; one flaky read should not end a sweep of hundreds.
      if (attempt >= attempts - 1) throw error;
      await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
      continue;
    }
    if (response.status === 304 && cache[path]) {
      await respectRateLimit(response);
      return cache[path].body as T;
    }
    if (response.ok) {
      await respectRateLimit(response);
      const body = (await response.json()) as T;
      const etag = response.headers.get("etag");
      if (etag && JSON.stringify(body).length <= CACHEABLE_BYTES) cache[path] = { etag, body };
      return body;
    }
    // 403 here is the rate limit, not a permission problem: the body says so and the headers prove it.
    if ((response.status === 403 || response.status === 429) && (await respectRateLimit(response))) continue;
    if (response.status >= 500 || response.status === 429) {
      if (attempt >= attempts - 1) throw new HttpError(response.status, `GET ${path}: ${response.status}`);
      await new Promise((done) => setTimeout(done, 3000 * (attempt + 1)));
      continue;
    }
    throw new HttpError(response.status, `GET ${path}: ${response.status} ${response.statusText}`);
  }
}

export async function json<T = any>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "user-agent": "ai-agent-stack" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new HttpError(response.status, `GET ${url}: ${response.status}`);
  return (await response.json()) as T;
}

/** Code search is limited to roughly 30 requests a minute, so callers space these out. */
export async function searchRepos(query: string, sort = "stars", perPage = 20, pages = 1): Promise<Repo[]> {
  const found: Repo[] = [];
  for (let page = 1; page <= pages; page++) {
    const result = await api<{ items: Repo[] }>(
      `/search/repositories?q=${encodeURIComponent(query)}&sort=${sort}&per_page=${perPage}&page=${page}`,
    );
    found.push(...(result.items ?? []));
    if ((result.items ?? []).length < perPage) break; // the last page is short; stop paying for the next
    if (page < pages) await new Promise((done) => setTimeout(done, 1000));
  }
  return found;
}

/**
 * Whole days since a timestamp, clamped at zero because GitHub's clock can sit seconds ahead of ours.
 * Undefined for a missing timestamp, which callers must handle: `days || 999` is falsy for today and
 * silently discarded a month of user issues when this was written in Python.
 */
export function daysSince(timestamp: string | null | undefined): number | undefined {
  if (!timestamp) return undefined;
  return Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 86_400_000));
}

export const within = (days: number | undefined, limit: number) => days !== undefined && days <= limit;

/** One at a time, with a gap. For endpoints that rate-limit on frequency rather than concurrency. */
export async function serial<T, R>(items: T[], gapMs: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) {
    out.push(await work(item));
    await new Promise((done) => setTimeout(done, gapMs));
  }
  return out;
}

/** Bounded concurrency: the API tolerates a handful of parallel reads, not hundreds. */
export async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

/** A read-through cache on disk, written once at the end: parallel writers corrupted it before. */
export function fileCache<T>(path: string) {
  let data: Record<string, T> = {};
  let loaded = false;
  return {
    async get(key: string): Promise<T | undefined> {
      if (!loaded) {
        data = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
        loaded = true;
      }
      return data[key];
    },
    set(key: string, value: T) {
      data[key] = value;
    },
    async flush() {
      await writeFile(path, JSON.stringify(data));
    },
  };
}
