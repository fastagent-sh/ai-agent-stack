import { defineTool, z } from "@fastagent-sh/fastagent";
import { discover } from "../lib/discover.ts";
import { unjudged } from "../lib/index-data.ts";

// Discovery is deterministic — searches, new-repository sweeps, other people's lists, a floor anyone
// can check — so it stays out of the model. This returns only what still needs a judgement.
//   fastagent tool candidates '{"refresh":true}'
export default defineTool({
  description:
    "Projects discovery found that nobody has judged yet, repositories created in the last month first. " +
    "Set `refresh` to run a new sweep (several minutes, hits the GitHub API) or leave it off to read the " +
    "last one.",
  input: z.object({
    refresh: z.boolean().default(false),
    minStars: z.number().int().min(0).max(5000).default(100).describe("floor for unlisted projects; ten user issues in 30 days also passes"),
    limit: z.number().int().min(1).max(60).default(25),
  }),
  async execute({ refresh, minStars, limit }, ctx) {
    const swept = refresh ? await discover(ctx.cwd, minStars) : undefined;
    return { swept: swept && { pool: swept.pool, pastFloor: swept.candidates.length }, ...(await unjudged(ctx.cwd, limit)) };
  },
});
