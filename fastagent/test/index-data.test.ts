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
      candidates: [
        { repo: "a/known", stars: 50, description: "d", foundVia: [], ageDays: 400, pushedDays: 1 },
        { repo: "b/fresh", stars: 900, description: "d", foundVia: [], ageDays: 400, pushedDays: 1 },
        { repo: "c/new", stars: 100, description: "d", foundVia: ["new"], ageDays: 5, pushedDays: 0 },
      ],
    }),
  );
  await writeFile(join(dir, "data/classified.json"), JSON.stringify({ verdicts: { "a/known": { repo: "a/known", in_stack: true, layer: "memory", why: "judged" } } }));
  return dir;
}

test("unjudged candidates are offered, new ones ahead of merely large ones", async () => {
  const dir = await workspace();
  const { total, candidates } = await unjudged(dir, 10);
  assert.equal(total, 2, "the already-judged project is not re-read");
  // A repository created five days ago outranks one with nine times the stars: a list cannot already
  // hold the new one, which is the only reason to spend a judgement on it first.
  assert.deepEqual(candidates.map((row) => row.repo), ["c/new", "b/fresh"]);
  assert.equal((await layerIds(dir)).length, 16);
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
