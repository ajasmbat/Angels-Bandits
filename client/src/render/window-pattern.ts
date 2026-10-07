// Facade window-pattern seam (ANGE-M763XM "C3 Facade realism"). The city is
// one InstancedMesh painted procedurally by the onBeforeCompile patch in
// buildings-material.ts, so there is no CPU-side geometry to assert on — the
// look lives entirely in generated GLSL. This module is the seam that makes it
// testable: ONE set of tuning constants (FACADE), a TypeScript mirror of the
// hashes and the lit/colour decisions the shader makes per window, and the
// GLSL emitters built from those same constants. Change a number here and the
// shader, the mirror and the tests all move together.
//
// Chosen design: "Concept 1 — Sparse Late Shift" (the human's pick at this
// ticket's sign-off gate): a mostly-dark city where the FLOOR is the unit —
// 42% of floors have gone home to a black band and 10% blaze on a late shift,
// with tenant zones correlating what is left. Warm-dominant, the most
// desaturated of the five palettes, moderate grime, and street AO measured
// against each building's OWN height so a 20 m BSP lot is grounded the same
// way a 200 m tower is.
//
// PRECISION NOTE: the mirror reproduces the shader's ALGORITHM, not its exact
// bits — GLSL evaluates these hashes in 32-bit highp while JS is 64-bit, and
// `sin` of a large argument diverges between them. Tests therefore assert
// distributions and invariants (lit fraction, clustering, convexity, finite
// pitch), never a specific window's on/off state on a specific GPU.

import * as THREE from "three";
import { AB_AA_GLSL } from "./aa-glsl";
import { FacadeArchetype } from "./archetypes";
import { emissiveBoost } from "./emissive";
import {
  TV_COLOR,
  livingColorGlsl,
  livingLitGlsl,
  livingShadeGlsl,
} from "./living-windows";
import {
  GARDEN_LIGHT_COLOR,
  PAD_LIGHT_COLOR,
  PARAPET_INSET,
  ROOF_ALBEDO,
  RoofKind,
  SKYLIGHT_COLOR,
} from "./roofs";

/** Per-archetype facade look: window grid, occupancy and light colour. */
export interface ArchetypeFacade {
  /** Window cell pitch in meters, [along the facade run, vertical]. */
  pitch: readonly [number, number];
  /** Pane size as a fraction of the cell — the rest is mullion. */
  pane: readonly [number, number];
  /** Baseline share of windows lit, before floor states and tenant zones. */
  lit: number;
  /** Baseline probability a lit window is cool fluorescent (vs warm). */
  cool: number;
  /** Share of lit windows with blinds drawn (flat glow, no parallax). */
  blinds: number;
  /** Fake interior depth for the parallax room box, meters. */
  roomDepth: number;
  /** Grime multiplier — concrete streaks worse than glass. */
  grimeScale: number;
}

/** The whole facade look as data. The shader is generated from this. */
export interface FacadeParams {
  glass: ArchetypeFacade;
  masonry: ArchetypeFacade;
  office: ArchetypeFacade;
  /** Per-building pitch jitter, ± this fraction (floor height / bay width). */
  pitchJitter: number;
  /** Tenant zone size in window cells: bays across × floors up. */
  zoneW: number;
  zoneH: number;
  /** Tenant-zone occupancy multiplier range: `lit * [zoneLo, zoneLo+zoneHi)`. */
  zoneLo: number;
  zoneHi: number;
  /** Share of floors that have gone home, and their residual lit share. */
  darkFloor: number;
  darkFloorLit: number;
  /** Share of floors on a late shift, and their lit share. */
  brightFloor: number;
  brightFloorLit: number;
  /** Colour-temperature swing added per building / per floor (±half each). */
  buildingTempSwing: number;
  floorTempSwing: number;
  /** Per-window hue jitter within the warm↔cool mix (stays convex). */
  tempJitter: number;
  /** Per-window brightness spread: lit windows dim to `1 - brightSpread`. */
  brightSpread: number;
  /** Per-face tone jitter amplitude — corners read in flat night light. */
  faceJitter: number;
  /** Upper bound on the street-AO fade height, meters. */
  aoHeight: number;
  /** AO strength at the pavement (0 = off, 1 = black). */
  aoStrength: number;
  /** Streak width as a multiple of the window bay. */
  streakWidth: number;
  /** Share of facade columns carrying a grime streak, and its strength. */
  grimeDensity: number;
  grimeStrength: number;
  /** Broad soot gradient over the lower facade. */
  soot: number;
  /** Roof albedo swing per building (VO3: roofs.ts rolls the tone). */
  roofVar: number;
}

/** Concept 1 "Sparse Late Shift" — the approved tuning, brightened by VO2
 * ("Neon Blue Hour", 2026-10-05): the human found the city too dark, so
 * fewer floors have gone home (42% → 30%), baseline occupancy is up ~6
 * points per archetype, and the street AO is lighter — at night the street
 * is a light source, not a shadow (the canyon bounce in buildings-material
 * now lifts the lower facades instead). */
export const FACADE: FacadeParams = {
  glass: {
    pitch: [3.2, 3.1],
    pane: [0.87, 0.76],
    lit: 0.36,
    cool: 0.62,
    blinds: 0.22,
    roomDepth: 3.4,
    grimeScale: 1.0,
  },
  masonry: {
    pitch: [3.5, 3.5],
    pane: [0.45, 0.42],
    lit: 0.28,
    cool: 0.06,
    blinds: 0.44,
    roomDepth: 2.2,
    grimeScale: 1.6,
  },
  office: {
    pitch: [5.2, 4.1],
    pane: [0.9, 0.5],
    lit: 0.32,
    cool: 0.38,
    blinds: 0.3,
    roomDepth: 3.0,
    grimeScale: 1.25,
  },
  pitchJitter: 0.16,
  zoneW: 3,
  zoneH: 3,
  zoneLo: 0.4,
  zoneHi: 1.5,
  darkFloor: 0.3,
  darkFloorLit: 0.03,
  brightFloor: 0.1,
  brightFloorLit: 0.95,
  buildingTempSwing: 0.4,
  floorTempSwing: 0.4,
  tempJitter: 0.18,
  brightSpread: 0.45,
  faceJitter: 0.09,
  aoHeight: 26,
  aoStrength: 0.22,
  streakWidth: 1,
  grimeDensity: 0.3,
  grimeStrength: 0.4,
  soot: 0.08,
  roofVar: 0.22,
};

/** Facade look for one archetype id (the `aArchetype` attribute value). */
export function facadeFor(arch: FacadeArchetype): ArchetypeFacade {
  if (arch === FacadeArchetype.OFFICE) return FACADE.office;
  if (arch === FacadeArchetype.MASONRY) return FACADE.masonry;
  return FACADE.glass;
}

/** GLSL float literal — the single formatter both emitters use. */
export const glslFloat = (n: number): string => n.toFixed(4);

const fract = (x: number) => x - Math.floor(x);

/** Mirror of the shader's `abHash(vec2 p, float s)`. */
export const abHash = (px: number, py: number, s: number): number =>
  fract(Math.sin((px + s * 61) * 127.1 + (py + s * 61) * 311.7) * 43758.5453);

/**
 * Mirror of `vBSeed`: seeded from the instance's DIMENSIONS, never its
 * translation — a building's translation shifts by WORLD_SIZE every time it
 * wraps past the torus seam, and seeding from it would repaint the facade
 * mid-flight (the seam rule every renderer in this repo follows).
 */
export const buildingSeed = (
  width: number,
  height: number,
  depth: number,
): number =>
  fract(Math.sin(width * 12.9898 + depth * 78.233 + height) * 43758.5453);

/**
 * L13: the pitch-jitter seed, BIT-EXACT on the GPU and in JS. `buildingSeed`
 * runs a large-argument `sin` that float32 and float64 disagree on, so it can
 * pick a lit pattern but never tell JS where the drawn rows are — and facade
 * detail (facade-detail.ts) must sit on them. This hashes the float32 BITS of
 * the tier's (w, h, d) with integer mixing (identical mod 2^32 in GLSL ES
 * 3.00 and under Math.imul) and keeps the top 24 bits, so the uint → float
 * step is exact too. Dimensions, never translation (the seam rule).
 */
const PITCH_MIX = [0x7feb352d, 0x846ca68b] as const;
const f32 = new Float32Array(1);
const f32Bits = new Uint32Array(f32.buffer);
const bitsOf = (v: number): number => {
  f32[0] = v;
  return f32Bits[0] as number;
};
const pitchMix = (x: number): number => {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, PITCH_MIX[0]);
  h ^= h >>> 15;
  h = Math.imul(h, PITCH_MIX[1]);
  h ^= h >>> 16;
  return h >>> 0;
};
export const pitchSeed = (
  width: number,
  height: number,
  depth: number,
): number =>
  (pitchMix(
    bitsOf(width) ^ pitchMix(bitsOf(height) ^ pitchMix(bitsOf(depth))),
  ) >>>
    8) /
  16777216;

/** GLSL twin of `pitchSeed` (vertex stage), from the same constants. */
export function pitchSeedGlsl(): string {
  return /* glsl */ `
uint abPitchMix(uint h) {
  h ^= h >> 16u;
  h *= ${PITCH_MIX[0]}u;
  h ^= h >> 15u;
  h *= ${PITCH_MIX[1]}u;
  h ^= h >> 16u;
  return h;
}
float abPitchSeed(vec3 dims) {
  uvec3 b = floatBitsToUint(dims);
  return float(abPitchMix(b.x ^ abPitchMix(b.y ^ abPitchMix(b.z))) >> 8u) / 16777216.0;
}
`;
}

/**
 * Window cell pitch in meters after this building's per-building jitter,
 * from its `pitchSeed`: x takes the seed, y its low 12 bits (`fract(seed ·
 * 4096)`, exact for a 24-bit seed) so the two jitters are independent.
 * Cells are measured from the TIER's horizontal centre and the tier's base
 * (the shader's vMeters frame).
 */
export function windowPitch(
  arch: FacadeArchetype,
  seed: number,
): [number, number] {
  const f = facadeFor(arch);
  const j = FACADE.pitchJitter;
  return [
    f.pitch[0] * (1 - j + 2 * j * seed),
    f.pitch[1] * (1 - j + 2 * j * fract(seed * 4096)),
  ];
}

/**
 * Probability that one window cell is lit, clustered the way the shader
 * clusters it: the floor's state wins outright (gone home / late shift),
 * otherwise the tenant zone scales the archetype's baseline occupancy.
 */
export function litProbability(
  arch: FacadeArchetype,
  seed: number,
  cellX: number,
  cellY: number,
): number {
  const s = seed * 61;
  const floorH = abHash(3, cellY, s);
  if (floorH < FACADE.darkFloor) return FACADE.darkFloorLit;
  if (floorH > 1 - FACADE.brightFloor) return FACADE.brightFloorLit;
  const zoneH = abHash(
    Math.floor(cellX / FACADE.zoneW) + 17,
    Math.floor(cellY / FACADE.zoneH) + 41,
    s,
  );
  const p = facadeFor(arch).lit * (FACADE.zoneLo + FACADE.zoneHi * zoneH);
  return Math.min(Math.max(p, 0), 0.97);
}

/** Is this window cell lit? (mirror of the shader's `lit` term.) */
export function isWindowLit(
  arch: FacadeArchetype,
  seed: number,
  cellX: number,
  cellY: number,
): boolean {
  return (
    abHash(cellX, cellY, seed * 61) <= litProbability(arch, seed, cellX, cellY)
  );
}

/**
 * L12 sky cycle: share of the night's lit windows that are switched on right
 * now (dusk: people still arriving; pre-dawn: thinning out). One shared
 * uniform for the buildings material; the cycle writes `.value` per frame.
 */
export const OCCUPANCY_UNIFORM = { value: 1 };
/**
 * M3 quality tier: 1 = the per-pane parallax room raycast, 0 = every lit
 * pane takes the room's mean light (the Mobile tier's cheaper far path). One
 * shared uniform for the buildings material; city.setQuality writes it.
 */
export const WIN_INTERIOR_UNIFORM = { value: 1 };
/** Occupancy span over which one window fades on/off. The cycle moves
 * occupancy ≤ 0.001 per second, so each window takes a few seconds to fade —
 * windows switch one at a time and never pop. */
export const OCCUPANCY_FADE = 0.004;

/**
 * How switched-on this window is at `occupancy` (0..1), mirroring the
 * shader: each window draws its OWN occupancy hash — not the brightness
 * hash — so thinning out removes windows evenly across the brightness
 * range, and at occupancy 1 every lit window is fully on.
 */
export function windowOccupied(
  seed: number,
  cellX: number,
  cellY: number,
  occupancy: number,
): number {
  const h = abHash(cellX + 59, cellY + 59, seed * 61);
  const t = Math.min(
    1,
    Math.max(0, (occupancy * (1 + OCCUPANCY_FADE) - h) / OCCUPANCY_FADE),
  );
  return t * t * (3 - 2 * t);
}

/**
 * Probability that a lit window reads cool fluorescent rather than warm
 * incandescent: the archetype's bias, shifted per building (a warm law
 * office over a cool trading floor) and again per floor.
 */
export function coolProbability(
  arch: FacadeArchetype,
  seed: number,
  cellY: number,
): number {
  const s = seed * 53;
  const bldT = abHash(21, 2, s);
  const floorT = abHash(9, cellY, s);
  const p =
    facadeFor(arch).cool +
    (bldT - 0.5) * FACADE.buildingTempSwing +
    (floorT - 0.5) * FACADE.floorTempSwing;
  return Math.min(Math.max(p, 0.02), 0.98);
}

/**
 * Where this window sits on the WARM→COOL line, mirroring the shader. Always
 * in [0, 1]: the shader only ever takes CONVEX mixes of the two palette
 * colours, which is what keeps every window at or below the WINDOW rung the
 * emissive intensity was normalised for (luminance is linear in colour).
 */
export function windowColorMix(
  arch: FacadeArchetype,
  seed: number,
  cellX: number,
  cellY: number,
): number {
  const s = seed * 53;
  const cool =
    abHash(cellX + 7, cellY + 7, s) <= coolProbability(arch, seed, cellY);
  const tJit = abHash(cellX + 31, cellY + 31, s);
  const j = FACADE.tempJitter * tJit;
  return cool ? 1 - j : j;
}

/** Vertical distance over which street AO fades out on this instance. */
export const aoFadeHeight = (tierHeight: number): number =>
  Math.min(Math.max(tierHeight * 0.45, 6), FACADE.aoHeight);

// --- GLSL emitters -------------------------------------------------------
// Everything below is generated from FACADE above, so the shader can never
// drift from the mirror the tests exercise.

const archBlock = (f: ArchetypeFacade) => /* glsl */ `
  winPitch = vec2(${glslFloat(f.pitch[0])}, ${glslFloat(f.pitch[1])});
  winPane = vec2(${glslFloat(f.pane[0])}, ${glslFloat(f.pane[1])});
  winLit = ${glslFloat(f.lit)};
  winCool = ${glslFloat(f.cool)};
  winBlinds = ${glslFloat(f.blinds)};
  roomDepth = ${glslFloat(f.roomDepth)};
  grimeScale = ${glslFloat(f.grimeScale)};`;

/**
 * Archetype params, the window grid, and the CLUSTERED occupancy decision.
 * Emitted into the `color_fragment` slot: the locals it declares stay in
 * scope for the emissive block below (same shader main body).
 */
export function windowGridGlsl(): string {
  return /* glsl */ `
vec2 winPitch = vec2(${glslFloat(FACADE.glass.pitch[0])}, ${glslFloat(FACADE.glass.pitch[1])});
vec2 winPane = vec2(${glslFloat(FACADE.glass.pane[0])}, ${glslFloat(FACADE.glass.pane[1])});
float winLit = ${glslFloat(FACADE.glass.lit)};
float winCool = ${glslFloat(FACADE.glass.cool)};
float winBlinds = ${glslFloat(FACADE.glass.blinds)};
float roomDepth = ${glslFloat(FACADE.glass.roomDepth)};
float grimeScale = ${glslFloat(FACADE.glass.grimeScale)};
float winInset = 0.0;
if (vArch > 1.5) {                 // OFFICE — strip windows, mixed light${archBlock(FACADE.office)}
} else if (vArch > 0.5) {          // MASONRY — small punched windows, warm${archBlock(FACADE.masonry)}
  winInset = 1.0;
}
// Per-building floor height and bay width: a block of BSP lots must read as
// many buildings, not one wall with one window grid stamped across it.
// L13: from the bit-exact vPitchSeed, so JS (windowPitch) knows the rows.
winPitch.y *= ${glslFloat(1 - FACADE.pitchJitter)} + ${glslFloat(2 * FACADE.pitchJitter)} * fract(vPitchSeed * 4096.0);
winPitch.x *= ${glslFloat(1 - FACADE.pitchJitter)} + ${glslFloat(2 * FACADE.pitchJitter)} * vPitchSeed;

// Facade plane: side faces get (facade-run, height) meters; roofs none.
vec2 winGrid = vec2(1e6);
if (abs(vObjNormal.x) > 0.5) winGrid = vec2(vMeters.z, vMeters.y);
else if (abs(vObjNormal.z) > 0.5) winGrid = vec2(vMeters.x, vMeters.y);
float facade = 1.0 - step(1e5, abs(winGrid.x));
${holeMaskGlsl()}vec2 winCell = floor(winGrid / winPitch);
vec2 winF = fract(winGrid / winPitch);
// O1 anti-aliasing: facade meters per pixel, (run, height). Taken from the
// continuous object meters (winGrid is 1e6 on roofs, so its own derivative
// is garbage along every roof edge), at the top level — never in a branch.
// On a side face one of x/z is constant, so the max is the run axis.
vec3 winMAA = fwidth(vMeters);
vec2 wAA = vec2(max(winMAA.x, winMAA.z), winMAA.y);
// 1 until one window cell is ~3 px, 0 once it is ~1.5 px: from there every
// per-cell decision is replaced by its expected value, so a distant facade
// is a stable average instead of a sparkle. Up close nothing changes.
float winDetail = min(abCellDetail(winPitch.x, wAA.x), abCellDetail(winPitch.y, wAA.y));
// The pane inside its cell — mullions between panes stay dark. A filtered
// box (sub-pixel edges up close), fading to its area share far away.
vec2 paneLo = (1.0 - winPane) * 0.5;
vec2 paneHi = 1.0 - paneLo;
vec2 paneAA = wAA / winPitch;            // cell fraction per pixel
vec2 paneD = abs(winF - 0.5) - winPane * 0.5;
vec2 paneCov = 1.0 - smoothstep(-0.5 * paneAA, 0.5 * paneAA, paneD);
float pane = mix(winPane.x * winPane.y, paneCov.x * paneCov.y, winDetail);

// --- CLUSTERED occupancy: floor state, then tenant zone, then the window ---
// Real towers do not scatter their lit windows independently: a floor has
// gone home or is on a late shift, and within an ordinary floor a tenant's
// bays light up together. Both scales apply before the per-window coin flip.
float floorH = abHash(vec2(3.0, winCell.y), vBSeed * 61.0);
float zoneH = abHash(
  vec2(floor(winCell.x / ${glslFloat(FACADE.zoneW)}) + 17.0, floor(winCell.y / ${glslFloat(FACADE.zoneH)}) + 41.0),
  vBSeed * 61.0
);
float winH = abHash(winCell, vBSeed * 61.0);
float pLit = clamp(winLit * (${glslFloat(FACADE.zoneLo)} + ${glslFloat(FACADE.zoneHi)} * zoneH), 0.0, 0.97);
if (floorH < ${glslFloat(FACADE.darkFloor)}) pLit = ${glslFloat(FACADE.darkFloorLit)};
else if (floorH > ${glslFloat(1 - FACADE.brightFloor)}) pLit = ${glslFloat(FACADE.brightFloorLit)};
float lit = step(winH, pLit) * facade;
${livingLitGlsl()}// L12 sky cycle: tonight's occupancy, own hash per window, soft switch.
float occH = abHash(winCell + 59.0, vBSeed * 61.0);
lit *= smoothstep(occH, occH + ${glslFloat(OCCUPANCY_FADE)}, uOccupancy * ${glslFloat(1 + OCCUPANCY_FADE)});
// O1: the per-window decision (coin flip, L3 crossfade, L12 occupancy)
// resolves to the floor's lit share once the cell is sub-pixel, and the
// floor's share to the building's expected share once a FLOOR (or a tenant
// zone) is — otherwise sub-pixel floors would still sparkle row against
// row. Expected values (occupancy's is uOccupancy: its threshold is
// uniform), so the distant glow — and the bloom it feeds — keeps its energy.
float litMean = ${glslFloat(FACADE.darkFloor * FACADE.darkFloorLit + FACADE.brightFloor * FACADE.brightFloorLit)}
  + ${glslFloat(1 - FACADE.darkFloor - FACADE.brightFloor)} * min(winLit * ${glslFloat(FACADE.zoneLo + 0.5 * FACADE.zoneHi)}, 0.97);
float floorDetail = min(abCellDetail(winPitch.y, wAA.y), abCellDetail(winPitch.x * ${glslFloat(FACADE.zoneW)}, wAA.x));
float pLitAA = mix(litMean, pLit, floorDetail);
lit = mix(pLitAA * clamp(uOccupancy, 0.0, 1.0) * facade, lit, winDetail);
`;
}

/**
 * Window colour temperature + the lit-pane emissive. `warm`/`cool` are the
 * linear palette colours and `intensity` the WINDOW-rung boost, both passed
 * in from buildings-material.ts so the emissive ladder stays owned there.
 */
export function windowEmissiveGlsl(
  warm: string,
  cool: string,
  intensity: string,
): string {
  return /* glsl */ `
// Colour temperature: a per-building bias, a per-floor swing (one floor is a
// warm law office over a cool trading floor), then per-window jitter.
float floorT = abHash(vec2(9.0, winCell.y), vBSeed * 53.0);
float bldT = abHash(vec2(21.0, 2.0), vBSeed * 53.0);
float pCool = clamp(
  winCool + (bldT - 0.5) * ${glslFloat(FACADE.buildingTempSwing)} + (floorT - 0.5) * ${glslFloat(FACADE.floorTempSwing)},
  0.02, 0.98
);
// O1: past the cell's resolution limit the per-window temperature is its
// expected value (per floor, then per building) — still a convex mix.
float pCoolB = clamp(winCool + (bldT - 0.5) * ${glslFloat(FACADE.buildingTempSwing)}, 0.02, 0.98);
float mixMean = mix(${glslFloat(FACADE.tempJitter * 0.5)}, ${glslFloat(1 - FACADE.tempJitter * 0.5)}, mix(pCoolB, pCool, floorDetail));
// The far-field colour: the expected temperature, untouched by the per-cell
// TV swap below (a sub-pixel TV cell must not sparkle either).
vec3 winColorMean = mix(${warm}, ${cool}, mixMean);
vec3 viewRay = normalize(vBWorldPos - cameraPosition);
// Some rooms draw their blinds: flat diffuse glow, no parallax.
float blinds = step(abHash(winCell + 3.0, vBSeed * 29.0), winBlinds);
// O1: the parallax room, the blinds and the brightness spread are per-cell
// detail too; far away a lit window is their mean (a lit cell's winH is
// uniform on [0, pLit), so its mean is pLit / 2; the room averages ~0.45 of
// its light over walls, floor and ceiling).
float winHMean = 0.5 * pLitAA;
vec3 litMeanCol = mix(winColorMean * ${glslFloat(0.45)} * (0.55 + 0.45 * winHMean), winColorMean * (0.5 + 0.3 * winHMean), winBlinds)
  * (${glslFloat(1 - FACADE.brightSpread)} + ${glslFloat(FACADE.brightSpread)} * winHMean);
vec3 litWindow = litMeanCol;
// O4: everything per WINDOW below — its temperature, the L3 TV, the parallax
// room, the brightness spread — is mixed in by winDetail, so where a cell is
// sub-pixel (winDetail 0: most of a distant skyline at Retina) it was all
// computed and then multiplied by zero. The branch skips it there. It is
// coherent in screen space (winDetail follows distance), takes no derivative
// (wAA is taken above, at the top level), and is bit-identical: the old
// mix(litMeanCol, x, 0.0) already returned litMeanCol exactly.
if (winDetail > 0.0) {
  float winT = abHash(winCell + 7.0, vBSeed * 53.0);
  float coolWin = step(winT, pCool);
  float tJit = abHash(winCell + 31.0, vBSeed * 53.0);
  // CONVEX mixes of WARM/COOL only: luminance is linear in colour, so every
  // window stays at or below the peak ${intensity} was normalised for.
  float mixT = mix(${glslFloat(FACADE.tempJitter)} * tJit, 1.0 - ${glslFloat(FACADE.tempJitter)} * tJit, coolWin);
  mixT = mix(mixMean, mixT, winDetail);
  vec3 winColor = mix(${warm}, ${cool}, mixT);
${livingColorGlsl(glslVec3(TV_COLOR))}
  // Fake window interiors (interior mapping): raycast a room box behind every
  // lit pane — parallax ceiling/floor/side/back walls, no geometry. Boxes never
  // rotate, so the world-space view ray IS the facade-space ray. Every wall
  // factor is < 1, so the interior peaks BELOW the flat pane the WINDOW rung
  // was normalized for — the ladder ordering cannot be disturbed.
  vec3 roomLight = winColor * (0.85 + 0.15 * abHash(winCell, vBSeed * 31.0));
  // M3: with uWinInterior off (the Mobile tier) every pane takes the room's
  // average light — the same 0.45 the distance fade below already ends on —
  // and skips the raycast. A uniform branch (coherent, no derivatives inside),
  // so the tier switch compiles nothing.
  vec3 roomCol = roomLight * 0.45;
  if (uWinInterior > 0.5) {
    float rayIn = 1.0;
    vec2 rayUV = vec2(0.0);
    if (abs(vObjNormal.x) > 0.5) {
      rayIn = -sign(vObjNormal.x) * viewRay.x;
      rayUV = vec2(viewRay.z, viewRay.y);
    } else if (abs(vObjNormal.z) > 0.5) {
      rayIn = -sign(vObjNormal.z) * viewRay.z;
      rayUV = vec2(viewRay.x, viewRay.y);
    }
    vec2 cellMeters = winF * winPitch;
    float tBack = roomDepth / max(rayIn, 0.03);
    float tU = ((rayUV.x > 0.0 ? winPitch.x : 0.0) - cellMeters.x) / abSafeDiv(rayUV.x);
    float tV = ((rayUV.y > 0.0 ? winPitch.y : 0.0) - cellMeters.y) / abSafeDiv(rayUV.y);
    float tHit = min(tBack, min(tU, tV));
    roomCol = tHit == tBack ? roomLight * 0.55
            : tHit == tV ? (rayUV.y > 0.0 ? roomLight * 0.9 : roomLight * 0.24)
            : roomLight * 0.38;
    roomCol *= 1.0 - 0.45 * clamp(tHit / (roomDepth * 2.2), 0.0, 1.0);
  }
  // Per-window brightness spread: a real block is not one bulb repeated.
  float dim = ${glslFloat(1 - FACADE.brightSpread)} + ${glslFloat(FACADE.brightSpread)} * winH;
  litWindow = mix(roomCol * (0.55 + 0.45 * winH), winColor * (0.5 + 0.3 * winH), blinds) * dim;
  litWindow = mix(litMeanCol, litWindow, winDetail);
}
${livingShadeGlsl()}vec3 windowGlow = pane * lit * litWindow * ${intensity} * ao;
// Unlit panes catch a faint grazing-angle sky sheen (far below the bloom
// threshold — a glassy read, not a light source).
float sheenF = pow(1.0 - clamp(abs(dot(viewRay, vObjNormal)), 0.0, 1.0), 3.0);
windowGlow += pane * (1.0 - lit) * facade * vec3(0.35, 0.5, 0.7) * sheenF * 0.05;
`;
}

/**
 * Weathering, diffuse only: per-face tone jitter, street AO measured against
 * the instance's OWN height, grime streaks of varied width/start/run, a broad
 * soot gradient, and a varied roof tone.
 */
export function weatheringGlsl(): string {
  return /* glsl */ `
// MASONRY punched windows read as deep holes: darken a surround ring around
// the pane (diffuse only — the lit glow is emissive and unaffected).
vec2 surroundCov = 1.0 - smoothstep(-0.5 * paneAA, 0.5 * paneAA, paneD - vec2(0.08, 0.1));
float surround = mix(
  min(winPane.x + 0.16, 1.0) * min(winPane.y + 0.2, 1.0),
  surroundCov.x * surroundCov.y,
  winDetail
);
diffuseColor.rgb *= 1.0 - winInset * surround * facade * 0.6;
// Per-face tone jitter: each box face gets a slightly different value (and
// opposite faces differ), so corners read even in flat night light.
float faceId = abs(vObjNormal.x) > 0.5 ? (vObjNormal.x > 0.0 ? 0.0 : 1.0)
             : abs(vObjNormal.z) > 0.5 ? (vObjNormal.z > 0.0 ? 2.0 : 3.0)
             : 4.0;
float faceJit = 1.0 + ${glslFloat(FACADE.faceJitter)} * (abHash(vec2(faceId, 7.0), vBSeed * 61.0) * 2.0 - 1.0)
              - 0.05 * mod(faceId, 2.0);
// Street AO measured against the instance's OWN height: a 20 m BSP lot must
// not come out uniformly dark just because the constant was written for a
// 120 m tower. vWorldY (never wraps — Y has no seam) puts upper tiers, whose
// bases sit far above the street, safely out of the fade.
float aoH = clamp(vBHeight * 0.45, 6.0, ${glslFloat(FACADE.aoHeight)});
float ao = 1.0 - ${glslFloat(FACADE.aoStrength)} * (1.0 - clamp(vWorldY / aoH, 0.0, 1.0));
// Grime: streaks of varied width, start height and run length, running DOWN
// from a sill or ledge. Measured in TIER-LOCAL meters (vMeters.y) so a
// setback tier weathers like the building it sits on rather than coming out
// clean because its base is already above every streak.
float colId = floor(winGrid.x / max(winPitch.x * ${glslFloat(FACADE.streakWidth)}, 0.5));
float streakTop = mix(8.0, max(vBHeight, 8.0), abHash(vec2(colId, 91.0), vBSeed * 61.0));
float streakLen = mix(6.0, 40.0, abHash(vec2(colId, 103.0), vBSeed * 61.0));
float streak = step(abHash(vec2(colId, 77.0), vBSeed * 61.0), ${glslFloat(FACADE.grimeDensity)})
  * clamp((streakTop - vMeters.y) / streakLen, 0.0, 1.0) * step(vMeters.y, streakTop) * facade;
// Broad soot gradient over the lower facade, on top of the streaks.
float soot = clamp(
  1.0 - ${glslFloat(FACADE.grimeStrength)} * grimeScale * streak
      - ${glslFloat(FACADE.soot)} * (1.0 - clamp(vWorldY / 90.0, 0.0, 1.0)) * facade,
  0.15, 1.0
);
// Facades only — roofs are repainted from scratch by roofSurfaceGlsl().
diffuseColor.rgb *= mix(1.0, faceJit * ao * soot, facade);
`;
}

// --- VO3 roofs & crowns --------------------------------------------------
// Roof paint and architectural light, generated from roofs.ts (which decides
// WHAT each roof is) and ROOF below (how big things are). All roof geometry
// is in the tier's OBJECT meters (vMeters.xz, origin at the tier centre), so
// nothing swims when the instance jumps to another torus image.

/** Roof pattern sizes, meters. */
export const ROOF = {
  /** Coping pavers run from the parapet to this far in. */
  copingWidth: 1.6,
  /** Membrane strip width (seams run along the roof's long axis). */
  stripWidth: 2.6,
  seamHalf: 0.05,
  /** Gravel blotch scale, and the broad stain scale every roof shares. */
  gravelScale: 1.6,
  stainScale: 9,
  /** Skylight grid: pitch and glazing half-size (x, z), frame width. */
  skyPitch: [7.0, 9.5] as const,
  skyHalf: [1.5, 2.6] as const,
  skyFrame: 0.25,
  /** Skylights keep this far from the roof edge. */
  skyMargin: 3,
  /** Share of skylights glowing from the floor below. */
  skyLit: 0.7,
  /** Garden: bed pitch and half-size (x, z), bed margin from the edge. */
  bedPitch: [6.0, 4.2] as const,
  bedHalf: [2.3, 1.4] as const,
  bedMargin: 2.5,
  bollardRadius: 0.22,
  /** Helipad: deck margin past the circle, ring/H proportions, lights. */
  deckPad: 1.8,
  ringHalf: 0.05,
  padLights: 12,
  padLightOffset: 1.1,
  padLightRadius: 0.32,
  /** LED lines: half-widths and where they sit. */
  ledHalf: 0.18,
  ledStripDrop: 0.6,
  ledStripHalf: 0.15,
  ledRingInset: PARAPET_INSET + 0.15,
  ledRingHalf: 0.15,
  /** Crown floodlights: one fixture per bay along the facade. */
  crownBay: 6,
} as const;

const glslVec3 = (c: { r: number; g: number; b: number }): string =>
  `vec3(${glslFloat(c.r)}, ${glslFloat(c.g)}, ${glslFloat(c.b)})`;
const vec2Lit = (v: readonly [number, number]): string =>
  `vec2(${glslFloat(v[0])}, ${glslFloat(v[1])})`;

/** Helpers for the roof emitters and the O1 window AA — emitted into the
 * fragment pars. */
export function roofParsGlsl(): string {
  return /* glsl */ `
float abNoise(vec2 p, float s) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(abHash(i, s), abHash(i + vec2(1.0, 0.0), s), f.x),
             mix(abHash(i + vec2(0.0, 1.0), s), abHash(i + vec2(1.0, 1.0), s), f.x), f.y);
}
${AB_AA_GLSL}`;
}

/**
 * Roof surface (diffuse) + the LED/crown masks the emissive block consumes.
 * Emitted AFTER weatheringGlsl() into the colour slot: it reads the window
 * grid locals (`facade`, `winGrid`, `pane`, `lit`) and declares the roof
 * locals the emissive half reads (`roofUp`, `skyGlow`, `padLight`,
 * `bollard`, `led`, `crownK`). Derivatives are taken at the top level only —
 * never inside a branch (undefined in non-uniform control flow).
 */
export function roofSurfaceGlsl(): string {
  const A = ROOF_ALBEDO;
  return /* glsl */ `
// --- VO3 roof surface ---
// A sill's top face points up but is a hole floor, not a roof (H1).
float roofUp = (1.0 - facade) * step(0.5, vObjNormal.y) * (1.0 - holeLining);
vec3 mAA = fwidth(vMeters);                 // meters per pixel, per axis
// Horizontal meters per pixel: the roof plane, or the facade run (on a side
// face one of x/z is constant, so the max is the run axis).
float rPix = max(max(mAA.x, mAA.z), 1e-4);
vec2 rP = vMeters.xz;
float rEdge = min(vHalfXZ.x - abs(rP.x), vHalfXZ.y - abs(rP.y));
float rKind = vRoof.x;
float skyGlow = 0.0;
float padLight = 0.0;
float bollard = 0.0;
vec3 roofAlbedo = ${glslVec3(A.membrane)};
if (roofUp > 0.5) {
  // Long axis first: membrane seams and the helipad H run along it.
  vec2 rL = vHalfXZ.x >= vHalfXZ.y ? rP : rP.yx;
  float rStain = abNoise(rP / ${glslFloat(ROOF.stainScale)}, vBSeed * 17.0);
  if (rKind < ${glslFloat(RoofKind.GRAVEL - 0.5)}) {
    // Single-ply membrane: welded strips, a seam every strip, per-strip tone.
    float sU = rL.y / ${glslFloat(ROOF.stripWidth)};
    float sSeam = abLine((0.5 - abs(fract(sU) - 0.5)) * ${glslFloat(ROOF.stripWidth)}, ${glslFloat(ROOF.seamHalf)}, rPix);
    float sTone = abHash(vec2(floor(sU), 3.0), vBSeed * 13.0) * 2.0 - 1.0;
    roofAlbedo = ${glslVec3(A.membrane)} * (1.0 + 0.06 * sTone * abDetail(${glslFloat(ROOF.stripWidth)}, rPix))
      * (1.0 - 0.2 * sSeam) * (0.86 + 0.28 * rStain);
  } else if (rKind < ${glslFloat(RoofKind.SKYLIGHTS - 0.5)}) {
    // Gravel ballast: blotchy fine grain over broad drifts.
    float gN = abNoise(rP / ${glslFloat(ROOF.gravelScale)}, vBSeed * 23.0) - 0.5;
    roofAlbedo = ${glslVec3(A.gravel)} * (1.0 + 0.3 * gN * abDetail(${glslFloat(ROOF.gravelScale)}, rPix))
      * (0.84 + 0.32 * rStain);
  } else if (rKind < ${glslFloat(RoofKind.GARDEN - 0.5)}) {
    // Skylights: a grid of framed glazing over membrane, kept off the edge.
    vec2 kPitch = ${vec2Lit(ROOF.skyPitch)};
    vec2 kHalf = ${vec2Lit(ROOF.skyHalf)};
    vec2 kId = floor(rP / kPitch + 0.5);
    vec2 kLocal = rP - kId * kPitch;
    vec2 kRoom = vHalfXZ - ${glslFloat(ROOF.skyMargin)} - kHalf;
    float kFits = step(abs(kId.x * kPitch.x), kRoom.x) * step(abs(kId.y * kPitch.y), kRoom.y);
    float kFrame = abBox(kLocal, kHalf + ${glslFloat(ROOF.skyFrame)}, rPix) * kFits;
    float kGlass = abBox(kLocal, kHalf, rPix) * kFits;
    roofAlbedo = mix(${glslVec3(A.membrane)} * (0.86 + 0.28 * rStain), ${glslVec3(A.coping)}, kFrame);
    roofAlbedo = mix(roofAlbedo, ${glslVec3(A.skyGlass)}, kGlass);
    skyGlow = kGlass * step(abHash(kId + 5.0, vBSeed * 37.0), ${glslFloat(ROOF.skyLit)})
      * (0.75 + 0.25 * abHash(kId + 9.0, vBSeed * 41.0));
  } else if (rKind < ${glslFloat(RoofKind.HELIPAD - 0.5)}) {
    // Roof garden: planted beds on a paver grid, bollards at the crossings.
    vec2 gPitch = ${vec2Lit(ROOF.bedPitch)};
    vec2 gLocal = (fract(rP / gPitch) - 0.5) * gPitch;
    float gIn = step(${glslFloat(ROOF.bedMargin)}, rEdge);
    float gBed = abBox(gLocal, ${vec2Lit(ROOF.bedHalf)}, rPix) * gIn;
    float gLeaf = abNoise(rP / 1.3, vBSeed * 29.0);
    roofAlbedo = mix(${glslVec3(A.path)} * (0.9 + 0.2 * rStain),
                     ${glslVec3(A.bed)} * (0.6 + 0.8 * mix(0.5, gLeaf, abDetail(1.3, rPix))), gBed);
    vec2 gCorner = gPitch * 0.5 - abs(gLocal);
    float gR = ${glslFloat(ROOF.bollardRadius)};
    bollard = gIn * step(abHash(floor(rP / gPitch + 0.5), vBSeed * 43.0), 0.5)
      * (1.0 - smoothstep(gR - rPix, gR + rPix, length(gCorner)))
      * min(1.0, (gR * gR) / (rPix * rPix));
  } else {
    // Helipad: dark deck, yellow touchdown circle, white H along the long
    // axis, green perimeter lights. Radius mirrors roofs.ts helipadRadius().
    float hR = 0.62 * (min(vHalfXZ.x, vHalfXZ.y) - ${glslFloat(PARAPET_INSET)});
    float hRr = length(rP);
    float hDeck = 1.0 - smoothstep(hR + ${glslFloat(ROOF.deckPad)} - rPix, hR + ${glslFloat(ROOF.deckPad)} + rPix, hRr);
    float hRing = abLine(abs(hRr - hR), ${glslFloat(ROOF.ringHalf)} * hR, rPix);
    float hH = max(
      abBox(vec2(rL.x, abs(rL.y) - 0.3 * hR), vec2(0.42 * hR, 0.07 * hR), rPix),
      abBox(rL, vec2(0.07 * hR, 0.3 * hR), rPix)
    );
    roofAlbedo = mix(${glslVec3(A.membrane)} * (0.86 + 0.28 * rStain), ${glslVec3(A.deck)} * (0.9 + 0.2 * rStain), hDeck);
    roofAlbedo = mix(roofAlbedo, ${glslVec3(A.padYellow)}, hRing);
    roofAlbedo = mix(roofAlbedo, ${glslVec3(A.padWhite)}, hH);
    float hRl = hR + ${glslFloat(ROOF.padLightOffset)};
    float hSeg = (fract(atan(rP.y, rP.x) / 6.2831853 * ${glslFloat(ROOF.padLights)}) - 0.5)
      * 6.2831853 * hRl / ${glslFloat(ROOF.padLights)};
    float hLr = ${glslFloat(ROOF.padLightRadius)};
    padLight = (1.0 - smoothstep(hLr - rPix, hLr + rPix, length(vec2(hSeg, hRr - hRl))))
      * min(1.0, (hLr * hLr) / (rPix * rPix));
  }
  // Coping pavers between the parapet and the deck, every roof kind.
  float cope = 1.0 - smoothstep(${glslFloat(ROOF.copingWidth)} - rPix, ${glslFloat(ROOF.copingWidth)} + rPix, rEdge);
  roofAlbedo = mix(roofAlbedo, ${glslVec3(A.coping)}, cope);
  roofAlbedo *= 1.0 - ${glslFloat(FACADE.roofVar)} * vRoof.z;
}
diffuseColor.rgb = mix(diffuseColor.rgb, roofAlbedo, roofUp);

// --- VO3 LED outline mask (0..1, convex: the emissive block REPLACES with it)
// Vertical tier corners, a strip just under the parapet (clear of its 0.2 m
// sink), and a ring on the roof just inside the parapet.
float ledOn = step(1e-3, vLed.r + vLed.g + vLed.b);
float ledRunHalf = abs(vObjNormal.x) > 0.5 ? vHalfXZ.y : vHalfXZ.x;
float ledCorner = abLine(max(ledRunHalf - abs(winGrid.x), 0.0), ${glslFloat(ROOF.ledHalf)}, rPix);
float ledStrip = abLine(abs(vMeters.y - (vBHeight - ${glslFloat(ROOF.ledStripDrop)})), ${glslFloat(ROOF.ledStripHalf)}, max(mAA.y, 1e-4));
float ledRing = abLine(abs(rEdge - ${glslFloat(ROOF.ledRingInset)}), ${glslFloat(ROOF.ledRingHalf)}, rPix);
float led = ledOn * clamp(max(ledCorner, ledStrip) * facade + ledRing * roofUp, 0.0, 1.0);
// The strip IS the light: no diffuse under it, so lit facade + LED never stack.
diffuseColor.rgb *= 1.0 - led;

// --- VO3 crown floodlight wash (top tier of the tallest towers) ---
// Fixtures on the ledge below the crown throw scalloped cones up the top
// floors: bright just above the fixture line, fading with height, a scallop
// per bay that fades to its mean with distance. Lit panes already emit, so
// the wash skips them; glass takes less of it than the wall.
float crownD = vRoof.y;
float crownZ = vMeters.y - (vBHeight - crownD);
float crownU = (fract(winGrid.x / ${glslFloat(ROOF.crownBay)}) - 0.5) * ${glslFloat(ROOF.crownBay)};
float crownSpread = 0.8 + 0.4 * max(crownZ, 0.0);
float crownScallop = mix(0.6, 0.35 + 0.65 * exp(-(crownU * crownU) / (crownSpread * crownSpread)),
  abDetail(${glslFloat(ROOF.crownBay)}, rPix));
float crownK = step(0.5, crownD) * facade * smoothstep(0.0, 1.5, crownZ)
  * mix(exp(-max(crownZ, 0.0) / max(crownD * 0.6, 1.0)), 1.0, 0.3)
  * crownScallop * (1.0 - pane * lit) * (1.0 - 0.5 * pane);
`;
}

/**
 * Architectural light, appended to the emissive slot AFTER the VO2 bounce
 * (so the LED replacement also overrides the bounce): crown wash (light ×
 * the facade's own albedo), skylight/pad/bollard glow, then the LED outline
 * replacing whatever the pixel emitted — a convex mix, so the brightest
 * pixel is max(existing rung, LED rung), never their sum.
 */
export function roofLightGlsl(): string {
  return /* glsl */ `
totalEmissiveRadiance += diffuseColor.rgb * vCrown * crownK;
totalEmissiveRadiance += roofUp * (skyGlow * ${glslVec3(SKYLIGHT_COLOR)}
  + padLight * ${glslVec3(PAD_LIGHT_COLOR)} + bollard * ${glslVec3(GARDEN_LIGHT_COLOR)});
totalEmissiveRadiance = mix(totalEmissiveRadiance, vLed, led);
`;
}

// --- H1 fly-through holes -------------------------------------------------
// A holed tier is drawn as walls + lintel + sill (city.ts), all painted in the
// PARENT tier's frame, and every one of them carries the tier's hole as
// `vHole` = (across offset, half width, floor above the tier base, ±height —
// + travels along x, − along z; 0 = no hole). From that one vec4 each
// fragment knows whether it lines the hole or frames its mouth, so the
// pattern needs no per-face flags and an unholed tier pays one branchless
// mask that comes out 0.

/** Hole sizes and tuning, meters. */
export const HOLE = {
  /** Windows stop this far short of a mouth opening — no half-cut panes. */
  reveal: 2.4,
  /** LED frame line: centred this far outside the opening, half-width. */
  frameOffset: 0.9,
  frameHalf: 0.22,
  /** Rim ring just inside each mouth, on the lining. */
  rimDepth: 0.6,
  rimHalf: 0.2,
  /** Ceiling lights: dashed line down the lintel's underside. */
  ceilingPitch: 7,
  ceilingDuty: 0.45,
  ceilingHalf: 0.3,
  ceilingGain: 0.55,
  /** Lining concrete: panel joints along the tunnel, depth falloff (AO). */
  panel: 4,
  aoDepth: 14,
  aoFloor: 0.3,
} as const;

/** Tunnel-lining albedo, linear: weathered board-formed concrete. */
export const HOLE_LINING = new THREE.Color(0.11, 0.105, 0.1);
/** The mouth frame's luminance — the VO3 LED rung, under EMISSIVE_SIGN. */
export const HOLE_LED_LUMINANCE = 0.9;
/** Mouth frame colour: a cool white that reads against every facade hue,
 * boosted to exactly HOLE_LED_LUMINANCE. */
export const HOLE_LED_COLOR = new THREE.Color(0.7, 0.9, 1.0).multiplyScalar(
  emissiveBoost(new THREE.Color(0.7, 0.9, 1.0), HOLE_LED_LUMINANCE),
);

/**
 * Which fragments line a hole, and which frame its mouth. Emitted right after
 * the facade mask (before any window is lit), and it takes those fragments
 * OFF the facade: no windows, shop band, bounce, grime, LED corners or crown
 * wash inside a hole or around its opening.
 */
export function holeMaskGlsl(): string {
  return /* glsl */ `
// --- H1 hole mask (parent-tier meters) ---
float holeH = abs(vHole.w);
float holeOn = step(1e-3, holeH);
float holeX = step(0.0, vHole.w);              // 1: travels along x
float holeAlong = mix(vMeters.z, vMeters.x, holeX);
float holeAcross = mix(vMeters.x, vMeters.z, holeX);
float holeHalfLen = mix(vHalfXZ.y, vHalfXZ.x, holeX);
// Normal along the travel axis = a mouth face (the tier's end facades).
float holeMouthFace = step(0.5, abs(mix(vObjNormal.z, vObjNormal.x, holeX)));
// Signed distance to the opening's rectangle (across, height); < 0 inside.
vec2 holeQ = vec2(abs(holeAcross - vHole.x) - vHole.y,
                  abs(vMeters.y - vHole.z - 0.5 * holeH) - 0.5 * holeH);
float holeSd = max(holeQ.x, holeQ.y);
// Lining: the walls, floor and ceiling of the hole itself.
float holeLining = holeOn * (1.0 - holeMouthFace) * step(holeSd, 0.02);
// Reveal: the band of mouth facade around the opening.
float holeReveal = holeOn * holeMouthFace * step(holeSd, ${glslFloat(HOLE.reveal)});
// Meters in from the nearer mouth.
float holeDepth = holeHalfLen - abs(holeAlong);
facade *= 1.0 - max(holeLining, holeReveal);
`;
}

/** Lining albedo (diffuse), after the roof pass: concrete panels darkening
 * with depth — there are no shadows, so the AO is what makes it a tunnel. */
export function holeSurfaceGlsl(): string {
  return /* glsl */ `
// --- H1 hole lining ---
float holePanel = abHash(vec2(floor(holeAlong / ${glslFloat(HOLE.panel)}), 7.0), vBSeed * 19.0);
float holeJoint = abLine((0.5 - abs(fract(holeAlong / ${glslFloat(HOLE.panel)}) - 0.5)) * ${glslFloat(HOLE.panel)}, 0.04, rPix);
float holeAo = mix(${glslFloat(HOLE.aoFloor)}, 1.0, exp(-max(holeDepth, 0.0) / ${glslFloat(HOLE.aoDepth)}));
vec3 holeAlbedo = ${glslVec3(HOLE_LINING)} * (0.85 + 0.3 * holePanel) * (1.0 - 0.35 * holeJoint) * holeAo;
diffuseColor.rgb = mix(diffuseColor.rgb, holeAlbedo, holeLining);
// The frame strip IS the light: no diffuse under it (the VO3 LED rule).
float holePix = max(rPix, max(mAA.y, 1e-4));
float holeFrame = holeReveal * abLine(abs(holeSd - ${glslFloat(HOLE.frameOffset)}), ${glslFloat(HOLE.frameHalf)}, holePix);
float holeRim = holeLining * abLine(abs(holeDepth - ${glslFloat(HOLE.rimDepth)}), ${glslFloat(HOLE.rimHalf)}, holePix);
float holeCeil = holeLining * step(vObjNormal.y, -0.5)
  * abLine(abs(holeAcross - vHole.x), ${glslFloat(HOLE.ceilingHalf)}, holePix)
  // Segments on for the first ceilingDuty of every pitch — filtered (O1).
  * mix(${glslFloat(HOLE.ceilingDuty)},
        abLine(abPeriodic(holeAlong, ${glslFloat(0.5 * HOLE.ceilingDuty * HOLE.ceilingPitch)}, ${glslFloat(HOLE.ceilingPitch)}), ${glslFloat(0.5 * HOLE.ceilingDuty * HOLE.ceilingPitch)}, holePix),
        abDetail(${glslFloat(HOLE.ceilingPitch)}, holePix));
float holeLed = clamp(max(max(holeFrame, holeRim), holeCeil * ${glslFloat(HOLE.ceilingGain)}), 0.0, 1.0);
diffuseColor.rgb *= 1.0 - holeLed;
`;
}

/** The mouth frame, rim and ceiling lights — a convex replacement like the
 * VO3 LEDs, so the brightest pixel is HOLE_LED_LUMINANCE, never a sum. */
export function holeLightGlsl(): string {
  return /* glsl */ `
totalEmissiveRadiance = mix(totalEmissiveRadiance, ${glslVec3(HOLE_LED_COLOR)}, holeLed);
`;
}
