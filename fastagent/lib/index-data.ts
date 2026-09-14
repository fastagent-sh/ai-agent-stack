import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** The sixteen layer ids, from the one definition every part of the pipeline reads. */
export async function layerIds(_workspace: string): Promise<string[]> {
  const { LAYER_IDS } = await import("./layers.ts");
  return LAYER_IDS;
}

export type Verdict = { repo: string; in_stack: boolean; layer: string | null; why: string };

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
