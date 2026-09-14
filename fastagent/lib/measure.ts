import { resolve } from "node:path";
import { api, daysSince, fileCache, json, within } from "./github.ts";

type Release = { body?: string; published_at?: string };
type Issue = { pull_request?: unknown; author_association?: string; created_at: string; comments?: number };

/**
 * What we can observe about a project, and the four sub-scores derived from it.
 *
 * The shape follows npms.io, which scores npm packages on separate axes rather than one number, and
 * Libraries.io's SourceRank 2.0 goals: comparable inside one ecosystem, readable without explanation,
 * published with its breakdown. Scores compare projects *within a layer*, never across the page.
 */
export type Metrics = {
  repo: string;
  description: string;
  stars: number;
  language: string;
  license: string;
  package?: string;
  weeklyDownloads?: number;
  pushedDays?: number;
  createdDays: number;
  lastReleaseDays?: number;
  releasesWithNotes90d: number;
  commits90d: number;
  userIssues30d: number;
  userIssuesAnswered30d: number;
  userIssuesTruncated: boolean;
};

/** A release whose notes are a version number describes a code change, not a change for the user. */
const NOTE_CHARS = 80;
const OUTSIDE = new Set(["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN"]);

export async function measureRepo(entry: string | { repo: string; package?: string }, workspace: string): Promise<Metrics | undefined> {
  const repo = typeof entry === "string" ? entry : entry.repo;
  const declared = typeof entry === "string" ? undefined : entry.package;
  try {
    const info = await api(`/repos/${repo}`);
    const [releases, issues, commits] = await Promise.all([
      api<Release[]>(`/repos/${repo}/releases?per_page=30`).catch(() => []),
      api<Issue[]>(`/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100`).catch(() => []),
      api<unknown[]>(`/repos/${repo}/commits?since=${new Date(Date.now() - 90 * 86_400_000).toISOString()}&per_page=100`).catch(() => []),
    ]);
    const withNotes = releases.filter((release) => (release.body ?? "").replace(/[#*`\s]/g, "").length >= NOTE_CHARS);
    const userIssues = issues.filter(
      (issue) => !issue.pull_request && OUTSIDE.has(issue.author_association ?? "") && within(daysSince(issue.created_at), 30),
    );
    return {
      repo,
      description: (info.description ?? "").trim(),
      stars: info.stargazers_count,
      language: info.language ?? "",
      license: (info.license?.spdx_id ?? "").replace("NOASSERTION", ""),
      package: declared,
      weeklyDownloads: await downloads(declared, workspace),
      pushedDays: daysSince(info.pushed_at),
      createdDays: daysSince(info.created_at) ?? 0,
      lastReleaseDays: withNotes.length ? daysSince(withNotes[0].published_at) : undefined,
      releasesWithNotes90d: withNotes.filter((release) => within(daysSince(release.published_at), 90)).length,
      commits90d: commits.length,
      userIssues30d: userIssues.length,
      userIssuesAnswered30d: userIssues.filter((issue) => (issue.comments ?? 0) > 0).length,
      // One page is 100 issues, so a busy tracker reports a floor rather than a total.
      userIssuesTruncated: issues.length === 100 && issues.every((issue) => within(daysSince(issue.created_at), 30)),
    };
  } catch (error) {
    console.error(`  skip ${repo}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

/**
 * Weekly installs, for packages declared in overrides.json. Detecting the name from a repository's root
 * manifest was tried and removed: in a monorepo the root package is a placeholder, so vercel/ai read as
 * "ai-repo" at 3 downloads a week against millions for the real package. A quietly wrong number is
 * worse here than no number.
 */
async function downloads(declared: string | undefined, workspace: string): Promise<number | undefined> {
  if (!declared) return undefined;
  const cache = fileCache<number | null>(resolve(workspace, "data/.package-cache.json"));
  const cached = await cache.get(declared);
  if (cached !== undefined) return cached ?? undefined;
  const [registry, name] = [declared.slice(0, declared.indexOf(":")), declared.slice(declared.indexOf(":") + 1)];
  let weekly: number | undefined;
  try {
    weekly =
      registry === "npm"
        ? (await json<{ downloads: number }>(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name).replace("%40", "@").replace("%2F", "/")}`)).downloads
        : (await json<{ data: { last_week: number } }>(`https://pypistats.org/api/packages/${name.toLowerCase().replace(/_/g, "-")}/recent`)).data.last_week;
  } catch {
    weekly = undefined; // a registry outage is a gap, not a zero
  }
  cache.set(declared, weekly ?? null);
  await cache.flush();
  return weekly;
}

export type Scores = { adoption: number; upkeep: number; answers?: number; growth?: number; score: number };

/**
 * Four sub-scores. Growth is what the index is for — a project shipping weekly and gaining users beats
 * a larger one doing neither — so it carries real weight, and adoption is log scaled because stars can
 * be bought. A project too new or too quiet to judge on answers is scored on the rest, never penalised
 * for the absence of evidence.
 */
export function scoreProject(metrics: Metrics, starsPerDay: number | undefined, asset: boolean): Scores {
  const installs = metrics.weeklyDownloads ?? 0;
  const adoption = Math.min(100, 8 * Math.log10(Math.max(10, metrics.stars)) + (installs ? 10 * Math.log10(installs) : 0));

  const upkeep = asset
    ? Math.min(100, metrics.commits90d * 1.2 + Math.max(0, 40 - (metrics.pushedDays ?? 99)))
    : Math.min(100, Math.max(0, 60 - (metrics.lastReleaseDays ?? 400) / 2) + Math.min(40, metrics.releasesWithNotes90d * 4));

  // Answering half of forty says more than answering both of two, so volume weights the ratio.
  const answers =
    metrics.userIssues30d >= 3
      ? Math.min(100, (100 * metrics.userIssuesAnswered30d) / metrics.userIssues30d * Math.min(1, 0.6 + metrics.userIssues30d / 25))
      : undefined;

  // Measured velocity when two snapshots exist; otherwise the project's own lifetime average, so a
  // repository published last week is not stuck at zero until the next run.
  const perDay = starsPerDay ?? (metrics.createdDays > 0 ? metrics.stars / metrics.createdDays : 0);
  const growth = Math.min(100, 25 * Math.log10(Math.max(1, perDay) + 1) * (starsPerDay === undefined ? 0.7 : 1));

  const parts = [adoption, upkeep, growth, answers ?? (adoption + upkeep + growth) / 3];
  return {
    adoption: Math.round(adoption),
    upkeep: Math.round(upkeep),
    answers: answers === undefined ? undefined : Math.round(answers),
    growth: Math.round(growth),
    score: Math.round(parts.reduce((sum, part) => sum + part, 0) / parts.length),
  };
}
