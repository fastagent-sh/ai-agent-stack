import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The sixteen layers, loaded from layers.json at the repository root so discovery, scoring, rendering
 * and the agent all read one definition. `queries` feed the search sweep; `keywords` place a candidate
 * before anyone has judged it; membership itself is the agent's decision.
 */
export type Layer = { id: string; title: string; blurb: string; queries: string[]; keywords: string };

const file = resolve(dirname(new URL(import.meta.url).pathname), "../../layers.json");
const raw = JSON.parse(readFileSync(file, "utf8")) as {
  sourceLists: string[];
  assetLayers: string[];
  layers: Record<string, Omit<Layer, "id">>;
};

export const LAYERS: Layer[] = Object.entries(raw.layers).map(([id, layer]) => ({ id, ...layer }));
export const LAYER_IDS = LAYERS.map((layer) => layer.id);
/** Layers whose projects ship no releases, so upkeep is read from commits instead. */
export const ASSET_LAYERS = new Set(raw.assetLayers);
export const layerById = (id: string) => LAYERS.find((layer) => layer.id === id);
