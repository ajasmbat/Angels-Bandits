# D11: collapses you can read from 600 m (before / after)

Every sheet here is shot on this GPU-less Linux box (SwiftShader, High tier,
render scale 0.75), the server quiet (`AB_QUIET_CITY=1`, no carrier waves),
the world clock pinned. **Before** is main (`981fba4` for the time-lapses,
`bb3a5bd` for the gallery) plus only the two QA hooks the tools need
(`__ab.qaFrameClock`, a QA camera's `fov`), so both sides are shot
identically. Particles age on a virtual 30 fps frame clock, so a 1 fps
rasteriser shows what a GPU does. The time-lapse sheets put before and
after side by side at each instant.

| sheet | what it shows |
| --- | --- |
| `pancake-timelapse.jpg` | The planner's pancake: building 166 (305 m) from 460 m off and 200 m up, before and 1.5–25 s after it lets go. |
| `topple-timelapse.jpg` | Building 247 (312 m) toppling east, from 600 m. |
| `chain-timelapse.jpg` | Tower-on-tower: building 157 (294 m) felled west into building 110. |
| `gallery-collapse.jpg` | The re-targeted collapse and ruin gallery views, before and after. |
| `gallery-destruction.jpg` | The chewed facades, the glass curtain wall, the bridge, the street. |

## What was wrong, and why

| view / symptom | cause | fix |
| --- | --- | --- |
| Pancake "just shrinks" | The demolition pancake fails at the base (12 m), so the whole tower sinks as one block. Every debris piece was drawn chipped from t0, which made it a ragged stump. The dust was small and dim enough to vanish at 460 m. | The block stays whole until it breaks (`CUT_INTACT`). Dust plumes boil out of the foot and climb as the tower sinks, and a curtain pours down its faces. Bursts fire where each piece lands. |
| Topple "flat grey screen" | The live director felled towers near the plane during the run (no `AB_QUIET_CITY`). Dust haze at 1.0 closed the fog to 4–140 m and mixed it to one grey. | Quiet city in every tool. Haze capped at 0.6, fog never closer than 20 / 280 m, dust colour mix ≤ 0.45. |
| Topple "fragments vanish" | They landed behind foreground towers. Nothing marked the landing. | A 600 m case that sees the fall line. Plumes and settling chunks mark where debris lands. |
| `ruin-detail` white-out | Dust stacked in front of a QA eye: the near fade and haze measured from the parked plane, not the eye. Lit puffs had no colour ceiling. | Dust measures from the camera that renders. Colour is clamped to 0.6 linear (under the 0.72 bloom threshold) before bloom. A 70 % frame-coverage budget applies. |
| `collapse-pancake-mid`, `-topple-impact`, `-dust-street`, `ruin-felled`, `ruin-pancake` show intact towers | H1's core towers block the old eyes. Staging was also relative to a wall clock that ran on for tens of seconds during the settle loop. | Re-posed with clear sight lines (`destruction-views.test.mjs`). Pinned to one instant (`timeMs`) with a `phase`. |
| `destruction-chewed` black / orange squares | Exposed storeys were a near-black room with a flat ember in 14 % of cells, seen at a grazing angle. | Thick lit slab edges, rooms behind them, dangling rebar, charred rims. Looked at head-on. |
| `destruction-bridge` "dark box" | The fallen span lay in the water, seen side-on from the promenade. | Seen from above the gap. |
| Planes dying "600 m away" | The topple model threw a tower's top storeys up to ~2× its height (≈ 600 m for a 305 m tower), far outside the strip the director warns about. The gallery's deaths were the live director's chains hitting a plane left to fly between pins. | `COLLAPSE_TOPPLE_DRIFT` 0.45 (`COLLAPSE_MODEL` 12): the farthest chunk lands ≈ 1 h out. `common/test/collapse-reach.test.ts`. The gallery holds its plane and runs a quiet city. |
| `destruction-glass` hard black mass over the sky (before and after G7) | Not smoke: bisected with `__ab.qaHide`, it is the **T2 elevated train**. Its loop turns at (x 600, z 200), 27 m up, and the view's street-level eye sat 15 m under it, so a passing car's underside filled the upper-left (unpinned, so only some shots). The inferno smoke *did* have the bug suspected: it clamped a near puff to 0.9× its distance before its near fade, leaving it ~97 % opaque, near-black and hard-rimmed. | View re-posed off the line and pinned. The committed check holds every pinned destruction view ≥ 30 m from the trains and ≥ 6 m from its own debris. Smoke: the near fade uses the true size (gone at 0.6×, full at 2×), the edge is soft to 0 with the core ≤ 0.85, the albedo is sooty rather than black, and the columns are held under 50 % of the frame (`client/test/collapse-coverage.test.ts`). |
| NaN pixels on every collapse (O7) | Rebar ribbons (four corners on one unit-box point) gave the facade AA `smoothstep(0, 0, x)`. Under the flame cap the inferno computed `∞ − ∞` as every flame's alpha. | Facade varyings from the displaced vertex. No cap fade under the cap. |

The gutted-building shading (inferno-shading.ts `GUTTED_*`) is G7's, not
this ticket's.

## Measured (time-lapse JSON, per frame)

| | pancake 460 m | topple 600 m | tower-on-tower |
| --- | --- | --- | --- |
| largest falling piece, 1.5–6.5 s (≥ 12 px) | 20 px | 14–15 px | 19–23 px |
| collapse particles in view, 1.5–6.5 s (≥ 150) | 464–1345 | 267–1357 | 275–1406 |
| dust's share of the frame (≤ 0.70) | ≤ 0.15 | ≤ 0.12 | ≤ 0.18 |
| clipped pixels (≤ 0.5 %) | 0 % | 0 % | 0 % |
| luma spread vs its before frame (≥ 0.6×) | ≥ 0.99× | ≥ 0.99× | ≥ 0.99× |
| NaN pixels (main → D11) | 33 → 0 | 413 → 0 | 586 → 0 |
| draw calls (main → D11) | 95–97 → 96–97 | 96–98 → 97–98 | 95–97 → 96–97 |
| plane deaths | none | none | none |

Resting pieces never drop between captures (D10 rubble rests for good). The
settled ring fills to its 320 fragments by the landing and holds them for
20 s.

**Perf** (`run.mjs --runs 3 --segments collapse,ruins,chaos --ab-ref
origin/main`, SwiftShader, load average 60–100). Draw calls, ref → D11:
`collapse` 110 → 110, `ruins` 164 → 141, `chaos` 136 → 134. The harness's
own pinning checks failed in both arms under that load (fake-pilot rooms
never emptied, the staged chaos did not hold, determinism FAIL), so its GPU
and wall numbers are not evidence either way. Measure them on the M3. The
O7 black-box detector (`blackbox.mjs`) was not run here. The NaN probe it
uses read 0 in every D11 time-lapse frame on every case.

**Known limit.** At 600 m a topple's and a chain's dust reads during the fall
but is faint once the debris lands behind foreground blocks. The pancake's
cloud is clear at 460 m. DL1 (Destruction Lab, live tuning) is the place to
push it further.
