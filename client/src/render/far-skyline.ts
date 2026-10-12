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
// WORLD-ANCHORED, SEAM-FREE. Everything is placed in an unwrapped camera
// offset (sky-clouds CloudOffset) kept mod FAR_PERIOD, a whole number of
// torus widths and of every cell size here: it never jumps at the seam,
// resets on a cut (a gallery view depends only on where the camera is) and
// stays congruent to the canonical position mod WORLD_SIZE, so the far
// street grid and the river row continue the real ones.
//
// FADES, so nothing pops (all radial distances from the eye):
//   towers  colour → fog over FADE_IN, then SINK to zero height over SINK
//           while already fog-coloured, gone before their slot leaves;
//   spires  the same, further out (SPIRE_FADE / SPIRE_SINK), so a landmark
//           recedes into the fog and is never reached;
//   carpet  fog-coloured at 800 m, in over CARPET_FADE;
//   far     farVisibility(): haze, and exactly the fog colour by R − 100
//           (the tier's R_out — the slot prefix wobbles ≤ 71 m with the
//           camera inside its cell), so there is no ring edge;
//   weather nothing inside the deck or dust, thinner in rain.
// The fog colour it fades to is the glow-aware one (fog.ts abGlowFog), the
// same the fog chunk and the dome reach, so the inner edge meets the
// fogged real city exactly. The band between the real city's fog and the
// far city's fade-in reads as a low mist bank — deliberate.

import {
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
} from "@angels-bandits/common/city/river";
import { LOT_LINE } from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  FOG_DISTANCE,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import * as THREE from "three";
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
/** Peak share of the far city's own colour over the fog, and its haze
 * length, m: `FAR_VIS · exp(−(D − 800) / FAR_HAZE)`. */
export const FAR_VIS = 0.62;
export const FAR_HAZE = 3200;

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
const WINDOW_COLOR = 0xffb468;
const WINDOW_PEAK = 0.66;
const STREET_COLOR = 0xffa040;
const STREET_PEAK = 0.24;
const LAMP_COLOR = 0xffd9a8;
const LAMP_PEAK = 0.45;
const CROWN_COLOR = 0xffdcae;
const CROWN_PEAK = 0.58;
const BEACON_COLOR = 0xff2a18;
const BEACON_PEAK = 0.58;
const EMBER_COLOR = 0xff5a1c;
const EMBER_PEAK = 0.5;
/** Masonry and roofs (sRGB), and the moon's tint on the faces it lights. */
const MASONRY = 0x1e1f25;
const ROOF = 0x17181d;
const MOONLIT = 0xbccbe8; // sky.ts DUSK.moon

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
// The shell (farShellDistance): \`rel\` (true, from the eye) → where it is drawn.
vec3 abFarShell(vec3 rel) {
  float d = length(rel);
  float x = max(d - ${f(FOG_DISTANCE)}, 0.0);
  float s = ${f(SHELL_NEAR)} + ${SHELL_DEPTH.toFixed(3)} * x / (x + ${f(SHELL_KNEE)});
  return rel * (s / max(d, 1.0));
}
// How much of the far city's own colour shows over the fog at true radial
// distance d: the haze, the far edge (0 by R − 100) and the weather (none
// in the deck or dust — abWeather.y, the fog closing in — fogFar).
float abFarVis(float d) {
  float v = ${FAR_VIS.toFixed(3)} * exp(-(d - ${f(FOG_DISTANCE)}) / ${f(FAR_HAZE)});
  v *= 1.0 - smoothstep(0.72 * uFarOuter, uFarOuter - 100.0, d);
  v *= (1.0 - clamp(abWeather.y, 0.0, 1.0)) / (1.0 + 1.5 * max(abWeather.x, 0.0));
  return v * smoothstep(${f(0.9 * FOG_DISTANCE)}, ${f(FOG_DISTANCE)}, fogFar);
}
`;

// --- 1. Towers -----------------------------------------------------------------

const TOWER_VERTEX = /* glsl */ `
${COMMON_GLSL}
attribute float aPart;
attribute vec3 aSlot; // lattice offset (x, z) from the camera's cell; kind
uniform vec2 uFarCell; // the camera's tower cell (mod the period)
uniform vec2 uFarFrac; // that cell's corner − the eye, m (x, z)
uniform vec2 uFarSuper; // the camera's spire super-cell
uniform vec2 uFarSuperFrac;
varying vec3 vRel;
varying vec2 vFacade;
varying vec3 vNormal;
flat varying vec4 vInfo; // seed, occupancy, colour fade, part
flat varying vec4 vKind; // kind (0 tower, 1 spire, 2 setback), burning, part top y, part height
float abBits(uint h, uint shift) { return float((h >> shift) & 0xffu) / 255.0; }
// The spire super-cell \`sc\`'s spire: (exists, block x, block z, seed).
vec4 abSpire(vec2 sc) {
  uint h = abFarHash(uvec2(mod(sc, ${f(FAR_PERIOD / FAR_SUPER)})) + uvec2(977u, 613u));
  float bx = float((h >> 8u) & 7u);
  float bz = float((h >> 12u) & 7u);
  // Never in the river row (the super-cell's block rows are canonical rows
  // mod 10: 8 per super-cell, 1600 = 8 × 200).
  float row = mod(sc.y * 8.0 + bz, ${f(WORLD_SIZE / BLOCK_PITCH)});
  float has = (abBits(h, 0u) < 0.55 && abs(row - ${f(RIVER_CENTER_Z / BLOCK_PITCH - 0.5)}) > 0.5) ? 1.0 : 0.0;
  return vec4(has, bx, bz, float(h >> 16u) / 65535.0);
}
void main() {
  float kind = aSlot.z;
  // Past this tier's radius: out before any hashing (the slot prefix
  // already stops near it).
  vec2 slotCentre = kind < 0.5
    ? aSlot.xy * ${f(FAR_CELL)} + uFarFrac + ${f(FAR_CELL / 2)}
    : aSlot.xy * ${f(FAR_SUPER)} + uFarSuperFrac + ${f(FAR_SUPER / 2)};
  if (length(slotCentre) > uFarOuter + (kind < 0.5 ? 100.0 : 1300.0)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
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
  if (kind < 0.5) {
    vec2 cell = mod(uFarCell + aSlot.xy, ${f(FAR_PERIOD / FAR_CELL)});
    uint h = abFarHash(uvec2(cell));
    uint h2 = abFarHash(uvec2(h, h ^ 0x9e3779b9u));
    vec2 corner = aSlot.xy * ${f(FAR_CELL)} + uFarFrac;
    vec2 w = uFarOrigin + corner + ${f(FAR_CELL / 2)};
    float dens = abFarDensity(w);
    // Blocks: cells are half-blocks; the river row and parks hold none.
    float row = mod(floor(cell.y / 2.0), ${f(WORLD_SIZE / BLOCK_PITCH)});
    if (abs(row - ${f(RIVER_CENTER_Z / BLOCK_PITCH - 0.5)}) < 0.5) alive = false;
    if (abBits(h, 0u) < 0.08 + 0.25 * (1.0 - smoothstep(0.0, 0.15, dens))) alive = false;
    // A spire's block is the spire's alone.
    vec2 sc = floor(cell / 16.0);
    vec4 sp = abSpire(sc);
    vec2 blk = floor((cell - sc * 16.0) / 2.0);
    if (sp.x > 0.5 && blk == sp.yz) alive = false;
    // The footprint inside the half-block's buildable band (streets clear).
    vec2 west = 1.0 - mod(cell, 2.0); // 1: the half on the block's low side
    vec2 lo = west * ${f(LOT_LINE)};
    vec2 hi = ${f(FAR_CELL)} - (1.0 - west) * ${f(LOT_LINE)};
    hsz = mix(vec2(17.0), (hi - lo) * 0.5 - 1.0, vec2(abBits(h, 8u), abBits(h, 16u)));
    vec2 t = vec2(abBits(h2, 0u), abBits(h2, 8u));
    c = corner + mix(lo + hsz, hi - hsz, t);
    float r = abBits(h, 24u);
    // Dense districts cluster tall: the downtowns stand out of the city.
    H = 16.0 + 60.0 * dens + (24.0 + 250.0 * dens * dens) * pow(r, 2.0);
    H = min(H, 340.0);
    seed = float(h2 >> 16u) / 65535.0;
    occ = 0.14 + 0.26 * abBits(h2, 16u) * (0.5 + 0.5 * dens);
    // Art Deco setbacks on the tall ones.
    if (H > 105.0 && abBits(h2, 24u) < 0.5) {
      style = 2.0;
      ends = vec3(0.6, 0.8, abBits(h2, 4u) < 0.35 ? 0.93 : 1.0);
      scale = vec3(1.0, 0.74, 0.5);
      needle = ends.z < 1.0 ? 2.0 : 0.0;
    }
  } else {
    vec2 sc = mod(uFarSuper + aSlot.xy, ${f(FAR_PERIOD / FAR_SUPER)});
    vec4 sp = abSpire(sc);
    alive = sp.x > 0.5;
    c = aSlot.xy * ${f(FAR_SUPER)} + uFarSuperFrac + sp.yz * ${f(BLOCK_PITCH)} + ${f(BLOCK_PITCH / 2)};
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
  // Fade and sink by the radial distance to the nearest point of the box.
  float camY = cameraPosition.y;
  float dh = max(length(c) - length(hsz), 0.0);
  float dy = camY > H ? camY - H : (camY < 0.0 ? -camY : 0.0);
  float dn = sqrt(dh * dh + dy * dy);
  vec2 fadeBand = kind < 0.5 ? vec2(${f(FADE_IN[0])}, ${f(FADE_IN[1])}) : vec2(${f(SPIRE_FADE[0])}, ${f(SPIRE_FADE[1])});
  vec2 sinkBand = kind < 0.5 ? vec2(${f(SINK[0])}, ${f(SINK[1])}) : vec2(${f(SPIRE_SINK[0])}, ${f(SPIRE_SINK[1])});
  float colourIn = smoothstep(fadeBand.y, fadeBand.x, dn);
  float sink = smoothstep(sinkBand.y, sinkBand.x, dn);
  if (sink <= 0.0 || length(c) > uFarOuter + 150.0) alive = false;
  if (!alive) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // behind the far plane: culled
    return;
  }
  // This vertex's part.
  float y0 = 0.0;
  float y1 = ends.x;
  float s = scale.x;
  float tp = 1.0;
  if (aPart > 0.5) { y0 = ends.x; y1 = ends.y; s = scale.y; }
  if (aPart > 1.5) { y0 = ends.y; y1 = ends.z; s = scale.z; tp = taper2; }
  vec2 hp = hsz * s;
  if (aPart > 2.5) {
    y0 = ends.z;
    y1 = 1.0;
    // The needle never thinner than ~1.5 px, so it cannot crawl.
    float wpx = 0.75 * length(vec3(c, H - camY)) * uFarPx;
    hp = vec2(needle > 0.0 ? max(needle, wpx) : 0.0);
    tp = 0.0;
  }
  float hgt = H * sink;
  vec2 local = position.xz * hp * mix(1.0, tp, position.y);
  float y = mix(y0, y1, position.y) * hgt;
  vec3 rel = vec3(c.x + local.x, y - camY, c.y + local.y);
  vRel = rel;
  vNormal = normal;
  vFacade = vec2(abs(normal.x) > 0.5 ? local.y : local.x, y);
  vInfo = vec4(seed, occ, colourIn, aPart);
  float burning = abBits(abFarHash(uvec2(seed * 65535.0, 31u)), 0u) < 0.4 * abCityGlow.a ? 1.0 : 0.0;
  vKind = vec4(style, burning, y1 * hgt, (y1 - y0) * hgt);
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + abFarShell(rel), 1.0);
}
`;

const TOWER_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
varying vec3 vRel;
varying vec2 vFacade;
varying vec3 vNormal;
flat varying vec4 vInfo;
flat varying vec4 vKind;
float abFarCell(vec2 cell, float seed) {
  return float(abFarHash(uvec2(ivec2(cell) + 4096) ^ uvec2(uint(seed * 65535.0))) & 0xffffu) / 65535.0;
}
void main() {
  float d = length(vRel);
  vec3 dir = vRel / max(d, 1.0);
  vec3 fogC = abGlowFog(fogColor, dir.y);
  vec3 n = normalize(vNormal);
  float seed = vInfo.x;
  float occ = vInfo.y;
  float part = vInfo.w;
  float style = vKind.x;
  float burn = abCityGlow.a;
  bool roof = n.y > 0.5;
  vec3 col = roof ? ${linear(ROOF)} : ${linear(MASONRY)} * (0.75 + 0.5 * fract(seed * 5.3));
  // Moonlight on the faces turned to it, and the glow's warm bounce.
  col *= 0.3 + 0.55 * max(dot(n, uFarMoon), 0.0) * ${linear(MOONLIT)} + abCityGlow.rgb * 10.0;
  vec3 em = vec3(0.0);
  float px = d * uFarPx; // metres per pixel here
  if (!roof) {
    // Lit windows: cells of 2 bays × 2 storeys, each lit or dark, shown
    // where a cell is ≥ ~2 px (its mean below that), and drawn as a lit
    // strip inset in the cell — separate lights, not blocks — where a cell
    // is ≥ ~5 px (the strip's mean coverage below that). Nothing finer
    // than ~2 px ever switches, so the far city cannot crawl.
    vec2 pg = vFacade / vec2(6.0, 7.2);
    float cellK = 1.0 - smoothstep(0.35, 0.65, px / 7.2);
    float insetK = 1.0 - smoothstep(0.12, 0.22, px / 7.2);
    float g = abFarCell(floor(pg), seed);
    float group = step(1.0 - occ, g) * (0.55 + 0.45 * fract(g * 7.0));
    float groupMean = occ * 0.775;
    vec2 fc = fract(pg);
    float inset = step(0.12, fc.x) * step(fc.x, 0.88) * step(0.18, fc.y) * step(fc.y, 0.62);
    float pane = mix(0.338, inset, insetK);
    float lit = mix(groupMean, group, cellK);
    vec3 wcol = mix(${lit(WINDOW_COLOR, WINDOW_PEAK)}, ${lit(EMBER_COLOR, WINDOW_PEAK)}, 0.6 * burn);
    em += wcol * lit * pane;
    // Floodlit crowns on the spires and the odd setback.
    if (part > 1.5 && part < 2.5 && ((style > 0.5 && style < 1.5) || (style > 1.5 && fract(seed * 3.1) < 0.3))) {
      float up = clamp(1.0 - (vKind.z - vFacade.y) / max(vKind.w, 1.0), 0.0, 1.0);
      em += ${lit(CROWN_COLOR, CROWN_PEAK)} * (0.45 + 0.55 * up);
    }
  }
  // Red beacons on the needle tips, a slow pulse.
  if (part > 2.5 && vFacade.y > vKind.z - 0.18 * vKind.w) {
    em += ${lit(BEACON_COLOR, BEACON_PEAK)} * (0.6 + 0.4 * sin(uFarTime * 2.1 + seed * 40.0));
  }
  // The burning city: a share of towers ablaze from inside.
  if (vKind.y > 0.5 && !roof) {
    float fl = 0.7 + 0.3 * sin(uFarTime * 7.0 + vFacade.y * 0.3 + seed * 50.0);
    em += ${lit(EMBER_COLOR, EMBER_PEAK)} * fl * smoothstep(0.0, 0.6, burn);
  }
  // Never past the bloom threshold where a tower's lights stack (windows,
  // crown, embers): a luminance cap under 0.72 before the far fade.
  em *= min(1.0, 0.7 / max(dot(em, vec3(0.2126, 0.7152, 0.0722)), 1e-4));
  float vis = abFarVis(d) * vInfo.z;
  gl_FragColor = vec4(mix(fogC, col + em, vis), 1.0);
}
`;

/** Four stacked unit boxes without bottoms (shaft, two tiers, the needle),
 * x/z in [−1, 1], y in [0, 1]; `aPart` 0..3, drawn shaft first. */
function towerGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const part: number[] = [];
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
    [
      [0, 1, 0],
      [
        [-1, 1, 1],
        [1, 1, 1],
        [1, 1, -1],
        [-1, 1, -1],
      ],
    ],
  ];
  for (let p = 0; p < 4; p++) {
    for (const [n, quad] of faces) {
      const base = pos.length / 3;
      for (const v of quad) {
        pos.push(v[0] as number, v[1] as number, v[2] as number);
        nor.push(n[0] as number, n[1] as number, n[2] as number);
        part.push(p);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

/** Every slot out to FAR_MAX_RADIUS, sorted near → far (early-z, and a
 * tier's R_out is a prefix). Towers: 100 m cells (centre radius ≥ 700 m —
 * anything nearer is always inside the fog limit); spires: super-cells
 * (any that can reach past SPIRE_SINK). Returns the slots and, per tier
 * radius, the prefix length. */
export function farSlots(): {
  slots: Float32Array;
  prefix: (r: number) => number;
} {
  const list: { x: number; z: number; kind: number; r: number }[] = [];
  const n = Math.ceil((FAR_MAX_RADIUS + FAR_CELL) / FAR_CELL);
  for (let ix = -n; ix <= n; ix++) {
    for (let iz = -n; iz <= n; iz++) {
      const r = Math.hypot((ix + 0.5) * FAR_CELL, (iz + 0.5) * FAR_CELL);
      if (r < 700 || r > FAR_MAX_RADIUS + FAR_CELL) continue;
      list.push({ x: ix, z: iz, kind: 0, r });
    }
  }
  const m = Math.ceil(FAR_MAX_RADIUS / FAR_SUPER) + 1;
  for (let ix = -m; ix <= m; ix++) {
    for (let iz = -m; iz <= m; iz++) {
      // The super-cell's nearest and farthest points from its own centre.
      const r = Math.hypot((ix + 0.5) * FAR_SUPER, (iz + 0.5) * FAR_SUPER);
      if (r - FAR_SUPER > FAR_MAX_RADIUS) continue;
      list.push({ x: ix, z: iz, kind: 1, r: Math.max(0, r - FAR_SUPER) });
    }
  }
  list.sort((a, b) => a.r - b.r);
  const slots = new Float32Array(list.length * 3);
  list.forEach((s, i) => {
    slots[i * 3] = s.x;
    slots[i * 3 + 1] = s.z;
    slots[i * 3 + 2] = s.kind;
  });
  const prefix = (radius: number): number => {
    let k = 0;
    while (k < list.length && (list[k] as { r: number }).r <= radius + FAR_CELL)
      k++;
    return k;
  };
  return { slots, prefix };
}

// --- 2. Carpet -----------------------------------------------------------------

/** Carpet rings (geometric in radius) × azimuth segments. */
const CARPET_RINGS = 24;
const CARPET_SEGMENTS = 128;

const CARPET_VERTEX = /* glsl */ `
${COMMON_GLSL}
attribute vec2 aRing; // (0..1 along the radius, azimuth rad)
varying vec3 vShell;
void main() {
  float camY = max(cameraPosition.y, 0.0);
  // From where the ground is exactly at the fog limit, out past R_out.
  float r0 = sqrt(max(${f(FOG_DISTANCE * FOG_DISTANCE)} - camY * camY, 1.0)) - 2.0;
  float r = r0 * pow(${f(FAR_MAX_RADIUS + 200)} / r0, aRing.x);
  vec3 rel = vec3(cos(aRing.y) * r, -camY, sin(aRing.y) * r);
  vShell = abFarShell(rel);
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + vShell, 1.0);
}
`;

const CARPET_FRAGMENT = /* glsl */ `
${COMMON_GLSL}
varying vec3 vShell;
// A filtered line train: lines of half width \`hw\` every \`per\` m at x, given
// the pixel footprint \`fw\` (m) — its exact AA edge near, its mean coverage
// once the period is under a few pixels.
float abLines(float x, float per, float hw, float fw) {
  float dd = abs(x - per * floor(x / per + 0.5));
  float aa = max(fw, 0.01);
  float cov = clamp((hw - dd) / aa + 0.5, 0.0, 1.0);
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
  float dens = abFarDensity(w);
  float burn = abCityGlow.a;
  // Roofs and courtyards, warm speckle of lit windows and yards (40 m cells,
  // their mean once a cell is under ~3 px).
  vec2 sc = floor(w / 40.0);
  float sp = float(abFarHash(uvec2(mod(sc, ${f(FAR_PERIOD / 40)}))) & 0xffffu) / 65535.0;
  float speckK = 1.0 - smoothstep(4.0, 14.0, max(fw.x, fw.y));
  float speck = mix(0.5, sp, speckK) * (0.25 + 0.75 * dens);
  vec3 col = ${linear(ROOF)} * 0.55;
  vec3 em = ${lit(WINDOW_COLOR, 0.12)} * speck;
  // The street grid on the real 200 m lattice: sodium lines, brighter
  // crossings; quieter districts dimmer.
  float lx = abLines(w.x, ${f(BLOCK_PITCH)}, 4.0, fw.x);
  float lz = abLines(w.y, ${f(BLOCK_PITCH)}, 4.0, fw.y);
  float street = max(lx, lz) + 1.2 * lx * lz;
  em += ${lit(STREET_COLOR, STREET_PEAK)} * street * (0.45 + 0.55 * dens);
  // The river images (z ≡ the real channel mod the torus): dark water with
  // the glow's sheen, lamp lines along both banks, a light chain on every
  // bridge deck (one per north–south street, as in the real city).
  float zr = w.y - ${f(RIVER_CENTER_Z)};
  zr -= ${f(WORLD_SIZE)} * floor(zr / ${f(WORLD_SIZE)} + 0.5);
  float az = abs(zr);
  if (az < ${f(RIVER_HALF_WIDTH + 14)}) {
    float water = 1.0 - smoothstep(${f(RIVER_HALF_WIDTH - 1)}, ${f(RIVER_HALF_WIDTH + 1)}, az);
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
  // The burning city: blocks afire, flickering.
  if (burn > 0.0) {
    vec2 bc = floor(w / ${f(BLOCK_PITCH)});
    float bh = float(abFarHash(uvec2(mod(bc, ${f(FAR_PERIOD / BLOCK_PITCH)})) + uvec2(71u, 19u)) & 0xffffu) / 65535.0;
    // Patchy: the fire is in some of each burning block's 40 m cells.
    float fire = step(bh, 0.5 * burn) * step(0.55, mix(0.6, sp, speckK))
      * (0.6 + 0.4 * sin(uFarTime * 5.0 + bh * 80.0 + sp * 9.0));
    em += ${lit(EMBER_COLOR, EMBER_PEAK)} * fire;
  }
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
  private readonly prefix: (r: number) => number;
  private readonly geometry: THREE.InstancedBufferGeometry;

  /** `moonDir`: the dome's moon direction uniform, shared by reference. */
  constructor(moonDir: { value: THREE.Vector3 }) {
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uFarOrigin: FAR_ORIGIN,
      uFarOuter: { value: FAR_MAX_RADIUS },
      uFarPx: { value: 0.001 },
      uFarTime: { value: 0 },
      uFarMoon: moonDir,
      uFarCell: { value: new THREE.Vector2() },
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
    const { slots, prefix } = farSlots();
    this.prefix = prefix;
    this.geometry = towerGeometry() as THREE.InstancedBufferGeometry;
    this.geometry.setAttribute(
      "aSlot",
      new THREE.InstancedBufferAttribute(slots, 3),
    );
    this.geometry.instanceCount = prefix(FAR_MAX_RADIUS);
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

  /**
   * Once a frame, after the render camera is final: advance the unwrapped
   * offset from it (`dtSec`, the sim's clamped step, tells flight from a
   * cut), place the lattices, and the pixel scale the needles floor to.
   */
  update(
    camera: THREE.PerspectiveCamera,
    dtSec: number,
    viewportH: number,
    nowMs: number,
    shown: boolean,
  ): void {
    const p = camera.position;
    // Hidden with the dome (inside the cloud deck the fog IS the sky); the
    // carpet also below the street, where it would be seen from beneath.
    this.towers.visible = shown;
    this.carpet.visible = shown && p.y > 0;
    this.offset.advance(p, dtSec);
    const ux = this.offset.x;
    const uz = this.offset.z;
    FAR_ORIGIN.value.set(ux, uz);
    const u = this.uniforms;
    const cx = Math.floor(ux / FAR_CELL);
    const cz = Math.floor(uz / FAR_CELL);
    (u.uFarCell?.value as THREE.Vector2).set(cx, cz);
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
    (u.uFarTime as THREE.IUniform).value = (nowMs / 1000) % 3600;
  }

  /** O3: the tier's far radius — an instance-count prefix and a uniform
   * (rule 1: no compile). Dressing only, so it may differ per tier. */
  setQuality(tier: QualityTier): void {
    const r = QUALITY_PROFILES[tier].farSkyline;
    (this.uniforms.uFarOuter as THREE.IUniform).value = r;
    this.geometry.instanceCount = this.prefix(r);
  }
}
