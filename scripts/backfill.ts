#!/usr/bin/env node
// One-time baseline: enumerate the whole domain instead of only what is recent.
// Costs hours — thousands of searches, then a repository read each, then a judgement each.
//   GITHUB_TOKEN=... node scripts/backfill.ts [--stars 100]
import { backfill } from "../fastagent/lib/discover.ts";

const index = process.argv.indexOf("--stars");
const workspace = new URL("..", import.meta.url).pathname;
const added = await backfill(workspace, index === -1 ? 100 : Number(process.argv[index + 1]));
console.log(`backfill added ${added} repositories the daily sweep had never seen`);
