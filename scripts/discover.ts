#!/usr/bin/env node
// Candidate discovery. Judgement happens in the agent, not here.
//   GITHUB_TOKEN=... node scripts/discover.ts [--stars 100] [--fresh-days 30]
import { discover } from "../fastagent/lib/discover.ts";

const flag = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const workspace = new URL("..", import.meta.url).pathname;
const result = await discover(workspace, flag("stars", 100), flag("fresh-days", 30));
console.log(`pool ${result.pool} -> ${result.candidates.length} candidates past the floor`);
