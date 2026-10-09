// D8 the registry of every per-building layer that re-seats its dressing to
// what still stands (standing-watch.ts), and of every building-reading render
// module that needs not, with the reason. The layer-sweep test
// (client/test/standing-layers.test.ts) drives each registered layer through
// a felled, pancaked, toppled and chewed tower and asserts nothing it keeps
// hangs in the air; it also scans client/src/render/*.ts and fails on a
// module that reads building geometry but is in neither list — so a new
// layer cannot silently skip the filter.

import type { Building } from "@angels-bandits/common/city";
import type { StandingLayer } from "./standing-watch";

/** One registered layer: the SAME StandingLayer its renderer masks with. */
export interface StandingProbe {
  /** The module's file name without `.ts`. */
  readonly name: string;
  /** The layer's items per building, for a city and its seed. */
  layer(buildings: readonly Building[], seed: number): StandingLayer;
}

export const STANDING_LAYERS: readonly StandingProbe[] = [];

/** Building-reading render modules that need no standing filter, and why. */
export const STANDING_EXEMPT: Readonly<Record<string, string>> = {
  city: "draws every damaged building 1:1 from its live solids() (D2) — the source of truth",
  "living-windows":
    "a shader schedule on city.ts's facades, which are the live solids",
  roofs: "roof styles: shader inputs on city.ts's live solids",
  archetypes: "facade archetype picks, a pure style input to city.ts",
  "damage-map":
    "D1 facade scorch slots, sampled by city.ts's shader on live solids",
  "roof-layout":
    "a pure layout; roofclutter and roof-details draw (and filter) its items",
};
