# Interpolated inputs to a `sin()` hash

**The edit that looks right:** pass a per-instance constant (a building
seed, `float(gl_InstanceID)`, a face's side) to the fragment shader as an
ordinary `varying` and hash it there with the usual
`fract(sin(dot(p, …)) * 43758.5453)`.

**Why it is wrong:** interpolating a value that is the same at every vertex
is not bit-exact — the barycentric weights do not sum to exactly 1 — so at
some pixels it arrives one ulp off. Inside a `sin()` whose argument is
1e4–1e6, one ulp is a different hash: every per-cell decision keyed on it
(lit window, blinds, tone, a passenger in a seat) becomes a per-pixel random
pick. It is invisible with the camera perfectly still and re-rolls under ANY
change of projection, so in flight it sparkles over every surface that uses
it. O6 found it on every facade (`vBSeed`) and in the T2 train's windows
(`vTrainId`, and the interpolated normal used as the side); L13 had already
met it once (`vPitchSeed`).

**Do instead:** declare such varyings `flat` (`flat varying float vSeed;` —
three.js maps it to `flat out`/`flat in` on WebGL2), and hash discrete
inputs (`floor`ed cells, an exact ±1 side), never a raw interpolated value.

**The same family:** one huge triangle carrying a world coordinate. The
ground was two triangles 1.8 km across; interpolating `vWorldXZ` over them
(clipped hard by the near plane) shifted the street paint a fraction of a
pixel every time the plane re-centred under the camera. Tessellate
(the ground is 64×64 now) so no triangle spans the view.

**How to catch it:** a frozen-camera flicker capture cannot — the image is
stable while still. `node tools/perf/flicker.mjs --grid --breathe` moves the
view by ~0.005° a frame; anything that re-rolls shows up as jitter, and
`--ablate all` names the system (`tools/perf/README.md`, O6).
