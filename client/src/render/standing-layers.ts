// D8 the registry of every per-building layer that re-seats its dressing to
// what still stands (standing-watch.ts), and of every building-reading render
// module that needs not, with the reason. The layer-sweep test
// (client/test/standing-layers.test.ts) drives each registered layer through
// a felled, pancaked, toppled and chewed tower and asserts nothing it keeps
// hangs in the air; it also scans client/src/render/*.ts and fails on a
// module that reads building geometry but is in neither list — so a new
// layer cannot silently skip the filter.

import type { Building } from "@angels-bandits/common/city";
import { atmosphereFxStandingLayer } from "./atmosphere-fx";
import { citylifeStandingLayer } from "./citylife-render";
import { facadeDetailStandingLayer } from "./facade-detail";
import { facadeGarnishStandingLayer } from "./facade-garnish";
import { facadeLifeStandingLayer } from "./facade-life";
import { holeDecorStandingLayer } from "./hole-decor";
import { jumbotronStandingLayer } from "./jumbotrons";
import { roofClutterStandingLayer } from "./roofclutter";
import { rooftopLifeStandingLayer } from "./rooftop-life";
import { searchlightsStandingLayer } from "./searchlights";
import { signageStandingLayer } from "./signage";
import type { StandingLayer } from "./standing-watch";
import { steamStandingLayer } from "./steam";

/** One registered layer: the SAME StandingLayer its renderer masks with. */
export interface StandingProbe {
  /** The module's file name without `.ts`. */
  readonly name: string;
  /** The layer's items per building, for a city and its seed. */
  layer(buildings: readonly Building[], seed: number): StandingLayer;
}

export const STANDING_LAYERS: readonly StandingProbe[] = [
  {
    name: "facade-detail",
    layer: (buildings, seed) => facadeDetailStandingLayer(buildings, seed),
  },
  {
    name: "facade-garnish",
    layer: (buildings) => facadeGarnishStandingLayer(buildings),
  },
  {
    name: "facade-life",
    layer: (buildings, seed) => facadeLifeStandingLayer(buildings, seed),
  },
  {
    name: "signage",
    layer: (buildings, seed) => signageStandingLayer(buildings, seed),
  },
  {
    name: "jumbotrons",
    layer: (buildings) => jumbotronStandingLayer(buildings),
  },
  {
    name: "hole-decor",
    layer: (buildings) => holeDecorStandingLayer(buildings),
  },
  {
    name: "atmosphere-fx",
    layer: (buildings) => atmosphereFxStandingLayer(buildings),
  },
  {
    name: "citylife-render",
    layer: (buildings, seed) => citylifeStandingLayer(buildings, seed),
  },
  {
    name: "roofclutter",
    layer: (buildings) => roofClutterStandingLayer(buildings),
  },
  {
    name: "rooftop-life",
    layer: (buildings) => rooftopLifeStandingLayer(buildings),
  },
  {
    name: "searchlights",
    layer: (buildings) => searchlightsStandingLayer(buildings),
  },
  {
    name: "steam",
    layer: (buildings) => steamStandingLayer(buildings),
  },
];

/** Building-reading render modules that need no standing filter, and why. */
export const STANDING_EXEMPT: Readonly<Record<string, string>> = {
  scaffold:
    "sizes its cage and crane to standingProfile itself (director-client.test.ts)",
  "standing-layers": "this registry",
  city: "draws every damaged building 1:1 from its live solids() (D2) — the source of truth",
  "living-windows":
    "a shader schedule on city.ts's facades, which are the live solids",
  roofs: "roof styles: shader inputs on city.ts's live solids",
  archetypes: "facade archetype picks, a pure style input to city.ts",
  "damage-map":
    "D1 facade scorch slots, sampled by city.ts's shader on live solids",
  "roof-details":
    "a pure layout; roofclutter draws its parts (structures exactly while in the live b.roof, the rest through its StandingLayer)",
  "roof-layout":
    "a pure layout; roofclutter and roof-details draw (and filter) its items",
  citylife:
    "a pure layout; citylife-render draws (and filters) its balcony and terrace figures",
  fires:
    "per-chunk emitters, not per-building items: a chunk this client holds gone never emits",
  reactions:
    "smoke bases re-derive from the live solids and roof when the building under them changes; wakes light city.ts's live facades",
  storm:
    "a bolt strikes the standing top (standingTopAt + the live roof), resolved per strike",
  "director-fx":
    "transient emitters: warning dust only from floors that stand, rebuild welding capped at the standing top",
  impacts:
    "transient particles; a burning patch stops once its facade no longer stands (BlastLedger.prune)",
  river:
    "the reflection skyline re-bakes from each bank building's standing top when one changes",
  "street-furniture":
    "street-level furniture and street vents only (roof vents are filtered out)",
  construction:
    "welding sparks at the construction crane sites — lots, not buildings",
  movers:
    "cranes, helicopters and boats stand on lots and streets; a felled crane is D5's own collapse record",
};
