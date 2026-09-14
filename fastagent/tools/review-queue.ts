import { defineTool, z } from "@fastagent-sh/fastagent";
import { reviewQueue } from "../lib/index-data.ts";

// Listed projects whose verdict may have gone stale, with the evidence. It ranks; you decide whether
// a project has changed enough to be read again, and re-recording a verdict replaces the old one.
//   fastagent tool review-queue '{"limit":10}'
export default defineTool({
  description:
    "Listed projects showing signs that their membership or layer is out of date: archived, renamed, " +
    "description changed since the verdict, gone silent, or filed under a layer the verdict did not " +
    "name. Read the ones that look real with repo-readme, then record a new verdict.",
  input: z.object({ limit: z.number().int().min(1).max(50).default(15) }),
  execute: (input, ctx) => reviewQueue(ctx.cwd, input.limit),
});
