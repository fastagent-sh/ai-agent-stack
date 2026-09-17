#!/usr/bin/env node
// The deterministic half of the pipeline: seeds from verdicts, then measure, score and render.
// Node 22 runs TypeScript directly, so CI needs no build step.
//   GITHUB_TOKEN=... node scripts/refresh.ts
import { buildSeeds } from "../fastagent/lib/seeds.ts";
import { refresh } from "../fastagent/lib/render.ts";

// `--full` re-reads every project regardless of tier. It costs one API call per project per endpoint,
// which at this size is hours of rate-limit waiting, so the daily job does not use it.
const workspace = new URL("..", import.meta.url).pathname;
console.log("seeds:", await buildSeeds(workspace));
console.log("refresh:", await refresh(workspace, process.argv.includes("--full")));
