# The sky meets the fog, and the fog hides the wrap

**The sites that must agree:**

- the **linear fog** every fogged material gets: `fog_fragment`, patched in
  `client/src/render/fog.ts`, computes `abFogFactor(fogNear, fogFar, d)`;
- every **custom shader that fogs itself**: the searchlight beams
  (`searchlights.ts`), the headlight cones (`headlights.ts`), and anything
  later that draws far away (L2's skyline);
- the **sky dome** (`sky.ts` `skyPatch`) below and just above
  `SKY_FOG_STOP`;
- the **fog colour writer**: `StormRenderer.atmosphere()` in `storm.ts`,
  the only place the fog colour, near and far are set each frame.

**The contract:**

1. **The fog is complete at `fogFar`.** `abFogFactor` is
   `smoothstep(near, far, d)` raised to `FOG_SHAPE` (L1: 2, so the
   mid-distance stays open and a skyline reads at 600 m). It is exactly 1 at
   `fogFar = FOG_DISTANCE` (800 m < half the 2 km torus) whatever the
   shape, so two images of one tower are never visible. `abWeather.y`
   flattens the shape back to the plain smoothstep inside the cloud deck,
   in dust, and partly in rain. 0 means the clear curve, so a program that
   lacks the uniform still gets a valid one. The TS mirror is
   `fogFactor()`.
2. **Below `SKY_FOG_STOP` the dome IS this frame's fog colour.** A fully
   fogged landmark must not show against the sky (pinned in
   `client/test/sky.test.ts`). `atmosphere()` builds the fog colour as one
   affine map of the clear-sky base, `fog = base · scale + add`, folding
   the rain dim, the in-cloud soup, the flash stain and the D3 dust in
   order (`SkyAir`). The dome:
   - draws the live fog colour below the stop;
   - puts its gradient through the same map above the stop, so the two
     meet exactly at every moment, mid-flash and in dust included;
   - ramps the flash's extra gain, the moon halo, the dusk/dawn glows,
     the burning city's glow (`uBurnGlow`, L7b) and the clouds in from
     zero over `SKY_GLOW_RAMP` / `CLOUD_FADE` (≈ 5° since L7b) above the
     stop;
   - thins the burn's smoke tint high up (L7b): the burn is the map's
     LAST lerp (`SkyAir.burn` / `burnTint`), so the dome can undo part of
     it, but only from `SKY_GLOW_RAMP` above the stop. Below that it is
     the full map, so the seam is still exact.
3. **Additive things fade by attenuation, never by lerping to the fog
   colour.** They multiply by `(1 − abFogFactor) · (1 − haze)` (the V1
   lesson: a lerp brightens the distance).

**What breaks when they disagree:**

- A beam that still uses a plain `smoothstep` glows on at mid-range while
  the buildings behind it have already dissolved.
- A dome tint that is not the fog's map shows a seam at 18° for every
  lightning flash.
- A shape that does not reach 1 at `fogFar` shows the torus wrap as a
  tower popping in at the screen edge.

**For a new far-field shader (L2):** include `AB_FOG_GLSL` and take
`fogColor` / `fogNear` / `fogFar` from three's `UniformsLib.fog` (a
`ShaderMaterial` with `fog: true` is fed them live). Then call
`abFogFactor` and `abHazeAmount`. Do not keep a second copy of the fog
state.

**The dome is centred on the rendered camera.** That is the chase
camera, or under `__ab.qaCamera` the QA eye's image, as with the river.
Centred on a plane parked hundreds of metres away, the moon and the
clouds slide by parallax.

**The cloud deck's ceiling sheet (`storm.ts` CloudDeck) thins with
distance** (L7b, `CEILING_NEAR`–`CEILING_FAR`). Seen edge-on and fogged,
it would otherwise lay a flat lid over the dome's clouds above ~16°.

**The storm sky's clouds (`sky-clouds.ts`) are part of the same seam:**

- They fade to zero at the stop.
- They are sampled at an unwrapped camera offset (`CloudOffset`), never the
  canonical position. Noise that is periodic in the 2 km world repeats
  visibly along a ray, and the canonical position jumps at the seam.
- The offset resets on a cut (an implied speed over `CUT_SPEED`), so a
  view's clouds depend only on where the camera is. That keeps gallery
  before/after pairs and flicker captures comparable.
- The stars and airliner lights read the same `abCloudCover`, with the
  same uniform objects, so they only show in the gaps.
