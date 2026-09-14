import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LAYERS } from "./layers.ts";
import type { Verdict } from "./index-data.ts";

/**
 * Verdicts plus corrections become seeds.json. The pipeline runs unattended, so a human's place is not
 * in the middle of it: overrides.json is where a disagreement is recorded, with a reason, so the next
 * reader knows whether it still applies.
 */
export type Overrides = {
  include?: Record<string, { layer: string; reason?: string }>;
  exclude?: Record<string, string>;
  packages?: Record<string, string>;
};

export async function buildSeeds(workspace: string) {
  const verdicts = (JSON.parse(await readFile(resolve(workspace, "data/classified.json"), "utf8")) as { verdicts: Record<string, Verdict> }).verdicts;
  const overridesPath = resolve(workspace, "overrides.json");
  const overrides: Overrides = existsSync(overridesPath) ? JSON.parse(await readFile(overridesPath, "utf8")) : {};
  const packages = overrides.packages ?? {};

  const placed = new Map<string, Set<string>>(LAYERS.map((layer) => [layer.id, new Set<string>()]));
  for (const verdict of Object.values(verdicts)) {
    if (overrides.exclude?.[verdict.repo]) continue;
    const layer = overrides.include?.[verdict.repo]?.layer ?? verdict.layer;
    if ((verdict.in_stack || overrides.include?.[verdict.repo]) && layer && placed.has(layer)) placed.get(layer)!.add(verdict.repo);
  }
  for (const [repo, entry] of Object.entries(overrides.include ?? {})) {
    if (!overrides.exclude?.[repo]) placed.get(entry.layer)?.add(repo);
  }

  const categories = LAYERS.filter((layer) => placed.get(layer.id)!.size).map((layer) => ({
    id: layer.id,
    title: layer.title,
    blurb: layer.blurb,
    repos: [...placed.get(layer.id)!].sort().map((repo) => (packages[repo] ? { repo, package: packages[repo] } : repo)),
  }));

  await writeFile(
    resolve(workspace, "seeds.json"),
    `${JSON.stringify(
      {
        _comment: "Generated. Membership comes from data/classified.json (the agent's verdicts) corrected by overrides.json. Edit overrides.json, not this file.",
        categories,
      },
      null,
      2,
    )}\n`,
  );
  return {
    projects: categories.reduce((sum, category) => sum + category.repos.length, 0),
    layers: categories.length,
    forcedIn: Object.keys(overrides.include ?? {}).length,
    forcedOut: Object.keys(overrides.exclude ?? {}).length,
  };
}
