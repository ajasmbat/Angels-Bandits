# The altitude stack clears the skyline

**The sites that must agree** (all in `common/src/constants.ts` unless named):

- the skyline: `BUILDING_MAX_HEIGHT` (320 m, generated lots) plus
  `ROOF_STRUCTURE_MAX_HEIGHT` (16 m); `LANDMARK_HEIGHT` (400 m, the
  recognition threshold — every landmark is at least this, nothing
  generated reaches it); `CITY_TOP` (480 m, the tallest landmark profile in
  `city/landmarks.ts`);
- `RESPAWN_ALTITUDE` (370 m) and the landmark run-out veto in
  `server/src/respawn.ts` (`landmarkClearance`);
- the news heli band `NEWS_HELI_ALT_MIN/MAX` (500–515 m, `HELI_HULL`);
- the carrier `BOSS_ALT` (570 m, `common/src/boss.ts`, reach ±30 m);
- the blimp `BLIMP_ALT` (625 m, `BLIMP_HULL`);
- `BOT_CEILING_ALT` (`CLOUD_BASE` − 20) and `CLOUD_BASE` (650 m);
- `STORM_KILL_ALT` = `SOFT_CEILING` (750 m), `CEILING_FADE`, `MAX_ALTITUDE`
  (950 m, also the wire's altitude clamp in `common/src/net.ts`);
- `METEOR_ALT` (`common/src/chaos.ts`) and the airliners
  (`common/src/skytraffic.ts`) above all of it.

**The contract:** on EXTENTS, not centres, bottom to top —
generated roofs < respawn − 30 < landmarks ≤ `CITY_TOP` < news heli belly
(− 15 m margin) < heli rotor + 15 ≤ carrier hull bottom < carrier top <
blimp belly < blimp top < `CLOUD_BASE`; `BOT_CEILING_ALT` < `CLOUD_BASE` <
`STORM_KILL_ALT` ≤ `SOFT_CEILING` < `MAX_ALTITUDE` < `METEOR_ALT` <
airliners. Pinned in `common/test/boss.test.ts` (hull over every roof and
the heli), `common/test/newsheli.test.ts` (heli over `CITY_TOP`, under the
blimp and the deck), `common/test/movers.test.ts` (helis under the blimp
under the deck).

**What breaks when they disagree:**

- A carrier whose hull dips into a supertall: its launch poses spawn
  enemies into a facade, and the hull is drawn through a tower.
- A respawn at `RESPAWN_ALTITUDE` into a landmark shaft: spawn protection
  does not stop a crash (the veto exists for this; any new tall landmark
  must stay in `LANDMARK_BLOCKS` so the veto sees it).
- A news heli or blimp that intersects the carrier or the deck.
- Anything the `height >= LANDMARK_HEIGHT` test identifies — the minimap
  accent, roof beacons, facade archetypes, searchlight picks — misfires the
  moment a generated lot reaches `LANDMARK_HEIGHT`.

**When the skyline grows again:** raise `CITY_TOP` and walk this list
bottom to top; then the fog seam (`concepts/invariants/sky-meets-fog.md`:
the deck's fog lift, the sky-matched fog) and the QA staging specs in
`tools/perf/segments.mjs` and `gallery-views.mjs`, which pin building
indices and heights and throw when the city changes under them.
