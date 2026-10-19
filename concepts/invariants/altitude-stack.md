# The altitude stack lives under the deck

K1 brought the sky down onto the skyline: the cloud deck sits at 440 m,
and everything that flies does so under it, among the towers. T1 (the
supertall canyon) pushed the towers up through it: the core towers run
250–650 m and the four landmark mega-towers 720–1000 m, their tops lost in
the deck — so the sky above the war is cloud and tower, never open air.

**The sites that must agree** (all in `common/src/constants.ts` unless named):

- the skyline: `BUILDING_MAX_HEIGHT` (650 m, the core band's top) plus
  `ROOF_STRUCTURE_MAX_HEIGHT` (16 m); `SKYLINE_RING_MAX_HEIGHT` (265 m, the
  mid and edge bands' top — the ring round the cores stays under the
  squadrons' and the bots' high bands, and only the cores pierce the
  deck); `LANDMARK_HEIGHT` (700 m, the recognition threshold — every
  landmark is at least this, nothing generated reaches it); `CITY_TOP`
  (1000 m, the tallest landmark profile in `city/landmarks.ts`). Tunnels
  (`HOLE_MAX_TOP`) and AA nests (`AA_NEST_MAX_HEIGHT`) stay under the deck;
  so does a comet's hit (`COMET_HIT_TOP`);
- the bots: canyon patrol `BOT_CANYON_ALT_*` (25–70 m), street spawns
  `BOT_SPAWN_ALT_*` (75–90 m), and their high limits inside 60–350 m
  (`BOT_DEFEND_MAX_ALT`, server `DIVE_IP_MAX`, `DIVE_ROOF_MAX` in
  `server/src/bombs.ts`);
- the fleet (`common/src/boss.ts`), six layers: layer 0 along the
  x-avenues at `FLEET_STREET_BANDS[0]` (86–130 m), layer 1 along the
  z-avenues at `FLEET_STREET_BANDS[1]` (140–176 m), the rooftop layer on
  the edge's mid-block lines, `FLEET_ROOF_MIN`–`FLEET_ALT_MAX`
  (≈ 241–400 m), each lane's altitude a profile that keeps
  `FLEET_ROOF_CLEAR` over every roof under it (`common/src/fleetplan.ts`);
  and T1's three among the supertalls — the threads down the core avenues
  and the berths at the mega-towers' masts in `FLEET_HIGH_BAND`
  (310–365 m), the orbits round the mega-towers in `FLEET_ORBIT_BAND`
  (`FLEET_ROOF_MIN`–300 m). An orbit's clearance is an annulus round its
  tower, a berth's the hull's box grown by its sway against the face
  (`towerClearance`);
- the helicopters `HELI_ALT_MIN/MAX` (192–222 m), between the street layers
  and the rooftops;
- `RESPAWN_ALTITUDE` (370 m), the tower run-out veto — every building and
  roof structure through that height, not only the landmarks, since T1's
  core towers stand through it (`spawnTowersOf`) — and, since the rooftop
  ships cruise this layer, the fleet veto with a fanned heading
  (`server/src/respawn.ts` `landmarkClearance`, `freeHeading`);
- E1's squadron band (`common/src/squadron.ts`), DERIVED, never a literal:
  `SQUAD_FLOOR_ALT` (60 m) over open ground, the roofline grid's dilated
  roofs + `SQUAD_CLEAR` everywhere else, the cruise cap `SQUAD_CRUISE_CAP`
  (the generated skyline `BUILDING_MAX_HEIGHT + ROOF_STRUCTURE_MAX_HEIGHT`
  + clearance, so the spires are flown round, not over) and the hard top
  `SQUAD_ALT_MAX` (under `BOT_CEILING_ALT`, `SOFT_CEILING` and the blimp's
  belly, less the formation's top: 361 m with this deck). The airships are
  steered round as moving obstacles (`SquadObstacle`), not by altitude;
- the blimp `BLIMP_ALT` (388 m, hull 374–402 m), on an avenue line parallel
  to the rooftop lanes, clear of them and of the spires
  (`city/movers.ts` `blimpCross`);
- the news heli `NEWS_HELI_ALT_MIN/MAX` (418–424 m): over the blimp, and a
  story whose route meets any tower through its height (`newsSpiresOf`:
  the landmarks and, since T1, the core towers over it) is not taken
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
(news heli belly − 15); generated roofs off the towers' run-out vetoes + 30 < respawn + a player
radius < blimp belly < blimp top < news heli belly < news heli rotor < `CLOUD_BASE`;
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
- A respawn at `RESPAWN_ALTITUDE` into a tower shaft or a rooftop hull:
  spawn protection does not stop a crash (the vetoes exist for this; they
  read the city's own towers, `installSpawnTowers`, so a taller skyline is
  seen without a list to keep).
- A blimp or news heli in the deck, or one that meets a spire or a hull.
- A squadron band written as numbers instead of derived, or the blimp
  lowered without it: the formations fly into the deck or the blimp's hull
  (squadrons steer round airships, not movers). `common/test/squadron.test.ts`
  pins the band under the ceilings and the blimp.
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
