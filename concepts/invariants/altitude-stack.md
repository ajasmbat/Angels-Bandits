# The altitude stack lives under the deck

K1 brought the sky down onto the skyline: the cloud deck sits at 440 m,
the four landmark spires (400–480 m) pierce it, and everything that flies
does so under it, among the towers.

**The sites that must agree** (all in `common/src/constants.ts` unless named):

- the skyline: `BUILDING_MAX_HEIGHT` (320 m, generated lots) plus
  `ROOF_STRUCTURE_MAX_HEIGHT` (16 m); `LANDMARK_HEIGHT` (400 m, the
  recognition threshold — every landmark is at least this, nothing
  generated reaches it); `CITY_TOP` (480 m, the tallest landmark profile in
  `city/landmarks.ts`);
- the bots: canyon patrol `BOT_CANYON_ALT_*` (25–70 m), street spawns
  `BOT_SPAWN_ALT_*` (75–90 m), and their high limits inside 60–350 m
  (`BOT_DEFEND_MAX_ALT`, server `DIVE_IP_MAX`, `DIVE_ROOF_MAX` in
  `server/src/bombs.ts`);
- the fleet (`common/src/boss.ts`), three layers with one heading each:
  layer 0 along the x-avenues at `FLEET_STREET_BANDS[0]` (86–130 m), layer
  1 along the z-avenues at `FLEET_STREET_BANDS[1]` (140–176 m), and the
  rooftop layer on mid-block lines, `FLEET_ROOF_MIN`–`FLEET_ALT_MAX`
  (≈ 241–400 m), each lane's altitude a profile that keeps
  `FLEET_ROOF_CLEAR` over every roof under it (`common/src/fleetplan.ts`);
- the helicopters `HELI_ALT_MIN/MAX` (192–222 m), between the street layers
  and the rooftops;
- `RESPAWN_ALTITUDE` (370 m), the landmark run-out veto and, since the
  rooftop ships cruise this layer, the fleet veto with a fanned heading
  (`server/src/respawn.ts` `landmarkClearance`, `freeHeading`);
- the blimp `BLIMP_ALT` (388 m, hull 374–402 m), on an avenue line parallel
  to the rooftop lanes, clear of them and of the spires
  (`city/movers.ts` `blimpCross`);
- the news heli `NEWS_HELI_ALT_MIN/MAX` (418–424 m): over every generated
  roof and the blimp, and a story whose route meets a spire is not taken
  (`city/newsheli.ts` `newsRouteClear`);
- `BOT_CEILING_ALT` (`CLOUD_BASE` − 20) and `CLOUD_BASE` (440 m); the
  SKY1 armada (`common/src/skyarmada.ts` `SHIP_LAYERS`, `GROUP_ALT`) and
  `FIREWORK_ALT_MAX` under it;
- `STORM_KILL_ALT` = `SOFT_CEILING` (480 m), `CEILING_FADE` (100 m),
  `MAX_ALTITUDE` (`SOFT_CEILING` + `CEILING_FADE` + 50 = 630 m, also the
  wire's altitude clamp in `common/src/net.ts`);
- `METEOR_ALT` (`common/src/chaos.ts`) and the airliners
  (`common/src/skytraffic.ts`) above all of it.

**The contract:** on EXTENTS, not centres, bottom to top —
bot canyon band + 15 ≤ layer 0 < layer 1 < heli rotor blur (1.3 × the
hull's half-height) < heli rotor + 15 ≤ rooftop hulls ≤ `FLEET_ALT_MAX`
(news heli belly − 15); generated roofs + 30 < respawn + a player radius <
blimp belly < blimp top < news heli belly < news heli rotor < `CLOUD_BASE`;
`BOT_CEILING_ALT` < `CLOUD_BASE` < `STORM_KILL_ALT` ≤ `SOFT_CEILING` <
`MAX_ALTITUDE` < `METEOR_ALT` < airliners. The street layers cross only at
intersections, one band over the other; a rooftop lane and the blimp share
heights but never a line. Pinned in `common/test/boss.test.ts` (each
lane's hull in its layer's band; the bands stacked; every lane clear of
the city, its movers and tracks except at its planned break-throughs;
the rooftop profile over every roof), `common/test/ceiling.test.ts`
(everything under the deck, and a source scan for hard-coded altitudes
over it), `common/test/newsheli.test.ts` (heli over the roofs and the
blimp, under the deck, off the spires) and `common/test/movers.test.ts`
(no mover spans `RESPAWN_ALTITUDE`).

**What breaks when they disagree:**

- A street lane at an altitude another street layer or the helicopters
  use: hulls meet at an intersection, or a heli flies through one. A
  rooftop lane over a spire, or a line too close to another's: the profile
  cannot clear it, and `laneClearance` reports a conflict.
- A lane that cannot clear a tower crane is fine only because the crane is
  a planned break-through: the server fells it on the ship's own course
  (`server/src/boss.ts` `dueBreaks`). Anything else in a lane's way
  (a building, the viaduct, a bridge, a heli) has no such escape.
- A respawn at `RESPAWN_ALTITUDE` into a landmark shaft or a rooftop hull:
  spawn protection does not stop a crash (the vetoes exist for this; any
  new tall landmark must stay in `LANDMARK_BLOCKS` so the vetoes see it).
- A blimp or news heli in the deck, or one that meets a spire or a hull.
- Anything the `height >= LANDMARK_HEIGHT` test identifies — the minimap
  accent, roof beacons, facade archetypes, searchlight picks — misfires the
  moment a generated lot reaches `LANDMARK_HEIGHT`.
- A QA staging (gallery view, perf segment) parked over `STORM_KILL_ALT`:
  the server's storm kills the plane mid-shot.

**When the skyline or the sky changes:** walk this list bottom to top,
re-run `laneClearance` for every lane (`common/test/boss.test.ts`), then
the fog seam (`concepts/invariants/sky-meets-fog.md`: the deck's fog lift,
now 0, and the sky-matched fog) and the QA staging specs in
`tools/perf/segments.mjs` and `gallery-views.mjs`, which pin building
indices, heights and altitudes and throw when the city changes under them.
