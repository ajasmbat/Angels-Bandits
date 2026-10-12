# L7 Inferno — before / after / reference

Each sheet is **before (main) | after (L7) | the matching reference**.
`reference-hero`, `reference-inferno` and `inferno-gutted` were re-shot after
L1 (the storm sky, grade and fog) landed: main `9e73a56` against this branch
merged onto it. The rest are from before that merge (main `56f6197`). The
reference is reference 1 (*Stormlit Manhattan*) for `reference-hero` and
reference 2 (*Apocalyptic City Under Fire*) for everything else.

| sheet | what it shows |
| --- | --- |
| `reference-hero.jpg` | the references' composition, the city at peace (burn 0): unchanged by L7 |
| `reference-inferno.jpg` | the same pose with the blocks on both banks chewed (`__ab.qaDestruction`, 44 buildings) and burn 0.9: flames on the floors and windows of the wreckage, black columns leaning downwind, gutted towers |
| `inferno-gutted.jpg` | a building a third gone, up close: a charred shell, fire floor by floor behind its windows, ember-edged frames, firelight pooled on the street |
| `inferno-chewed.jpg` | D8's chewed block at burn 0.9: roaring roof fires, smoke, embers |
| `inferno-sky.jpg` | looking up over the burning blocks: the cloud deck's puffs glowing ember-red, the haze gone smoky, the moon dimmed |
| `high-overview.jpg`, `chase-rooftops.jpg`, `street-low.jpg`, `boss-closeup.jpg` | the standard views, calm (burn 0): no inferno draw, no tint |
| `phone-mobile-reference-inferno.jpg` | `reference-inferno` on the phone profile at the Mobile tier (fewer flames and columns, bigger puffs) |

## How they were captured

GPU-less Linux box, SwiftShader, render scale 0.75, every view pinned to one
world instant (`__ab.pinWorld(1 790 000 000 000)`), clear weather, the plane
held at its pose each frame, main and this branch shot with the same tool
in the same session. The server ran with
`AB_QUIET_CITY=1` and raised `LIVENESS_TIMEOUT_MS` / `?silence=` — at
0.3–0.5 fps a slow page is otherwise dropped and its resume's welcome wipes
the staged destruction mid-capture. On this box the carrier's staging
crashes the renderer in the reference composition, so the zeppelin is left
out of these shots (the gallery view keeps it for a real GPU).

`__ab.inferno()` for each burning view reported `floating: 0` (no drawn fire
site over what stands — the D8 check) and, for `reference-inferno`, 558 live
sites, 72 drawn, 14 columns, 6 firelights, 43 gutted buildings.

## Burn 0 is the old city

At burn 0 the inferno draws nothing and every term it adds is gated to zero:
the calm views drew the same number of calls on both builds, and with a fixed
QA camera the mean luma and chroma of L7's frame sat inside the spread
between two captures of main (e.g. `reference-hero` Y 65.253 between main's
65.249 and 65.258). A per-pixel diff is not a usable bar on this box: two
captures of main alone differ in 0.8–9 % of pixels (the pinned world advances
by each frame's own sim step, so traffic and living windows land at
slightly different instants).
