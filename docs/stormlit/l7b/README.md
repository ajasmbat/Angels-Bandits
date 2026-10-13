# L7b: the inferno and the storm sky (before, after, reference)

Each sheet is **before (main `7061222`) | after (L7b) | the matching
reference**. `reference-hero` and `reference-inferno` were re-shot after
merging main's L2 (the far skyline) and L5 (mist and rain); the after panel
is labelled to say so. Both builds were shot at the same pose, using the new gallery
views (tools-side) on main's own build. The reference is:

- reference 1 (*Stormlit Manhattan*) for the calm views: `reference-hero`,
  `high-overview`, `chase-rooftops` and `street-low`;
- reference 2 (*Apocalyptic City Under Fire*) for the burning ones.

| sheet | what it shows |
| --- | --- |
| `reference-hero.jpg` | The references' composition, re-aimed over the city toward the horizon. The moon and the moonlit cloud deck with silver rims are now in frame, and the zeppelin is side-on. |
| `reference-inferno.jpg` | The same pose with 116 buildings chewed and burn 0.9. It shows a sea of fire on both banks, black columns leaning downwind into an ember sky, and the moon above. |
| `high-overview-inferno.jpg` | high-overview's pose over a burning district: the columns from the standard overview. |
| `inferno-sky.jpg` | Looking up at the deck over the burning blocks: the cloud base glows red and the columns climb into it. |
| `inferno-gutted.jpg` | A gutted tower close up: ember-orange corners and floor slabs, rooms ablaze on most floors, embers in the air. |
| `inferno-dogfight.jpg` | Readability: the chase camera over the fires, with a bandit ahead and the guns firing. |
| `high-overview.jpg`, `chase-rooftops.jpg`, `street-low.jpg` | The standard views at burn 0. The inferno draws nothing; the deck's ceiling sheet no longer lays a fogged lid over the sky. |

## Fire cover

`node tools/perf/fire-cover.mjs --hud [--horizon 326] <png>` counts the pixels
that are red-orange (hue ≤ 25°), saturated and bright. The thresholds are
fixed in the script. The city's sodium light (hue 20–35°) and the hazy air
don't pass.

| image | fire, whole frame | below the horizon |
| --- | --- | --- |
| reference 2 | 24.7 % | |
| reference 1 | 3.9 % | |
| main, `reference-inferno` | 1.3 % | 1.5 % |
| **L7b, `reference-inferno`** (before merging L2/L5) | **21.2 %** (20.7–22.9 % over four captures) | **33.0 %** |
| **L7b merged with L2 + L5, `reference-inferno`** | **29.2 %** | **43.2 %** |
| main, `inferno-gutted` | 6.4 % | |
| L7b, `inferno-gutted` | 34.5 % | |
| main / L7b, `reference-hero` (burn 0) | 1.3 % / 1.3 % | |

The ticket estimated reference 2 at ~40 % by eye. With a mask that leaves out
city light, reference 2 measures 24.7 %.

After merging L2 (the far skyline), part of the count is L2's own burning far
city, whose ember-lit districts sit on the horizon band. This ticket's fire
alone measured 21.2 %. When the burn fog was brighter, it stacked with L2's
horizon glow and pushed the haze over the mask's value cut. L7b therefore
keeps the burn fog dark, and the haze measures ≈ sRGB 0.3, so the air itself
never counts as fire.

`__ab.inferno()` on `reference-inferno` reported: 2591 live sites, 209 flames
drawn (627 cards), 18 columns, 116 gutted, and `floating: 0` (no drawn fire
over anything that no longer stands).

**Readability (`inferno-dogfight`).** The 99th-percentile fire pixel has a
luma of 149. The brightest non-fire pixel in the gun/pipper area is 253.
The flames peak on the `EMISSIVE_FIRE` rung, under the tracers.

## Draw calls (same pose, main → L7b)

| view | main | L7b |
| --- | --- | --- |
| `reference-inferno` | 106 | 105 |
| `inferno-dogfight` | 117 | 118 |
| `inferno-gutted` | 98 | 100 |
| `high-overview-inferno` | 96 | 96 |
| `inferno-sky` | 96 | 96 |
| `high-overview` | 94 | 94 |
| `street-low` | 102 | 102 |
| `reference-hero` | 100 | 99 |
| `chase-rooftops` | 93 | 95 |

L7b adds no draw. The rubble flames share the flame draw, and the camera's
embers share the air draw. The ±2 jitter appears in the calm views too: the
pinned world still advances by each frame's sim step, so traffic and movers
differ between captures.

## How they were captured

- The box is GPU-less Linux with SwiftShader, at render scale 0.75 and the
  High tier.
- Every view is pinned to one world instant.
- The server ran with `AB_QUIET_CITY=1` and with `LIVENESS_TIMEOUT_MS` /
  `?silence=` raised.
- The gallery now re-picks a view's weather after it pins the world clock.
  Before, `clear` was chosen against the live clock, so the pinned views were
  shot in rain.
