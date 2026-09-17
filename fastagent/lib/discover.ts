import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HttpError, api, daysSince, json, pooled, saveEtags, searchRepos, serial, type Repo } from "./github.ts";
import { LAYERS } from "./layers.ts";

/**
 * Where candidates come from. Four sources, because each one is blind to what the others see:
 *
 * 1. **What is already listed.** Without this a listed project falls off the week its search ranking
 *    dips; a run of this pipeline once lost Claude Code, LangGraph, LiteLLM, Mastra and Langfuse, none
 *    of which had changed at all.
 * 2. **Per-layer searches**, which find projects that describe themselves in the layer's own words.
 * 3. **Brand-new repositories**, which no ranking or list has caught up with yet. This is the only
 *    source that can see a project published this week.
 * 4. **Lists other people maintain full time.** Breadth for free; measured freshness on 2026-09-13 was
 *    17/25 and 13/25 of sampled links pushed within 30 days, against 5/24 for a stale one we dropped.
 */
export const SOURCE_LISTS = [
  "hesreallyhim/awesome-claude-code",
  "kyrolabs/awesome-agents",
  "punkpeye/awesome-mcp-servers",
  "e2b-dev/awesome-sdks-for-ai-agents",
  "awesome-opencode/awesome-opencode",
  "Shubhamsaboo/awesome-llm-apps",
  "steven2358/awesome-generative-ai",
];
/** Ecosystem-wide sweeps that belong to no single layer. */
export const ECOSYSTEM_QUERIES = [
  "topic:llmops",
  "topic:agentic-ai",
  "topic:autonomous-agents",
  "topic:ai-agent stars:>300",
  "topic:ai-agents",
  "topic:llm-apps",
  "topic:generative-ai tools",
  "topic:openai stars:>500",
];
/**
 * New repositories. One window sorted by stars is one ranking, and a 45-day window ranked by stars is
 * a list of things that are 40 days old — anything published on Tuesday is crowded out before it can
 * gather a star. Several windows each get their own ranking, and the `updated` sort catches what has
 * no stars at all yet.
 */
export const FRESH_WINDOWS: { days: number; sort: string }[] = [
  { days: 7, sort: "stars" },
  { days: 21, sort: "stars" },
  { days: 60, sort: "stars" },
  { days: 7, sort: "updated" },
];
export const FRESH_QUERIES = [
  "agent in:name,description",
  "llm in:name,description",
  "mcp in:name,description",
  "ai agent in:readme",
  "agentic in:name,description",
  "claude in:name,description",
  "codex OR cursor in:name,description",
  "ai tool in:description",
];
/**
 * Per list, not shared: one counter was consumed in order, so awesome-mcp-servers and four others
 * contributed exactly zero while the first two lists spent it all.
 *
 * This is a cost ceiling, not a quality judgement — every name costs one repository read here and one
 * model judgement later — so it is named as one and set high enough that a list's own curation, not
 * our budget, decides what gets seen.
 */
const NEW_PER_LIST = Number(process.env.STACK_LIST_BUDGET ?? 400);

/** A list, a course or a demo is not a project you put in production. */
const EXCLUDE = /awesome|tutorial|course|roadmap|handbook|cookbook|examples?$|demo|starter|template|boilerplate|papers?$|interview|study|learn/i;

export type Candidate = {
  repo: string;
  stars: number;
  pushedDays: number;
  ageDays: number;
  description: string;
  foundVia: string[];
  seeded: boolean;
};

export function repoMentions(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [, owner, name] of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
    if (["orgs", "topics", "features", "settings", "sponsors"].includes(owner)) continue;
    const repo = `${owner}/${name.replace(/\.git$|\.$/, "")}`;
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return counts;
}

/**
 * The floor, which is deliberately dull. Scoring ranks; a filter only hides. It keeps out what cannot
 * be measured (no licence), what is already dead, and forks. A listed project skips it entirely: only
 * a judgement removes something from the index, never a ranking wobble.
 */
export function passesFloor(repo: Repo, listed: boolean, minStars: number, userIssues = 0): boolean {
  if (listed) return true;
  if (repo.fork || repo.archived) return false;
  if (!(repo.license?.spdx_id ?? "").replace("NOASSERTION", "")) return false;
  if ((daysSince(repo.pushed_at) ?? 999) > 90) return false;
  if (EXCLUDE.test(repo.full_name) || EXCLUDE.test(repo.description ?? "")) return false;
  return repo.stargazers_count >= minStars || userIssues >= 10;
}

async function userIssueCount(repo: string): Promise<number> {
  try {
    const issues = await api<any[]>(`/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=60`);
    return issues.filter((issue) => !issue.pull_request && (daysSince(issue.created_at) ?? 999) <= 30).length;
  } catch {
    return 0;
  }
}

/**
 * Where a project is talked about before GitHub ranking notices it. Each source is wrapped: one that
 * will not load is a gap in breadth, never a reason to abandon the sweep.
 *
 * Product Hunt was checked and left out — its feed carries launches, and launches rarely link a
 * repository — and Lobsters is included cheaply despite thin GitHub coverage.
 */
export async function mentionSources(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const add = (repo: string, source: string) => {
    if (!found.has(repo)) found.set(repo, source);
  };
  const linked = (text: string | null | undefined) => text?.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/)?.[1];

  const month = Math.floor(Date.now() / 1000) - 30 * 86_400;
  // Ten keywords at a lower floor: a project posted to HN at 6 points is still earlier evidence than
  // anything GitHub ranking will show, and 16 hits from four keywords was leaving the source unused.
  const hnQueries = ["agent", "llm", "mcp", "ai coding", "agentic", "coding agent", "llm tool", "ai memory", "prompt", "show hn ai"];
  for (const query of hnQueries) {
    try {
      const result = await json<{ hits: { url?: string; title: string; points: number }[] }>(
        `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(query)}&numericFilters=points>5,created_at_i>${month}&hitsPerPage=50`,
      );
      for (const hit of result.hits) {
        const repo = linked(hit.url);
        if (repo) add(repo, "hn");
      }
    } catch {
      // Algolia is free and unauthenticated; when it is down we simply see less this run.
    }
  }

  try {
    // GitHub publishes no trending API, so this reads the page. Fragile by nature, hence wrapped.
    for (const since of ["daily", "weekly"]) {
      const response = await fetch(`https://github.com/trending?since=${since}`, {
        headers: { "user-agent": "Mozilla/5.0 (ai-agent-stack)" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;
      for (const [, repo] of (await response.text()).matchAll(/href="\/([\w.-]+\/[\w.-]+)\/stargazers"/g)) add(repo, `trending-${since}`);
    }
  } catch {
    // ignore
  }

  // Lobsters was tried and removed: its AI tag produced zero repository links across a full sweep.
  return found;
}

/**
 * A one-time baseline. The daily sweep only sees what was pushed in the last month or created in the
 * last two, so a project built two years ago, last touched six weeks ago and never listed anywhere is
 * invisible to it — not rejected, never seen. This enumerates the whole domain instead.
 *
 * GitHub returns at most 1,000 results per query however many pages you ask for, so the space is cut
 * into star bands until each band fits under that ceiling. The floor's own rules are pushed into the
 * query (at least 100 stars, pushed within 90 days) because filtering in the search costs one call and
 * filtering afterwards costs one call per repository.
 */
const BACKFILL_TERMS = [
  "(ai agent OR llm OR mcp OR agentic) in:name,description",
  "(assistant OR chatbot) llm in:name,description",
  "(prompt OR skills OR context) llm in:name,description",
  "(rag OR embeddings OR vector) in:name,description",
  "(openai OR anthropic OR claude OR gemini) in:name,description",
  "(智能体 OR 大模型 OR 提示词) in:name,description",
];
/** Narrow enough that each band stays under the 1,000-result ceiling for the broadest term. */
const STAR_BANDS = [
  "100..119", "120..149", "150..189", "190..249", "250..329", "330..449", "450..699",
  "700..1199", "1200..2499", "2500..4999", "5000..9999", "10000..29999", ">=30000",
];

export async function backfill(workspace: string, minStars: number): Promise<number> {
  const pool = await collectPool(workspace);
  const pushed = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  let added = 0;
  for (const term of BACKFILL_TERMS) {
    for (const band of STAR_BANDS) {
      const stars = band.startsWith(">=") ? `stars:${band}` : `stars:${band}`;
      const repos = await searchRepos(`${term} ${stars} pushed:>${pushed}`, "stars", 100, 10).catch(() => []);
      for (const repo of repos) {
        if (!pool.has(repo.full_name)) added++;
        pool.set(repo.full_name, (pool.get(repo.full_name) ?? new Set()).add("backfill"));
      }
      console.log(`  ${band.padEnd(12)} ${repos.length.toString().padStart(4)} results  ${term.slice(0, 42)}`);
      await new Promise((done) => setTimeout(done, 1000)); // search allows 30 requests a minute
    }
  }
  await measurePool(workspace, pool, minStars);
  return added;
}

export async function collectPool(workspace: string): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  const add = (repo: string, source: string) => found.set(repo, (found.get(repo) ?? new Set()).add(source));

  const seedsPath = resolve(workspace, "seeds.json");
  if (existsSync(seedsPath)) {
    const seeds = JSON.parse(await readFile(seedsPath, "utf8")) as { categories: { repos: (string | { repo: string })[] }[] };
    for (const category of seeds.categories) {
      for (const entry of category.repos) add(typeof entry === "string" ? entry : entry.repo, "listed");
    }
  }

  const month = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  await serial(LAYERS.flatMap((layer) => layer.queries.map((query) => ({ layer: layer.id, query }))), 1000, async ({ layer, query }) => {
    for (const repo of await searchRepos(`${query} pushed:>${month}`, "stars", 20, 2).catch(() => [])) add(repo.full_name, layer);
  });
  await serial(ECOSYSTEM_QUERIES, 1000, async (query) => {
    for (const repo of await searchRepos(`${query} pushed:>${month}`, "updated", 30).catch(() => [])) add(repo.full_name, "ecosystem");
  });
  for (const window of FRESH_WINDOWS) {
    const since = new Date(Date.now() - window.days * 86_400_000).toISOString().slice(0, 10);
    await serial(FRESH_QUERIES, 1000, async (query) => {
      for (const repo of await searchRepos(`${query} created:>${since}`, window.sort, 30).catch(() => [])) {
        add(repo.full_name, `new-${window.days}d-${window.sort}`);
      }
    });
  }

  for (const [repo, source] of await mentionSources()) add(repo, source);

  for (const source of SOURCE_LISTS) {
    let budget = NEW_PER_LIST;
    try {
      const response = await fetch(`https://raw.githubusercontent.com/${source}/HEAD/README.md`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) continue;
      // Most-mentioned first: a list that names a project twice is pointing at it.
      const mentioned = [...repoMentions(await response.text()).entries()].sort((a, b) => b[1] - a[1]);
      for (const [repo] of mentioned) {
        if (found.has(repo) || budget <= 0) continue;
        add(repo, `list:${source}`);
        budget -= 1;
      }
    } catch {
      // A list that will not load is a gap in breadth, not a reason to abandon the sweep.
    }
  }
  return found;
}

export async function discover(workspace: string, minStars: number) {
  return measurePool(workspace, await collectPool(workspace), minStars);
}

async function measurePool(workspace: string, pool: Map<string, Set<string>>, minStars: number) {
  const listedSet = new Set([...pool].filter(([, sources]) => sources.has("listed")).map(([repo]) => repo));
  const names = [...pool.keys()].filter((repo) => !EXCLUDE.test(repo));

  const rows = await pooled(names, 8, async (repo): Promise<Candidate | undefined> => {
    let info: Repo;
    try {
      info = await api<Repo>(`/repos/${repo}`);
    } catch (error) {
      if (error instanceof HttpError) return undefined;
      return undefined;
    }
    const listed = listedSet.has(repo);
    // The issue count is a second door into the list, so it is only worth paying for when stars fail.
    const issues = !listed && info.stargazers_count < minStars ? await userIssueCount(repo) : 0;
    if (!passesFloor(info, listed, minStars, issues)) return undefined;
    return {
      repo: info.full_name,
      stars: info.stargazers_count,
      pushedDays: daysSince(info.pushed_at) ?? 999,
      ageDays: daysSince(info.created_at) ?? 0,
      description: (info.description ?? "").slice(0, 120),
      foundVia: [...(pool.get(repo) ?? [])],
      seeded: listed,
    };
  });

  const candidates = rows.filter((row): row is Candidate => Boolean(row)).sort((a, b) => b.stars - a.stars);
  const payload = {
    generatedAt: new Date().toISOString(),
    floor: { minStars, orUserIssues30d: 10, pushedWithinDays: 90, openLicence: true },
    pool: pool.size,
    candidates,
  };
  await writeFile(resolve(workspace, "data/candidates.json"), `${JSON.stringify(payload, null, 1)}\n`);
  // Discovery never saved its ETags, so every sweep re-read all 6,500 repositories at full price and
  // spent the hourly limit several times over. A 304 costs nothing; not storing the tag costs everything.
  await saveEtags();
  return payload;
}
