# R1 — a realistic, endless far city

Before (top: `main`) / after (bottom: this branch), SwiftShader, gallery
`AB_GALLERY_QUALITY=high`, deep night, clear. Looks and frame cost are
confirmed on the M3; these are for composition.

| view | what it shows |
| --- | --- |
| [`skyline-far.png`](skyline-far.png) | the user's framing: a 380 m rooftop eye looking north across the city to the far skyline |
| [`skyline-far-zoom.png`](skyline-far-zoom.png) | the far band of the same shot, 2× nearest-neighbour: the orange checker "static" against lit floor lines |
| [`skyline-horizon-low.png`](skyline-horizon-low.png) | 60 m over the river, a 40° lens on the horizon |
| [`reference-wide.png`](reference-wide.png) | L2's long view east down the river — the far field the user called "red gold orange" |

## What changed

- **Prefiltering.** `abCellDetail` (`client/src/render/aa-glsl.ts`) now
  resolves every per-cell decision to its expected value by ~3 px (full
  detail from ~6 px; it used to hold detail down to ~1.5 px). The far
  towers take an anisotropic `fwidth(vFacade)` footprint, and their windows
  are a tower → 3-storey band → storey → window hierarchy, each level shown
  only where it is ≥ ~6 px on its own axis, so a band reads as a
  box-filtered line of lit floors and nothing under ~3 px ever switches.
  The carpet's street lines are an exact box filter.
- **Variety.** Each far tower burns one colour temperature (tungsten,
  warm-white LED, cool LED, blue-teal office), the odd tower is dark,
  floors grade up or down; streets are sodium or LED; tall towers carry a
  mast with a blinking red aviation beacon (world clock, three phase
  groups); crowns are warm or cool floodlit, a few neon. A small share of
  far towers and blocks burns whatever the room's burn (the Infinite War).
- **Air.** Silhouettes layer dark blue → grey-blue with depth before the
  haze; far lights dim and pale; the light-pollution colour
  (`storm.ts CITY_GLOW_COLOR`) is a less saturated sodium/LED mix at the
  same L9 peak, so the horizon and the cloud deck over the city stop
  reading orange.

- **Depth in the far shell.** The shell holds ~200 depth steps for
  0.8–5 km, so a far tower is about one step deep. The lattice is now
  drawn far to near (three's LessEqual keeps the nearer tower on a tie), a
  lower part's roof is a ring round the part above (no hidden floor behind
  its faces — the seam that crawled along every setback, on main too), and
  each far tower gets a one-pixel silhouette AA. A tower's own colour,
  occupancy, bands and neon converge on the city's mean by 2.4 km, as the
  air would merge them, so the depth ties that remain do not show.

No new draws: the far skyline is still its two meshes (`__ab.perf()`
draw calls equal main's in every view below).

## Far-field flicker (`flicker.mjs --far`, SwiftShader, res 2)

The camera slides 0.5 m a frame with the world frozen and everything but
the far skyline and the sky hidden; `flicker` is the mean |Δ²luma| inside
the view's far rect (a steady sub-pixel slide cancels; switching does not).

| view | main (be8ce88) | R1 | drop |
| --- | --- | --- | --- |
| `skyline-horizon-low` | 4.256 | 0.779 | **81.7 %** |
| `skyline-far` | 2.069 | 1.288 | 37.7 % |

`skyline-far`'s rect is the whole far band from a 380 m eye: hundreds of
towers a few pixels across, whose remaining flicker is geometric (box edges
stepping, no MSAA) and depth ties at 2+ km — present on main too, and only
shrunk, not removed, by the work above. The window sparkle itself (the
orange checker) is gone in both views.
