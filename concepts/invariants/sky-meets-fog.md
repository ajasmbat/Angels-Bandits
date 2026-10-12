# The sky meets the fog, and the fog hides the wrap

**The sites that must agree:**

- the **linear fog** every fogged material gets: `fog_fragment`, patched in
  `client/src/render/fog.ts`, computes `abFogFactor(fogNear, fogFar, d)`;
- every **custom shader that fogs itself**: the searchlight beams
  (`searchlights.ts`), the headlight cones (`headlights.ts`), the far rain
  curtain (`rain.ts`'s far layer, L5: attenuated by `abFogFactor` and the
  height haze in its vertex shader, `fog: true` only to be fed the
  uniforms), and anything later that draws far away (L2's skyline);
- the **sky dome** (`sky.ts` `skyPatch`) below and just above
  `SKY_FOG_STOP`;
- the **sky-matched fog colour** (`sky-fog.ts` `AB_SKY_FOG_GLSL`, read by
  `fog_fragment`): above the stop, what a fogged surface fades toward;
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
2. **Below `SKY_FOG_STOP` the dome IS this frame's fog colour; above it, a
   fogged surface fades toward the dome's own gradient.** A fully fogged
   landmark must not show against the sky (pinned in
   `client/test/sky.test.ts`). H1's supertalls reach `CITY_TOP` (480 m):
   at the fog limit a crown stands up to asin(480/800) ≈ 37° up, far above
   the 18° stop, and the stop cannot rise that far without burying the
   moon (`MOON_EL_LOW`). So `fog_fragment` mixes toward `abSkyFog(fogColor,
   sinEl)`: the fog colour below the stop, and above it the dome's gradient
   at the fragment's elevation through the same air map, blended over
   `SKY_GLOW_RAMP` exactly as the dome blends (`SKY_FOG_STOPS` and
   `SKY_FOG_AIR` are shared uniform arrays the sky writes each frame; `on`
   stays 0 without a sky, which is the old flat fog). The dome's extras —
   moon halo, dusk/dawn glows, clouds — are not in it, so a crown fully
   fogged 800–900 m away can still outline against a cloud, as a real far
   tower does; the torus flip (horizontal ≥ 1000 m) is past the camera's
   far plane (`FOG_DISTANCE` + 100) and the dome writes no depth, so the
   wrap itself never shows. `atmosphere()` builds the fog colour as one
   affine map of the clear-sky base, `fog = base · scale + add`, folding
   the rain dim, the in-cloud soup, the flash stain and the D3 dust in
   order (`SkyAir`). The dome:
   - draws the live fog colour below the stop;
   - puts its gradient through the same map above the stop, so the two
     meet exactly at every moment, mid-flash and in dust included;
   - ramps the flash's extra gain, the moon halo, the dusk/dawn glows and
     the clouds in from zero over `SKY_GLOW_RAMP` / `CLOUD_FADE` above the
     stop.
3. **Additive things fade by attenuation, never by lerping to the fog
   colour.** They multiply by `(1 − abFogFactor) · (1 − haze)` (the V1
   lesson: a lerp brightens the distance).

4. **The cloud deck fogs as if it were 150 m lower** (H1, `storm.ts`
   `DECK_FOG_LIFT`, the `AB_FOG_LIFT` define in `fog_fragment`): the deck
   rose from 500 m to 650 m over the supertalls, and plain radial fog would
   swallow it from the street. The lift is capped so the deck is still
   fully fogged where the far plane cuts it (from the street, 622 m out:
   √(622² + 500²) ≈ 798 m).

**What breaks when they disagree:**

- A beam that still uses a plain `smoothstep` glows on at mid-range while
  the buildings behind it have already dissolved.
- A dome tint that is not the fog's map shows a seam at 18° for every
  lightning flash.
- A fog colour that is flat above the stop shows every tall tower at the
  fog limit as a pale cut-out against the darker sky.
- A shape that does not reach 1 at `fogFar` shows the torus wrap as a
  tower popping in at the screen edge.

**For a new far-field shader (L2):** include `AB_FOG_GLSL` and take
`fogColor` / `fogNear` / `fogFar` from three's `UniformsLib.fog` (a
`ShaderMaterial` with `fog: true` is fed them live). Then call
`abFogFactor` and `abHazeAmount`. Do not keep a second copy of the fog
state.

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
