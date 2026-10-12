# L1 Stormlit: storm sky, grade and fog, before and after

Each sheet has three columns: the matching crop of a reference render, main
before L1 (`0ef18bb`), and this branch. Everything was shot with
`tools/perf/gallery.mjs` (plus a scratch capture for the sky-facing views and
a pinned lightning strike) at 1280×720. The renderer was SwiftShader on a
GPU-less Linux box, so colours are right but the frame rate is not
representative.

Weather is live in the gallery unless pinned. The `high-overview` pair was
shot in rain in both builds. The `street-low` "after" was taken during a
downpour flash (the pale air).

| sheet | what to look at |
|---|---|
| `01-high-overview.jpg` | The palette changes from lilac haze to steel-blue air with amber street lights. The fog stays thin near the camera, so the city reads much further out. |
| `02-chase-rooftops.jpg` | The far skyline is visible as silhouettes through blue-grey haze, where before a uniform violet wall hid it. |
| `03-street-low.jpg` | Warm street light. The pooled height haze lies low between the buildings. |
| `04-sky-moon.jpg` | New view: the moon breaks through a noise-edged gap in moonlit cloud, and stars show only in the gaps. |
| `05-lightning.jpg` | New view, pinned strike: lightning lights the cloud deck from inside. Before, a violet bolt stood in a flat sky. |
| `06-plane-side.jpg` | Readability: plane-to-sky luminance contrast goes from 3.40:1 to 4.76:1. |
| `07-moon.jpg` | The gallery's moon view. |
| `08-night-dusk-predawn.jpg`, `09-predawn-canyon.jpg` | All three sky-cycle keys after the retune. None of them is lilac any more. |
| `10-new-views.jpg` | A low moon over the skyline, and the Mobile tier (same cloud coverage; a live strike landed mid-shot). |

## Pixel probes (scratch scripts, not committed tests)

**Plane-vs-sky contrast.** WCAG-style luminance ratio between the red
airframe and the sky beside it. The pass condition is at least main's value.

| view | before | after |
|---|---|---|
| `plane-side` | 3.40 | 4.76 |
| `high-overview` | 3.26 | 4.25 |

**The fog stop during a flash.** The pinned-strike frame's luminance down a
column through `SKY_FOG_STOP` (row ≈ 396) is flat: 73–80 across rows
330–470, within the film grain. There is no seam.

**Night horizon (= fog colour).** `0x232c3c` has hue 222° and linear
luminance 0.0248, inside the planned band of 205–225° and 0.012–0.030.

**Fog curve.** `fogFactor(400 m) = 0.067`, `fogFactor(600 m) = 0.549`,
`fogFactor(800 m) = 1`. Inside cloud and dust it goes back to the plain
smoothstep.

## Performance (SwiftShader, load average 130–150 from other tickets)

Command: `node tools/perf/run.mjs --runs 3 --res 0.75 --ab-ref 0ef18bb --segments core,sky`

**Frame times are not measurable on this box.** With 2–4 frames per window,
the harness's own determinism check fails. An earlier 4-segment run lost a
page join to a 180 s timeout. No timing claim is made here; it has to be
re-measured on a GPU (`--ab-ref` on the M3).

These numbers do not depend on frame timing, and they hold:

- **Draw calls are identical:** `core` 96 → 96 and `sky` 80 → 80. The
  clouds are drawn in the existing dome shader, so they add 0 draws against
  a budget of +2.
- **The fragment proxy is identical:** 518 400 px × 3.166 passes in both
  builds. No full-screen pass was added; the grade is retuned inside the
  fused final pass.
- **Late compiles: 0, and first-sight allocations: 0.** The tier switch
  changes uniforms only.

The cloud cost is per sky pixel above the fog stop: 9 gradient-noise calls
on High and Medium, 8 on Low, 6 on Mobile, and 0 in the fog band. `?clouds=0`
switches them off for a paired A/B on real hardware.

## Flicker

**The default gate passes.** `node tools/perf/flicker.mjs --ref 0ef18bb`
gives frozen 0.091 on main and **0.021** on this branch.

**The `--grid --breathe` run is mixed**, on the sky/city views:

| view | main | this branch |
|---|---|---|
| chase-rooftops | 0.149 | 0.176 |
| high-overview | 0.072 | 0.098 |
| plane-side | 0.124 | 0.150 |
| moon | 0.087 | 0.128 |
| sky-night-city | 0.201 | 0.242 |

Main also fails all five on the grid's absolute O5 thresholds.

`--ablate` shows where the difference comes from:

- **Not the new sky.** The dome's share is unchanged: moon 0.011 → 0.010,
  high-overview 0 → 0.
- **The sweeping searchlight beams over the darker sky:** moon
  0.036 → 0.058, high-overview 0.029 → 0.034.

This is animation that already existed. The stronger, tighter bloom and the
deeper S-curve, which the ticket asks for, raise its frame-to-frame contrast.
It is not new shimmer. See the PR for the variant run that isolates the
grade and bloom.
