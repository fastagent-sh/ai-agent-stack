import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HttpError, api, daysSince, pooled, searchRepos, serial, type Repo } from "./github.ts";
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
export const ECOSYSTEM_QUERIES = ["topic:llmops", "topic:agentic-ai", "topic:autonomous-agents", "topic:ai-agent stars:>300"];
/** New repositories: the only path by which something published this week can be seen at all. */
export const FRESH_QUERIES = ["agent in:name,description", "llm in:name,description", "mcp in:name,description", "ai agent in:readme"];
const NEW_PER_RUN = 250;

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

export async function collectPool(workspace: string, freshDays: number): Promise<Map<string, Set<string>>> {
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
  const fresh = new Date(Date.now() - freshDays * 86_400_000).toISOString().slice(0, 10);

  await serial(LAYERS.flatMap((layer) => layer.queries.map((query) => ({ layer: layer.id, query }))), 1000, async ({ layer, query }) => {
    for (const repo of await searchRepos(`${query} pushed:>${month}`).catch(() => [])) add(repo.full_name, layer);
  });
  await serial(ECOSYSTEM_QUERIES, 1000, async (query) => {
    for (const repo of await searchRepos(`${query} pushed:>${month}`, "updated", 30).catch(() => [])) add(repo.full_name, "ecosystem");
  });
  // Sorted by stars *among repositories created inside the window*: new and already noticed.
  await serial(FRESH_QUERIES, 1000, async (query) => {
    for (const repo of await searchRepos(`${query} created:>${fresh}`, "stars", 30).catch(() => [])) add(repo.full_name, "new");
  });

  let budget = NEW_PER_RUN;
  for (const source of SOURCE_LISTS) {
    try {
      const response = await fetch(`https://raw.githubusercontent.com/${source}/HEAD/README.md`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) continue;
      for (const repo of repoMentions(await response.text()).keys()) {
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

export async function discover(workspace: string, minStars: number, freshDays = 30) {
  const pool = await collectPool(workspace, freshDays);
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
  return payload;
}
