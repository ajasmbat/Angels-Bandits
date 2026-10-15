# L9: the reference-match gate (before, after, reference)

Each sheet is **before | after | the matching crop of its reference**:

- before is main at `721ba0d` (every L-ticket, H1, L11, D11, DL1 and G7 merged);
- after is this branch;
- the reference is reference 1 (*Stormlit Manhattan*) for the calm views and reference 2 (*Apocalyptic City Under Fire*) for the burning ones.

Both arms are shot with the same gallery views (this branch's `gallery-views.mjs`) at the same pinned instant, in clear weather (`AB_GALLERY_WEATHER=clear`), so a pair differs only by the build. The two `-reframe` sheets instead put main's own pose for the reference views beside the re-posed one.

| sheet | what to look at |
| --- | --- |
| `reference-hero-reframe.jpg` | **Re-frame after H1.** Main's pose cut the carrier off at the top of the frame and left the near towers out of shot. Now the carrier crosses broadside in the upper left with its lamps' beams down on the roofs. A posed biplane flies away mid-right, the south core's towers and the 430 m landmark frame the right, and the river and skyline run into the distance. |
| `reference-inferno-reframe.jpg` | The same composition burning: main's two giant flame sheets in the foreground against the many small fires. |
| `reference-hero.jpg`, `reference-inferno.jpg` | The new pose, before vs after: the grade, the glow and the fire alone. |
| `inferno-gutted.jpg` | **Fire realism.** Main's sawtooth sheets the size of the block (up to ~30 × 55 m per card, grown 2.8× with distance) against flames licking out of the window rows storey by storey, burning floors and rubble, each its own size, heat and flicker. |
| `inferno-dogfight.jpg`, `dogfight-calm.jpg` | **Readability**, with the guns firing at a bandit 110 m ahead, burning and at peace. The muzzle flash was a white square on main (see below). |
| `high-overview.jpg`, `chase-rooftops.jpg`, `street-low.jpg`, `river-bridges.jpg`, `boss-closeup.jpg` | The standard views. |
| `downpour.jpg` | Rain plus mist, main vs L9: `chase-rooftops` and `high-overview` in a pinned downpour. Neither overloads. |

## What changed

1. **Fire: many small, varied flames** (`client/src/render/inferno.ts`).
   - Each drawn fire site is now one instance of `TONGUES` (10) small flame cards. Before, it was three cards up to block size.
   - The vertex shader scatters the tongues over what actually burns:
     - a window fire sends its tongues out of the windows of every storey of its facade chunk, curling out of the face;
     - a floor fire spreads them wall to wall;
     - a rubble fire scatters them as low lumps in a disc round the wrecked building's foot.
   - Each tongue gets its own width, height, heat and 1–3-cycle flicker from a per-tongue hash, and about one in six never lights.
   - The 2.8× distance growth is gone. Instead a tongue is held to at least 4 px wide (grown up to 4×, then faded), so a far block reads as a carpet of fires, not a sheet.
   - The edges are soft-additive with a glow round each tongue, so a window row reads as one burning band. Blending is premultiplied: the edges and glow hide only part of what is behind them. Their light is clamped to `EMISSIVE_FIRE` × their own cover, so the composite over anything at or under the rung still never passes it, and tracers stay on top.
   - The picker is a quickselect, O(candidates) instead of O(candidates × cap). The cap therefore rises from 220 to 1200 sites (Mobile keeps 30 %), which reaches the burning blocks across the frame, not only those under the camera. It is still one draw.
2. **Smoke columns:** 6 drawn (was 20). D11's frame budget (`SMOKE_COVERAGE_MAX`) had thinned 20 columns until none was visible against the haze; six read as dark plumes. The cloud-deck glow and the district firelight (`FIRE_ZONES`) are now fed from the 8 nearest burning blocks whether or not their column is drawn, so fewer columns do not dim the burning city.
3. **Grade, fog and light** (`sky.ts`, `storm.ts`), measured with the new `tools/perf/palette.mjs` (below):
   - `EXPOSURE` 1.10 → 1.25. The calm views measured mean luma 0.13–0.20 against reference 1's 0.27.
   - `CITY_GLOW_PEAK` 0.017 → 0.04. The haze over the lit city glows amber, as in reference 1. It is ~1.6× the fog colour's own luminance and ~1/18 of the bloom threshold.
   - The burning city's haze: `BURN_FOG_COLOR` `0x6a2a12` × 0.42 → `0x5a3c0e` × 0.40. Over the steel-blue night fog the old mix left blue above green, so the haze read magenta (49 % of its hue mass at 330–360°, against reference 2's 3 %). With more green it reads ember orange-red at about the same dark level.
   - `BURN_GLOW_GAIN` 1.4 → 0.2, so the burning horizon glow stays where L7b had it.
4. **Muzzle flash** (`tracers.ts`). It was an untextured `THREE.Sprite`: a flat 4 m square at the tracer rung, which bloomed into a white block over the bandit dead ahead for as long as the trigger was held (main's `inferno-dogfight`). It now carries a radial glow texture that peaks at the same rung.
5. **Views (tools only):**
   - `reference-hero` / `reference-inferno` are re-posed. The eye is 400 m over the south bank looking down the river at −6°, through a pinned 80° lens.
   - The plane is parked 90 m over the eye with its nose aimed so the carrier, staged 430 m ahead, crosses broadside 170 m above the eye.
   - A biplane is posed 40 m out, mid-right.
   - It is not higher: fire is cut at 760 m (`CUT_M`, inside the 800 m fog), so from 530 m almost none of the burning city was in reach.
   - `reference-inferno` stages its burning blocks where that band of the frame looks (`REFERENCE_INFERNO_STAGE`).
   - A new view, `dogfight-calm`, is `inferno-dogfight` at peace.

The neon layer (L11) is untouched: crowns, signs, storefronts and the plaza keep their full strength, and the exposure lift only makes it read more.

## The palette match (`tools/perf/palette.mjs --hud --vs <reference>`)

Hue distance is the L1 distance between the two 12-bin hue histograms (each pixel weighted by saturation × value; 0 is identical, 2 is disjoint). Δ luma is the shot's mean luma minus the reference's. Shares are of the frame without the HUD.

| view | vs | hue distance before → after | Δ luma before → after | fire % before → after |
| --- | --- | --- | --- | --- |
| `reference-hero` | ref 1 | 0.61 → **0.38** | −0.07 → **−0.02** | 0.9 → 1.1 |
| `high-overview` | ref 1 | 0.55 → **0.28** | −0.11 → **−0.07** | |
| `chase-rooftops` | ref 1 | 0.55 → **0.47** | −0.06 → **−0.03** | |
| `river-bridges` | ref 1 | 0.23 → 0.26 | −0.07 → **−0.02** | |
| `boss-closeup` | ref 1 | 0.47 → **0.38** | −0.10 → **−0.06** | |
| `dogfight-calm` | ref 1 | 0.30 → **0.22** | −0.04 → −0.04 | |
| `street-low` | ref 1 | 0.69 → 0.73 | +0.01 → +0.04 | |
| `reference-inferno` | ref 2 | 0.74 → **0.23** | −0.02 → +0.01 | 34.7 → 31.9 (ref 2: 27.3 on the same HUD mask, 24.7 whole frame) |
| `inferno-dogfight` | ref 2 | 0.48 → **0.14** | +0.02 → +0.01 | 33.9 → 32.9 |
| `inferno-gutted` | ref 2 | 0.21 → **0.13** | +0.07 → **+0.02** | 42.0 → 35.0 |

`street-low` is an eye-level street scene scored against the whole of reference 1, which is a high view. It is warmer than the whole reference by nature and is listed for completeness.

## Readability

The measure is the 99th-percentile fire pixel against the gun, pipper and bandit area (the centre of the frame), plus where the near-white pixels are:

| shot | fire p99 luma | brightest non-fire, gun area | luma ≥ 245 px: gun area / rest |
| --- | --- | --- | --- |
| main, `inferno-dogfight` | 147 | 253 | 3698 (the flash square) / 0 |
| L9, `inferno-dogfight` | 148 | 251 | 445 / 0 |
| main, `dogfight-calm` | 170 | 253 | 3764 (the flash square) / 0 |
| L9, `dogfight-calm` | 171 | 251 | 462 / 0 |

Tracers and the flash are the only near-white pixels in either state, and fire stays far under them. The pipper, the HUD bars, the tips and the carrier bar are untouched and read over both.

## Cost (same poses, main → L9)

The flames' overdraw proxy (`__ab.inferno().coverage` less the smoke's share, i.e. the screen fraction of flame cards) and the draw calls:

| view | flame overdraw | draw calls |
| --- | --- | --- |
| `inferno-gutted` (the M3's 50 fps view) | 2.39 → **0.59** | 100 → 98 |
| `reference-inferno` | 0.81 → **0.38** | 104 → 104 |
| `inferno-dogfight` | 1.13 → **0.55** | 121 → 120 |
| `reference-hero` | — | 98 → 98 |
| `high-overview` | — | 92 → 92 |
| `chase-rooftops` | — | 96 → 96 |
| `street-low` | — | 101 → 101 |
| `river-bridges` | — | 91 → 93 |
| `boss-closeup` | — | 91 → 91 |

No draw is added. The flames stay one instanced draw and the smoke one; the ±2 is the pinned world's traffic and movers (L7b noted the same jitter). The flame vertex count rises (1200 sites × 10 cards × 4 vertices, against 660 cards × 4) while fill falls ~4×. The fps itself needs the M3 (below).

## Regression (this box)

**Black boxes and NaN** (`tools/perf/blackbox.mjs`, night, 40 frames per path, every path including each tunnel bore):

| profile | frames with NaN / Inf pixels | positive control | image-heuristic boxes |
| --- | --- | --- | --- |
| desktop (High) | **0** | ok | 5: `street`, `rubble`, `rings`, `bore0`, `bore2` |
| phone (Mobile) | **0** | ok | 1: `boss`, not reproduced in 3 reruns (0, 0, 0) |

- Every desktop box sits in the bottom strip of the frame (y ≥ 316 of 360). That strip holds the HUD's status panel and the coach tip's dark backing, which comes and goes; none is in the 3D scene.
- Main has the same boxes, and more of them. Main's own build through main's own detector, on the same five paths with `--repeat 2`, counted 11 per pass (`rubble` 4, `rings` 5, `bore0` 2). This branch counted 6 per pass (`rubble` 2, `rings` 2, `bore0` 1, `bore2` 1). Both are deterministic pass to pass.
- The phone `boss` path is the harness's one non-deterministic segment (11 fake pilots on their own wall clock).
- The detector exits 1 on any box, on main as on this branch.

**Flicker grid** (`tools/perf/flicker.mjs --grid --ref 721ba0d`, 12 views: the standard views, the reference pair, `inferno-gutted`, and four seeded poses). Frozen mean |Δluma|, main → L9:

| view | main | L9 | |
| --- | --- | --- | --- |
| `chase-rooftops` | 0.015 | 0.015 | |
| `high-overview` | 0.010 | 0.011 | |
| `street-low` | 0.125 | 0.129 | |
| `river-bridges` | 0.051 | 0.052 | |
| `reference-hero` | 0.017 | 0.018 | |
| `reference-inferno` | 0.266 | **0.172** | the small flames shimmer less than the sheets |
| `inferno-gutted` | 1.380 | 1.375 | fire is animation; both arms flagged as a flash |
| `pose-00` / `01` / `03` | 0.350 / 0.488 / 0.057 | 0.356 / 0.499 / 0.059 | |
| `chase-canyon` | 0.338 | 0.363 | "worse": the exposure, see below |
| `pose-02` | 0.201 | 0.217 | "worse": the exposure, see below |

- The grid's absolute bar fails every view on both builds. The bar is to halve anything over 0.01 with nothing over 0.041; it is the M3's bar, and SwiftShader at 640×360 cannot meet it (as L11 found).
- **The two "worse" views are the exposure lift, not new shimmer.** The same frames, 13 % brighter, move more luma per step. This branch was rebuilt at `EXPOSURE` 1.10, a throwaway commit object with the branch untouched, and A/B'd against itself at 1.25 on the same views: `chase-canyon` read 0.336 at 1.10 (main 0.338) against 0.363 at 1.25, and `street-low` read 0.125 at 1.10, exactly main.
- Pan (pure motion) rises a uniform ~4 % on every view for the same reason.

**Perf harness** (`tools/perf/run.mjs --runs 1 --ab-ref 721ba0d --res 1`, every segment, SwiftShader).

At 1–2 s a frame under a load average of 15–26, the GPU and wall columns are not evidence either way. The paired draw calls, main → L9:

| | segments |
| --- | --- |
| identical | `core` 102, `sky` 89, `canyon` 102, `storm` 93, `street` 103, `station` 100, `sidewalk` 101, `collapse` 110, `ruins` 185, `rubble` 121, `boss` 98, `glass` 101, `chaos` 122, `tunnel` 101, `exit` 112 |
| fewer | `furball` 181 → 174, `hole` 115 → 101, `rings` 102 → 97 |
| more | `plaza` 97 → 98, `cavein` 94 → 101 (see below) |

No program linked late (0 late compiles). The ones that move are the segments with live movers: the fake pilots, the cave-in's falling pieces and puffs, the ring course's ghost. `cavein` reads 101 in both arms on the phone pass, so the desktop pass's 94 on main was that arm's outlier.

**Phone** (`run.mjs --runs 1 --ab-ref 721ba0d --device phone`, the Mobile tier):
- **Identical draw calls:** `plaza` 97, `sky` 89, `canyon` 102, `storm` 93, `street` 103, `station` 100, `sidewalk` 101, `collapse` 110, `glass` 101, `chaos` 122, `exit` 111, `cavein` 101.
- **Live-mover segments** move both ways: `furball` 156 → 176, `rings` 103 → 112, `boss` 97 → 101, `core` 101 → 102, `ruins` 184 → 179, `rubble` 107 → 101, `hole` 115 → 101, `tunnel` 115 → 101.
- The Mobile tier draws 30 % of the flame sites (360), 2 smoke columns and no air, as before.
- There were 0 late compiles.
- The harness could not hold `boss`, `chaos` or `exit` in one arm or the other at this load (no baseline). On desktop the same happened to `rings` and `exit`.

The fps the planner's M3 measured (`inferno-gutted` at 50 fps) needs the M3. The flame overdraw it came from is down ~4× on that view (above).

## Commands for the planner (M3)

```sh
npm ci && npm run perf:setup            # once
npm run build -w client

# Perf, every segment, paired against main before L9 and against O7b:
node tools/perf/run.mjs --runs 3 --ab-ref 721ba0d
node tools/perf/run.mjs --runs 3 --ab-ref 67703d4
node tools/perf/run.mjs --runs 3 --ab-ref 67703d4 --device phone

# The 50 fps view: the gallery prints each shot's fps ("shot inferno-gutted {fps: …}")
node tools/perf/gallery.mjs /tmp/l9-m3 8099 inferno-gutted,reference-inferno,inferno-dogfight,reference-hero

# Flicker grid and the black-box / NaN detector
node tools/perf/flicker.mjs --grid --repeat 3 --ref 721ba0d
node tools/perf/blackbox.mjs --device all --repeat 3

# The palette match against the references (any gallery shot)
node tools/perf/palette.mjs --hud --vs "<reference 1 png>" /tmp/l9-m3/reference-hero.png
node tools/perf/fire-cover.mjs --hud /tmp/l9-m3/reference-inferno.png
```

## How they were captured

- The box is GPU-less Linux with SwiftShader, at render scale 0.75, the High tier and 1280 × 720, under a load average of 12–26 from other worktrees. Colours and draw calls are right; frame times on this box mean nothing.
- Every view is pinned to one world instant, and the server runs a quiet city (`AB_QUIET_CITY=1`) with no carrier waves.
- `LIVENESS_TIMEOUT_MS` and `?silence=` are raised to 600 s. Under load, a software frame of seconds tripped the socket watchdog, and the resume wiped the client-staged wreckage, so `reference-inferno` shot an intact city.
