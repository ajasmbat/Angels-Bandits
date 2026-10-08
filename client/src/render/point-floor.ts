// O5: the point-light size floor. Every glowing point the city draws as a
// GL point (MoverLights — aviation lights, helicopter and blimp lights,
// drones —, plane nav lights, rooftop string lights, airliners, stars)
// goes through this one rule:
//
//  - It is never DRAWN smaller than POINT_FLOOR_PX drawing-buffer pixels.
//    A GL point under ~2 px covers one pixel, then two, then one as it
//    slides a fraction of a pixel — a light that pops between pixels as the
//    camera moves, and under bloom (threshold 0.72) a blob that jumps with
//    it. That is the shimmer O5 hunts.
//  - Its alpha pays for the floor: between 1 px and the floor the light
//    keeps the energy it really has (alpha = (px / floor)²), so a far light
//    does not grow brighter by being drawn bigger.
//  - Below 1 px it fades out linearly — a light a third of a pixel across
//    is a third as bright, instead of a whole saturated pixel that blinks.
//
// The sizes involved are the shader's own: `gl_PointSize` after three's
// size attenuation, in drawing-buffer pixels — what the rasteriser sees, so
// it holds at every pixel ratio and resolution rung.
//
// Every point material here blends with SRC_ALPHA (additive is
// SRC_ALPHA, ONE in three), so scaling alpha scales the light.

/** Smallest drawn point size, drawing-buffer pixels. */
export const POINT_FLOOR_PX = 2;

/**
 * Alpha multiplier for a point whose true (attenuated) size is `px`
 * drawing-buffer pixels, drawn at max(px, floorPx): 1 at or above the
 * floor, the true-to-drawn area ratio from 1 px up to it, and that times
 * `px` (fading to 0) below 1 px. Continuous and non-decreasing in `px`.
 * The GLSL below is this function, line for line.
 */
export function pointFloorAlpha(
  px: number,
  floorPx: number = POINT_FLOOR_PX,
): number {
  if (!(px > 0)) return 0;
  if (px >= floorPx) return 1;
  const k = Math.max(px, 1) / floorPx;
  return k * k * Math.min(px, 1);
}

const glsl = (n: number) => n.toFixed(4);

/**
 * Patch a PointsMaterial's shader (inside onBeforeCompile) with the floor:
 * after three's size attenuation (at `#include <logdepthbuf_vertex>`) the
 * size is floored and the fade handed to the fragment, which multiplies it
 * into `diffuseColor.a` once the vertex colour is in. Call it after any
 * other `gl_PointSize` patch, so it floors the final size.
 */
export function applyPointFloor(
  shader: { vertexShader: string; fragmentShader: string },
  floorPx: number = POINT_FLOOR_PX,
): void {
  const f = glsl(floorPx);
  shader.vertexShader = shader.vertexShader
    .replace("void main() {", "varying float vPointFloor;\nvoid main() {")
    .replace(
      "#include <logdepthbuf_vertex>",
      /* glsl */ `{
\tfloat abFloorPx = gl_PointSize;
\tfloat abFloorK = max(abFloorPx, 1.0) / ${f};
\tvPointFloor = abFloorPx >= ${f} ? 1.0 : abFloorK * abFloorK * clamp(abFloorPx, 0.0, 1.0);
\tgl_PointSize = max(abFloorPx, ${f});
}
#include <logdepthbuf_vertex>`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace("void main() {", "varying float vPointFloor;\nvoid main() {")
    .replace(
      "#include <color_fragment>",
      "#include <color_fragment>\n\tdiffuseColor.a *= vPointFloor;",
    );
}
