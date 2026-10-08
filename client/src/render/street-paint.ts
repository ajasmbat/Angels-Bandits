// G1 street-level paint: the ground shader's road wear and markings, the
// sidewalk flags, ramps and grates — GLSL spliced into sky.ts's GroundPlane
// at three points (see GROUND_FRAGMENT_MAIN there). Same contract as the S1
// paint: canonical world XZ, every offset from the street contract or the
// G1 layout seam (street-detail.ts), hashes keyed mod their world period so
// the paint tiles across the torus seam.
//
// THE CURB PLAN IS BAKED, NOT MIRRORED. `curbPlanWords()` packs street-
// detail.ts's seed-free curbPlanFor() into a const int table at module load,
// so a parking line, a red curb or a BUS STOP box can never disagree with the
// parked cars, hydrants and shelters drawn over them.
//
// Cost and distance (the O1 AA rules, plus an early-out):
//  - no new fwidth(): everything takes the top-level `abAA` (m per pixel);
//  - every repeating or scattered feature is filtered (abLine / abEdge /
//    abBox / box-filtered glyphs) and fades by its own SIZE;
//  - the scattered fine detail (patches, trenches, stains, manholes, drains,
//    arrows, words, bike icons, tiles, grates) sits inside ONE coherent
//    branch, `abAA < STREET_PAINT_FAR_AA`. That threshold is half the
//    largest faded size (a 6 m patch), so at the branch boundary every
//    feature has already resolved to its MEAN — and the else-path multiplies
//    exactly those means in, so the average tone is continuous across the
//    cut (no ring). Long lines that must survive distance (stop bars, bike
//    lanes, the parking line, the tyre tracks — abLine keeps them
//    mean-correct at any range) are drawn outside the branch;
//  - `uStreetPaint` (a uniform — quality.ts rule 1: a tier switch compiles
//    nothing) turns all of it off on Mobile, which keeps the S1/VO5 paint.

import { CITY_GRID } from "@angels-bandits/common/city";
import { GROUND_SITE } from "@angels-bandits/common/city/nature";
import {
  CROSSWALK_DEPTH,
  CURB_LINE,
  FURNITURE_LINE,
  LANE_CENTERS,
  ROADWAY_HALF,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import * as THREE from "three";
import {
  BIKE_LANE_IN,
  BIKE_LANE_OUT,
  BUS_ZONE_AFTER,
  BUS_ZONE_BEFORE,
  CORNER_CLEAR,
  CURB_SHADER,
  HYDRANT_CLEAR,
  PARKING_LINE,
  SIDES_PER_WORD,
  bikeLaneWord,
  curbPlanWords,
  treePits,
} from "./street-detail";

/** The quality tier's switch, shared by reference into the ground program. */
export const STREET_PAINT_UNIFORM = { value: 1 };

/** m per pixel beyond which the fine detail is skipped (see the header):
 * half the largest faded feature size, the 6 m patch. */
export const STREET_PAINT_FAR_AA = 3.0;

// The means the fine detail resolves to — and the else-path applies. Each is
// 1 − coverage × (1 − tone), with the expected coverage written down so a
// later tuning pass keeps the two in step:
/** Patches: 18 % of 10 m cells × ~0.58 of the cell × ~0.47 of the half
 * roadway ≈ 4.9 % coverage, mean tone 0.936 (60 % fresh 0.8 / 40 % old
 * 1.14), plus ~0.07 % of sealant seams at 0.65. */
export const PATCH_MEAN = 1 - 0.049 * 0.064 - 0.0007 * 0.35;
/** Utility trenches: 5 % of cells × 0.9 m / 10 m ≈ 0.45 %, tone 1.16. */
export const TRENCH_MEAN = 1 + 0.0045 * 0.16;
/** Oil stains: ~14 % of 4 m cells × ~0.9 m² effective / 60 m² at 0.55. */
export const STAIN_MEAN = 1 - 0.0021 * 0.45;
/** The road's far-field factor: the three above. */
export const ROAD_MEAN = PATCH_MEAN * TRENCH_MEAN * STAIN_MEAN;
/** Sidewalk flags: two 5 cm joint families every 1.25 m (7.8 % coverage)
 * at 1 − JOINT_DARK; the per-flag tone jitter has mean 1. */
const TILE = 1.25;
const TILE_JOINT = 0.025;
/** How much a joint darkens the flag, 0..1. */
const JOINT_DARK = 0.42;
export const TILE_MEAN =
  1 -
  JOINT_DARK * ((2 * (2 * TILE_JOINT)) / TILE - ((2 * TILE_JOINT) / TILE) ** 2);

/** Linear-space GLSL literal for an sRGB hex. */
const col = (hex: number): string => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};
const num = (v: number): string => v.toFixed(4);

const C = {
  manhole: col(0x2c2e35),
  drain: col(0x0c0d11),
  white: col(0xd2d9e6),
  yellow: col(0xd9b23a),
  red: col(0xa8352e),
  bike: col(0x1d4a35),
  ramp: col(0x3a3d4e),
  tactile: col(0x8a7a3a),
  grate: col(0x15161b),
  soil: col(0x1c1712),
  paver: col(0x2b2a35),
} as const;

/** White marking emissive lift (~0.45 peak luminance, sub-bloom — the same
 * rule as the S1 markings), yellow's a little lower. The ground's
 * GROUND_LUMA_CAP bounds whatever stacks anyway. */
const MARK_GLOW = "0.6";
const YELLOW_GLOW = "0.35";

const LANE = LANE_CENTERS[1];
const G = {
  P: num(BLOCK_PITCH),
  grid: `${CITY_GRID}`,
  gridF: num(CITY_GRID),
  lane: num(LANE),
  curb: num(CURB_LINE),
  road: num(ROADWAY_HALF),
  xwalkOut: num(ROADWAY_HALF + CROSSWALK_DEPTH),
  corner: num(CORNER_CLEAR),
  parking: num(PARKING_LINE),
  bikeIn: num(BIKE_LANE_IN),
  bikeOut: num(BIKE_LANE_OUT),
  furniture: num(FURNITURE_LINE),
  hydClear: num(HYDRANT_CLEAR),
  hydPlus: num(CURB_SHADER.hydrant[1]),
  hydMinus: num(CURB_SHADER.hydrant[-1]),
  busPlus0: num(CURB_SHADER.busStations[1][0]),
  busPlus1: num(CURB_SHADER.busStations[1][1]),
  busMinus0: num(CURB_SHADER.busStations[-1][0]),
  busMinus1: num(CURB_SHADER.busStations[-1][1]),
  busBefore: num(BUS_ZONE_BEFORE),
  busAfter: num(BUS_ZONE_AFTER),
  far: num(STREET_PAINT_FAR_AA),
  site: `${GROUND_SITE}`,
} as const;

const words = curbPlanWords();
const pitsPlus = treePits(1);
const pitsMinus = treePits(-1);
const pitList = (p: number[]) =>
  `vec3(${[0, 1, 2].map((i) => num(p[i] ?? -1000)).join(", ")})`;

// 3×5 bitmap glyphs, row-major from the TOP row, bit 14 = top-left.
const GLYPHS: Record<string, string[]> = {
  B: ["110", "101", "110", "101", "110"],
  U: ["101", "101", "101", "101", "111"],
  S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"],
  O: ["111", "101", "101", "101", "111"],
  P: ["111", "101", "111", "100", "100"],
  N: ["101", "111", "111", "111", "101"],
  L: ["100", "100", "100", "100", "111"],
  Y: ["101", "101", "010", "010", "010"],
};
const GLYPH_ORDER = Object.keys(GLYPHS);
const glyphBits = GLYPH_ORDER.map((k) =>
  Number.parseInt((GLYPHS[k] as string[]).join(""), 2),
);
/** Word id → glyph indices (padded to 4). */
const WORDS: Record<string, number> = { STOP: 0, ONLY: 1, BUS: 2 };
const wordGlyphs = ["STOP", "ONLY", "BUS"].map((w) =>
  [...w.padEnd(4, " ")].map((ch) => (ch === " " ? 0 : GLYPH_ORDER.indexOf(ch))),
);
/** Lit share of each word's bounding box — what it resolves to far away. */
const wordMean = ["STOP", "ONLY", "BUS"].map((w) => {
  let lit = 0;
  for (const ch of w) {
    for (const row of GLYPHS[ch] as string[])
      lit += [...row].filter((b) => b === "1").length;
  }
  return lit / ((4 * w.length - 1) * 5);
});

/** Declarations, spliced after the ground's own fragment pars. */
export const STREET_PAINT_PARS = /* glsl */ `
// --- G1 street paint (street-paint.ts) ---
uniform float uStreetPaint;
const int AB_CURB[${words.length}] = int[${words.length}](${words.join(", ")});
const int AB_BIKE = ${bikeLaneWord()};
const int AB_GLYPH[${glyphBits.length}] = int[${glyphBits.length}](${glyphBits.join(", ")});
const int AB_WORD[12] = int[12](${wordGlyphs.flat().join(", ")});
const float AB_WORD_MEAN[3] = float[3](${wordMean.map(num).join(", ")});
// The 4-bit curb code of one street side (street-detail.ts curbCode):
// bit 0 parking, 1 bus stop, 2 bus slot, 3 hydrant (0 only on a bridge).
int abCurbCode(int axisIdx, float line, float seg, float side) {
  int l = int(mod(line, ${G.gridF}));
  int s = int(mod(seg, ${G.gridF}));
  int i = ((axisIdx * ${G.grid} + l) * ${G.grid} + s) * 2 + (side > 0.0 ? 0 : 1);
  int w = i / ${SIDES_PER_WORD};
  return (AB_CURB[w] >> ((i - w * ${SIDES_PER_WORD}) * 4)) & 15;
}
bool abBikeLane(int axisIdx, float line) {
  int l = int(mod(line, ${G.gridF}));
  return ((AB_BIKE >> (axisIdx * ${G.grid} + l)) & 1) == 1;
}
// One glyph pixel of a word: c.x columns from the left, c.y rows from the top.
float abWordBit(int word, int len, ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.y > 4 || c.x >= len * 4 - 1) return 0.0;
  int ch = c.x / 4;
  int colI = c.x - ch * 4;
  if (colI == 3) return 0.0;
  int g = AB_GLYPH[AB_WORD[word * 4 + ch]];
  return float((g >> (14 - (c.y * 3 + colI))) & 1);
}
// A road word in its driver frame: g.x to the driver's right, g.y forward,
// centred; px = glyph pixel size (across, along), m. Box-filtered over the
// pixel footprint (w <= 1 glyph pixel), then resolved to the word's mean
// coverage over its box once a glyph pixel is sub-pixel, then faded out
// with the box itself — all before STREET_PAINT_FAR_AA.
float abRoadWord(int word, int len, vec2 g, vec2 px, float aa) {
  vec2 size = vec2(float(len * 4 - 1), 5.0) * px;
  float boxM = abBox(g, size * 0.5, aa);
  if (boxM <= 0.0) return 0.0;
  vec2 q = vec2(g.x + size.x * 0.5, size.y * 0.5 - g.y) / px;
  vec2 w = min(vec2(aa) / px, vec2(1.0));
  vec2 lo = q - 0.5 * w;
  vec2 hi = q + 0.5 * w;
  ivec2 i0 = ivec2(floor(lo));
  ivec2 i1 = ivec2(floor(hi));
  float acc = 0.0;
  for (int dy = 0; dy < 2; dy++) {
    for (int dx = 0; dx < 2; dx++) {
      ivec2 c = i0 + ivec2(dx, dy);
      if (c.x > i1.x || c.y > i1.y) continue;
      vec2 ov = max(min(hi, vec2(c) + 1.0) - max(lo, vec2(c)), 0.0);
      acc += abWordBit(word, len, c) * ov.x * ov.y;
    }
  }
  float sharp = acc / (w.x * w.y);
  float txt = mix(AB_WORD_MEAN[word] * boxM, sharp, abDetail(px.x * 2.0, aa));
  return txt * abDetail(size.y, aa);
}
// Distance to segment ab.
float abSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// A lane arrow in its driver frame (g.x right, g.y forward, centred on the
// arrow): kind 0 straight, 1 turn left, 2 turn right. Filtered, ~4.8 m long.
float abArrow(vec2 g, int kind, float aa) {
  float shaft = abBox(g - vec2(0.0, -0.9), vec2(0.15, 1.5), aa);
  if (kind == 0) {
    float hw = 0.6 * clamp((2.4 - g.y) / 1.8, 0.0, 1.0);
    float head = (1.0 - abEdge(hw, abs(g.x), aa)) * abEdge(0.6, g.y, aa) * (1.0 - abEdge(2.4, g.y, aa));
    return max(shaft, head);
  }
  float s = kind == 1 ? -1.0 : 1.0;
  // Shaft up, then the bar turns toward the side and ends in a head.
  float bar = abBox(vec2(g.x - s * 0.55, g.y - 0.45), vec2(0.7, 0.15), aa);
  float hx = s * g.x - 1.25;
  float hw = 0.55 * clamp((0.75 - hx) / 0.75, 0.0, 1.0);
  float head = (1.0 - abEdge(hw, abs(g.y - 0.45), aa)) * abEdge(0.0, hx, aa) * (1.0 - abEdge(0.75, hx, aa));
  return max(max(shaft, bar), head);
}
// A painted bicycle (read standing up by an approaching cyclist) and the
// chevron ahead of it, in its frame (g.x right, g.y forward).
float abBikeIcon(vec2 g, float aa) {
  float w = 0.045;
  float wheels = max(
    abLine(abs(length(g - vec2(-0.5, 0.0)) - 0.3), w, aa),
    abLine(abs(length(g - vec2(0.5, 0.0)) - 0.3), w, aa));
  vec2 hubR = vec2(-0.5, 0.0);
  vec2 hubF = vec2(0.5, 0.0);
  vec2 crank = vec2(-0.02, 0.02);
  vec2 seat = vec2(-0.18, 0.48);
  vec2 bars = vec2(0.36, 0.5);
  float d = min(min(abSeg(g, hubR, crank), abSeg(g, crank, seat)),
    min(min(abSeg(g, seat, bars), abSeg(g, crank, bars)),
        min(abSeg(g, bars, hubF), abSeg(g, hubR, seat))));
  float frame = abLine(d, w, aa);
  float chev = abLine(min(abSeg(g, vec2(-0.4, 1.0), vec2(0.0, 1.35)), abSeg(g, vec2(0.4, 1.0), vec2(0.0, 1.35))), 0.07, aa);
  return max(max(wheels, frame), chev);
}
`;

/**
 * Road base, spliced in the roadway branch right after S1's wear mask: the
 * street frame every G1 road block shares, the tyre tracks (outside the
 * early-out — abLine keeps them mean-correct), then the fine scattered wear.
 */
export const STREET_ROAD_BASE_GLSL = /* glsl */ `
// --- G1 road base (street-paint.ts) ---
bool abGOn = uStreetPaint > 0.5;
bool abGCore = abRoadX * abRoadZ > 0.5; // the intersection box
// The street frame: travel axis, offset off the centreline, the side and its
// segment, travel direction and the distance to the intersection ahead.
float abGAxisZ = abRoadX; // 1 on a north–south street (travel axis z)
float abGAlong = abGAxisZ > 0.5 ? vWorldXZ.y : vWorldXZ.x;
float abGCross = abGAxisZ > 0.5 ? abDx : abDz;
float abGAcr = abs(abGCross);
float abGSide = abGCross >= 0.0 ? 1.0 : -1.0;
float abGLine = floor((abGAxisZ > 0.5 ? vWorldXZ.x : vWorldXZ.y) / ${G.P} + 0.5);
float abGSeg = floor(abGAlong / ${G.P});
float abGLa = abGAlong - abGSeg * ${G.P};
// Right-hand traffic as traffic.ts lays it out: a z street's +x half drives +z.
float abGDir = abGAxisZ > 0.5 ? abGSide : -abGSide;
float abGAhead = abGDir > 0.0 ? ${G.P} - abGLa : abGLa;
float abGOff = abGAxisZ > 0.5 ? abAdz : abAdx; // to the crossing centreline
float abGKeyLine = mod(abGLine, ${G.gridF}) + (abGAxisZ > 0.5 ? 0.0 : 20.0);
int abGCode = abGOn ? abCurbCode(abGAxisZ > 0.5 ? 0 : 1, abGLine, abGSeg, abGSide) : 0;
float abGPark = (abGOn && !abGCore && (abGCode & 1) == 1) ? 1.0 : 0.0;
// Wear shows in the WET look too: at a grazing view the road is mostly the
// VO5 sky sheen, so tracks (drier, where tyres squeeze the water out),
// patches and stains also scale the wetness.
float abGWetK = 1.0;
if (abGOn && !abGCore) {
  // Tyre tracks: two polished wheel paths per lane, darker toward the stop
  // line where everyone brakes; a slow periodic swell (WORLD-periodic, so
  // seam-safe) breaks them up.
  float abGTrack = max(
    abLine(abs(abGAcr - (${G.lane} - 0.8)), 0.28, abAA),
    abLine(abs(abGAcr - (${G.lane} + 0.8)), 0.28, abAA));
  float abGBrake = 1.0 - smoothstep(20.0, 70.0, abGAhead);
  float abGSwell = 0.5 + 0.5 * sin(abGAlong * 0.1163 + abGKeyLine * 1.7);
  float abGTrackK = abGTrack * (0.08 + 0.1 * abGBrake) * (0.55 + 0.45 * abGSwell);
  abPaint *= 1.0 - abGTrackK;
  abGWetK *= 1.0 - 3.0 * abGTrackK;
}
if (abGOn && abAA < ${G.far}) {
  vec2 abGP = vec2(abGAlong, abGAcr);
  // Patches: repaved rectangles in one lane of a 10 m cell, a fresh (darker)
  // or an old (greyer) asphalt, outlined by a sealant seam.
  float abGCell = floor(abGAlong / 10.0);
  vec2 abGK = vec2(mod(abGCell, 200.0) + (abGSide > 0.0 ? 0.5 : 0.0), abGKeyLine);
  float abGPatch = 1.0;
  if (!abGCore && abHash(abGK + 1.3) < 0.18) {
    float abGA0 = 1.0 + 3.0 * abHash(abGK + 2.1);
    float abGLen = min(3.0 + 5.5 * abHash(abGK + 3.7), 9.0 - abGA0);
    bool abGCurbLane = abHash(abGK + 4.9) < 0.4;
    vec2 abGLo = vec2(abGCell * 10.0 + abGA0, abGCurbLane ? 7.6 : 0.5);
    vec2 abGHi = vec2(abGLo.x + abGLen, abGCurbLane ? 14.6 : 7.4);
    vec2 abGQ = abGP - (abGLo + abGHi) * 0.5;
    vec2 abGH = (abGHi - abGLo) * 0.5;
    float abGIn = abBox(abGQ, abGH, abAA);
    float abGSeam = abGIn * (1.0 - abBox(abGQ, abGH - 0.07, abAA));
    float abGTone = abHash(abGK + 6.1) < 0.6 ? 0.8 : 1.14;
    abGPatch = mix(1.0, abGTone, abGIn) * (1.0 - 0.35 * abGSeam);
  }
  // Utility trenches: a cut-and-filled strip across the whole street.
  float abGTrench = 1.0;
  if (abHash(vec2(mod(abGCell, 200.0), abGKeyLine) + 50.0) < 0.05) {
    abGTrench = 1.0 + 0.16 * abBox(vec2(abGAlong - (abGCell * 10.0 + 5.0), 0.0), vec2(0.45, 1.0), abAA);
  }
  // Oil stains: drips between the wheel paths (more at the stop line) and
  // under the parked cars.
  float abGCellS = floor(abGAlong / 4.0);
  vec2 abGKS = vec2(mod(abGCellS, 500.0), abGKeyLine * 2.0 + (abGSide > 0.0 ? 1.0 : 0.0)) + 90.0;
  float abGStain = 1.0;
  float abGSProb = 0.1 + 0.25 * (1.0 - smoothstep(20.0, 45.0, abGAhead));
  if (!abGCore && abHash(abGKS) < abGSProb) {
    vec2 abGSC = vec2(abGCellS * 4.0 + 0.5 + 3.0 * abHash(abGKS + 1.1),
      abHash(abGKS + 3.3) < 0.3 && abGPark > 0.5 ? 13.6 + (abHash(abGKS + 4.4) - 0.5)
                                                 : ${G.lane} + (abHash(abGKS + 2.2) - 0.5) * 1.1);
    float abGR = 0.3 + 0.6 * abHash(abGKS + 5.5);
    float abGD = length((abGP - abGSC) * vec2(0.7, 1.0));
    abGStain = 1.0 - 0.45 * (1.0 - smoothstep(abGR * 0.4, abGR, abGD));
  }
  float abGWearF = mix(${num(PATCH_MEAN)}, abGPatch, abDetail(6.0, abAA))
    * mix(${num(TRENCH_MEAN)}, abGTrench, abDetail(1.8, abAA))
    * mix(${num(STAIN_MEAN)}, abGStain, abDetail(2.4, abAA));
  abPaint *= abGWearF;
  abGWetK *= abGWearF * abGWearF;
  if (!abGCore) {
    // Manholes: a cast-iron disc in a lane every few 20 m cells, rim and grid.
    float abGCellM = floor(abGAlong / 20.0);
    vec2 abGKM = vec2(mod(abGCellM, 100.0), abGKeyLine * 2.0 + (abGSide > 0.0 ? 1.0 : 0.0)) + 70.0;
    vec2 abGMC = vec2(abGCellM * 20.0 + 3.0 + 14.0 * abHash(abGKM + 1.0), 1.4 + 5.6 * abHash(abGKM + 2.0));
    float abGMLa = mod(abGMC.x, ${G.P});
    if (abHash(abGKM) < 0.45 && min(abGMLa, ${G.P} - abGMLa) > ${G.xwalkOut} + 1.0) {
      vec2 abGMQ = abGP - abGMC;
      float abGMD = length(abGMQ);
      float abGMF = abDetail(1.2, abAA);
      float abGCover = (1.0 - abEdge(0.36, abGMD, abAA)) * abGMF;
      float abGRim = abLine(abs(abGMD - 0.33), 0.03, abAA) * abGMF;
      float abGGrid = mix(0.25, max(abLine(abPeriodic(abGMQ.x, 0.0, 0.11), 0.018, abAA),
        abLine(abPeriodic(abGMQ.y, 0.0, 0.11), 0.018, abAA)), abDetail(0.11, abAA));
      abPaint = mix(abPaint, ${C.manhole} * (1.0 - 0.35 * abGGrid), abGCover);
      abPaint *= 1.0 - 0.4 * abGRim;
    }
    // Storm drains: slotted grates in the gutter just past each crosswalk.
    float abGDrainA = min(abs(abGLa - 22.5), abs(abGLa - (${G.P} - 22.5)));
    float abGDrain = abBox(vec2(abGDrainA, abGAcr - (${G.curb} - 0.28)), vec2(0.48, 0.24), abAA) * abDetail(1.0, abAA);
    float abGSlots = mix(0.5, abLine(abPeriodic(abGLa, 0.0, 0.12), 0.03, abAA), abDetail(0.12, abAA));
    abPaint = mix(abPaint, ${C.drain} * (1.0 + 1.6 * (1.0 - abGSlots)), abGDrain);
  }
} else if (abGOn) {
  abPaint *= ${num(ROAD_MEAN)};
  abGWetK *= ${num(ROAD_MEAN * ROAD_MEAN)};
}
abWet *= abGWetK;
`;

/**
 * Road markings, spliced at the end of the outside-the-intersection block,
 * after the S1 zebra/dash/edge lines: stop bars, arrows and words, bike
 * lanes, the parking line + bay ticks, bus-stop boxes.
 */
export const STREET_ROAD_MARK_GLSL = /* glsl */ `
// --- G1 road markings (street-paint.ts) ---
if (abGOn) {
  float abGWhite = 0.0;
  float abGYellow = 0.0;
  bool abGApproach = abGAhead < ${G.P} * 0.5;
  // Stop bar across the approach half, just past the crosswalk.
  float abGAcrossHalf = abEdge(0.3, abGAcr, abAA) * (1.0 - abEdge(${G.curb} - 0.5, abGAcr, abAA));
  if (abGApproach) {
    abGWhite = max(abGWhite, abLine(abs(abGAhead - (${G.xwalkOut} + 0.55)), 0.25, abAA) * abGAcrossHalf);
  }
  // Bike lanes (whole street lines): a green band with white edge lines.
  bool abGBikeOn = abBikeLane(abGAxisZ > 0.5 ? 0 : 1, abGLine) && abGOff > ${G.xwalkOut};
  if (abGBikeOn) {
    float abGBand = abEdge(${G.bikeIn}, abGAcr, abAA) * (1.0 - abEdge(${G.bikeOut}, abGAcr, abAA));
    abPaint = mix(abPaint, ${C.bike}, abGBand * 0.6 * abWear);
    abGWhite = max(abGWhite, max(abLine(abs(abGAcr - ${G.bikeIn}), 0.07, abAA),
      abLine(abs(abGAcr - ${G.bikeOut}), 0.07, abAA)) * abWear);
  }
  // The parking line replaces the lane-edge line along a parking side.
  float abGInZone = abEdge(${G.corner}, abGLa, abAA) * (1.0 - abEdge(${G.P} - ${G.corner}, abGLa, abAA));
  if (abGPark > 0.5) {
    abGWhite = max(abGWhite, abLine(abs(abGAcr - ${G.parking}), 0.06, abAA) * abGInZone * abWear);
  }
  if (abAA < ${G.far}) {
    vec2 abGKA = vec2(abGKeyLine * 2.0 + (abGSide > 0.0 ? 1.0 : 0.0), mod(abGSeg, ${G.gridF})) + 30.0;
    // Approach markings: arrows, ONLY, STOP — one layout per approach.
    if (abGApproach && abGOff > ${G.xwalkOut}) {
      float abGKind = abHash(abGKA);
      float abGGx = ${G.lane} - abGAcr; // the driver's right (curb on the left)
      if (abGKind < 0.7) {
        int abGArrowK = abGKind < 0.35 ? 0 : abGKind < 0.55 ? 1 : 2;
        abGWhite = max(abGWhite, abArrow(vec2(abGGx, 29.0 - abGAhead), abGArrowK, abAA) * abDetail(3.0, abAA) * abWear);
        if (abGArrowK > 0) {
          abGWhite = max(abGWhite, abRoadWord(1, 4, vec2(abGGx, 34.4 - abGAhead), vec2(0.26, 0.5), abAA) * abWear);
        }
      } else if (abGKind < 0.85) {
        abGWhite = max(abGWhite, abRoadWord(0, 4, vec2(abGGx, 23.6 - abGAhead), vec2(0.26, 0.5), abAA) * abWear);
      }
    }
    // Bike symbols every 60 m in the bike lane.
    if (abGBikeOn) {
      float abGStation = 40.0 + 60.0 * floor((abGLa - 10.0) / 60.0 + 0.5);
      vec2 abGG = vec2((${G.bikeIn} + ${G.bikeOut}) * 0.5 - abGAcr, abGDir * (abGLa - abGStation));
      abGWhite = max(abGWhite, abBikeIcon(abGG, abAA) * abDetail(2.0, abAA) * abWear);
    }
    // Parking bay ticks at every slot boundary (street-detail.ts SLOT).
    if (abGPark > 0.5) {
      float abGTick = abLine(abPeriodic(abGLa - ${G.corner}, 0.0, 6.3), 0.06, abAA)
        * abEdge(${G.parking}, abGAcr, abAA) * (1.0 - abEdge(${G.parking} + 0.9, abGAcr, abAA));
      abGWhite = max(abGWhite, abGTick * abGInZone * abDetail(0.6, abAA) * abWear);
    }
  }
  // Bus stop box: a yellow outline in the curb lane and BUS / STOP.
  if ((abGCode & 2) != 0) {
    bool abGSlot = (abGCode & 4) != 0;
    float abGBus = abGSide > 0.0 ? (abGSlot ? ${G.busPlus1} : ${G.busPlus0}) : (abGSlot ? ${G.busMinus1} : ${G.busMinus0});
    float abGZ0 = abGBus - abGDir * ${G.busBefore};
    float abGZ1 = abGBus + abGDir * ${G.busAfter};
    vec2 abGZc = vec2((abGZ0 + abGZ1) * 0.5, (${G.parking} + ${G.curb} - 0.2) * 0.5);
    vec2 abGZh = vec2(abs(abGZ1 - abGZ0) * 0.5, (${G.curb} - 0.2 - ${G.parking}) * 0.5);
    vec2 abGZq = vec2(abGLa, abGAcr) - abGZc;
    float abGOutline = abBox(abGZq, abGZh, abAA) * (1.0 - abBox(abGZq, abGZh - 0.12, abAA));
    abGYellow = max(abGYellow, abGOutline * abWear);
    if (abAA < ${G.far}) {
      vec2 abGWg = vec2(abGZc.y - abGAcr, abGDir * (abGLa - abGZc.x));
      abGYellow = max(abGYellow, abRoadWord(2, 3, abGWg + vec2(0.0, 1.7), vec2(0.2, 0.45), abAA) * abWear);
      abGYellow = max(abGYellow, abRoadWord(0, 4, abGWg - vec2(0.0, 1.7), vec2(0.155, 0.45), abAA) * abWear);
    }
  }
  abPaint = mix(abPaint, ${C.white}, abGWhite * 0.92);
  abPaint = mix(abPaint, ${C.yellow}, abGYellow * 0.9);
  abEmissive += ${C.white} * abGWhite * ${MARK_GLOW} + ${C.yellow} * abGYellow * ${YELLOW_GLOW};
}
`;

/**
 * Sidewalk detail, spliced after S1's curb stone: coloured curbs, curb
 * ramps with tactile pads, flags with wear, tree grates.
 */
export const STREET_WALK_GLSL = /* glsl */ `
// --- G1 sidewalk (street-paint.ts) ---
if (uStreetPaint > 0.5) {
  // The nearer street's frame (corners go to the nearer street).
  float abWZ = abAdx <= abAdz ? 1.0 : 0.0;
  float abWOff = abWZ > 0.5 ? abAdx : abAdz;
  float abWAlong = abWZ > 0.5 ? vWorldXZ.y : vWorldXZ.x;
  float abWSide = (abWZ > 0.5 ? abDx : abDz) >= 0.0 ? 1.0 : -1.0;
  float abWLine = floor((abWZ > 0.5 ? vWorldXZ.x : vWorldXZ.y) / ${G.P} + 0.5);
  float abWSeg = floor(abWAlong / ${G.P});
  float abWLa = abWAlong - abWSeg * ${G.P};
  float abWCross = abWZ > 0.5 ? abAdz : abAdx;
  float abWDir = abWZ > 0.5 ? abWSide : -abWSide;
  int abWCode = abCurbCode(abWZ > 0.5 ? 0 : 1, abWLine, abWSeg, abWSide);
  float abWKeyLine = mod(abWLine, ${G.gridF}) + (abWZ > 0.5 ? 0.0 : 20.0) + (abWSide > 0.0 ? 0.5 : 0.0);
  // Worn walking line: the middle of the pavement is polished a shade
  // lighter, broken by a world-periodic swell (seam-safe).
  float abWWorn = 1.0 - smoothstep(0.4, 1.6, abs(abWOff - 18.0));
  abPaint *= 1.0 + 0.07 * abWWorn * (0.6 + 0.4 * sin(abWAlong * 0.0942 + abWKeyLine));
  // Curb colours: red along a hydrant, yellow along a bus stop.
  float abWCurb = 1.0 - abEdge(${G.curb} + 0.5, abWOff, abAA);
  if ((abWCode & 8) != 0) {
    float abWHyd = abWSide > 0.0 ? ${G.hydPlus} : ${G.hydMinus};
    abPaint = mix(abPaint, ${C.red}, abWCurb * (1.0 - abEdge(${G.hydClear}, abs(abWLa - abWHyd), abAA)) * 0.85);
  }
  if ((abWCode & 2) != 0) {
    bool abWSlot = (abWCode & 4) != 0;
    float abWBus = abWSide > 0.0 ? (abWSlot ? ${G.busPlus1} : ${G.busPlus0}) : (abWSlot ? ${G.busMinus1} : ${G.busMinus0});
    float abWZ0 = abWBus - abWDir * ${G.busBefore};
    float abWZ1 = abWBus + abWDir * ${G.busAfter};
    float abWIn = abEdge(min(abWZ0, abWZ1), abWLa, abAA) * (1.0 - abEdge(max(abWZ0, abWZ1), abWLa, abAA));
    abPaint = mix(abPaint, ${C.yellow} * 0.8, abWCurb * abWIn * 0.85);
  }
  // Curb ramp where a crosswalk lands: a flush ramp and a tactile pad.
  float abWRamp = (1.0 - abEdge(${G.curb} + 1.4, abWOff, abAA))
    * abEdge(${G.road} + 0.3, abWCross, abAA) * (1.0 - abEdge(${G.xwalkOut} - 0.3, abWCross, abAA));
  float abWPad = abWRamp * abEdge(${G.curb} + 0.12, abWOff, abAA) * (1.0 - abEdge(${G.curb} + 0.8, abWOff, abAA));
  abPaint = mix(abPaint, ${C.ramp}, abWRamp);
  if (abAA < ${G.far}) {
    // Truncated domes on the pad (resolve to the pad's tone far away).
    vec2 abWDome = vec2(abPeriodic(abWOff, 0.0, 0.12), abPeriodic(abWCross, 0.0, 0.12));
    float abWDots = mix(0.3, 1.0 - abEdge(0.03, length(abWDome), abAA), abDetail(0.12, abAA));
    abPaint = mix(abPaint, ${C.tactile} * (0.8 + 0.35 * abWDots), abWPad);
    // Flags: 1.25 m pavers past the furniture strip, jittered per flag, the
    // odd one cracked; small dark pavers in the strip.
    float abWStrip = 1.0 - abEdge(${G.furniture} + 0.7, abWOff, abAA);
    float abWT = abWStrip > 0.5 ? 0.5 : ${num(TILE)};
    vec2 abWTile = vec2(abWAlong, abWOff) / abWT;
    vec2 abWId = vec2(mod(floor(abWTile.x), 4000.0), floor(abWTile.y));
    float abWH = abHash(abWId + abWKeyLine * 7.0);
    float abWJ = max(abLine(abPeriodic(abWAlong, 0.0, abWT), ${num(TILE_JOINT)}, abAA),
      abLine(abPeriodic(abWOff, 0.0, abWT), ${num(TILE_JOINT)}, abAA));
    vec2 abWF = fract(abWTile) * abWT;
    float abWCrack = abWH < 0.03 ? abLine(abs(abWF.x - abWF.y) * 0.7071, 0.012, abAA) : 0.0;
    float abWFlag = (1.0 + 0.2 * (abWH - 0.5)) * (1.0 - ${num(JOINT_DARK)} * abWJ) * (1.0 - 0.5 * abWCrack);
    vec3 abWBase = mix(abPaint, ${C.paver} * (1.0 + (abNoiseV - 0.5) * 0.3), abWStrip * (1.0 - abWRamp) * (1.0 - abWCurb));
    abPaint = abWBase * mix(${num(TILE_MEAN)}, abWFlag, abDetail(${num(TILE)}, abAA) * (1.0 - abWRamp));
    // Tree grates at every candidate pit (street-detail.ts treePits), except
    // on a bridge (hydrant bit clear) or a construction site's pavement.
    vec3 abWPits = abWSide > 0.0 ? ${pitList(pitsPlus)} : ${pitList(pitsMinus)};
    vec3 abWPd = abs(vec3(abWLa) - abWPits);
    float abWPit = min(abWPd.x, min(abWPd.y, abWPd.z));
    if ((abWCode & 8) != 0 && abBlockKind(vWorldXZ) != ${G.site}) {
      vec2 abWGq = vec2(abWPit, abWOff - ${G.furniture});
      float abWGr = abBox(abWGq, vec2(0.7), abAA) * abDetail(1.4, abAA);
      float abWRings = mix(0.4, abLine(abPeriodic(length(abWGq), 0.0, 0.14), 0.025, abAA), abDetail(0.14, abAA));
      float abWSoil = 1.0 - abEdge(0.28, length(abWGq), abAA);
      vec3 abWGrate = mix(${C.grate} * (1.0 + 1.5 * abWRings), ${C.soil}, abWSoil);
      abPaint = mix(abPaint, abWGrate, abWGr);
    }
  } else {
    abPaint = mix(abPaint, ${C.tactile} * 0.9, abWPad);
    abPaint *= ${num(TILE_MEAN)};
  }
}
`;
