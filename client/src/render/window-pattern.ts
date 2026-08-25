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

import { FacadeArchetype } from "./archetypes";

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
  /** Roof tone variation per building. */
  roofVar: number;
}

/** Concept 1 "Sparse Late Shift" — the approved tuning. */
export const FACADE: FacadeParams = {
  glass: {
    pitch: [3.2, 3.1],
    pane: [0.87, 0.76],
    lit: 0.3,
    cool: 0.62,
    blinds: 0.22,
    roomDepth: 3.4,
    grimeScale: 1.0,
  },
  masonry: {
    pitch: [3.5, 3.5],
    pane: [0.45, 0.42],
    lit: 0.2,
    cool: 0.06,
    blinds: 0.44,
    roomDepth: 2.2,
    grimeScale: 1.6,
  },
  office: {
    pitch: [5.2, 4.1],
    pane: [0.9, 0.5],
    lit: 0.26,
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
  darkFloor: 0.42,
  darkFloorLit: 0.03,
  brightFloor: 0.1,
  brightFloorLit: 0.95,
  buildingTempSwing: 0.4,
  floorTempSwing: 0.4,
  tempJitter: 0.18,
  brightSpread: 0.45,
  faceJitter: 0.09,
  aoHeight: 26,
  aoStrength: 0.5,
  streakWidth: 1,
  grimeDensity: 0.3,
  grimeStrength: 0.4,
  soot: 0.12,
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

/** Window cell pitch in meters after this building's per-building jitter. */
export function windowPitch(
  arch: FacadeArchetype,
  seed: number,
): [number, number] {
  const f = facadeFor(arch);
  const j = FACADE.pitchJitter;
  const s = seed * 61;
  return [
    f.pitch[0] * (1 - j + 2 * j * abHash(9, 13, s)),
    f.pitch[1] * (1 - j + 2 * j * abHash(5, 3, s)),
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
winPitch.y *= ${glslFloat(1 - FACADE.pitchJitter)} + ${glslFloat(2 * FACADE.pitchJitter)} * abHash(vec2(5.0, 3.0), vBSeed * 61.0);
winPitch.x *= ${glslFloat(1 - FACADE.pitchJitter)} + ${glslFloat(2 * FACADE.pitchJitter)} * abHash(vec2(9.0, 13.0), vBSeed * 61.0);

// Facade plane: side faces get (facade-run, height) meters; roofs none.
vec2 winGrid = vec2(1e6);
if (abs(vObjNormal.x) > 0.5) winGrid = vec2(vMeters.z, vMeters.y);
else if (abs(vObjNormal.z) > 0.5) winGrid = vec2(vMeters.x, vMeters.y);
float facade = 1.0 - step(1e5, abs(winGrid.x));
vec2 winCell = floor(winGrid / winPitch);
vec2 winF = fract(winGrid / winPitch);
// The pane inside its cell — mullions between panes stay dark.
vec2 paneLo = (1.0 - winPane) * 0.5;
vec2 paneHi = 1.0 - paneLo;
float pane = step(paneLo.x, winF.x) * step(winF.x, paneHi.x)
           * step(paneLo.y, winF.y) * step(winF.y, paneHi.y);

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
float winT = abHash(winCell + 7.0, vBSeed * 53.0);
float pCool = clamp(
  winCool + (bldT - 0.5) * ${glslFloat(FACADE.buildingTempSwing)} + (floorT - 0.5) * ${glslFloat(FACADE.floorTempSwing)},
  0.02, 0.98
);
float coolWin = step(winT, pCool);
float tJit = abHash(winCell + 31.0, vBSeed * 53.0);
// CONVEX mixes of WARM/COOL only: luminance is linear in colour, so every
// window stays at or below the peak ${intensity} was normalised for.
float mixT = mix(${glslFloat(FACADE.tempJitter)} * tJit, 1.0 - ${glslFloat(FACADE.tempJitter)} * tJit, coolWin);
vec3 winColor = mix(${warm}, ${cool}, mixT);

// Fake window interiors (interior mapping): raycast a room box behind every
// lit pane — parallax ceiling/floor/side/back walls, no geometry. Boxes never
// rotate, so the world-space view ray IS the facade-space ray. Every wall
// factor is < 1, so the interior peaks BELOW the flat pane the WINDOW rung
// was normalized for — the ladder ordering cannot be disturbed.
vec3 viewRay = normalize(vBWorldPos - cameraPosition);
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
vec3 roomLight = winColor * (0.85 + 0.15 * abHash(winCell, vBSeed * 31.0));
vec3 roomCol = tHit == tBack ? roomLight * 0.55
             : tHit == tV ? (rayUV.y > 0.0 ? roomLight * 0.9 : roomLight * 0.24)
             : roomLight * 0.38;
roomCol *= 1.0 - 0.45 * clamp(tHit / (roomDepth * 2.2), 0.0, 1.0);
// Some rooms draw their blinds: flat diffuse glow, no parallax.
float blinds = step(abHash(winCell + 3.0, vBSeed * 29.0), winBlinds);
// Per-window brightness spread: a real block is not one bulb repeated.
float dim = ${glslFloat(1 - FACADE.brightSpread)} + ${glslFloat(FACADE.brightSpread)} * winH;
vec3 litWindow = mix(roomCol * (0.55 + 0.45 * winH), winColor * (0.5 + 0.3 * winH), blinds) * dim;
vec3 windowGlow = pane * lit * litWindow * ${intensity} * ao;
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
float surround = step(paneLo.x - 0.08, winF.x) * step(winF.x, paneHi.x + 0.08)
               * step(paneLo.y - 0.1, winF.y) * step(winF.y, paneHi.y + 0.1);
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
// Roofs: darker than facades, varied per building so the top-down view is
// not one uniform slab color.
float roofTone = 0.5 - ${glslFloat(FACADE.roofVar)} * abHash(vec2(11.0, 5.0), vBSeed * 61.0);
diffuseColor.rgb *= mix(roofTone, faceJit * ao * soot, facade);
`;
}
