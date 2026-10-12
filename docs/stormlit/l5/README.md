# L5 Stormlit: mist, steam plumes and cinematic rain

Each sheet has three columns: the matching crop of the reference render
(`Stormlit Manhattan_ Zeppelin and Biplane.png`), main before L5
(`7061222`), and this branch.

All shots are 1280×720 on SwiftShader (a GPU-less Linux box), quality High,
deep night. The weather was pinned to `downpour` every frame. Each shot was
taken just after a lightning strike was consumed, so no flash is in frame.
Colours are right, but frame rates on this box are not representative.

The captures came from a scratch variant of `tools/perf/weather.mjs` (pose
and weather held every frame, plus a discarded warm-up shot) and from
`tools/perf/gallery.mjs`. Every `after` frame is from the final build. A
few frames were re-shot, or taken from the gallery run, because this loaded
box returned blank screenshots for some captures on both builds (see Black
boxes below).

| sheet | reference crop (x, y, w, h of the 1672×941 render) | what to look at |
|---|---|---|
| `01-high-overview.jpg` | whole frame | The rain goes from a screen-wide wall of streaks to a fine, varied scatter, and the city reads through it. |
| `02-chase-rooftops.jpg` | 0, 469, 840, 472 (lower-left rooftops) | White steam plumes rise off the roofs and lean downwind. The roof puddles hold sign colour. |
| `03-street-low.jpg` | 820, 558, 680, 383 (the lit avenue) | Rain is subtle at street height and never in the way. |
| `05-chase-canyon.jpg` | 600, 380, 836, 470 (the river canyon) | Plumes lift off the canyon roofs. |
| `06-rooftop-skim.jpg` | 180, 470, 836, 470 | Rooftops in rain: fine streaks, roof-puddle smears, plumes. |
| `07-puddle-street.jpg` (new) | 900, 620, 560, 315 | The wet look: soaked asphalt, rain rings, and neon and lamp reflections. The reflections in standing water now shimmer, which needs motion to see. |
| `08-mist-canyon.jpg` (new) | 0, 330, 836, 470 (mist between the towers) | Canyon mist strands lit sodium from below, and roof plumes. Both frames caught L1's post-strike fog stain (pale air), so they are a like-for-like pair. |
| `09-steam-roofs.jpg` (new) | 380, 520, 700, 394 (plumes over the roofs) | Roof plumes seen from 210 m. Before L5, steam was gone above 140 m of camera height. |

`boss-closeup` is in `04-boss-closeup.jpg` (the zeppelin crop, 150, 60,
700, 394). Its view pins clear weather, so it shows the mist and steam
changes only.

## What changed, and the numbers it rests on

### Rain (`rain.ts`, `rain-look.ts`)
- **Coverage cap: 8 % → 3 % of the screen.** The streaks get 2.6 %, the lens
  drops 0.33 % (worst case) and the rest is slack. `rain-look.test.ts`
  sweeps every speed, FOV 70–90°, tier and buffer height (down to the phone
  floor) over both layers plus the lens drops. A Monte Carlo projection
  cross-checks the analytic bound for each layer.
- **Thinner and fainter.** The half-width goes 0.02 → 0.013 m. An unlit
  streak adds about 0.09 luminance (it was 0.14).
- **Sparse near the lens:** the near cut moves from 4/8 m to 6/14 m.
- **Each drop its own length,** 0.45–1.55× (mean 1).
- **Depth.** Every 3rd instance is a far drop in a 400 m box (it divides the
  torus), drawn 40–200 m out, 3× longer and 0.45× as bright. It is
  attenuated by the shaped fog and the height haze, never lerped to the fog
  colour. Same draw call.
- **Lit by the city.** A streak near a street-lamp head turns sodium-warm.
  The lamps come from the street contract's stations, the same imports the
  ground reflections use. A streak inside one of the 4 nearest searchlight
  or spot cones takes the beam's colour. The light redistributes the budget:
  a fully lit near streak reaches R3's old 0.14 peak and a lit far streak
  about 0.12, never more.
- **Splashes** on roofs and wet streets are the existing L4 ripple and splash
  dots (`weather.ts` `abWxRippleLayer`). They were already on in rain and are
  unchanged.
- R3's gravity, wind, lean, aim clear and near clear are unchanged.

### Low mist (`fogbanks.ts`)
- **S5 banks sit at 35–80 m** (were 25–115) and get smaller near the ground.
- **They part around the towers.** Each puff shrinks to fit the gap to the
  nearest standing building box (`nearestBoxDistance` − 2 m) and fades out
  once squeezed under half its size. A sprite therefore never reaches a box,
  so there is no hard line where a facade cuts it and no pop: the distance
  is continuous. Felled buildings stop counting (`standingProfile`).
  - Offline, over the whole layout and an hour of drift, 52 % of bank puffs
    keep ≥ half their alpha, at 76 % of their size on average. A plain
    clearance fade kept 16 %.
- **Canyon mist** is new, in the same draw:
  - 120 strands of 6 puffs on the street centre lines at 12–40 m.
  - Each drifts along its street with the along-street share of the shared
    air, and runs straight through the crossings.
  - A puff is never wider than the gap between the facades. The module
    checks this against the street contract's `LOT_LINE` at load, so canyon
    mist needs no clearance test.
- **Layered and lit from below.** Sheets flatten side-on (×0.5–0.6) and stay
  round seen from above. A sodium underglow sits on their lower half.
- **Brightness:** about 0.3 luminance at night, hard-capped at 0.4 so a
  lightning flash (which lifts the fog colour they are built from) never
  makes them a bloom source.
- Fogged by the L1 seam, as before (`#include <fog_fragment>`). Identical on
  every quality tier: mist can hide a plane, so it is not dressing.

### Steam (`steam.ts`)
- **Roof plumes are white, big and tall:** a 20 m rise, 2× the puff size and
  0.42 opacity. They come from 45 % of roofs up to 160 m (were 25 % up to
  90 m), with 6 vents per block (was 5).
- They read from up to 300–460 m of camera height (`steamRoofGate`); street
  vents keep the street life's micro gate.
- **They drift with the wind.** A puff is carried by `airDrift(now) −
  airDrift(its birth)`, the integrated shared air, so a plume bends and a
  veer never swings it whole. A street vent's plume drifts only along its
  street. Still a pure function of (vent, puff, time).
  - The renderer memoises each puff's birth drift for its life, which takes
    it from 2 `airDrift` calls per puff per frame to about 3 per frame.
    `steam.test.ts` pins memo == pure.
- **Per-puff alpha and tint** use three's rgba vertex colours. Alpha fades
  in over the first 12 % of a life and out from 60 %; the old shrink trick is
  gone. Puffs are sodium-warm low over the street and moon-white aloft.
- **Soft, with no hard intersections.** There is no depth texture, so the
  soft-particle fade is analytic:
  - a clearance fade, so a puff is gone before its sprite could reach a
    building box (`clearanceAgainst`, each vent's neighbours cached);
  - a lift, so the sprite never dips into the surface it rises from;
  - a near-camera fade;
  - a screen-edge fade, so a big point never pops when its centre is culled;
  - sprites capped at 0.35 × their view distance.
- Still one pooled `THREE.Points` draw.

### Wet look (`weather.ts`)
- The VO5/L4 wet streets and roofs already carried the reflections of lamps
  and signs.
- L5 makes the reflections in standing water shimmer. Two travelling waves,
  phase-warped by static world noise, modulate the lamp and neon reflections
  ±25 % on the ground (±20 % on the roof-puddle smears).
- Their periods (2 s and 3 s) divide the 600 s ripple-clock wrap, which
  module load checks, so the shimmer is seamless.
- The shimmer is world-anchored, so a frozen world is a still image. It
  fades over 15–90 m and stays under the ground luma cap.

## Draw calls and budget

**0 new draw calls.** The far rain, the canyon mist and the shimmer all live
inside existing draws (the rain's instanced streaks, the S5 fog-bank quads,
the ground and building materials). Steam is still one pooled `THREE.Points`
draw.

The one visible change in counts is at altitude. Above 140 m the steam used
to be gated off entirely, and its draw now stays on to 460 m for the roof
plumes: +1 draw in those views, inside the +2 budget.

`node tools/perf/run.mjs --runs 3 --res 0.75 --ab-ref 7061222 --segments
core,street,canyon` gives **draws 99 → 99, 100 → 100, 101 → 101 (Δ 0)**.
The fragment proxy is identical (518 400 px × 3.166). Late compiles: 0.
First-sight GL allocations: 0.

Phone: `--device phone --cpu-throttle 4 --segments core,street` gives draws
99 → 99, 101 → 101 (Δ 0) and the same proxy. Every segment completed, with
0 late compiles.

The quality tiers only change counts (`rainDensity` also thins the far
curtain, `steamDensity`), so a tier switch compiles nothing. Mist and fog
banks are identical on every tier.

**CPU work added per frame**, read from `__ab.perf()` in the shots:
- clearance box tests: 4–6.6 k (mist + steam), against a ceiling of 20 k;
- `airDrift` calls: about 3 (memoised).

**Bank survival** (`__ab.perf().mist`): 31–65 % of the in-range S5 bank puffs
keep ≥ half their alpha across the shots (target ≥ 15 %). Canyon mist is
never parted (it lives inside the canyon), with 270–365 puffs in range.

**Frame times are not measurable on this box.** The machine ran at load
average 60–150 from other sessions throughout. The harness flags it itself
(GPU p50 spread 152 %, "the machine was busy"), and its determinism check
fails on timing in both arms, while draw calls are identical per segment.
GPU and wall deltas from these runs mean nothing. They need an `--ab-ref`
run on a quiet GPU (the M3).

## Flicker (`tools/perf/flicker.mjs --grid`, ref `7061222`)

**Clear and dry** (the default; `--repeat 3`) is no worse anywhere. The run
was cut by my 150-minute timeout (exit 124) two views into the ref's third
repeat, so the tool never printed its own verdict table. These are the
recorded frozen scores, HEAD vs ref:

| view | ref | HEAD |
|---|---|---|
| chase-rooftops | 0.026 | 0.030 / 0.031 / 0.030 |
| chase-canyon | 0.362–0.364 | 0.364–0.366 |
| high-overview | 0.056–0.057 | 0.057 |
| street-low | 0.057 | 0.057 |
| rooftop-skim | 0.025 | 0.027 |
| puddle-street | 0.269 | 0.269 |
| moon | 0.132–0.133 | 0.134 |

Every view is inside the tool's own "not worse" band, max(ref × 1.05,
ref + 0.01). `hot` is unchanged: 0.05–0.56 % on both builds.

**Downpour** (`FLICKER_WEATHER=downpour`, `--repeat 1`). The rain now
shimmers **4–6× less** than main's:

| view | ref | HEAD | hot ref → HEAD |
|---|---|---|---|
| chase-rooftops | 0.375 | 0.067 | 1.06 % → 0.15 % |
| chase-canyon | 0.633 | 0.363 | 1.03 % → 0.21 % |
| high-overview | 0.494 | 0.088 | 1.51 % → 0.21 % |
| street-low | 0.347 | 0.083 | 0.89 % → 0.11 % |
| rooftop-skim | 0.324 | 0.059 | 0.88 % → 0.09 % |
| puddle-street | 0.470 | 0.236 | 1.16 % → 0.55 % |

The tool still prints `0/6 views pass — FAIL` and exits 1. That is O5's
absolute grid rule (halve every view over 0.01, none over 0.041), which a
rain view cannot meet: falling rain is real animation. Main fails the same
rule by more. Measured against main, every view is better.

## Black boxes (`tools/perf/blackbox.mjs`, desktop)

**Non-finite pixels: 0 in every frame of every path on this branch**:
core, sky, canyon, street (downpour) and sidewalk, at night and dusk, with
the positive control passing. That was one full pass plus part of a second;
the box cut the run short with my own 90-minute timeout, exit 124.

The first pass found 1 NaN frame (1 px) on `core`. The one NaN-capable line
I had added, the mist billboard's view-direction `normalize`, was then
guarded (`7034169`), and every later pass is 0.

The image half of the detector flagged transient dark-cell "boxes" with no
non-finite pixel behind any of them:
- this branch: 18 over 12 path runs (street 2, sidewalk 6 + 3, dusk core 7);
- **main under the same load:** 11 over its `core`/`street`/`sidewalk` run,
  0 non-finite (exit 1), plus 9 on dusk `core` alone in another run.

So the tool's "0 boxes" bar is not met on either build here.

These are cells of frames the SwiftShader process dropped at load 120–150,
not render faults. The same machine also returned a few fully black
screenshots from both builds (a paired main/branch run lost `mist-canyon` on
both), which were re-shot.

## Not measured here
- **The lit-rain luminance probe** (lamp-crop minus unlit-crop lift, with
  and without rain) could not be made deterministic on this box.
  `pinWorld` steps the sim by the real frame time, so the two frames of a
  pair differ by moving traffic and lights. That swamps a rain lift of 1–2
  luma units at 2.6 % coverage, so no number is claimed. Lit streaks are
  visible near lamps and in the beams in the shots.
- **Puddle shimmer is motion.** A still shows the wet look, not the shimmer.
