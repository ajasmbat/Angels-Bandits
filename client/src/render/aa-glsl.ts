// O1: the anti-aliasing helpers every procedural pattern shares.
//
// A hard `step()` on a repeating pattern is a point sample: once a pixel
// spans a window, a joint or a road stripe, which side of the edge it lands
// on changes every frame the camera moves, and the pattern sparkles. These
// helpers filter with `aa`, the pattern's metres per pixel from `fwidth()`,
// so edges are one pixel soft and sub-pixel patterns resolve to their mean.
//
// `fwidth()` itself is NOT in here: derivatives are undefined in non-uniform
// control flow, so every caller takes them once at the top of its main body
// and passes the result down into its branches.

/** GLSL: `abLine`, `abBox`, `abDetail`, `abEdge`, `abPeriodic`. */
export const AB_AA_GLSL = /* glsl */ `
// Coverage of a line of half-width w at distance d, with aa = meters per
// pixel. Once the line is thinner than a pixel it stays one pixel wide and
// its intensity scales by w / aa, so it fades with distance instead of
// shimmering — and never exceeds 1 (the LED ladder argument).
float abLine(float d, float w, float aa) {
  float a = max(aa, 1e-4);
  float wd = max(w, a);
  return (1.0 - smoothstep(wd - a * 0.5, wd + a * 0.5, d)) * min(1.0, w / a);
}
// Anti-aliased box of half-size h around the origin.
float abBox(vec2 p, vec2 h, float aa) {
  vec2 d = abs(p) - h;
  float b = max(aa, 1e-4);
  return (1.0 - smoothstep(-b, b, d.x)) * (1.0 - smoothstep(-b, b, d.y));
}
// 1 while a pattern of this period (m) is well resolved, fading to 0 once a
// pixel spans about half of it — patterns fall back to their mean albedo.
float abDetail(float period, float aa) {
  return 1.0 - smoothstep(0.25 * period, 0.5 * period, aa);
}
// Filtered step(edge, x): one pixel wide, so a long edge does not crawl.
float abEdge(float edge, float x, float aa) {
  float h = max(aa, 1e-4) * 0.5;
  return smoothstep(edge - h, edge + h, x);
}
// Distance from v to the nearest centre of a pattern repeating every
// period with a centre at centre — the d that abLine wants.
float abPeriodic(float v, float centre, float period) {
  return abs(mod(v - centre + 0.5 * period, period) - 0.5 * period);
}
`;
