# The Infinite War

The Infinite War goal (Z1, SKY1, C1, P1, R1, then O1's gate) turns the 2 km
torus into a city at war with no edge and no end. A sky full of airships,
dogfights and flak runs to the horizon. Towers come down around a pilot who
flies low, and comets and burning wrecks tear through whole rows. A real
city stands under all of it, and only the parts you can touch are
simulated.

This page explains how the illusion is built, what it may cost, and which
knobs tune it.

## The three layers

Everything on screen belongs to exactly one layer. Each layer is cheaper
than the one before it, and each one only starts where the one before it
can no longer be seen.

| layer | what is in it | how it moves | costs | can you touch it? |
| --- | --- | --- | --- | --- |
| **Real** | the city and its destruction, the 20-ship airship fleet, planes, bots, flak, bombs, comets, meteors, wrecks, C1's low chaos | server-authoritative; every pose is a pure function of wire state and synced server time | CPU (server sim, client posing) and the wire | yes: what is drawn is what collides (draw == collide) |
| **Cosmetic** | SKY1's armada (640 airship slots), distant dogfights (120 groups) and their flak (160) | a pure function of (seed, synced clock, unwrapped camera offset), evaluated per vertex in the shader from `gl_InstanceID` | four draws, no per-object CPU, nothing on the wire | no: it is never nearer than `SKY_INNER` (900 m), beyond the far plane |
| **Painted** | R1's far city (L2's two meshes: the lit street carpet and the instanced far towers, 0.8–5 km), the sky dome, the cloud deck, the city glow | world-anchored lattice in the far shell; the dome is a shader | a handful of draws | no |

### Where one layer hands off to the next

The hand-offs are distances, and the fog hides each one.

- **Real → painted, at 800 m.** The real city is fully fogged at
  `FOG_DISTANCE` (800 m) and the camera's far plane is 900 m. The far
  shell draws every far vertex along its own view ray at a compressed depth
  just inside the fog limit (`far-skyline.ts`), so real geometry at 800 m or
  more is exactly the fog colour and always loses the depth test to it. A
  torus wrap can therefore never show against the far city. Far towers fade
  to the glow-aware fog colour (`fog.ts abGlowFog`) and then sink while
  already fog-coloured. Nothing pops.
- **Real → cosmetic, at 900–1500 m.** A cosmetic airship's visibility is
  exactly 0 nearer than `SKY_INNER` and ramps in over `SHIP_FADE_IN`
  (950–1500 m), while the real fleet is fully fogged by 800 m. A real ship
  and a cosmetic one are never both visible in the same place. The real
  fleet's altitude band (`FLEET_ALT_MIN`–`FLEET_ALT_MAX`, about 534–606 m)
  sits inside the armada's layers (490–625 m), so the sky reads as one
  fleet that thins into the haze. A new real ship comes on at least
  `FLEET_HIDE_M` (900 m) from every human, so it drifts out of the haze
  rather than appearing.
- **Cosmetic → painted.** Both live in L2's far shell and share its haze
  (`SKY_VIS` / `SKY_HAZE`, the same shape as the far city's 0.7 / 4000), so
  the armada sinks into the same air as the skyline.

`concepts/invariants/sky-meets-fog.md` lists every site that must agree on
the fog. A custom shader that fogs itself must call `abFogFactor`, or it
becomes the one thing that pops at 800 m.

### The invariants every layer keeps

- **Draw == collide.** If you can hit it, it is drawn exactly where the
  crash check sees it: the city's chunks, the debris on the render clock,
  the fleet's hull table (`BOSS_PARTS`), and the P1 tunnels, which break on
  every client at their entry times.
- **Determinism.** The server sends events and the clients pose them on
  the synced clock, so a late joiner sees the same war.
- **The HDR emissive ladder.** Bloom starts at 0.72. Dressing (embers,
  room lights, rubble glow, cosmetic lights) stays under it, and only the
  rungs that should bloom go over.
- **Zero per-frame allocation in hot paths.** `tools/chaos-bench.ts`,
  `tools/spectacle-bench.ts` and `tools/destruction-bench.ts` hold every
  entry point to 1 KB/frame and the whole frame to 4 KB.

## Budgets

The target is 60 fps on the M3 (GPU p50 ≤ 14 ms at a pixel ratio of 2), and
30 fps on the Mobile tier. The runner that builds this game has no GPU:
SwiftShader proves draw counts and composition, and the M3 proves time.

### Draw calls

`tools/perf/segments.mjs` `BUDGETS` holds every ceiling, each with its
reason:

- `drawCalls` judges the scripted flight (`run.mjs`). `chaos` (140, Mobile
  90) is peak C2 chaos under the fleet with a full room. `boss` (101) is a
  full room under the 20-ship fleet. Z1 kept that ceiling: the whole fleet
  costs the four draws the one zeppelin did.
- `galleryDraws` (O1) judges the gallery's fixed views (`gallery.mjs`) on
  the draws of the frame each one shoots. It covers every Infinite War view,
  the two ruin views this gate fixed, and `war-peak`, the busiest combined
  scenario.

What each feature costs in draws, on every tier:

| feature | draws | scales with the tier by |
| --- | --- | --- |
| Z1 fleet (20 ships) | 2 instanced hull draws (near and far detail) + 2 Points (lights, flak) | particle emission only; the ships are never fewer |
| SKY1 armada, dogfights, flak, painted horizon | 4 | `skyArmada`: 100 / 80 / 60 / 45 % of the slots and radius |
| R1 far city | 2 (carpet, towers) | lattice size |
| C1 low chaos | 0 of its own: the debris mesh, the D1 particle pool, the props and the director FX already exist | — |
| P1 penetration | 0 of its own: the tunnels are chunk breaks, the bodies ride the missile and wreck meshes, the bursts the D1 pool | — |

### Levers already in place

- **Collapses falling at once.** C1 starts at most `LOW_FALLING_MAX` (2)
  collapses (warned, or with debris still in the air) within
  `LOW_FALLING_R` (350 m) of one human. The room's destroyed share stops
  the director at `stopShare`, and `COLLAPSE_CAP` / `DESTROY_CAP` bound
  every other source.
- **Debris.** The debris mesh is sized once, at boot, for everything
  `COLLAPSE_CAP` lets fall (`city.ts attachCollapses`), and is never
  reallocated mid-game (`BUDGETS.chunkInstances`). A settled collapse is
  re-posed only when its torus image changes.
- **Cosmetic work runs in the vertex shader.** The armada and the far city
  do no per-object CPU work. The far lattice's CPU cost is one row of cells
  per cell the camera crosses.
- **One program per class, and pooled FX.** The fleet's two hull draws
  share one material. Every explosion, spark, dust and fire puff is in the
  D1 particle pool.

Measured on the runner, at High on desktop (draws of the shot frame;
`tools/perf/README.md` has the table): `war-peak` 121, `chaos-low-pass`
107, `impact-plane-through` 100, `sky-dogfights` 97, `boss-breakup` 94,
`impact-comet-row` 93, `fleet-sky` 90, the sky and skyline views 84–88.
Every ceiling is that number plus ~10 %.

### The busiest moment

`war-peak` (gallery) is the worst case the goal can stage. C1's low pass
runs at 55 m down a canyon, a tower toppling and another pouring dust,
facades peeling, gas mains, a car chain and a bridge span about to drop. The
fleet sits 850 m down the canyon with its hero breaking up, a P1 comet
tears through a row of towers, and the armada and the far city fill the
back. Its draw ceiling is in `BUDGETS.galleryDraws`.

![war-peak, SwiftShader](infinite-war/war-peak.jpg)

## Tuning

| to change | knob | where |
| --- | --- | --- |
| how often low chaos fires | `LOW_INTERVAL_MIN_MS` / `MAX_MS` (2–4 s) | `common/src/lowchaos.ts` |
| who counts as low | `LOW_ENTER_ALT` (120 m), `LOW_EXIT_ALT` (145 m), `LOW_TOWERS_MIN` (45 m) | `common/src/lowchaos.ts` |
| how fair it is | `LOW_REACT_S` (0.8 s), `LOW_TURN_RATE`, `LOW_CLIMB_MS`, `LOW_CLEAR_M` | `common/src/lowchaos.ts` |
| how many towers fall at once near you | `LOW_FALLING_MAX` / `LOW_FALLING_R` | `common/src/lowchaos.ts` |
| the warning before any director event | `DIRECTOR_WARN_MS` (3.5 s) | `common/src/director.ts` |
| how tough the airships are | `SHIP_CLASSES[].hp` (140 / 175 / 210) and `FLEET_TUNING.hpScale` | `common/src/boss.ts` |
| how fast a downed ship is replaced | `FLEET_TUNING.refillMs` (12 s), `refillWaitMs` | `common/src/boss.ts` |
| the shake of a kill | `blastShake.add(dist, 2, …)` in `onShipDown`, capped by `budgetShake` and the Shake setting | `client/src/main.ts`, `client/src/game/juice.ts` |
| how far impacts carry | `IMPACTORS` (mass, radius, `maxChunks`, blast) | `common/src/city/penetrate.ts` |
| comets and meteors | `CHAOS_CADENCE` (meteor 4–9 s, comet 35–65 s), `COMET_*` | `common/src/chaos.ts` |
| how busy the sky is | `SHIP_SLOTS`, `GROUP_SLOTS`, `FLAK_SLOTS`, and the tier's `skyArmada` | `common/src/skyarmada.ts`, `client/src/render/quality.ts` |
| where the cosmetic sky starts | `SKY_INNER`, `SHIP_FADE_IN`, `PLANE_FADE_IN` (keep them past the far plane) | `common/src/skyarmada.ts` |
| the far haze | `SKY_VIS`, `SKY_HAZE`; the far city's `abFarVis` | `common/src/skyarmada.ts`, `client/src/render/far-skyline.ts` |
| how a collapse looks | the Destruction Lab (`?destructlab`), then its defaults | `common/src/destruction-tuning.ts` |
| how a settled pile looks | `RUBBLE_ALBEDO`, `RUBBLE_FINISH`, `RUBBLE_SOOT`, `RUBBLE_GLOW` | `client/src/render/broken-shading.ts` |

After a change, run:

- `npx vitest run common/test/lowchaos.test.ts server/test/lowchaos.test.ts`
  for fairness;
- `node --import tsx tools/carrier-sanity.ts --runs 3` for the fleet loop;
- `node --import tsx tools/chaos-bench.ts` and `tools/destruction-bench.ts`
  for allocations;
- `node tools/perf/gallery.mjs <out> 8099 war-peak,…` for draws. It
  exits 1 when a view is over its `galleryDraws` ceiling.

The M3 confirms the time.

## The O1 gate

What the final gate found and fixed is in the PR. In short:

- **Every staged collapse view shot an intact city on a slow
  rasteriser.** The gallery's server dropped a client whose frame took
  seconds, and the resume replayed the room's empty collapse list over the
  staged one. `collapse-topple-impact` showed no falling tower, and the
  ruin views showed the tower standing or gone. The gallery now raises the
  liveness timeout, like every other staging tool.
- **The settled pile was a dark smear** (`ruin-detail`, `ruin-pancake`).
  Rubble was 0.2-albedo concrete under heavy soot, with its chunks hashed
  along diagonals down every side. It is now dusty concrete hashed in the
  face's plane, with light soot and a faint sub-bloom city-glow bounce.
- **Plane lights allocated on every frame.** `planelights.place` boxed its
  exhaust colour and size into non-inlined calls, and `chaos-bench` failed
  its 1 KB budget on remote planes (1392 B/frame, already at f62e54f). It
  now reads 672.
- **C1's warnings were easy to miss.** A low pass sets off an event every
  2–4 s, and its tells (the alarm, dust trickling, a gas main's hiss) were
  sound and particles only. While an event is warned and still to come
  within 320 m, the HUD's alert slot now names it ("⚠ TOWER COMING DOWN",
  "⚠ GAS MAIN ABOUT TO BLOW", …), with a due enemy bomb taking priority
  (`client/src/game/hazard-warn.ts`).
- **The soak called a death fade stuck at 0.1 fps.** Its frame floor
  rounded the frame rate to 0 (`tools/perf/polish.mjs`).

Before and after, SwiftShader, gallery scale 0.5–0.75. The planner checks
the look on the M3.

| sheet | what it shows |
| --- | --- |
| [`ruin-detail.jpg`](infinite-war/ruin-detail.jpg) | the pancake pile up close: the dark smear (main), then the dusty grey pile |
| [`ruin-pancake.jpg`](infinite-war/ruin-pancake.jpg) | the same pile from across the street, both with the harness fix, to isolate the look |
| [`collapse-topple-impact.jpg`](infinite-war/collapse-topple-impact.jpg) | tower 157 felled west: no tower in the shot (main's harness), then the topple breaking up onto its neighbour |
