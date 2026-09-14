import { defineTool, z } from "@fastagent-sh/fastagent";
import { buildSeeds } from "../lib/seeds.ts";
import { refresh } from "../lib/render.ts";

// The deterministic half, in one call because running these out of order publishes a half-updated index.
//   fastagent tool refresh '{}'
export default defineTool({
  description:
    "Regenerate the index: seeds from the recorded verdicts and overrides, then measure every project, " +
    "score it, and rewrite README, the layer pages and CHANGES. Run after recording verdicts or editing " +
    "overrides.json. Takes a few minutes and calls the GitHub API.",
  input: z.object({
    only: z.enum(["seed", "all"]).default("all").describe("`seed` rebuilds seeds.json alone, for a quick check"),
  }),
  async execute({ only }, ctx) {
    const seeds = await buildSeeds(ctx.cwd);
    if (only === "seed") return { seeds };
    return { seeds, index: await refresh(ctx.cwd) };
  },
});
