// L2 "Stormlit" far skyline: kilometres of city past the fog limit — a lit
// street carpet with the river's waterfronts and bridge light chains, and
// instanced towers with Art Deco setbacks and a few tall spires — so a long
// view reads near blocks → mid city → far skyline → glowing horizon, like
// the reference. Two draws, purely far-field: nothing here is solid.
//
// THE SHELL. The real city is fully fogged at FOG_DISTANCE (800 m, the
// torus contract) and the camera's far plane is 900 m. The far city lives
// 0.8–5 km out, so the vertex shader draws every vertex along its OWN view
// ray at a compressed radial distance in [SHELL_NEAR, SHELL_NEAR +
// SHELL_DEPTH) — just inside the fog limit (farShellDistance). The screen
// position is exact and the depth order is monotonic, and everything real
// at 800 m or more (exactly the fog colour, torus images that switch
// included) always loses the depth test to it: no wrap can ever show
// against the far city. Real geometry at 792–800 m is ≥ 99.8 % fogged, so
// its order against the shell cannot be seen.
//
// THE LATTICE. Each 100 m world cell's tower depends only on the cell, so
// the CPU works it out once, when the cell enters a toroidal window of
// N × N instance slots round the camera (FarSkyline.step: one row per cell
// crossed); the vertex shader only reads it.
//
// WORLD-ANCHORED, SEAM-FREE. Everything is placed in an unwrapped camera
// offset (sky-clouds CloudOffset) kept mod FAR_PERIOD, a whole number of
// torus widths and of every cell size here: it never jumps at the seam,
// resets on a cut (a gallery view depends only on where the camera is) and
// stays congruent to the canonical position mod WORLD_SIZE, so the far
// street grid and the river row continue the real ones.
//
// FADES, so nothing pops (all radial distances from the eye):
//   towers  colour → fog over FADE_IN, then SINK to zero height over SINK
//           while already fog-coloured, gone before the fog limit;
//   spires  the same, further out (SPIRE_FADE / SPIRE_SINK), so a landmark
//           recedes into the fog and is never reached;
//   carpet  fog-coloured at 800 m, in over CARPET_FADE;
//   far     abFarVis(): haze, and exactly the fog colour by R − 100 (the
//           tier's R_out; a tower centred past R is dropped, already
//           fog-coloured), so there is no ring edge;
//   weather nothing inside the deck or dust, thinner in rain.
// The fog colour it fades to is the glow-aware one (fog.ts abGlowFog), the
// same the fog chunk and the dome reach, so the inner edge meets the
// fogged real city exactly. The band between the real city's fog and the
// far city's fade-in reads as a low mist bank — deliberate.

import {
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
  RIVER_ROW,
} from "@angels-bandits/common/city/river";
import { LOT_LINE } from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  FOG_DISTANCE,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import * as THREE from "three";
import { AB_AA_GLSL } from "./aa-glsl";
import { AB_FOG_GLSL } from "./fog";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";
import { CloudOffset } from "./sky-clouds";

/** The unwrapped offset's period, m: 32 torus widths — a whole number of
 * tower cells (100 m), blocks (200 m) and super-cells (1600 m). */
export const FAR_PERIOD = 32 * WORLD_SIZE;
/** Tower lattice cell, m: half a block. */
export const FAR_CELL = BLOCK_PITCH / 2;
/** Spire super-cell, m: at most one landmark spire in each. */
export const FAR_SUPER = 8 * BLOCK_PITCH;
/** The shell: compressed radial distances [NEAR, NEAR + DEPTH), m. */
export const SHELL_NEAR = FOG_DISTANCE - 8;
export const SHELL_DEPTH = 7.5;
/** True distance past FOG_DISTANCE at which the shell is half used, m. */
const SHELL_KNEE = 2000;
/** Largest R_out on any tier, m (the carpet and slot lists are built to it). */
export const FAR_MAX_RADIUS = 5000;
/** Towers: colour → fog over [a, b] (b nearer), sink to 0 over [b, c]. */
export const FADE_IN = [1250, 950] as const;
export const SINK = [950, 820] as const;
export const SPIRE_FADE = [2600, 2000] as const;
export const SPIRE_SINK = [2000, 1800] as const;
/** Carpet: fog-coloured at the fog limit, in by the second distance. */
export const CARPET_FADE = [FOG_DISTANCE, 1250] as const;
/** Share of the spire super-cells that hold a spire. */
const SPIRE_SHARE = 0.55;
/** The river's block row, as a GLSL-comparable index (canonical rows mod
 * WORLD_SIZE / BLOCK_PITCH). */
const RIVER_ROW_INDEX = RIVER_ROW;
/** Peak share of the far city's own colour over the fog, and its haze
 * length, m: `FAR_VIS · exp(−(D − 800) / FAR_HAZE)`. */
export const FAR_VIS = 0.7;
export const FAR_HAZE = 4000;

/**
 * Where the shell draws something whose true radial distance is `d`, m —
 * the TS mirror of `abFarShell`. Strictly increasing past FOG_DISTANCE and
 * always under SHELL_NEAR + SHELL_DEPTH (< FOG_DISTANCE).
 */
export function farShellDistance(d: number): number {
  const x = Math.max(d - FOG_DISTANCE, 0);
  return SHELL_NEAR + (SHELL_DEPTH * x) / (x + SHELL_KNEE);
}

// Colours (sRGB) and peak linear luminances — every one under the 0.72
// bloom threshold before the far fade even applies (≤ FAR_VIS of it shows).
/** R1: a real night city is not one sodium orange. Each tower's offices
 * burn one of these (shares in WINDOW_SHARES), all at the same peak
 * luminance, so any mix of them stays on the WINDOW rung. */
export const WINDOW_PALETTE = {
  tungsten: 0xffc27a, // warm incandescent flats
  warmWhite: 0xffe4c0, // warm-white LED
  led: 0xe6eeff, // cool LED white
  office: 0xa6dff0, // blue-teal office fluorescents
} as const;
/** Cumulative shares of WINDOW_PALETTE, in its order (the last is 1). */
export const WINDOW_SHARES = [0.3, 0.55, 0.82, 1] as const;
const WINDOW_PEAK = 0.66;
/** A tower this often is dark: empty, or bombed out of power. */
export const DARK_TOWER_SHARE = 0.14;
/** The window grid: a bay by a storey, m. */
const WIN_CELL = [3, 3.6] as const;
/** Storeys per floor band (the band's lit share is one decision). */
const BAND_STOREYS = 3;
/** Street lighting: old sodium and new LED white, per street. */
const STREET_COLOR = 0xffa040;
const STREET_LED = 0xdde6ff;
const STREET_SODIUM_SHARE = 0.55;
const STREET_PEAK = 0.24;
const LAMP_COLOR = 0xffd9a8;
const LAMP_PEAK = 0.45;
const CROWN_COLOR = 0xffdcae;
const CROWN_COOL = 0xdde8ff;
const CROWN_PEAK = 0.66;
/** R1: the odd tower's neon crown — a coloured line round its roof edge. */
const NEON_COLORS = [0xff3ad0, 0x30e8ff, 0x58ff8e, 0xff4a5a] as const;
const NEON_PEAK = 0.55;
export const NEON_SHARE = 0.1;
const BEACON_COLOR = 0xff2a18;
const BEACON_PEAK = 0.58;
/** Aviation obstruction lights: one flash every BLINK_S, on for its first
 * ~third; three phase groups across the skyline. */
const BLINK_S = 1.6;
/** Towers over this get a mast with a beacon (most of them), m. */
const MAST_MIN_H = 130;
const MAST_SHARE = 0.65;
const EMBER_COLOR = 0xff5a1c;
const EMBER_PEAK = 0.5;
/** R1, the Infinite War: this share of far towers and blocks burns even
 * when the room's city does not (the burn adds the rest). */
export const WAR_FIRE_SHARE = 0.025;
/** Masonry and roofs (sRGB), and the moon's tint on the faces it lights. */
const MASONRY = 0x1d2029;
const ROOF = 0x16181f;
const MOONLIT = 0xbccbe8; // sky.ts DUSK.moon
/** R1 aerial perspective: the silhouettes' depth layers (sRGB) — near dark
 * blue, mid grey-blue — before the haze takes them to the fog colour; and
 * the distance (m) by which a light has dimmed and paled the most. */
const SIL_NEAR = 0x121827;
const SIL_MID = 0x232c3e;
const DEPTH_FAR = 3200;
/** R1: the gain on a tower's window light where its windows are only their
 * mean — a field of sub-pixel lights reads as a glow, not as their
 * average dimmed by the dark wall between them (the cap still holds). */
const FAR_GLOW_GAIN = 1.8;
/** R1: where a far tower's own character (colour, occupancy, tone, neon)
 * converges on the city's mean, m (see `own` in the tower shader), and
 * that mean occupancy (farCellTower's, dark towers included). */
const VARIETY_FADE = [1200, 2400] as const;
const FAR_OCC_MEAN = 0.26;
/** R1: a far roof's light, as a share of its facade's mean window light. */
const ROOF_GLOW = 0.5;

/** Linear rgb at unit luminance × `peak`, as a GLSL vec3 literal. */
function lit(hex: number, peak: number): string {
  const c = new THREE.Color(hex);
  const k = peak / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  return `vec3(${(c.r * k).toFixed(5)}, ${(c.g * k).toFixed(5)}, ${(c.b * k).toFixed(5)})`;
}
/** Linear rgb, as a GLSL vec3 literal. */
function linear(hex: number): string {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;
}
const f = (n: number): string => n.toFixed(2);
/** WINDOW_PALETTE at `peak`, as a GLSL ternary chain on `t` in [0, 1). */
function paletteGlsl(t: string, peak: number): string {
  const cs = Object.values(WINDOW_PALETTE).map((c) => lit(c, peak));
  return `(${t} < ${WINDOW_SHARES[0].toFixed(2)} ? ${cs[0]} : ${t} < ${WINDOW_SHARES[1].toFixed(2)} ? ${cs[1]} : ${t} < ${WINDOW_SHARES[2].toFixed(2)} ? ${cs[2]} : ${cs[3]})`;
}
/** WINDOW_PALETTE's share-weighted mean at `peak` (still at `peak`: luma
 * is linear), as a GLSL vec3 literal. */
function paletteMean(peak: number): string {
  const cols = Object.values(WINDOW_PALETTE).map((c) => {
    const k = new THREE.Color(c);
    const l = 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b;
    return [k.r / l, k.g / l, k.b / l];
  });
  const m = [0, 0, 0];
  let prev = 0;
  cols.forEach((c, i) => {
    const w = (WINDOW_SHARES[i] as number) - prev;
    prev = WINDOW_SHARES[i] as number;
    for (let j = 0; j < 3; j++)
      m[j] = (m[j] as number) + w * (c[j] as number) * peak;
  });
  return `vec3(${m.map((v) => v.toFixed(5)).join(", ")})`;
}

/**
 * The far field's district density, GLSL: `abFarDensity(w)` at a point `w`
 * (m) of the unwrapped plane, 0..1 — dense downtowns, quieter districts and
 * the occasional park. Integer hash, periodic at FAR_PERIOD. The dome
 * includes it too (the cloud bases glow where the city under them is
 * dense), with FAR_ORIGIN as `uFarOrigin`.
 */
export const FAR_DENSITY_GLSL = /* glsl */ `
uniform vec2 uFarOrigin;
uint abFarHash(uvec2 q) {
  q = q * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  n ^= n >> 15u;
  n *= 2246822519u;
  n ^= n >> 13u;
  return n;
}
float abFarRand(vec2 cell, float per) {
  return float(abFarHash(uvec2(mod(cell, per))) & 0xffffu) / 65535.0;
}
float abFarValue(vec2 p, float per) {
  vec2 i = floor(p);
  vec2 t = p - i;
  vec2 u = t * t * (3.0 - 2.0 * t);
  return mix(mix(abFarRand(i, per), abFarRand(i + vec2(1.0, 0.0), per), u.x),
             mix(abFarRand(i + vec2(0.0, 1.0), per), abFarRand(i + vec2(1.0, 1.0), per), u.x), u.y);
}
float abFarDensity(vec2 w) {
  float per = ${f(FAR_PERIOD / FAR_SUPER)};
  float n = 0.62 * abFarValue(w / ${f(FAR_SUPER)}, per)
    + 0.38 * abFarValue(w / ${f(FAR_SUPER / 2)} + vec2(11.0, 5.0), per * 2.0);
  return smoothstep(0.22, 0.78, n);
}
`;

/** The unwrapped camera offset (FAR_DENSITY_GLSL's `uFarOrigin`), shared
 * BY REFERENCE with the dome. FarSkyline.update() is its only writer. */
export const FAR_ORIGIN = { value: new THREE.Vector2() };

/** GLSL: the shell (farShellDistance) — `abFarShell(rel)`, `rel` true and
 * from the eye → where it is drawn. SKY1's cosmetic sky draws in it too. */
export const FAR_SHELL_GLSL = /* glsl */ `
vec3 abFarShell(vec3 rel) {
  float d = length(rel);
  float x = max(d - ${f(FOG_DISTANCE)}, 0.0);
  float s = ${f(SHELL_NEAR)} + ${SHELL_DEPTH.toFixed(3)} * x / (x + ${f(SHELL_KNEE)});
  return rel * (s / max(d, 1.0));
}
`;

/** GLSL shared by both draws: the shell, the far visibility, the uniforms. */
const COMMON_GLSL = /* glsl */ `
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
${AB_FOG_GLSL}
${FAR_DENSITY_GLSL}
uniform float uFarOuter;
uniform float uFarPx;
uniform float uFarTime;
uniform vec3 uFarMoon;
${FAR_SHELL_GLSL}
// How much of the far city's own colour shows over the fog at true radial
// distance d: the haze, the far edge (0 by R − 100) and the weather (none
// in the deck or dust — abWeather.y, the fog closing in — fogFar).
float abFarVis(float d) {
  float v = ${FAR_VIS.toFixed(3)} * exp(-(d - ${f(FOG_DISTANCE)}) / ${f(FAR_HAZE)});
  v *= 1.0 - smoothstep(0.72 * uFarOuter, uFarOuter - 100.0, d);
  v *= (1.0 - clamp(abWeather.y, 0.0, 1.0)) / (1.0 + 0.9 * max(abWeather.x, 0.0));
  return v * smoothstep(${f(0.9 * FOG_DISTANCE)}, ${f(FOG_DISTANCE)}, fogFar);
}
// R1 aerial perspective, 0 at the fog limit → 1 by DEPTH_FAR.
float abFarDepth(float d) {
  return smoothstep(${f(FOG_DISTANCE)}, ${f(DEPTH_FAR)}, d);
}
// The air between: lights dim and pale with depth (so their bloom softens
// with them), on top of the haze abFarVis already lerps to the fog.
vec3 abFarAirLight(vec3 em, float depth) {
  float l = dot(em, vec3(0.2126, 0.7152, 0.0722));
  return mix(em, vec3(l), 0.6 * depth) * (1.0 - 0.5 * depth);
}
// And silhouettes layer: near dark blue, mid grey-blue.
vec3 abFarAirSurface(vec3 col, float depth) {
  return mix(col, mix(${linear(SIL_NEAR)}, ${linear(SIL_MID)}, depth), 0.2 + 0.6 * depth);
}
`;

// --- 1. Towers -----------------------------------------------------------------

/** GLSL: the spire super-cell \`sc\`'s spire — (exists, block x, block z,
 * seed). Mirrored by farSpire() (the lattice keeps a spire's block clear). */
const FAR_SPIRE_GLSL = /* glsl */ `
float abBits(uint h, uint shift) { return float((h >> shift) & 0xffu) / 255.0; }
vec4 abSpire(vec2 sc) {
  uint h = abFarHash(uvec2(mod(sc, ${f(FAR_PERIOD / FAR_SUPER)})) + uvec2(977u, 613u));
  float bx = float((h >> 8u) & 7u);
  float bz = float((h >> 12u) & 7u);
  // Never in the river row (a super-cell's 8 block rows are canonical rows
  // mod 10: 1600 = 8 × 200).
  float row = mod(sc.y * 8.0 + bz, ${f(WORLD_SIZE / BLOCK_PITCH)});
  float has = (abBits(h, 0u) < ${SPIRE_SHARE.toFixed(2)} && abs(row - ${f(RIVER_ROW_INDEX)}) > 0.5) ? 1.0 : 0.0;
  return vec4(has, bx, bz, float(h >> 16u) / 65535.0);
}
`;

const TOWER_VERTEX = /* glsl */ `
${COMMON_GLSL}
attribute float aPart;
// R1: 1 on a roof's inner ring vertex (scaled to the part above's
// footprint — the roof is a ring round it), 0 elsewhere.
attribute float aInner;
// Per instance. A lattice tower (the first N²): its world cell's tower,
// worked out on the CPU (farCellTower) — (centre x/z from the camera
// cell's corner, half sizes) and (height, seed, occupancy, style; style −1:
// none), in DRAW ORDER, far to near (FarSkyline.writeDrawOrder). A spire
// slot (style −2): (super-cell offset x/z from the camera's, −, −).
attribute vec4 aTowerA;
attribute vec4 aTowerB;
uniform vec2 uFarFrac; // the camera cell's corner − the eye, m (x, z)
uniform vec2 uFarSuper; // the camera's spire super-cell
uniform vec2 uFarSuperFrac;
varying vec3 vRel;
varying vec2 vFacade;
varying vec3 vNormal;
flat varying vec4 vInfo; // seed, occupancy, colour fade, part
flat varying vec4 vKind; // style (0 plain, 1 spire, 2 setback), burning, part top y, part height
flat varying float vTop; // the roof (sunk) height, m: where a neon crown runs
// R1 silhouette AA: the fragment's box-local position (x, y, z; m), and the
// part's TRUE extents — half sizes x/z, base and top y (m) — and taper.
varying vec3 vLoc;
flat varying vec4 vHalf;
flat varying float vTaper;
${FAR_SPIRE_GLSL}
void main() {
  vec2 c;     // footprint centre, from the eye (x, z), m
  vec2 hsz;   // footprint half sizes, m
  float H;    // full height, m
  float seed;
  float occ;
  // Part profile: y fractions where parts 0..2 end, their half-size scale,
  // part 2's taper; part 3 is the needle.
  vec3 ends = vec3(1.0);
  vec3 scale = vec3(1.0, 0.0, 0.0);
  float taper2 = 1.0;
  float needle = 0.0; // needle half width, m (0: none)
  float style = 0.0;
  bool alive = true;
  float code = aTowerB.w;
  if (code > -1.5) {
    c = aTowerA.xy + uFarFrac;
    hsz = aTowerA.zw;
    H = aTowerB.x;
    seed = aTowerB.y;
    occ = aTowerB.z;
    alive = code > -0.5;
    // Art Deco setbacks (2) — with a needle (3).
    if (code > 1.5) {
      style = 2.0;
      ends = vec3(0.6, 0.8, code > 2.5 ? 0.93 : 1.0);
      scale = vec3(1.0, 0.74, 0.5);
      needle = code > 2.5 ? 2.0 : 0.0;
    }
  } else {
    vec2 sc = mod(uFarSuper + aTowerA.xy, ${f(FAR_PERIOD / FAR_SUPER)});
    vec4 sp = abSpire(sc);
    alive = sp.x > 0.5;
    c = aTowerA.xy * ${f(FAR_SUPER)} + uFarSuperFrac + sp.yz * ${f(BLOCK_PITCH)} + ${f(BLOCK_PITCH / 2)};
    hsz = vec2(40.0);
    seed = sp.w;
    H = 290.0 + 170.0 * fract(seed * 7.31);
    occ = 0.32;
    style = 1.0;
    ends = vec3(0.56, 0.72, 0.86);
    scale = vec3(1.0, 0.78, 0.52);
    // Two crowns: stepped (square tiers) or tapering to the needle.
    taper2 = fract(seed * 13.7) < 0.5 ? 1.0 : 0.38;
    needle = 3.5;
  }
  // R1: most tall towers without a needle carry a mast for their aviation
  // beacon (part 3, above the roof; lattice towers only — spires have the
  // needle). Its own hash of the seed, so no other pick correlates with it.
  float mast = 0.0;
  if (code > -1.5 && needle == 0.0 && H > ${f(MAST_MIN_H)}
      && float(abFarHash(uvec2(uint(seed * 65535.0), 41u)) & 0xffffu) / 65535.0 < ${MAST_SHARE.toFixed(2)}) {
    mast = 1.0;
  }
  // Fade and sink by the radial distance to the nearest point of the box.
  float camY = cameraPosition.y;
  float dh = max(length(c) - length(hsz), 0.0);
  float dy = camY > H ? camY - H : (camY < 0.0 ? -camY : 0.0);
  float dn = sqrt(dh * dh + dy * dy);
  bool spire = style > 0.5 && style < 1.5;
  vec2 fadeBand = spire ? vec2(${f(SPIRE_FADE[0])}, ${f(SPIRE_FADE[1])}) : vec2(${f(FADE_IN[0])}, ${f(FADE_IN[1])});
  vec2 sinkBand = spire ? vec2(${f(SPIRE_SINK[0])}, ${f(SPIRE_SINK[1])}) : vec2(${f(SINK[0])}, ${f(SINK[1])});
  float colourIn = smoothstep(fadeBand.y, fadeBand.x, dn);
  float sink = smoothstep(sinkBand.y, sinkBand.x, dn);
  if (sink <= 0.0 || length(c) > uFarOuter) alive = false;
  if (!alive) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // behind the far plane: culled
    return;
  }
  // This vertex's part.
  float y0 = 0.0;
  float y1 = ends.x;
  float s = scale.x;
  float tp = 1.0;
  // The part above's scale (0: none — the roof is whole).
  float sUp = ends.y > ends.x ? scale.y : 0.0;
  if (aPart > 0.5) { y0 = ends.x; y1 = ends.y; s = scale.y; sUp = ends.z > ends.y ? scale.z : 0.0; }
  if (aPart > 1.5) { y0 = ends.y; y1 = ends.z; s = scale.z; tp = taper2; sUp = 0.0; }
  vec2 hp = hsz * s;
  float hgt = H * sink;
  float mastL = 0.0;
  // One pixel here, m.
  float pxm = length(vec3(c, H - camY)) * uFarPx;
  if (aPart > 2.5) {
    y0 = ends.z;
    y1 = 1.0;
    // The needle never thinner than ~1.5 px, so it cannot crawl.
    float wpx = 0.75 * pxm;
    hp = vec2(needle > 0.0 ? max(needle, wpx) : mast * max(0.6, wpx));
    tp = needle > 0.0 ? 0.0 : 1.0;
    // A mast: 12 m over the roof, never shorter than 3 px (its beacon is
    // the top of it, so it cannot drop through a pixel either).
    mastL = mast * max(12.0, 3.0 * pxm) * sink;
  }
  // R1 silhouette AA: a solid part is drawn a pixel larger every way but
  // down; the fragment shader fades that pixel (and the one inside it) to
  // the haze by the true edge's coverage — on silhouette edges only — so a
  // far tower's outline slides instead of stepping a pixel at a time.
  // Only the tower's top part grows upward: a lower part's roof raised a
  // pixel would cover the foot of the part standing on it.
  bool solid = aPart < 2.5 && y1 > y0 && hp.x > 0.0;
  bool top = y1 >= ends.z;
  vHalf = vec4(hp, y0 * hgt, y1 * hgt);
  vTaper = tp;
  vec2 local = position.xz * (hp + (solid ? vec2(pxm) : vec2(0.0))) * mix(1.0, tp, position.y);
  // R1: a lower part's roof is a RING round the part above (its inner
  // vertices at that part's true footprint). A whole roof put a hidden
  // floor right behind the upper part's faces; in the far shell a whole
  // tower is about one depth step deep, so that floor won the depth test
  // along the junction and a dark seam crawled over every setback.
  if (aInner > 0.5) local = position.xz * hsz * sUp;
  float y = mix(y0, y1, position.y) * hgt + position.y * (mastL + (solid && top ? pxm : 0.0));
  vLoc = vec3(local.x, y, local.y);
  vec3 rel3 = vec3(c.x + local.x, y - camY, c.y + local.y);
  vRel = rel3;
  vNormal = normal;
  vFacade = vec2(abs(normal.x) > 0.5 ? local.y : local.x, y);
  vInfo = vec4(seed, occ, colourIn, aPart);
  // The burning city's share, and (R1) the war's own fires on top.
  float burning = fract(seed * 91.7) < ${WAR_FIRE_SHARE.toFixed(3)} + 0.4 * abCityGlow.a ? 1.0 : 0.0;
  vKind = vec4(style, burning, y1 * hgt + mastL, (y1 - y0) * hgt + mastL);
  vTop = ends.z * hgt;
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + abFarShell(rel3), 1.0);
}
`;

const TOWER_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
${AB_AA_GLSL}
varying vec3 vRel;
varying vec2 vFacade;
varying vec3 vNormal;
flat varying vec4 vInfo;
flat varying vec4 vKind;
flat varying float vTop;
varying vec3 vLoc;
flat varying vec4 vHalf;
flat varying float vTaper;
float abFarCell(vec2 cell, float seed) {
  return float(abFarHash(uvec2(ivec2(cell) + 4096) ^ uvec2(uint(seed * 65535.0))) & 0xffffu) / 65535.0;
}
// R1: stream k of a tower's seed, in [0, 1] — one independent pick per k.
float abFarSeed(float seed, uint k) {
  return float(abFarHash(uvec2(uint(seed * 65535.0), k)) & 0xffffu) / 65535.0;
}
// Box-filtered coverage of [lo, hi] in a unit cell at cell coordinate f
// for a footprint of aa cells: exact while aa is under the gaps.
float abFarSpan(float f, float lo, float hi, float aa) {
  float a = max(aa, 1e-4) * 0.5;
  return clamp((min(f + a, hi) - max(f - a, lo)) / (2.0 * a), 0.0, 1.0);
}
// abCellDetail's fade at a cell's own scale: 1 from ~6 px, 0 by ~3 px.
float abFarDetail(float period, float aa) {
  return 1.0 - smoothstep(0.167 * period, 0.333 * period, aa);
}
void main() {
  // R1: the footprint — facade metres per pixel along each facade axis,
  // ANISOTROPIC (a wall seen edge-on is many metres per pixel along its
  // run though the isotropic d · uFarPx is one), at the top level, before
  // any branch. Never under the isotropic footprint, which is its floor.
  float d = length(vRel);
  vec2 fw = max(fwidth(vFacade), vec2(d * uFarPx));
  vec3 lw = max(fwidth(vLoc), vec3(1e-4));
  vec3 dir = vRel / max(d, 1.0);
  vec3 fogC = abGlowFog(fogColor, dir.y);
  vec3 n = normalize(vNormal);
  float seed = vInfo.x;
  float occ = vInfo.y;
  float part = vInfo.w;
  float style = vKind.x;
  float burn = abCityGlow.a;
  float depth = abFarDepth(d);
  // R1: how much of a tower's own character still shows — 1 near, 0 by
  // VARIETY_FADE[1]: past it the towers converge on the city's mean, as
  // the air would merge them. It is also what keeps the shell's depth
  // ties quiet: ~200 depth steps span 0.8–5 km, so two far towers within
  // ~35–70 m of each other can trade pixels as the camera moves, which only
  // shows if they differ.
  float own = 1.0 - smoothstep(${f(VARIETY_FADE[0])}, ${f(VARIETY_FADE[1])}, d);
  bool roof = n.y > 0.5;
  vec3 col = roof ? ${linear(ROOF)} : ${linear(MASONRY)} * (0.75 + 0.5 * mix(0.5, fract(seed * 5.3), own));
  // Moonlight on the faces turned to it, and the glow's bounce.
  col *= 0.3 + 0.55 * max(dot(n, uFarMoon), 0.0) * ${linear(MOONLIT)} + abCityGlow.rgb * 6.0;
  col = abFarAirSurface(col, depth);
  vec3 em = vec3(0.0);
  // The tower's character: one colour temperature, the odd dark (empty)
  // tower (its own picks of the seed).
  float tT = abFarSeed(seed, 2u);
  vec3 wB = mix(${paletteMean(WINDOW_PEAK)}, ${paletteGlsl("tT", WINDOW_PEAK)}, own);
  float occB = mix(${FAR_OCC_MEAN.toFixed(3)}, occ * (abFarSeed(seed, 3u) < ${DARK_TOWER_SHARE.toFixed(2)} ? 0.08 : 1.0), own);
  // R1: a far roof is not black beside its lit floors — rooftop lights and
  // the glow of the floors under it, averaged: ROOF_GLOW of the facade's
  // mean light. It keeps the roof-to-face edge (an inner edge no outline AA
  // reaches) from stepping hard as it slides.
  if (roof && part < 2.5) em += wB * occB * ${(0.385 * 0.8 * ROOF_GLOW).toFixed(4)} * ${FAR_GLOW_GAIN.toFixed(2)};
  if (!roof && part < 2.5) {
    // R1 WINDOWS, a hierarchy as on the near facades: the tower's lit
    // share → a 3-storey band's → a storey's → each bay × storey window,
    // each level shown only where it is ≥ ~6 px on its own axis and its
    // expected value by ~3 px. Nothing smaller than ~3 px ever switches, so
    // a far tower is a steady glow, banded by its floors where they resolve.
    // A vertical gradient (brighter up, or brighter down).
    // The odd floor runs on another temperature (warm ↔ cool).
    vec3 wAlt = tT < ${WINDOW_SHARES[1].toFixed(2)} ? ${lit(WINDOW_PALETTE.led, WINDOW_PEAK)} : ${lit(WINDOW_PALETTE.tungsten, WINDOW_PEAK)};
    float yN = clamp(vFacade.y / max(vTop, 1.0), 0.0, 1.0);
    float grade = 1.0 + (abFarSeed(seed, 4u) - 0.5) * 0.9 * (2.0 * yN - 1.0);
    vec2 g = vFacade / vec2(${f(WIN_CELL[0])}, ${f(WIN_CELL[1])});
    vec2 gi = floor(g);
    vec2 gf = g - gi;
    float band = floor(gi.y / ${f(BAND_STOREYS)});
    float bandH = abFarCell(vec2(977.0, band), seed);
    // A band is dimmer (gone home) now and then, else lit by its own
    // share; normalised so its mean over bands is the tower's (÷ 0.953).
    float bandF = (bandH < 0.1 ? 0.35 : 0.8 + 0.4 * bandH) * ${(1 / 0.953).toFixed(4)};
    float pMean = occB * grade;
    float pBand = min(pMean * bandF, 0.95);
    // Each storey in it its own share around the band's (mean 1), then
    // each window a coin flip at the storey's share.
    float pRow = min(pBand * (0.6 + 0.8 * abFarCell(vec2(613.0, gi.y), seed)), 0.95);
    float winH = abFarCell(gi, seed);
    // (Bands converge with the rest of a far tower's character: own.)
    float bandK = abFarDetail(${f(WIN_CELL[1] * BAND_STOREYS)}, fw.y) * own;
    float rowK = abFarDetail(${f(WIN_CELL[1])}, fw.y);
    float winK = min(abFarDetail(${f(WIN_CELL[0])}, fw.x), rowK);
    float lit = mix(pMean, mix(pBand, mix(pRow, step(winH, pRow), winK), rowK), bandK);
    // The pane in its cell, per axis (mullions and spandrels dark): an
    // exact box filter while the footprint is under the gaps — so rows of
    // lit floors read as lines of light as soon as a storey is ~4 px — and
    // the pane's share on that axis (0.7 across, 0.55 up) once it is not.
    vec2 gaa = fw / vec2(${f(WIN_CELL[0])}, ${f(WIN_CELL[1])});
    vec2 paneK = 1.0 - smoothstep(vec2(0.25), vec2(0.45), gaa);
    float pane = mix(0.7, abFarSpan(gf.x, 0.15, 0.85, gaa.x), paneK.x)
      * mix(0.55, abFarSpan(gf.y, 0.2, 0.75, gaa.y), paneK.y);
    // Before the storeys resolve, each band is a line of light with a dark
    // spandrel under the next (its top quarter): the lines of lit floors a
    // far tower reads as, box-filtered from ~4 px a band, mean-preserving.
    float baa = fw.y / ${f(WIN_CELL[1] * BAND_STOREYS)};
    float bandLineK = (1.0 - smoothstep(0.25, 0.45, baa)) * (1.0 - paneK.y) * own;
    pane *= mix(1.0, abFarSpan(fract(vFacade.y / ${f(WIN_CELL[1] * BAND_STOREYS)}), 0.0, 0.75, baa) / 0.75, bandLineK);
    // Colour: the tower's, an eighth of its bands the other temperature
    // (their mean where a band is small); a brightness spread per window
    // (its mean, 0.8, where a window is).
    float bandT = abFarCell(vec2(331.0, band), seed);
    vec3 wcol = mix(mix(wB, wAlt, 0.12), bandT < 0.12 ? wAlt : wB, bandK);
    wcol = mix(wcol, ${lit(EMBER_COLOR, WINDOW_PEAK)}, 0.6 * burn);
    float bright = mix(0.8 * ${FAR_GLOW_GAIN.toFixed(2)}, 0.6 + 0.4 * fract(winH * 7.0), winK);
    em += wcol * lit * pane * bright;
    // The burning city — and the war's own fires — from inside, floor by
    // floor (their mean where a band is small).
    if (vKind.y > 0.5) {
      float fl = 0.75 + 0.25 * sin(uFarTime * 6.0 + seed * 50.0 + band * 1.7);
      float fire = mix(0.5, step(0.5, fract(bandH * 13.0)), bandK);
      em += ${lit(EMBER_COLOR, EMBER_PEAK)} * fl * fire * max(smoothstep(0.0, 0.6, burn), 0.7);
    }
    // Floodlit crowns on the spires and the odd setback, warm or cool.
    if (part > 1.5 && ((style > 0.5 && style < 1.5) || (style > 1.5 && fract(seed * 3.1) < 0.3))) {
      float up = clamp(1.0 - (vKind.z - vFacade.y) / max(vKind.w, 1.0), 0.0, 1.0);
      vec3 cc = abFarSeed(seed, 5u) < 0.6 ? ${lit(CROWN_COLOR, CROWN_PEAK)} : ${lit(CROWN_COOL, CROWN_PEAK)};
      em += cc * (0.45 + 0.55 * up);
    }
    // R1 neon crowns: the odd tower rings its roof edge with a coloured
    // line 2 m down — a filtered line, never under a pixel wide and dimmer
    // as it gets thinner, so it cannot crawl (abLine).
    float neonH = abFarSeed(seed, 6u);
    if (style < 0.5 || style > 1.5) {
      if (abs(vKind.z - vTop) < 0.5 && neonH < ${NEON_SHARE.toFixed(2)} * own) {
        float k = neonH / ${NEON_SHARE.toFixed(2)};
        vec3 nc = k < 0.25 ? ${lit(NEON_COLORS[0], NEON_PEAK)} : k < 0.5 ? ${lit(NEON_COLORS[1], NEON_PEAK)} : k < 0.75 ? ${lit(NEON_COLORS[2], NEON_PEAK)} : ${lit(NEON_COLORS[3], NEON_PEAK)};
        em += nc * abLine(abs(vTop - 2.0 - vFacade.y), 0.6, fw.y);
      }
    }
  }
  // Aviation beacons on the needle tips and masts (part 3): red, flashing
  // on world time (three phase groups), the top 18 % of the part — never
  // under 2 px of it.
  if (part > 2.5 && vFacade.y > vKind.z - max(0.18 * vKind.w, 2.0 * fw.y)) {
    float ph = fract(uFarTime / ${f(BLINK_S)} + floor(abFarSeed(seed, 7u) * 3.0) / 3.0);
    float on = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.3, 0.4, ph));
    em += ${lit(BEACON_COLOR, BEACON_PEAK)} * (0.1 + 0.9 * on);
  }
  // Never past the bloom threshold where a tower's lights stack (windows,
  // crown, neon, embers): a luminance cap under 0.72 before the far fade.
  em *= min(1.0, 0.7 / max(dot(em, vec3(0.2126, 0.7152, 0.0722)), 1e-4));
  em = abFarAirLight(em, depth);
  float vis = abFarVis(d) * vInfo.z;
  // R1 silhouette AA: the pixel distance to the part's true edge, on the
  // edges whose neighbouring face is turned away (the outline; an inner
  // corner between two seen faces stays solid), as a coverage — ½ on the
  // edge, 0 a half pixel outside it (the drawn pixel of margin), 1 inside.
  float cov = 1.0;
  if (part < 2.5) {
    float t = clamp((vLoc.y - vHalf.z) / max(vHalf.w - vHalf.z, 1e-3), 0.0, 1.0);
    vec2 hh = vHalf.xy * mix(1.0, vTaper, t);
    float dpx = 1e3;
    if (roof || abs(n.z) > 0.5) {
      if (sign(vLoc.x) * vRel.x >= 0.0) dpx = min(dpx, (hh.x - abs(vLoc.x)) / lw.x);
    }
    if (roof || abs(n.x) > 0.5) {
      if (sign(vLoc.z) * vRel.z >= 0.0) dpx = min(dpx, (hh.y - abs(vLoc.z)) / lw.z);
    }
    if (!roof && vHalf.w >= cameraPosition.y) dpx = min(dpx, (vHalf.w - vLoc.y) / lw.y);
    cov = clamp(dpx + 0.5, 0.0, 1.0);
  }
  gl_FragColor = vec4(mix(fogC, col + em, vis * cov), 1.0);
}
`;

/** Four stacked unit boxes without bottoms (shaft, two tiers, the needle),
 * each roof a ring round the part above (R1, `aInner`),
 * x/z in [−1, 1], y in [0, 1]; `aPart` 0..3, drawn shaft first. */
function towerGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const part: number[] = [];
  const inner: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[][]][] = [
    // normal, 4 corners (CCW from outside)
    [
      [1, 0, 0],
      [
        [1, 0, 1],
        [1, 0, -1],
        [1, 1, -1],
        [1, 1, 1],
      ],
    ],
    [
      [-1, 0, 0],
      [
        [-1, 0, -1],
        [-1, 0, 1],
        [-1, 1, 1],
        [-1, 1, -1],
      ],
    ],
    [
      [0, 0, 1],
      [
        [-1, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [-1, 1, 1],
      ],
    ],
    [
      [0, 0, -1],
      [
        [1, 0, -1],
        [-1, 0, -1],
        [-1, 1, -1],
        [1, 1, -1],
      ],
    ],
  ];
  // R1: the roof as a ring of four trapezoids, outer edge then inner
  // (aInner: scaled to the part above in the shader; collapsed to the
  // centre when there is none, which makes it the whole roof again).
  const ring: number[][][] = [
    [
      [-1, 1, 1, 0],
      [1, 1, 1, 0],
      [1, 1, 1, 1],
      [-1, 1, 1, 1],
    ],
    [
      [1, 1, 1, 0],
      [1, 1, -1, 0],
      [1, 1, -1, 1],
      [1, 1, 1, 1],
    ],
    [
      [1, 1, -1, 0],
      [-1, 1, -1, 0],
      [-1, 1, -1, 1],
      [1, 1, -1, 1],
    ],
    [
      [-1, 1, -1, 0],
      [-1, 1, 1, 0],
      [-1, 1, 1, 1],
      [-1, 1, -1, 1],
    ],
  ];
  const quads: [number[], number[][]][] = [
    ...faces.map(
      ([n, q]) => [n, q.map((v) => [...v, 0])] as [number[], number[][]],
    ),
    ...ring.map((q) => [[0, 1, 0], q] as [number[], number[][]]),
  ];
  for (let p = 0; p < 4; p++) {
    for (const [n, quad] of quads) {
      const base = pos.length / 3;
      for (const v of quad) {
        pos.push(v[0] as number, v[1] as number, v[2] as number);
        nor.push(n[0] as number, n[1] as number, n[2] as number);
        part.push(p);
        inner.push(v[3] as number);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute("aInner", new THREE.Float32BufferAttribute(inner, 1));
  g.setIndex(idx);
  return g;
}

// The CPU half of the towers. Each world cell's tower depends only on the
// cell, so it is worked out once, when the cell enters the lattice — a
// toroidal window of N × N slots centred on the camera's cell, slot ≡ world
// cell mod N. Crossing a cell refills ONE row of N slots (a cut, or a tier
// change, all of them), and the vertex shader only reads. These mirror the
// GLSL bit for bit where it matters (the integer hash) and to float
// precision elsewhere (the district density the carpet and dome share).

const mod = (a: number, m: number): number => ((a % m) + m) % m;
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** abFarHash: (uint, uint) → uint. */
export function farHash(x: number, y: number): number {
  const qx = Math.imul(x >>> 0, 1597334673) >>> 0;
  const qy = Math.imul(y >>> 0, 3812015801 | 0) >>> 0;
  let n = Math.imul((qx ^ qy) >>> 0, 1597334673) >>> 0;
  n = (n ^ (n >>> 15)) >>> 0;
  n = Math.imul(n, 2246822519 | 0) >>> 0;
  return (n ^ (n >>> 13)) >>> 0;
}
const bits = (h: number, shift: number): number => ((h >>> shift) & 0xff) / 255;
function farRand(cx: number, cy: number, per: number): number {
  return (farHash(mod(cx, per), mod(cy, per)) & 0xffff) / 65535;
}
function farValue(px: number, py: number, per: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const tx = px - ix;
  const ty = py - iy;
  const ux = tx * tx * (3 - 2 * tx);
  const uy = ty * ty * (3 - 2 * ty);
  const a = farRand(ix, iy, per);
  const b = farRand(ix + 1, iy, per);
  const c = farRand(ix, iy + 1, per);
  const d = farRand(ix + 1, iy + 1, per);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}
/** abFarDensity at (x, z) of the unwrapped plane, 0..1. */
export function farDensity(x: number, z: number): number {
  const per = FAR_PERIOD / FAR_SUPER;
  const n =
    0.62 * farValue(x / FAR_SUPER, z / FAR_SUPER, per) +
    0.38 * farValue(x / (FAR_SUPER / 2) + 11, z / (FAR_SUPER / 2) + 5, per * 2);
  return smooth(0.22, 0.78, n);
}
/** abSpire: the super-cell's spire block, or null. */
function farSpire(sx: number, sz: number): { bx: number; bz: number } | null {
  const per = FAR_PERIOD / FAR_SUPER;
  const h = farHash(mod(sx, per) + 977, mod(sz, per) + 613);
  const bx = (h >>> 8) & 7;
  const bz = (h >>> 12) & 7;
  const row = mod(mod(sz, per) * 8 + bz, WORLD_SIZE / BLOCK_PITCH);
  return bits(h, 0) < SPIRE_SHARE && row !== RIVER_ROW_INDEX
    ? { bx, bz }
    : null;
}

/** Cells per period, and the tower data's floats per slot. */
const CELLS = FAR_PERIOD / FAR_CELL;
/**
 * Write the tower of world cell (cx, cz) (cell indices mod CELLS) into
 * `a`/`b` at slot `i`: (centre x/z within the cell, half sizes) and
 * (height, seed, occupancy, style: −1 none, 0 plain, 2 setback, 3 setback
 * with a needle).
 */
export function farCellTower(
  cx: number,
  cz: number,
  a: Float32Array,
  b: Float32Array,
  i: number,
): void {
  const h = farHash(cx, cz);
  const h2 = farHash(h, (h ^ 0x9e3779b9) >>> 0);
  const dens = farDensity((cx + 0.5) * FAR_CELL, (cz + 0.5) * FAR_CELL);
  let alive = true;
  // Blocks: cells are half-blocks; the river row and parks hold none.
  if (mod(Math.floor(cz / 2), WORLD_SIZE / BLOCK_PITCH) === RIVER_ROW_INDEX)
    alive = false;
  if (bits(h, 0) < 0.08 + 0.25 * (1 - smooth(0, 0.15, dens))) alive = false;
  // A spire's block is the spire's alone.
  const sx = Math.floor(cx / 16);
  const sz = Math.floor(cz / 16);
  const sp = farSpire(sx, sz);
  if (
    sp &&
    Math.floor((cx - sx * 16) / 2) === sp.bx &&
    Math.floor((cz - sz * 16) / 2) === sp.bz
  )
    alive = false;
  // The footprint inside the half-block's buildable band (streets clear).
  const westX = 1 - mod(cx, 2);
  const westZ = 1 - mod(cz, 2);
  const loX = westX * LOT_LINE;
  const loZ = westZ * LOT_LINE;
  const hiX = FAR_CELL - (1 - westX) * LOT_LINE;
  const hiZ = FAR_CELL - (1 - westZ) * LOT_LINE;
  const hx = 17 + ((hiX - loX) * 0.5 - 1 - 17) * bits(h, 8);
  const hz = 17 + ((hiZ - loZ) * 0.5 - 1 - 17) * bits(h, 16);
  const tx = bits(h2, 0);
  const tz = bits(h2, 8);
  a[i * 4] = loX + hx + (hiX - hx - (loX + hx)) * tx;
  a[i * 4 + 1] = loZ + hz + (hiZ - hz - (loZ + hz)) * tz;
  a[i * 4 + 2] = hx;
  a[i * 4 + 3] = hz;
  // Dense districts cluster tall: the downtowns stand out of the city.
  const r = bits(h, 24);
  const H = Math.min(340, 16 + 60 * dens + (24 + 250 * dens * dens) * r * r);
  let style = 0;
  // Art Deco setbacks on the tall ones, some with a needle.
  if (H > 105 && bits(h2, 24) < 0.5) style = bits(h2, 4) < 0.35 ? 3 : 2;
  b[i * 4] = H;
  b[i * 4 + 1] = (h2 >>> 16) / 65535;
  b[i * 4 + 2] = 0.18 + 0.32 * bits(h2, 16) * (0.5 + 0.5 * dens);
  b[i * 4 + 3] = alive ? style : -1;
}

/** The spire super-cells (offsets from the camera's) that can hold a spire
 * inside FAR_MAX_RADIUS wherever the camera is in its own super-cell — a
 * fixed list after the lattice in the instance buffer, so a spire is never
 * missed and never pops. */
function spireSlots(): [number, number][] {
  const out: [number, number][] = [];
  const m = Math.ceil(FAR_MAX_RADIUS / FAR_SUPER) + 1;
  for (let ix = -m; ix <= m; ix++) {
    for (let iz = -m; iz <= m; iz++) {
      // The nearest the two squares (the camera's super-cell, this one)
      // come to each other.
      const gap = Math.hypot(
        Math.max(Math.abs(ix) - 1, 0) * FAR_SUPER,
        Math.max(Math.abs(iz) - 1, 0) * FAR_SUPER,
      );
      if (gap <= FAR_MAX_RADIUS) out.push([ix, iz]);
    }
  }
  return out;
}

/** R1: the draw order of a lattice of side `n` — every cell offset from
 * the camera's cell in the window ([−n/2, n/2) per axis), as (x, z)
 * pairs, farthest (by cell centre) first. */
export function farDrawOrder(n: number): Int16Array {
  const h = n / 2;
  const cells: [number, number, number][] = [];
  for (let z = -h; z < h; z++) {
    for (let x = -h; x < h; x++) {
      cells.push([x, z, (x + 0.5) ** 2 + (z + 0.5) ** 2]);
    }
  }
  cells.sort((p, q) => q[2] - p[2]);
  const out = new Int16Array(n * n * 2);
  cells.forEach(([x, z], k) => {
    out[k * 2] = x;
    out[k * 2 + 1] = z;
  });
  return out;
}

/** The lattice side for a far radius: every cell whose tower can lie
 * within `radius` of the eye. Even, so the window is centred. */
export function farLatticeSide(radius: number): number {
  return 2 * (Math.ceil(radius / FAR_CELL) + 1);
}

// --- 2. Carpet -----------------------------------------------------------------

/** Carpet rings (geometric in radius) × azimuth segments. */
const CARPET_RINGS = 24;
const CARPET_SEGMENTS = 128;

const CARPET_VERTEX = /* glsl */ `
${COMMON_GLSL}
attribute vec2 aRing; // (0..1 along the radius, azimuth rad)
varying vec3 vShell;
// The district density, per vertex: it varies over 1.6 km cells, far
// coarser than the rings, so the pixels interpolate it instead of hashing.
varying float vDens;
void main() {
  float camY = max(cameraPosition.y, 0.0);
  // From where the ground is exactly at the fog limit, out past R_out.
  float r0 = sqrt(max(${f(FOG_DISTANCE * FOG_DISTANCE)} - camY * camY, 1.0)) - 2.0;
  float r = r0 * pow(${f(FAR_MAX_RADIUS + 200)} / r0, aRing.x);
  vec3 rel = vec3(cos(aRing.y) * r, -camY, sin(aRing.y) * r);
  vDens = abFarDensity(uFarOrigin + rel.xz);
  vShell = abFarShell(rel);
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + vShell, 1.0);
}
`;

const CARPET_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
varying vec3 vShell;
varying float vDens;
// A filtered line train: lines of half width \`hw\` every \`per\` m at x, given
// the pixel footprint \`fw\` (m) — the exact box filter of the nearest line
// (R1: it kept ≥ half coverage on whichever pixel a sub-pixel line fell
// in, so far streets crawled), its mean coverage once the period is under a
// few pixels.
float abLines(float x, float per, float hw, float fw) {
  float dd = abs(x - per * floor(x / per + 0.5));
  float a = max(fw, 0.01) * 0.5;
  float cov = clamp((min(dd + a, hw) - max(dd - a, -hw)) / (2.0 * a), 0.0, 1.0);
  return mix(cov, 2.0 * hw / per, smoothstep(0.2, 0.6, fw / per));
}
// A dotted run: dots of half length \`hl\` every \`per\` m along x.
float abDots(float x, float per, float hl, float fw) {
  return abLines(x, per, hl, fw);
}
void main() {
  // The pixel's own view ray (any point on the shell under it lies on it)
  // meets the ground exactly: world position and footprint from that.
  vec3 dir = normalize(vShell);
  vec3 fogC = abGlowFog(fogColor, dir.y);
  float down = -dir.y;
  if (down < 0.002) { gl_FragColor = vec4(fogC, 1.0); return; }
  float camY = max(cameraPosition.y, 0.0);
  vec3 rel = dir * (camY / down);
  float d = length(rel);
  vec2 w = uFarOrigin + rel.xz;
  vec2 fw = fwidth(w);
  float dens = vDens;
  float burn = abCityGlow.a;
  float depth = abFarDepth(d);
  // Roofs and courtyards, a speckle of lit windows and yards (40 m cells,
  // each its own light — R1: the window palette, not one orange — their
  // mean once a cell is under ~3 px).
  vec2 sc = floor(w / 40.0);
  uint sh = abFarHash(uvec2(mod(sc, ${f(FAR_PERIOD / 40)})));
  float sp = float(sh & 0xffffu) / 65535.0;
  float st = float(sh >> 16u) / 65535.0;
  float speckK = 1.0 - smoothstep(${f(40 / 6)}, ${f(40 / 3)}, max(fw.x, fw.y));
  vec3 spCol = mix(${paletteMean(0.16)} * 0.5, ${paletteGlsl("st", 0.16)} * sp, speckK);
  vec3 col = abFarAirSurface(${linear(ROOF)} * 0.55, depth);
  vec3 em = spCol * (0.25 + 0.75 * dens);
  // The street grid on the real 200 m lattice: each street its own lamps
  // (R1: old sodium or new LED white — their mean where streets are under
  // a few pixels apart), brighter crossings; quieter districts dimmer.
  float lx = abLines(w.x, ${f(BLOCK_PITCH)}, 4.0, fw.x);
  float lz = abLines(w.y, ${f(BLOCK_PITCH)}, 4.0, fw.y);
  float stPer = ${f(FAR_PERIOD / BLOCK_PITCH)};
  vec2 sodium = vec2(
    abFarRand(vec2(floor(w.x / ${f(BLOCK_PITCH)} + 0.5), 7.0), stPer) < ${STREET_SODIUM_SHARE.toFixed(2)} ? 1.0 : 0.0,
    abFarRand(vec2(floor(w.y / ${f(BLOCK_PITCH)} + 0.5), 9.0), stPer) < ${STREET_SODIUM_SHARE.toFixed(2)} ? 1.0 : 0.0);
  sodium = mix(sodium, vec2(${STREET_SODIUM_SHARE.toFixed(2)}), smoothstep(vec2(0.2), vec2(0.6), fw / ${f(BLOCK_PITCH)}));
  vec3 cx = mix(${lit(STREET_LED, STREET_PEAK)}, ${lit(STREET_COLOR, STREET_PEAK)}, sodium.x);
  vec3 cz = mix(${lit(STREET_LED, STREET_PEAK)}, ${lit(STREET_COLOR, STREET_PEAK)}, sodium.y);
  em += ((lx >= lz ? cx * lx : cz * lz) + 0.6 * (cx + cz) * lx * lz) * (0.45 + 0.55 * dens);
  // The river images (z ≡ the real channel mod the torus): dark water with
  // the glow's sheen, lamp lines along both banks, a light chain on every
  // bridge deck (one per north–south street, as in the real city).
  float zr = w.y - ${f(RIVER_CENTER_Z)};
  zr -= ${f(WORLD_SIZE)} * floor(zr / ${f(WORLD_SIZE)} + 0.5);
  float az = abs(zr);
  float water = 0.0;
  if (az < ${f(RIVER_HALF_WIDTH + 14)}) {
    water = 1.0 - smoothstep(${f(RIVER_HALF_WIDTH - 1)}, ${f(RIVER_HALF_WIDTH + 1)}, az);
    float deck = abLines(w.x, ${f(BLOCK_PITCH)}, 11.0, fw.x);
    vec3 wcol = fogC * 0.3 + abCityGlow.rgb * 0.8;
    col = mix(col, wcol, water * (1.0 - deck));
    em *= 1.0 - water;
    // The deck chains: lamps each side of the deck, every 8 m along it.
    float chainX = abLines(w.x + 10.0, ${f(BLOCK_PITCH)}, 1.2, fw.x) + abLines(w.x - 10.0, ${f(BLOCK_PITCH)}, 1.2, fw.x);
    // A third of the bridges are the big lit suspension spans; the rest
    // carry only their street lamps.
    float bi = mod(floor(w.x / ${f(BLOCK_PITCH)} + 0.5), ${f(FAR_PERIOD / BLOCK_PITCH)});
    float big = abFarRand(vec2(bi, 3.0), ${f(FAR_PERIOD / BLOCK_PITCH)}) < 0.34 ? 1.0 : 0.3;
    float chain = min(chainX, 1.0) * abDots(zr, 8.0, 1.2, fw.y) * water * big;
    // Waterfront lamps on the promenades, every 14 m.
    float bank = abLines(az - ${f(RIVER_HALF_WIDTH + 6)}, 1000.0, 1.4, fw.y) * abDots(w.x, 14.0, 1.5, fw.x);
    // Their reflections smeared toward the camera on the water.
    float refl = water * exp(-(${f(RIVER_HALF_WIDTH)} - az) / 6.0) * 0.12;
    // Capped at the lamp peak (LAMP_PEAK, under bloom) where they meet.
    em += ${lit(LAMP_COLOR, LAMP_PEAK)} * min(chain + 0.8 * bank + refl, 1.0);
  }
  // The burning city — and (R1) the war's own scattered fires, burning
  // whatever the room's burn: blocks afire, flickering.
  {
    vec2 bc = floor(w / ${f(BLOCK_PITCH)});
    float bh = float(abFarHash(uvec2(mod(bc, ${f(FAR_PERIOD / BLOCK_PITCH)})) + uvec2(71u, 19u)) & 0xffffu) / 65535.0;
    // Patchy: the fire is in some of each burning block's 40 m cells (its
    // 45 % mean where a cell is small).
    float fire = 0.7 * step(bh, ${WAR_FIRE_SHARE.toFixed(3)} + 0.45 * burn) * mix(0.45, step(0.55, sp), speckK)
      * (0.6 + 0.4 * sin(uFarTime * 5.0 + bh * 80.0 + sp * 9.0));
    em += ${lit(EMBER_COLOR, EMBER_PEAK)} * fire * (1.0 - water);
  }
  em = abFarAirLight(em, depth);
  float vis = abFarVis(d) * smoothstep(${f(CARPET_FADE[0])}, ${f(CARPET_FADE[1])}, d);
  gl_FragColor = vec4(mix(fogC, col + em, vis), 1.0);
}
`;

function carpetGeometry(): THREE.BufferGeometry {
  const ring: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= CARPET_RINGS; i++) {
    for (let j = 0; j <= CARPET_SEGMENTS; j++) {
      ring.push(i / CARPET_RINGS, (j / CARPET_SEGMENTS) * Math.PI * 2);
    }
  }
  const row = CARPET_SEGMENTS + 1;
  for (let i = 0; i < CARPET_RINGS; i++) {
    for (let j = 0; j < CARPET_SEGMENTS; j++) {
      const a = i * row + j;
      // Seen from above (front faces): the winding faces +y.
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const g = new THREE.BufferGeometry();
  // three needs a position for its bounds; the shader uses aRing only.
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(new Float32Array(ring.length * 1.5), 3),
  );
  g.setAttribute("aRing", new THREE.Float32BufferAttribute(ring, 2));
  g.setIndex(idx);
  return g;
}

/** The far skyline: carpet + towers, two opaque draws after the city. */
export class FarSkyline {
  readonly carpet: THREE.Mesh;
  readonly towers: THREE.Mesh;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly offset = new CloudOffset(FAR_PERIOD);
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly towerA: THREE.InstancedBufferAttribute;
  private readonly towerB: THREE.InstancedBufferAttribute;
  private readonly spires = spireSlots();
  /** Each world cell's tower, by toroidal slot (slot ≡ world cell mod n):
   * filled as cells enter the window, then copied into the attributes in
   * draw order (writeDrawOrder). Sized for the largest lattice. */
  private readonly slotA: Float32Array;
  private readonly slotB: Float32Array;
  /** The window's cell offsets from the camera's cell (x, z pairs), far to
   * near — the draw order (farDrawOrder). */
  private order: Int16Array;
  /** The lattice's side (cells) and the camera's UNWRAPPED cell (null:
   * the lattice needs a full fill). */
  private n = farLatticeSide(FAR_MAX_RADIUS);
  private wcx = 0;
  private wcz = 0;
  private filled = false;
  private cellX = 0;
  private cellZ = 0;

  /** `moonDir`: the dome's moon direction uniform, shared by reference. */
  constructor(moonDir: { value: THREE.Vector3 }) {
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uFarOrigin: FAR_ORIGIN,
      uFarOuter: { value: FAR_MAX_RADIUS },
      uFarPx: { value: 0.001 },
      uFarTime: { value: 0 },
      uFarMoon: moonDir,
      uFarFrac: { value: new THREE.Vector2() },
      uFarSuper: { value: new THREE.Vector2() },
      uFarSuperFrac: { value: new THREE.Vector2() },
    };
    const material = (vertexShader: string, fragmentShader: string) =>
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader,
        fragmentShader,
        // Feeds fogColor/fogNear/fogFar live; the shaders fog themselves.
        fog: true,
        side: THREE.FrontSide,
      });
    const capacity = this.n * this.n + this.spires.length;
    this.slotA = new Float32Array(this.n * this.n * 4);
    this.slotB = new Float32Array(this.n * this.n * 4);
    this.order = farDrawOrder(this.n);
    this.geometry = towerGeometry() as THREE.InstancedBufferGeometry;
    this.towerA = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    );
    this.towerB = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    );
    for (const attr of [this.towerA, this.towerB]) {
      attr.setUsage(THREE.DynamicDrawUsage);
    }
    this.geometry.setAttribute("aTowerA", this.towerA);
    this.geometry.setAttribute("aTowerB", this.towerB);
    // Until the first fill: nothing alive (style −1).
    (this.towerB.array as Float32Array).fill(-1);
    this.writeSpires();
    this.towers = new THREE.Mesh(
      this.geometry,
      material(TOWER_VERTEX, TOWER_FRAGMENT),
    );
    this.carpet = new THREE.Mesh(
      carpetGeometry(),
      material(CARPET_VERTEX, CARPET_FRAGMENT),
    );
    for (const m of [this.carpet, this.towers]) {
      m.frustumCulled = false;
      // Opaque, after the city's opaques (early-z culls what it hides).
      m.renderOrder = RENDER_ORDER.farSkyline;
    }
    (this.towers.material as THREE.ShaderMaterial).customProgramCacheKey = () =>
      "l2-far-towers";
    (this.carpet.material as THREE.ShaderMaterial).customProgramCacheKey = () =>
      "l2-far-carpet";
  }

  /** The spire slots, right after the lattice's n² (style −2). */
  private writeSpires(): void {
    const a = this.towerA.array as Float32Array;
    const b = this.towerB.array as Float32Array;
    const base = this.n * this.n;
    this.spires.forEach(([x, z], k) => {
      const i = base + k;
      a.set([x, z, 0, 0], i * 4);
      b.set([0, 0, 0, -2], i * 4);
    });
    this.geometry.instanceCount = base + this.spires.length;
  }

  /** Fill one world cell (unwrapped indices) into its slot. */
  private fillCell(wx: number, wz: number): void {
    const n = this.n;
    farCellTower(
      mod(wx, CELLS),
      mod(wz, CELLS),
      this.slotA,
      this.slotB,
      mod(wz, n) * n + mod(wx, n),
    );
  }

  /**
   * R1: the window's towers into the attributes in DRAW order, far to
   * near, centres from the camera cell's corner. The far shell has only
   * ~200 depth steps for 0.8–5 km, so two far towers within ~35–70 m of each
   * other can land on the same depth; three's LessEqual test then keeps the
   * one drawn LAST, and drawn far to near that is always the nearer one —
   * no tower ever trades pixels with the one behind it as the camera moves.
   * A permutation copy (n² × 8 floats) on a cell crossing, which re-uploads
   * the whole buffer anyway.
   */
  private writeDrawOrder(): void {
    const n = this.n;
    const a = this.towerA.array as Float32Array;
    const b = this.towerB.array as Float32Array;
    const o = this.order;
    for (let k = 0; k < n * n; k++) {
      const rx = o[k * 2] as number;
      const rz = o[k * 2 + 1] as number;
      const s = (mod(this.wcz + rz, n) * n + mod(this.wcx + rx, n)) * 4;
      a[k * 4] = (this.slotA[s] as number) + rx * FAR_CELL;
      a[k * 4 + 1] = (this.slotA[s + 1] as number) + rz * FAR_CELL;
      a[k * 4 + 2] = this.slotA[s + 2] as number;
      a[k * 4 + 3] = this.slotA[s + 3] as number;
      b[k * 4] = this.slotB[s] as number;
      b[k * 4 + 1] = this.slotB[s + 1] as number;
      b[k * 4 + 2] = this.slotB[s + 2] as number;
      b[k * 4 + 3] = this.slotB[s + 3] as number;
    }
    this.towerA.needsUpdate = true;
    this.towerB.needsUpdate = true;
  }

  /** Fill the whole window round the camera's cell. */
  private fillAll(): void {
    const h = this.n / 2;
    for (let z = this.wcz - h; z < this.wcz + h; z++) {
      for (let x = this.wcx - h; x < this.wcx + h; x++) this.fillCell(x, z);
    }
    this.filled = true;
  }

  /** Step the window one cell along x (`dx` ±1) or z, filling the column
   * or row that enters it. */
  private step(dx: number, dz: number): void {
    const h = this.n / 2;
    if (dx !== 0) {
      this.wcx += dx;
      const x = dx > 0 ? this.wcx + h - 1 : this.wcx - h;
      for (let z = this.wcz - h; z < this.wcz + h; z++) this.fillCell(x, z);
    }
    if (dz !== 0) {
      this.wcz += dz;
      const z = dz > 0 ? this.wcz + h - 1 : this.wcz - h;
      for (let x = this.wcx - h; x < this.wcx + h; x++) this.fillCell(x, z);
    }
  }

  /**
   * Once a frame, after the render camera is final: advance the unwrapped
   * offset from it (`dtSec`, the sim's clamped step, tells flight from a
   * cut), move the lattice (one row per cell crossed; all of it on a cut),
   * and the pixel scale the needles floor to. `worldMs` is the WORLD clock
   * (R1: the beacons' flash and the fires' flicker are cosmetic — a pure
   * function of synced server time, the same on every client and pinned
   * with `__ab.pinWorld`).
   */
  update(
    camera: THREE.PerspectiveCamera,
    dtSec: number,
    viewportH: number,
    worldMs: number,
    shown: boolean,
  ): void {
    const p = camera.position;
    // Hidden with the dome (inside the cloud deck the fog IS the sky); the
    // carpet also below the street, where it would be seen from beneath.
    this.towers.visible = shown;
    this.carpet.visible = shown && p.y > 0;
    const cut = this.offset.advance(p, dtSec);
    const ux = this.offset.x;
    const uz = this.offset.z;
    FAR_ORIGIN.value.set(ux, uz);
    const u = this.uniforms;
    const cx = Math.floor(ux / FAR_CELL);
    const cz = Math.floor(uz / FAR_CELL);
    // The unwrapped cell: steps of the mod-CELLS one, wrap-aware.
    const dx = mod(cx - this.cellX + CELLS / 2, CELLS) - CELLS / 2;
    const dz = mod(cz - this.cellZ + CELLS / 2, CELLS) - CELLS / 2;
    this.cellX = cx;
    this.cellZ = cz;
    if (cut || !this.filled || Math.abs(dx) > 1 || Math.abs(dz) > 1) {
      this.wcx = cx;
      this.wcz = cz;
      this.fillAll();
      this.writeDrawOrder();
    } else if (dx !== 0 || dz !== 0) {
      this.step(dx, dz);
      this.writeDrawOrder();
    }
    (u.uFarFrac?.value as THREE.Vector2).set(
      cx * FAR_CELL - ux,
      cz * FAR_CELL - uz,
    );
    const sx = Math.floor(ux / FAR_SUPER);
    const sz = Math.floor(uz / FAR_SUPER);
    (u.uFarSuper?.value as THREE.Vector2).set(sx, sz);
    (u.uFarSuperFrac?.value as THREE.Vector2).set(
      sx * FAR_SUPER - ux,
      sz * FAR_SUPER - uz,
    );
    // Metres per pixel per metre of distance.
    (u.uFarPx as THREE.IUniform).value =
      2 / (camera.projectionMatrix.elements[5] * Math.max(viewportH, 1));
    (u.uFarTime as THREE.IUniform).value = (worldMs / 1000) % 3600;
  }

  /** O3: the tier's far radius — the lattice's side (an instance count,
   * refilled on the next update), and a uniform (rule 1: no compile).
   * Dressing only, so it may differ per tier. */
  setQuality(tier: QualityTier): void {
    const r = QUALITY_PROFILES[tier].farSkyline;
    (this.uniforms.uFarOuter as THREE.IUniform).value = r;
    const n = farLatticeSide(r);
    if (n === this.n) return;
    this.n = n;
    this.order = farDrawOrder(n);
    (this.towerB.array as Float32Array).fill(-1);
    this.writeSpires();
    this.filled = false;
  }
}
