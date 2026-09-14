import { spawn } from "node:child_process";
import { defineTool, z } from "@fastagent-sh/fastagent";
import { unjudged } from "../lib/index-data.ts";

// Discovery is deterministic — searches, other people's lists, a floor anyone can check — so it stays
// in scripts/discover.py. This tool runs it and hands back only what still needs a judgement.
//   fastagent tool candidates '{"limit":20}'
export default defineTool({
  description:
    "Projects that discovery found and nobody has judged yet, newest sweep first. Set `refresh` to " +
    "re-run discovery (a few minutes, and it hits the GitHub API) or leave it off to read the last sweep.",
  input: z.object({
    refresh: z.boolean().default(false).describe("re-run scripts/discover.py before reading"),
    limit: z.number().int().min(1).max(60).default(25),
  }),
  async execute({ refresh, limit }, ctx) {
    if (refresh) {
      const code = await new Promise<number>((done) => {
        const child = spawn("python3", ["-u", "scripts/discover.py"], { cwd: ctx.cwd, stdio: "inherit" });
        child.on("close", (status) => done(status ?? 1));
      });
      if (code !== 0) throw new Error(`scripts/discover.py exited ${code}`);
    }
    return unjudged(ctx.cwd, limit);
  },
});
