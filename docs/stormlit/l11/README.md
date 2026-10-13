# L11 Stormlit: neonized New York architecture

Each sheet is `origin/main` before L11 (`8a53dce`, with H1, L2 and L7b; left)
beside this branch merged with it (right),
same view, same build settings. All shots are 1280×720 on SwiftShader (a
GPU-less Linux box at load ~65), quality High, render scale 0.75, deep night,
clear weather, taken with a scratch variant of `tools/perf/gallery.mjs` that
also reads the `?nanprobe` counters (`__ab.nanProbe()`) once a few fresh
frames have landed. Colours are right; frame rates on this box are not
representative.

| sheet | view | what to look at |
|---|---|---|
| `facade-prewar.jpg` | prewar brick tower (54, 534.5), 119 m | Recessed 2-over-2 sashes with shaded reveals, stone sills and lintels, soot under some sills, the rusticated base over the shops, arched crown-floor windows, the cornice ledge. |
| `facade-deco.jpg` | Art Deco tower (144.5, 677.5), 95 m | Window strips between proud piers, dark recessed spandrels (chevrons up close). |
| `facade-castiron.jpg` | cast-iron loft (37.5, 900), 48 m | Tall segmental-arched loft windows between painted columns, entablature at every floor. |
| `facade-brownstone.jpg` | brownstone row (130.5, 958), 21 m | Stoops and front doors with lit fanlights in every third bay, 6-over-6 windows under heavy hoods, no shopfront signs or awnings. |
| `facade-glass.jpg` | modern glass tower (54, 454.5), 143 m | Mullion grid with caps, dark slab spandrels, reflective glass. |
| `neon-plaza.jpg` | plaza (4,4) street wall at its screen | The neon layer at its densest: S2 signs and screens, tower outlines, neon window signs. |
| `neon-street-night.jpg` | the x = 1000 avenue at eye level | Storefronts with neon window signs, marquees, the deep upper windows. |

## The New York mix (seed 42, after H1)

`facadeStyleFor` over the 523 buildings: prewar 182, mid-century office 137,
modern glass 79, cast-iron loft 65, Art Deco 35, brownstone 14, mid-century
glass box 11. Brownstones are masonry under 32 m (4–6 floors); H1 lifted most
low lots above that, so there are fewer of them than before H1 (36).

## Flicker (main vs branch, same box, same session)

`node tools/perf/flicker.mjs --grid --repeat 3 --no-build --ref e1e4482
--only street-low,chase-rooftops,chase-canyon,sidewalk-closeup,facade-prewar,neon-street-night`
on SwiftShader, measured on this branch before the H1/L2/L7b merge so the
A/B isolates L11. Every pass of each arm was identical (deterministic), so
the spread is ~0. Frozen mean |Δluma| (hot / jitter alike):

| view | main | L11 |
|---|---|---|
| chase-rooftops | 0.031 | 0.029 |
| chase-canyon | 0.365 | 0.362 |
| street-low | 0.057 | 0.053 |
| sidewalk-closeup | 0.238 | 0.241 |
| facade-prewar | 0.411 | 0.402 |
| neon-street-night | 0.515 | 0.523 |

All within the tool's own TOLERANCE (5 % / 0.01). The tool prints FAIL for
every view on BOTH builds: its absolute gate (halve anything over 0.01, none
over 0.041) is the M3's O-series bar and SwiftShader at 640×360 cannot meet
it. A first run had `sidewalk-closeup` at 0.334: `--ablate` put all of it on
`signage` — dropping the brownstones' signs had re-rolled S2's per-sign
animation stream (tickers, chases, broken neon) for the whole city. The
renderer now animates the full S2 layout and drops the brownstone signs
after, so every other sign keeps the animation it had (0.241).

## NaN / black boxes

- `tools/perf/blackbox.mjs --device desktop --sky night --paths
  core,canyon,sidewalk,street,glass,plaza --frames 40`: 0 frames with a
  non-finite pixel on main (`e1e4482`), on this branch, and on this branch
  merged with H1/L2/L7b. The image heuristic's "boxes" are on the downpour
  `street` path (and one `sidewalk`): 3 on main and 3 on the branch before
  the merge.
- The `?nanprobe` captures above: 0 NaN/Inf in every view on the branch
  except one transient 613-pixel frame in `facade-deco` that did not
  reproduce in three re-probes of the same view; `origin/main`'s capture had
  the same kind of transient (1309 px in `facade-brownstone`). Negative
  (finite) channels, which the probe reports but never fails, are present on
  main too in the same views.

## Perf

L11 adds no draw call: the facade is still the one city mesh, cornices ride
the L13 facade-detail mesh, subway entrances the G1 furniture rig, neon
window signs the facade shader. The GPU cost of the bigger facade shader
needs the M3 (`node tools/perf/run.mjs --runs 3 --ab-ref <main>`); SwiftShader
frame times say nothing about it.

