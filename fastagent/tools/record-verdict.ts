import { defineTool, z } from "@fastagent-sh/fastagent";
import { layerIds, saveVerdicts, wrongLayers } from "../lib/index-data.ts";

// Verdicts are the agent's only write into the data. Everything else on the page is measured.
//   fastagent tool record-verdict '{"verdicts":[{"repo":"a/b","in_stack":true,"layer":"memory","why":"agent memory store"}]}'
export default defineTool({
  description:
    "Record membership judgements in data/classified.json: whether each project is part of the agent " +
    "stack and which layer it sits in. A reason is required and stays short enough to check at a glance.",
  input: z.object({
    verdicts: z
      .array(
        z.object({
          repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
          in_stack: z.boolean(),
          layer: z.string().nullable().describe("layer id; null when not in the stack"),
          why: z.string().min(3).max(60).describe("the reason, a few words"),
          judgedDescription: z.string().optional().describe("the project's description as read, so a later change is visible"),
        }),
      )
      .min(1)
      .max(40),
  }),
  async execute({ verdicts }, ctx) {
    const layers = await layerIds(ctx.cwd);
    // Stamped so a later run can tell whether the project has changed since anyone looked at it.
    const judgedAt = new Date().toISOString();
    verdicts = verdicts.map((verdict) => ({ ...verdict, judgedAt }));
    const wrong = wrongLayers(verdicts, layers);
    if (wrong.length) {
      throw new Error(
        `unknown layer for ${wrong.map((v) => `${v.repo} -> ${v.layer}`).join(", ")}. Layers: ${layers.join(", ")}`,
      );
    }
    return saveVerdicts(ctx.cwd, verdicts);
  },
});
