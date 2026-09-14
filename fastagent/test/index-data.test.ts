import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { layerIds, saveVerdicts, unjudged, wrongLayers } from "../lib/index-data.ts";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "stack-"));
  await mkdir(join(dir, "data"));
  await writeFile(
    join(dir, "data/candidates.json"),
    JSON.stringify({
      layers: {
        memory: { title: "Memory", candidates: [{ repo: "a/known", stars: 50, description: "d", hints: [] }, { repo: "b/fresh", stars: 900, description: "d", hints: [] }] },
        security: { title: "Security", candidates: [{ repo: "c/fresh", stars: 100, description: "d", hints: [] }] },
      },
    }),
  );
  await writeFile(join(dir, "data/classified.json"), JSON.stringify({ verdicts: { "a/known": { repo: "a/known", in_stack: true, layer: "memory", why: "judged" } } }));
  return dir;
}

test("only unjudged candidates are offered, largest first", async () => {
  const dir = await workspace();
  const { total, candidates } = await unjudged(dir, 10);
  assert.equal(total, 2, "the already-judged project is not re-read");
  assert.deepEqual(candidates.map((row) => row.repo), ["b/fresh", "c/fresh"]);
  assert.equal(candidates[0].foundUnder, "memory");
  assert.deepEqual(await layerIds(dir), ["memory", "security"]);
});

test("a verdict for an unknown layer is refused, and a correction overwrites", async () => {
  const dir = await workspace();
  const layers = await layerIds(dir);
  const typo = [{ repo: "b/fresh", in_stack: true, layer: "memroy", why: "typo layer" }];
  assert.deepEqual(wrongLayers(typo, layers).map((v) => v.repo), ["b/fresh"], "a mistyped layer is caught, not stored");
  assert.equal(wrongLayers([{ repo: "x/y", in_stack: false, layer: null, why: "out" }], layers).length, 0, "a rejection needs no layer");

  await saveVerdicts(dir, [{ repo: "b/fresh", in_stack: true, layer: "memory", why: "agent memory store" }]);
  await saveVerdicts(dir, [{ repo: "b/fresh", in_stack: false, layer: null, why: "on reading, a database" }]);
  const stored = JSON.parse(await readFile(join(dir, "data/classified.json"), "utf8")).verdicts;
  assert.equal(stored["b/fresh"].in_stack, false, "a rerun corrects rather than duplicates");
  assert.equal(stored["a/known"].in_stack, true, "existing verdicts survive");
});
