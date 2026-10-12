# The sky meets the fog, and the fog hides the wrap

**The sites that must agree:**

- the **linear fog** every fogged material gets: `fog_fragment`, patched in
  `client/src/render/fog.ts`, computes `abFogFactor(fogNear, fogFar, d)`;
- every **custom shader that fogs itself**: the searchlight beams
  (`searchlights.ts`), the headlight cones (`headlights.ts`), the far rain
  curtain (`rain.ts`'s far layer, L5: attenuated by `abFogFactor` and the
  height haze in its vertex shader, `fog: true` only to be fed the
  uniforms), and L2's far skyline (`far-skyline.ts`);
- the **city glow** (`fog.ts` `CITY_GLOW`, L2): a warm term added to the
  fog colour per view direction, `abGlowFog(fogColor, sinEl)`;
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
4. **The fog colour is per RAY, not per frame (L2).** Every site that draws
   the fog colour adds the same city glow, `CITY_GLOW.rgb ·
   cityGlowProfile(sinEl)`, with sinEl the sine of the view ray's elevation:
   - the fog chunk (`abFogC`, all fogged materials; none under the street);
   - the dome, on both sides of the stop, so below it the dome is still
     exactly the fog colour along that ray;
   - the far skyline's fade target.
   The glow is elevation-only by design, because the fog chunk only knows
   the ray's height. Its only writer is `storm.atmosphere()`, and it is 0
   inside the deck and in dust. A custom shader that mixes toward
   `fogColor` itself must mix toward `abGlowFog(fogColor, sinEl)` instead,
   or a fogged object shows as a darker shape against the glowing horizon.

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

**For a new far-field shader:** include `AB_FOG_GLSL` and take
`fogColor` / `fogNear` / `fogFar` from three's `UniformsLib.fog` (a
`ShaderMaterial` with `fog: true` is fed them live). Then call
`abFogFactor`, `abHazeAmount` and `abGlowFog`. Do not keep a second copy of
the fog state.

**The far skyline (L2) is drawn in a shell just INSIDE the fog limit.**
- Its vertices move along their own view rays to a compressed radial
  distance in [792, 799.5) m (`farShellDistance`). The screen position stays
  exact and the depth order monotonic.
- Everything real at or past 800 m is exactly the fog colour (torus images
  that switch included) and always loses the depth test to it, so no wrap
  can ever show against the far city.
- Real geometry at 792–800 m is ≥ 99.8 % fogged, so its order against the
  shell cannot be seen.
- It is placed at an unwrapped offset like the clouds (`CloudOffset` with a
  64 km period, a whole number of torus widths). It stays congruent to the
  canonical position, so the far street grid and river continue the real
  ones.
- It fades so nothing pops: fog-coloured at its inner edge, then sunk to
  zero height before it reaches the fog limit.
- Moving the shell outside 800 m, or past the camera's far plane (900 m),
  breaks this.

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
