// The sky's fog band and the colour fog fades toward — one seam shared by
// the dome (sky.ts) and every fogged material (fog.ts), split out of sky.ts
// so the fog chunks can read it without an import cycle.
//
// H1 (taller skyline): below SKY_FOG_STOP the dome IS the fog colour, so a
// fully fogged surface there can never be told from the sky behind it. The
// supertalls now reach CITY_TOP (480 m): seen from the street at the fog
// limit their crowns stand ~37° up, far above the 18° stop — and the stop
// cannot rise that far without burying the moon (MOON_EL_LOW 0.365 rad).
// So above the stop the fog no longer fades toward the flat horizon colour
// but toward the dome's own gradient at the fragment's elevation, through
// the same SkyAir map (`skyFogTarget`): a fully fogged spire takes exactly
// the dome's colour behind it, whatever its height. Only the dome's extras
// (moon halo, dusk/dawn glows, clouds), which ramp in from zero above the
// stop, can still outline one — as they would a real far tower; the torus
// flip (≥ WORLD_SIZE/2) stays past the camera's far plane either way.

/** Canvas fraction at which the gradient becomes the fog colour for good.
 * 0.5 is the horizon; 0.4 is 18° above it. Below it the dome is the fog
 * colour; above it fog fades toward the dome's gradient (skyFogTarget), so
 * a fully fogged tower can never be told apart from the sky behind it at
 * any height (the torus occlusion guarantee; pinned in
 * client/test/sky.test.ts). */
export const SKY_FOG_STOP = 0.4;

/** Vertical gradient stops, as polar-angle fractions (0 zenith, 0.5 the
 * horizon): the last is SKY_FOG_STOP, from which the sky IS the fog colour. */
export const SKY_STOPS = [0, 0.14, 0.25, 0.32, 0.37, SKY_FOG_STOP] as const;
/** Elevation (rad) above SKY_FOG_STOP over which the moon halo and the
 * dawn/dusk dome glows ramp in from exactly zero — nothing additive may
 * touch the fog-coloured band (a fogged tower would show against it). */
export const SKY_GLOW_RAMP = 0.06;
/** Elevation of SKY_FOG_STOP, rad. */
export const SKY_FOG_ELEVATION = (0.5 - SKY_FOG_STOP) * Math.PI;

/**
 * H1: the dome's gradient stops (sRGB, 3 floats each, zenith → horizon) as
 * ONE shared uniform value — three's cloneUniforms copies typed arrays by
 * reference, so every fogged program reads this array (fog.ts installs it)
 * and the sky writes it once a frame (Sky.setCycle).
 */
export const SKY_FOG_STOPS = new Float32Array(SKY_STOPS.length * 3);
/**
 * H1: the dome's air map, shared the same way (Sky.setAir writes it):
 * [add.r, add.g, add.b, scale, gain, on, 0, 0]. `on` stays 0 until a sky
 * has written it, so a scene without one (tests, tools) fogs to the plain
 * fog colour exactly as before.
 */
export const SKY_FOG_AIR = new Float32Array([0, 0, 0, 1, 1, 0, 0, 0]);

const f5 = (v: number): string => v.toFixed(5);

/**
 * GLSL: `abSkyFog(fogColor, sinEl)` — what a fully fogged fragment whose
 * view ray climbs at elevation asin(sinEl) takes: the fog colour below the
 * stop, the dome's gradient through the air map above it, blended over
 * SKY_GLOW_RAMP exactly as the dome blends it (sky.ts skyPatch).
 */
export const AB_SKY_FOG_GLSL = /* glsl */ `
uniform vec3 abSkyStops[${SKY_STOPS.length}];
uniform vec4 abSkyAir[2];
vec3 abSkyFog(vec3 fogCol, float sinEl) {
  if (abSkyAir[1].y < 0.5) return fogCol;
  float el = asin(clamp(sinEl, -1.0, 1.0));
  float above = smoothstep(${f5(SKY_FOG_ELEVATION)}, ${f5(SKY_FOG_ELEVATION + SKY_GLOW_RAMP)}, el);
  if (above <= 0.0) return fogCol;
  float f = 0.5 - el / PI;
  vec3 c = abSkyStops[0];
${SKY_STOPS.slice(1)
  .map(
    (f, i) =>
      `  c = mix(c, abSkyStops[${i + 1}], clamp((f - ${f5(SKY_STOPS[i] as number)}) / ${f5(f - (SKY_STOPS[i] as number))}, 0.0, 1.0));`,
  )
  .join("\n")}
  vec3 sky = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  vec3 air = (sky * abSkyAir[0].w + abSkyAir[0].xyz) * (1.0 + (abSkyAir[1].x - 1.0) * above);
  return mix(fogCol, air, above);
}
`;

/** TS mirror of abSkyFog's blend: how much of the dome's gradient (vs the
 * flat fog colour) a fully fogged fragment at elevation `el` (rad) takes. */
export function skyFogAbove(el: number): number {
  const t = Math.min(1, Math.max(0, (el - SKY_FOG_ELEVATION) / SKY_GLOW_RAMP));
  return t * t * (3 - 2 * t);
}
