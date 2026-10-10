# A1 performance audit

What costs the game time at runtime, measured where this runner can measure
it and read statically where it cannot, and the safe wins that shipped.
Every fix is behavior-identical, or identical within float rounding: no
visual change beyond noise and no gameplay change. The proofs are below.

The runner has **no GPU**. Chromium falls back to SwiftShader, so every
browser number here is a SwiftShader number: frames take 1–3 s, and
over 95 % of the main thread is spent blocked in GL. The machine was also
shared with other agents' perf runs (load average 40–90). So read the
browser rows as **relative** rankings. Read the server and wire rows as
real: Node does not care about the GPU. The M3 commands at the end are the
ones that settle the GPU questions.

## How to reproduce

```sh
# server tick + wire (no browser): 8 humans + 4 bots, every chaos layer on FAST
node tools/perf/server-tick.mjs --humans 8 --bots 4 --warmup 20 --seconds 60
node tools/perf/server-tick.mjs --humans 1 --bots 11 --cpu-prof /tmp/prof   # + a V8 profile
# client: where the main thread goes, from Chrome traces (unminified build reads best)
(cd client && npx vite build --minify false)
node tools/perf/run.mjs --no-build --runs 1 --res 0.25 \
  --segments chaos,tunnel,furball,boss,ruins --trace /tmp/traces
node tools/perf/trace-spikes.mjs --top 15 /tmp/traces/*.json
# the paired gate (prints the late-compile table too)
node tools/perf/run.mjs --runs 3 --ab-ref origin/main --segments chaos,tunnel,furball,boss,ruins
```

On a Linux box whose Playwright cache holds a different Chromium than the
pinned one, set `AB_CHROME` to its `chrome-headless-shell`.

## Server tick

### Method

`tools/perf/server-tick.mjs` (new) boots the real server with
`AB_TICK_STATS=1` and every chaos layer on its FAST schedule: boss raid and
carrier launches, missiles, the director, meteors, bombers, quakes, fires
and cave-ins. It joins plain ws pilots that stream poses at 30 Hz and fire
4 shots a second each, sets the bot slider, and after a 20 s warm-up reads
60 s of ticks. `server/src/tickstats.ts` (new, off unless the env var is
set) times each phase of `tick()` and serves `GET /debug/tick`.

**"8 humans + 12 enemies" does not fit a room.** `ROOM_CAP` is 12 planes,
so 8 humans get at most 4 bots. Both ends were measured: **8 humans +
4 bots** (the room full of humans) and **1 human + 11 bots** (the room full
of enemies), each with the boss carrier and every chaos layer up. W1's
carrier waves replace the bots; this bench still drives them through the
same `setBots`.

The before arm is `main` (97883bd) plus only the profiler. The two arms ran
interleaved, 3 rounds each, on a machine at load average 80–150 (other
agents' perf runs). The p50s are stable across rounds. The tails are noisy,
so read the max column for the director and quote the medians.

### Before → after (median of 3 interleaved runs; ms)

| room | p50 | p95 | p99 | max (median run) | max (worst of 3) |
| --- | --- | --- | --- | --- | --- |
| 8 humans + 4 bots, before | 1.43 | 9.2 | 27.6 | **277** | 386 |
| 8 humans + 4 bots, after | 1.34 | 12.9 | 32.0 | **70** | 145 |
| 1 human + 11 bots, before | 1.42 | 13.0 | 34.7 | **259** | 274 |
| 1 human + 11 bots, after | 1.42 | 13.2 | 33.9 | **89** | 143 |

At 20 Hz the budget is 50 ms. **Before, the director stalled a tick for
250–390 ms, about once per slot: 5–8 snapshots missed in a row, which every
client sees as every plane freezing and snapping.** After, no tick in any
run comes near that.

Per phase (median run):

| phase | before mean / p99 / max | after mean / p99 / max |
| --- | --- | --- |
| director (8 + 4) | 0.84 / 1.8 / **276** | 0.83 / 24 / **69** |
| director (1 + 11) | 1.02 / 2.7 / **258** | 0.81 / 24 / **88** |
| bots (1 + 11) | **1.53** / 13.5 / 35 | **1.21** / 7.6 / 30 |
| bots (8 + 4) | 0.87 / 5.8 / 31 | 0.85 / 5.5 / 23 |
| wrecks + missiles (8 + 4) | 0.31 / 5.3 / 27 | 0.25 / 3.9 / 15 |

### Hot spots and fixes

1. **Destruction director, the spike** (`server/src/director.ts`). Each
   pick simulated the real debris of the top 4 towers, each way they could
   fall: up to 20 `buildCollapse` runs (~9 ms each idle, 20–30 ms at this
   load) in **one tick**, and again on every retry. The fix:
   - Each candidate's danger zone and fall footprint are **cached** by
     (building, style, direction, chunk set). `buildCollapse` is a pure
     function of its wire and the generated city, the chunk set is the
     only live input, and the cache keeps the newest 256 entries.
   - In the 2 s before a slot arms, and while it is armed (the schedule is
     a pure function of seed and time), idle ticks **prefill** the shapes
     of the towers the pick would score, at most one simulation a tick.
     This is the director p99 going from 2 to 24 ms: the same work, spread
     over ~20 ticks instead of one.
   - **Proof of identity:** the shapes are built at t = 0, not at the warn
     time. Across 610 collapses (every tower ≥ 60 m in thirds, intact and
     15 % damaged, every style and direction), the encoded wire zone and
     the fall footprint are equal in every case. The raw bounds differ by
     at most 6e-14 m, inside the zone's whole-metre quantisation. The
     director tests pass unchanged.
2. **`losClear` scanned all 559 buildings** (`common/src/collision.ts`), for
   every bot sight-line test, every boss-turret target check and every
   missile sweep. It now takes the city's block index: only the buildings
   in the blocks the segment's bounds touch, deduplicated and ascending.
   The index footprints are grown by `RUBBLE_REACH`, so every building the
   old footprint reject could pass is in them. **Proof:** 600 000 random
   segments (intact, 10 % and 40 % damaged cities; seam-crossing, long up
   to 1200 m, vertical, short), index versus linear: 0 mismatches. Bots
   −21 % mean in the bot-heavy room.
3. `tickRebuilds` built the director's plane list every tick for a check
   that runs once a second (`rebuildDue`).
4. Five bot rollout loops (`pathBlocked`, `heldBlocked`, `inputMeetsHazard`,
   `arcBlocked`, `launchClear`) spread a fresh input object every simulated
   step. It is now hoisted; the input is constant across each loop.
5. The snapshot is built with a loop (no `flatMap` of one-element arrays),
   and every broadcast is **UTF-8 encoded once per room** (ws re-encoded the
   string for every socket). It is still a text frame.

### Proposed, not shipped

- **Stagger bot decisions** (`bots.ts`: every bot decides on the same tick
  in 4). Spreading them by bot index would flatten the bot phase's p99,
  but it changes the bot sim's numbers: a gameplay re-baseline, not an
  audit fix.
- Build the plane list once per tick for chaos and cave-ins (two identical
  builds). Not shipped because a chaos death between them would change
  what cave-ins see.
- Cache bot `poseOf` / `contactOf` per tick (about 9 plane-list builds per
  member per tick).

## Network

The snapshot was already quantised (ANGE-4KO2W2): a tuple of integers per
plane, at 20 Hz. What was left, measured by the bench as one client
receives it (full chaos, median of 3):

| room | snapshot before | after | bytes/entry | all traffic, per client |
| --- | --- | --- | --- | --- |
| 8 humans + 4 bots | 921 B | **733 B (−20 %)** | 76.6 → 60.8 | 21.3 → **17.1 KB/s** |
| 1 human + 11 bots | 740 B | 709 B | 62.1 → 60.3 | 15.8 → 15.3 KB/s |

**The trim:** a player id was a 36-character UUID, written into every
snapshot entry for every client. That was nearly half a human's entry. Ids
are now 12-character base64url (72 random bits). The wire layout is
unchanged, so a stale tab still decodes it, and nothing parses an id:
`bot:` and `@` ids stay unambiguous, since base64url has neither `:` nor
`@`. Resume tokens are separate, and a resumed session keeps its old id.

Snapshots make up 84 % of the traffic. The rest is `fired` (one message
per accepted shot), `cityEvent`, `rebuild`, `damage`, `missile`, `flak`
and `chunks`. All are event-driven, and nothing is stringified per member.

**Considered and rejected:**

- **Delta snapshots, or dropping default fields.** There is no protocol
  version handshake, and a stale tab can resume against a new server. Any
  layout change it cannot decode would put planes in the wrong place.
- **`perMessageDeflate`.** It would compress the repeated ids and digits,
  but it costs a deflate per socket per message and ~32 KB per
  connection, which is server CPU in exactly the place this audit is
  trying to free.
- **Batching `fired` into one message per tick.** It needs a new message
  type. Stale clients drop unknown types, so they would lose remote
  tracers. Worth doing with a version gate, about 1.1 KB/s per client.

## Client CPU and GC

### Method

A scripted session of the five chaos-era segments (`chaos`, `tunnel`,
`furball`, `boss`, `ruins`). Each pass is a full warm-up lap plus the
measured windows, a little over 3 minutes of game time. It ran on an
unminified build of `main` (97883bd) with `run.mjs --trace` at `--res 0.25`,
and `trace-spikes.mjs --top` (new in A1) summed the V8 CPU samples. On
SwiftShader at load ~80, **98.6 % of the main thread is native time blocked
in GL**, and only 24 frames landed in the traced windows. So the ranking
below is the signal, not the milliseconds. GC was small everywhere: 0–8.6 ms
per traced window, and no spike was GC-caused in any trace.

### Top 15 JS self-time costs (main@97883bd, traced windows)

| # | function (source) | ms | what it is | A1 |
| --- | --- | --- | --- | --- |
| 1 | `losClear` (common/collision) | 119 | the shimmer vents' sight lines (`atmosphere-fx.ts`), scanning all 559 buildings, 4 Hz × every vent | **fixed**: uses the city index |
| 2 | `wrapDeltaAxis` (common/world) | 55 | mostly inside #1 (two per building per sight line) | falls with #1 |
| 3 | `Pedestrians.update` | 41 | walkers' pose and pack; already prefix-uploaded | — |
| 4 | `frame` (main.ts) | 33 | the frame body's own glue | small allocations trimmed (below) |
| 5 | `landingTime` (common/collapse) | 28 | staged collapses' debris, built once per collapse | event-driven; see the server's shape cache |
| 6 | `flight` (common/collapse) | 24 | same | event-driven |
| 7 | `createBiquadFilter` (Web Audio) | 19 | one-shot voices: gun bursts, collapses, warnings | event-driven, voice-capped |
| 8 | `performance.mark` | 19 | the harness's own window marks | harness only |
| 9 | `Signage.place` | 19 | per-sign colour pulse, whole colour buffer each frame | proposed: pulse in the shader |
| 10 | `setProgram` (three) | 17 | per-draw uniform upload | — |
| 11 | `createStereoPanner` (Web Audio) | 15 | a panner per burst, even centred ones | **fixed**: centred bursts skip it |
| 12 | `projectObject` (three) | 13 | scene traversal | — |
| 13 | `TrainRenderer.local` | 12 | train cars' part placement | fixed slots no longer re-placed (below) |
| 14 | `GameSocket.handle` | 12 | message decode | — |
| 15 | `updateMatrixWorld` (three) | 12 | scene graph | — |

### Per-frame waste found, and what shipped

From a full read of the frame path (`main.ts` and every `update()` it
calls), ranked by expected cost. **Shipped** means it is in this PR;
everything shipped is behavior-identical.

| finding | where | shipped |
| --- | --- | --- |
| train viaduct, stations and people (100–300 boxes) recomposed and the whole instance buffer uploaded every frame | `render/train.ts` | **yes**: fixed slots only on a torus-image flip or a person coming or going; `InstanceUploads` sends the cars plus changed slots |
| ~15 + 3 × remotes `setTargetAtTime` calls a frame with unchanged targets (engines, remote engines, static, neon buzz, train, boss drone, busker, clatter) | `audio/sound.ts`, `busker.ts`, `train-audio.ts` | **yes**: `audio/ramp.ts` sends a target only when it moved > 0.002 (ambience's existing rule) |
| a StereoPanner node per gun burst, even at pan 0 (own gun at 10 Hz, hits, thunder) | `audio/sound.ts` `burst` | **yes**: a mono source through a centred panner is × cos(π/4) into both channels, so the gain takes `Math.SQRT1_2` instead: the same signal, one node fewer |
| `syncRemotes` allocates a `Set` a frame | `audio/sound.ts` | **yes**: one Set, cleared |
| MoverLights uploads all 1024 slots (~28 KB) every frame | `render/movers.ts` | **yes**: the drawn prefix |
| missiles/meteors/bombers flag their buffers for upload at count 0 | `render/missiles.ts`, `bombers.ts` | **yes**: only while live, plus the frame they empty |
| birds: ~5 allocations a bird (6 × 24) a frame | `render/birds.ts` | **yes**: `birdPositionInto` + `nearestImageInto` scratch (same arithmetic) |
| `remotes.headings()` built twice a frame | `main.ts` | **yes**: once |
| storm `pings()` filter + map every frame with no reveals | `render/storm.ts` | **yes**: shared empty result |
| bloom pass `new THREE.Color()` a frame | `render/post.ts` | **yes**: one scratch |
| edge markers: `targets.map` a frame, `nearestImage` per target, every pooled arrow re-hidden every frame | `main.ts`, `ui/markers.ts` | **yes**: reused array, scratch image, DOM writes only on change |
| minimap: three array literals a frame | `ui/minimap.ts` | **yes** |
| shimmer sight lines scan the whole city (#1 above) | `render/atmosphere-fx.ts` | **yes** |
| signage colour pulse on the CPU + full colour upload | `render/signage.ts` | proposed (GPU section) |
| cranes and aircraft: about 20 literals, closures and `find`s per crane a frame | `render/movers.ts` | not shipped: a wider refactor of a file siblings touch |
| own-bullet hit tests: `wrapDelta` × bullets × targets | `game/hitdetect.ts`, `magnetism.ts` | not shipped: only while firing; next candidate |
| airliners recomputed from the seed every frame (`airlinersAt(...).slice`) | `render/airliners.ts` | not shipped: memoise per slot |
| "on your six" callout re-queued every frame while it lasts | `main.ts`, `audio/radio.ts` | not shipped |
| sparks/explosions upload whole pools | `render/fx.ts` | not shipped: `uploadPrefix` candidate |
| idle loops (boss drone, neon buzz, static, busker) keep running at gain 0 | `audio/sound.ts` | not shipped: stopping and rebuilding changes their phase |

The HUD was already clean: its `setStyle` cache (O2) writes a style only on
change, and the score, boss, damage and race HUDs go through it.

## GPU (static read: no GPU on the runner)

### Passes and targets

In draw order (composer setup in `client/src/main.ts`, passes in `render/post.ts`):

| pass | target | cost notes |
| --- | --- | --- |
| RenderPass | full-res HalfFloat, **MSAA 0** (4 only with `?aa=msaa`) | the scene; every pass is `needsSwap=false`, so the composer's second target never gets storage |
| DiscardDepthPass | — | invalidates depth (tile GPUs) |
| ShaftsPass | quarter-CSS-res HalfFloat, no depth | 24-tap radial march; skipped when inactive |
| AbBloomPass | half-res bright pass, then 5 mips × H/V blur targets | about 12 quad draws |
| FinalPass | screen | bloom add, ACES, sRGB, grade; 6-slot shimmer loop (early break), glare branch |
| Reflection probe (`reflections.ts`) | 3 × 128² HalfFloat cubes + mips + depth | 7 draws per face; faces per frame: High 1, Medium 0.5, Low 0.34, Mobile 0 |
| Jumbotron replay | 256×144 RGBA8 | only on a kill, plus one boot capture |

No shadow maps and no depth prepass. Pixel ratio per tier: High 2,
Medium 1.5, Low 1, Mobile 1. The adaptive ladder is
`[2, 1.75, 1.5, 1.25, 1, 0.75]` (`resolution.ts`), with thermal caps on top.
Bloom is on for every tier and turns off at thermal level 1.

### Overdraw-heavy transparent layers

| layer | size | blending |
| --- | --- | --- |
| cloud ceiling (`storm.ts`) | 1800 × 1800 m, follows the camera | normal 0.55, double-sided |
| cloud puffs | 160 billboards | normal |
| fog banks (`fogbanks.ts`) | 40 banks, fill clamped to 0.35 × view distance | ShaderMaterial |
| rain | up to 8000 instances | additive |
| steam, dust (6), smoke (18 × 24 puffs), litter, impacts, ruin smoke | Points | mixed |
| searchlight beams, headlight cones | — | additive, double-sided |
| underground veil and motes | — | normal / additive |
| sky dome | full screen, renderOrder −1 | opaque, no depth write |

### Shader loops

| loop | per | iterations |
| --- | --- | --- |
| building window wake (`reactions.ts`) | **every facade pixel** | was always 8 (`continue` on empty slots); **now stops at `uWakeCount`** |
| damage map | facade pixel | 3, early break |
| FinalPass shimmer | screen pixel | 6, early break |
| shafts | quarter-res pixel | 24 taps |
| boss hull | hull pixel, raid only | 4 and 7 |
| fog banks, look-up, cave-in | vertex | 12, 12 × 2, 4 |

### Shipped (no visual change)

- **Window-wake loop** (`reactions.ts`, `buildings-material.ts`). A
  `uWakeCount` uniform carries how many of `uWake`'s slots are live this
  frame, and the loop breaks there. The slots past the count already had
  `w = 0` and were skipped, so the result is identical. With no gunfire
  nearby, every facade pixel now does 0 iterations instead of 8 uniform
  reads. It deliberately does not `break` on `w <= 0`: the newest wake sits
  in slot 0 and can read 0 on its first frame, and that would drop every
  wake behind it.
- **Train fixed slots** (`train.ts`). The viaduct, stations and platform
  people (100–300 boxes) were recomposed and the **whole** instance buffer
  re-uploaded every frame. Now a fixed slot is re-placed only when its torus
  image flips, or when a person boards or appears. Uploads go through
  `InstanceUploads`: the moving cars every frame, plus only the fixed slots
  that changed.
- **Empty pools stop uploading** (`missiles.ts`, `bombers.ts`). With
  nothing in the air, the instance matrices and glint/light buffers are no
  longer flagged every frame. The frame a pool empties still uploads once,
  to park its glints.
- **MoverLights** (`movers.ts`) uploads its drawn prefix, not all 1024
  slots (~28 KB) every frame.

### Proposed, not shipped (each needs eyes on a real GPU)

1. **Underground opaque geometry before the city when the camera is below
   ground**, with hysteresis around y = 0. From a bore, the ground plane is
   back-face culled, so facades are fully shaded and then painted over by
   the tunnel shell. Drawing the shell first lets early-Z reject them. Not
   shipped: draw order decides exactly-coplanar ties at the portals, and
   that is where O7 fought flicker.
2. **Skip the reflection-probe refresh while `underCover(camera)`**, and
   refill on exit. Up to 7 draws per face. The only visible difference
   would be river water seen through a river-mouth bore.
3. **Signage pulse in the vertex shader.** `signage.ts` scales every
   sign's colour on the CPU and re-uploads the whole colour buffer each
   frame for a 12 % sine pulse the shader could compute from `uSignTime`
   and a per-instance phase. float32 versus float64 arithmetic is a
   noise-level difference, but the change touches the signage shader patch.
4. **Sky dome after the city when underground**, so it fills only what
   nothing nearer covers. Not pixel-proven: geometry beyond the dome's
   860 m radius would be covered.
5. **Culling above-ground layers in a tunnel, or the underground from above:
   not safe wholesale.** Bores have straight legs of 242–463 m and you can
   see out of the mouths (and down into portals). Either direction needs a
   per-tunnel sightline test.

### Commands for the M3 (machine otherwise idle)

```sh
# 1. the shipped changes against main, GPU columns (quote the paired delta)
node tools/perf/run.mjs --runs 3 --label A1 --ab-ref origin/main
# 2. the facade-heavy segments, where the wake loop and train uploads land
node tools/perf/run.mjs --runs 3 --label A1-core --ab-ref origin/main \
  --segments core,canyon,street,station
# 3. the tunnel segments (for proposal 1/2: rerun after each lands)
node tools/perf/run.mjs --runs 3 --label A1-tunnel --ab-ref origin/main \
  --segments tunnel,exit,cavein
# 4. first-sight on Metal: 0 late compiles, and no early-window wall spikes
node tools/perf/run.mjs --runs 3 --samples --segments chaos,boss,ruins,storm,street
```

## Hitches

### Pre-warm coverage

`prewarmScene` (`render/prewarm.ts`) shows every hidden object, turns
frustum culling and LOD switching off, uploads `.map` textures, compiles
with the composer's target bound, waits for the links, then draws one real
composer frame behind the boot fade. Every `scene.add` in `main.ts` comes
before it. Only remote planes are added later, and they share program keys
with your own plane. Nothing changes material defines at runtime, and no
light is added after boot.

| ticket | what it added | covered? |
| --- | --- | --- |
| D8 (cc2cf1c) | visibility masks only; materials stay in constructors | yes |
| U6 (2769057) | cave-ins create `instanceColor` at construction so the right variant compiles; the flicker uses a fixed-size uniform array | yes |
| S9 (201cda0) | hull, lite hull, glow, lights, shells all built in the constructor, group hidden; launched planes are bots drawn by the fleet | yes |
| F10 (97883bd) | no render or material change | n/a |
| O7 (d1da64b) | edits existing shaders; FinalPass is linked by the warm-up frame | yes |

**The gap, fixed:** a shown object that draws *nothing* is not drawn. Every
pool that boots empty was compiled and then skipped by the warm-up frame,
so the driver's lazy first-draw work (pipeline state on ANGLE/Metal) still
landed on the first missile, bomber, cave-in, bolt, explosion or downpour.
That covers instanced meshes at count 0 (missiles, meteors, bombers,
cave-ins, scaffold, headlights, signals, street furniture, pedestrians, city
life, facade detail, the damaged-building mesh), empty draw ranges (storm
bolts, steam, dust, impacts, litter, reaction smoke, sparks) and 0-instance
instanced geometries (fog banks, rain). For that one frame, each pool with
capacity draws a minimal prefix (1 instance, ≤ 3 vertices). It is put back
synchronously, before any await, so no game frame or socket handler sees
the forced counts. P4's `fleet.warm` / `tagBatch.warm` were the same idea
for two pools; this generalises it.

### The late-compile gate

`run.mjs` now logs every program link from its init-script GL probe, with
the shader's name (three writes `#define SHADER_NAME` into each source)
and the phase it landed in: boot, warm-up lap, or a segment. The client
exposes a read-only `__ab.bootedAt()` (performance.now() when the boot
pre-warm finished). The report prints **late compiles: programs linked
more than 5 s after it**, over the whole session (warm-up lap included),
per pass. The target is 0, and any is a non-zero exit, like a draw-budget
miss.

**Result** (this branch, `--runs 3 --ab-ref origin/main` over `chaos`,
`tunnel`, `furball`, `boss` and `ruins`, warm-up laps included): **0 late
compiles in each of the 3 passes**, and the existing first-sight table
reads `0p 0t 0b` in every settle and every window. The probe sees links,
not the driver's lazy pipeline work. The forced warm-up draws are aimed at
that work, and only the M3's `--samples` run (command 4 above) can show it.

### Other mid-game allocations (not shipped)

- The damaged-buildings mesh starts at 256 slots and doubles by building a
  new mesh and re-uploading (`city.ts`); debris doubles the same way past
  its boot size. No shader compile, but a buffer re-upload during a
  collapse. The D6 gate shows `damaged slots ≤ 1024`, and the ruins
  segment peaked at 316. Starting at the gate's cap would trade ~60 KB of
  memory for never growing.
- Textures re-uploaded on events: the name-tag atlas (1024×256, on a join
  or rename), the river's skyline bake (after collapses), and the
  jumbotron canvases (1024×576 and 2048×64 with mipmaps, on each kill or
  headline, at any distance). The jumbotron upload could be skipped while
  every screen is out of range.
- Web Audio node creation shows in spike frames: a collapse's rumble,
  roar and sub (about 10 nodes), and a director warning's creaks. These are
  one-shot event voices, capped by `chaosVoice`. They are fire-and-forget
  by Web Audio's design, and pooling them would change their envelopes.

## The paired run (`run.mjs --runs 3 --ab-ref origin/main`)

```
node tools/perf/run.mjs --no-build --runs 3 --ab-ref origin/main \
  --segments chaos,tunnel,furball,boss,ruins --res 1        # exit 0
```

**The SwiftShader caveat, in full:** this runner has no GPU timer, so every
GPU column reads 0.0 in both arms, and the harness's own GPU-p50 verdict
cannot say anything. The box was at load 60–140, so wall p50 moved 235 %
between passes of the *same* build. The harness flags that as "the machine
was busy" and fails its determinism line on wall clock, as designed. What
this run can show:

- **Scene identity holds.** Draw calls are identical between the two
  builds in every segment whose world is fully pinned: `tunnel` 84 = 84
  (the asserted segment) and `chaos` 101 = 101, each identical across all
  3 passes. `furball`, `ruins` and `boss` fly fake pilots on their own wall
  clock, so they vary pass to pass in **both** arms (ref `boss` 112 / 85 /
  86, ref `ruins` 152 / 152 / 164; this branch `ruins` 138 / 115 / 152).
  Their median rows (−3, −37, 0) are that noise, not a change.
- **No regression it can see:** every budget verdict is `ok`, the room and
  spectacle staging held, and the destruction table matches field for
  field (316 damaged slots, 667 debris pieces, 8 collapses in `ruins`).
- **The late-compile gate reads 0** (above).
- Wall and JS p50 deltas (−17 % to +16 %) are inside the run's own 235 %
  pass-to-pass spread. They are not quoted as wins.

The render-side wins (wake loop, train and pool uploads, MoverLights,
shimmer sight lines) need the M3's GPU columns: run the commands in the
GPU section. The measurable wins in this PR are the server's: the
director stall (277 → 70 ms max tick), the bot phase (−21 %), and the
wire (−20 % per client).

One harness fix came out of getting this run to finish on a loaded
software-rendered box: `joinGame`'s boot waits are now 180 s (they were
60 s and 30 s). The boot pre-warm compiles every program synchronously,
and at load ~130 that held the page's main thread, and so the harness's
in-page polls, past the old limits on both builds.
