import { spawn } from "node:child_process";
import { defineTool, z } from "@fastagent-sh/fastagent";

// The deterministic half: seeds from verdicts and overrides, then measurement, scores and pages.
// Kept as one tool because running these out of order publishes a half-updated index.
//   fastagent tool refresh '{}'
const STEPS = [
  ["scripts/seed.py", "verdicts + overrides -> seeds.json"],
  ["scripts/collect.py", "measure every project, score it, write README and layer pages"],
  ["scripts/changes.py", "diff against the previous snapshot"],
] as const;

export default defineTool({
  description:
    "Regenerate the index: seeds, measurement, scores, README, the layer pages and the weekly diff. " +
    "Run it after recording verdicts or editing overrides.json. Takes a few minutes and calls the GitHub API.",
  input: z.object({
    only: z.enum(["seed", "all"]).default("all").describe("`seed` rebuilds seeds.json alone, for a quick check"),
  }),
  async execute({ only }, ctx) {
    const steps = only === "seed" ? STEPS.slice(0, 1) : STEPS;
    const output: { step: string; summary: string }[] = [];
    for (const [script, what] of steps) {
      const lines: string[] = [];
      const code = await new Promise<number>((done) => {
        const child = spawn("python3", ["-u", script], { cwd: ctx.cwd });
        child.stdout.on("data", (chunk) => lines.push(String(chunk)));
        child.stderr.on("data", (chunk) => lines.push(String(chunk)));
        child.on("close", (status) => done(status ?? 1));
      });
      const summary = lines.join("").trim().split("\n").slice(-4).join(" | ");
      if (code !== 0) throw new Error(`${script} exited ${code}: ${summary}`);
      output.push({ step: `${script} (${what})`, summary });
    }
    return { ran: output };
  },
});
