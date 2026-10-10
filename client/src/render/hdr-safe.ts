// O7: the post chain's belt and braces against black boxes. One non-finite
// texel in the HDR scene is all a black box takes: the bloom's bright pass
// keeps it, every blur tap that touches it turns NaN, each mip spreads it
// further, and the tone map writes it as black — a blocky square that grows
// with the mip level. And it takes only one value over float16's 65504 to
// make one: the scene target is RGBA16F on every device, so that value is
// STORED as +Inf, and ACES maps Inf to Inf/Inf = NaN.
//
// Every source O7 found is fixed where it starts (tools/perf/README.md "O7");
// this is the guard that keeps the next one a single pixel instead of a box.
// Every pass that reads the scene — the bloom's bright pass, the shafts'
// march, FinalPass — reads it through `abFinite`, so nothing downstream ever
// sees a non-finite value, and nothing can overflow a half-float target:
//
//   NaN           → 0
//   +Inf, ≥ max   → HDR_MAX
//   −Inf, < 0     → 0
//
// The test is on the float BITS, never `isnan()` / `x != x`, which a
// driver's fast-math may fold away. GLSL ES 3.00 only (ShaderMaterial, or a
// RawShaderMaterial built with `glslVersion: GLSL3`).

/**
 * The brightest linear HDR value any pass passes on. Far above anything the
 * scene legitimately draws (the emissive ladder tops out in the tens; ACES
 * is white long before), and low enough that the bloom chain's largest gain
 * — the composite's strength × Σ mip factors, 0.4 × 3.0 = 1.2 — keeps every
 * bloom target at ≤ 1.2 × HDR_MAX = 19661, under float16's 65504.
 */
export const HDR_MAX = 16384;

/** `vec3 abFinite(vec3)`: see the header. */
export const FINITE_GLSL = /* glsl */ `
vec3 abFinite(vec3 c) {
  // NaN: exponent all ones, mantissa non-zero (mix with a bvec selects).
  c = mix(c, vec3(0.0),
    greaterThan(floatBitsToUint(c) & uvec3(0x7fffffffu), uvec3(0x7f800000u)));
  // ±Inf and everything finite: min(max(Inf, 0), MAX) = MAX; -Inf → 0.
  return clamp(c, 0.0, ${HDR_MAX.toFixed(1)});
}
`;
