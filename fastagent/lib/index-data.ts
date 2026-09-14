import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ASSET_LAYERS as ASSET_IDS } from "./layers.ts";

/** The sixteen layer ids, from the one definition every part of the pipeline reads. */
export async function layerIds(_workspace: string): Promise<string[]> {
  const { LAYER_IDS } = await import("./layers.ts");
  return LAYER_IDS;
}

export type Verdict = {
  repo: string;
  in_stack: boolean;
  layer: string | null;
  why: string;
  /** What the project said about itself when it was judged, and when. A verdict without them cannot be
   *  checked for staleness, which is why the review queue treats a missing stamp as a reason to look. */
  judgedAt?: string;
  judgedDescription?: string;
};

/**
 * Candidates nobody has judged yet. Judged ones are skipped rather than re-read: a verdict costs a
 * model call, and the point of `data/classified.json` is that the cost is paid once per project.
 */
export async function unjudged(workspace: string, limit: number) {
  const { candidates } = JSON.parse(await readFile(resolve(workspace, "data/candidates.json"), "utf8")) as {
    candidates: { repo: string; stars: number; description: string; foundVia: string[]; ageDays: number; pushedDays: number }[];
  };
  const judgedPath = resolve(workspace, "data/classified.json");
  const judged = existsSync(judgedPath)
    ? new Set(Object.keys((JSON.parse(await readFile(judgedPath, "utf8")) as { verdicts: Record<string, Verdict> }).verdicts))
    : new Set<string>();

  const rows = candidates.filter((candidate) => !judged.has(candidate.repo));
  // Newest first when they are new: a project published this week is the one a list cannot already have.
  rows.sort((a, b) => (b.ageDays <= 30 ? 1 : 0) - (a.ageDays <= 30 ? 1 : 0) || b.stars - a.stars);
  return { total: rows.length, candidates: rows.slice(0, limit) };
}

/** Verdicts naming a layer that does not exist, which is the one mistake a typo produces silently. */
export function wrongLayers(verdicts: Verdict[], layers: string[]): Verdict[] {
  return verdicts.filter((verdict) => verdict.in_stack && !layers.includes(verdict.layer ?? ""));
}

export type Review = {
  repo: string;
  layer: string | null;
  why: string;
  judgedAt?: string;
  daysSinceVerdict?: number;
  signals: string[];
};

/**
 * Listed projects whose verdict may no longer hold, with the evidence behind that suspicion. It ranks;
 * it decides nothing. A fixed "re-judge every 30 days" was the alternative and it is the wrong shape:
 * most projects do not change in a month, and the ones that matter change the week they pivot.
 */
export async function reviewQueue(workspace: string, limit: number): Promise<{ total: number; reviews: Review[] }> {
  const verdicts = (JSON.parse(await readFile(resolve(workspace, "data/classified.json"), "utf8")) as { verdicts: Record<string, Verdict> }).verdicts;
  const latestPath = resolve(workspace, "data/latest.json");
  if (!existsSync(latestPath)) return { total: 0, reviews: [] };
  const latest = JSON.parse(await readFile(latestPath, "utf8")) as {
    categories: { id: string; rows: { repo: string; description: string; archived: boolean; lastReleaseDays?: number; pushedDays?: number; commits90d: number; userIssues30d: number; score: number }[] }[];
  };

  const reviews: Review[] = [];
  for (const category of latest.categories) {
    for (const row of category.rows) {
      const verdict = verdicts[row.repo] ?? Object.values(verdicts).find((entry) => entry.repo.toLowerCase() === row.repo.toLowerCase());
      const signals: string[] = [];
      if (row.archived) signals.push("archived on GitHub");
      if (verdict?.judgedDescription && verdict.judgedDescription !== row.description) {
        signals.push(`description changed: "${verdict.judgedDescription.slice(0, 60)}" -> "${row.description.slice(0, 60)}"`);
      }
      if (!verdict?.judgedAt) signals.push("judged before verdicts carried a date");
      if ((row.pushedDays ?? 0) > 60 && row.commits90d === 0) signals.push("no commits in 90 days");
      if ((row.lastReleaseDays ?? 0) > 180 && !ASSET_IDS.has(category.id)) signals.push(`${row.lastReleaseDays} days since a release with notes`);
      if (verdict && category.id !== verdict.layer) signals.push(`listed under ${category.id}, verdict said ${verdict.layer}`);
      const days = verdict?.judgedAt ? Math.floor((Date.now() - Date.parse(verdict.judgedAt)) / 86_400_000) : undefined;
      if (signals.length) {
        reviews.push({ repo: row.repo, layer: category.id, why: verdict?.why ?? "(no verdict on file)", judgedAt: verdict?.judgedAt, daysSinceVerdict: days, signals });
      }
    }
  }
  // Most signals first: a project that is archived and renamed and silent is the one worth the read.
  reviews.sort((a, b) => b.signals.length - a.signals.length || (b.daysSinceVerdict ?? 999) - (a.daysSinceVerdict ?? 999));
  return { total: reviews.length, reviews: reviews.slice(0, limit) };
}

/** Merge verdicts into the store. Existing entries are replaced, so a correction is just a rerun. */
export async function saveVerdicts(workspace: string, verdicts: Verdict[]) {
  const path = resolve(workspace, "data/classified.json");
  const store = existsSync(path)
    ? (JSON.parse(await readFile(path, "utf8")) as { verdicts: Record<string, Verdict> })
    : { verdicts: {} };
  for (const verdict of verdicts) store.verdicts[verdict.repo] = verdict;
  await writeFile(path, `${JSON.stringify(store, null, 1)}\n`);
  return { stored: verdicts.length, total: Object.keys(store.verdicts).length };
}
