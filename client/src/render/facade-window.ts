// L11 "Neonized New York" facade relief (ANGE-ND1JQR): the windows get
// depth and shape, the walls get their material. The city is still ONE
// InstancedMesh of unit boxes, so all of it is shader relief spliced into
// the buildings material (buildings-material.ts), driven by the New York
// style the fragment stage decodes from the flat packed `vArch`
// (archetypes.ts facadeStyleFor / packArchetype, window-pattern.ts
// styleChainGlsl) — no attribute, no varying, no draw call.
//
// Three emitters, in splice order:
//  - windowDepthGlsl(), right after the window grid: the opening's shape
//    (punched, round-headed, loft, Deco strip, ribbon, curtain cell), a
//    box-recess parallax (the glass sits `fwRecess` behind the wall, so the
//    sill top, the lintel soffit and the jambs show at an angle), the sash
//    frame and muntins, and the stone trim around each opening. It rewrites
//    `pane` — the share of the pixel that is visible glass — which every
//    later pass (lit rooms, reflections, the bounce, damage) already reads.
//  - facadeMaterialGlsl(), after the weathering: the wall itself — brick
//    coursing or ashlar joints, the prewar rusticated base, Deco piers and
//    recessed spandrels, cast-iron columns and entablatures, curtain-wall
//    mullion caps, mid-century spandrel panels — then the trim, the reveal,
//    the glass and the sash, and the brownstone's stoop and front door.
//  - the reveal's lit-room spill rides windowEmissiveGlsl (window-pattern).
//
// The O1 rules hold throughout: every repeating line is abLine/abDetail
// filtered with the metres-per-pixel the grid took at the top level, every
// per-cell mask resolves to its area mean through `winDetail` once a cell
// is sub-pixel, and no derivative is taken here at all. The M3 tier switch
// (`uWinInterior`, off on Mobile) gates the near detail — recess, muntins,
// fine joints — whose mean the Mobile tier keeps. Brighteners are convex
// mixes toward CORNICE.stone, never a gain, so the facade-palette bound
// (client/test/facade-palette.test.ts) still covers every face.

import { FacadeStyle } from "./archetypes";
import {
  BROWNSTONE_BAYS,
  CORNICE,
  LOFT_ARCH_RADIUS,
  ROOF,
  WindowShape,
  glslFloat,
  styleSlot,
} from "./window-pattern";

const slot = (s: FacadeStyle): string => glslFloat(styleSlot(s));
const vec3Lit = (c: { r: number; g: number; b: number }): string =>
  `vec3(${glslFloat(c.r)}, ${glslFloat(c.g)}, ${glslFloat(c.b)})`;

/** Relief sizes, meters (and a few tone factors). */
export const RELIEF = {
  /** The steepest view ray the recess parallax follows (its cosine): past
   * it the shift stops growing, so a grazing wall shows all reveal, never a
   * pane pulled from another cell. */
  minRayIn: 0.12,
  /** Projecting sill / lintel overhang past the opening, each side. */
  sillOver: 0.1,
  lintelOver: 0.14,
  /** The shadow line a sill throws on the wall under it. */
  sillShadow: 0.07,
  /** Round-headed arch: voussoir ring width and keystone half size. */
  voussoir: 0.26,
  keystone: [0.13, 0.2] as const,
  /** Soot streaks under sills: share of windows, longest run. */
  sootShare: 0.45,
  sootMax: 1.7,
  /** Brick: course height and brick length (with joint); joint half width. */
  brick: [0.21, 0.08] as const,
  brickJoint: 0.006,
  /** Ashlar block length × course height: limestone, cast iron, brownstone. */
  ashlar: [1.2, 0.6] as const,
  ironBlock: [1.0, 0.5] as const,
  brownBlock: [0.9, 0.45] as const,
  ashlarJoint: 0.008,
  /** Rusticated base: groove pitch and half width. */
  rustPitch: 0.55,
  rustGroove: 0.035,
  /** Deco: chevron pitch (up) and run (across); pier edge shadow width. */
  chevron: [0.5, 0.3] as const,
  pierEdge: 0.06,
  /** Cast iron: column edge past the opening, flute pitch, entablature. */
  columnOver: 0.08,
  flute: 0.14,
  entablature: 0.34,
  /** Curtain wall: mullion cap half width. */
  capHalf: 0.05,
  /** Brownstone: front door half size, stoop step rise. */
  door: [0.62, 1.3] as const,
  stoopRise: 0.18,
} as const;

/** Glass seen as a surface (unlit): dark, faintly blue — the lit room and
 * the reflection are emissive and come on top. Not black: night glass
 * holds the city's glow, and a near-black pane sliding past a lit one
 * reads as a black flash in motion (the O7 detector flags it). */
const GLASS_DARK = { r: 0.05, g: 0.055, b: 0.068 } as const;
/** Front door wood, and the dark iron of rails and sashes. */
const DOOR_WOOD = { r: 0.06, g: 0.032, b: 0.018 } as const;
const IRON_DARK = { r: 0.022, g: 0.022, b: 0.024 } as const;

/** Signed distance (m) to a window opening of half size h at cell-centred
 * p, < 0 inside — the GLSL twin of window-pattern.ts openingSd. Emitted
 * into the fragment pars. */
export const OPENING_SD_GLSL = /* glsl */ `
float abOpeningSd(vec2 p, vec2 h, float shape) {
  float opBox = max(abs(p.x) - h.x, abs(p.y) - h.y);
  if (shape > ${glslFloat(WindowShape.ARCH - 0.5)}) {
    float spring = h.y - h.x;
    return p.y > spring ? length(vec2(p.x, p.y - spring)) - h.x : opBox;
  }
  if (shape > ${glslFloat(WindowShape.LOFT - 0.5)}) {
    float opR = h.x * ${glslFloat(LOFT_ARCH_RADIUS)};
    return max(max(abs(p.x) - h.x, -h.y - p.y), length(vec2(p.x, p.y - (h.y - opR))) - opR);
  }
  return opBox;
}
`;

/**
 * After windowGridGlsl(): the opening, its recess and its trim. Declares
 * the fw* masks facadeMaterialGlsl() paints with, and rewrites `pane`.
 */
export function windowDepthGlsl(): string {
  const R = RELIEF;
  return /* glsl */ `
// --- L11 deep, shaped windows ---
// Cell-centred meters on the wall plane: u along the run, v up.
vec2 fwP = (winF - 0.5) * winPitch;
vec2 fwHalf = winPane * winPitch * 0.5;
float fwAA = max(max(wAA.x, wAA.y), 1e-4);
// Each tier's top floor is its crown floor: a prewar tier's arches.
float fwTop = step(vBHeight - ${glslFloat(ROOF.windowBand)}, (winCell.y + 2.0) * winPitch.y);
float fwPrewar = step(${slot(FacadeStyle.PREWAR)} - 0.5, fwSid) * (1.0 - step(${slot(FacadeStyle.PREWAR)} + 0.5, fwSid));
float fwShapeK = mix(fwShape, ${glslFloat(WindowShape.ARCH)}, fwPrewar * fwTop);
// Brownstones: the first bay of every house is the door bay — a stoop up
// to the parlour floor's front door (window-pattern.ts brownstoneDoorBay).
float fwBrown = step(${slot(FacadeStyle.BROWNSTONE)} - 0.5, fwSid) * (1.0 - step(${slot(FacadeStyle.BROWNSTONE)} + 0.5, fwSid));
float fwGround = 1.0 - step(0.5, vWorldY - vMeters.y);
float fwBayMod = mod(winCell.x, ${glslFloat(BROWNSTONE_BAYS)});
float fwDoorBay = fwBrown * fwGround * (1.0 - step(0.5, fwBayMod)) * (1.0 - step(1.5, winCell.y));
// The view ray in facade space (boxes never rotate): into the wall, and
// along (u, v). The M3 tier switch gates the recess.
float fwNearOn = step(0.5, uWinInterior);
float fwRayIn = 1.0;
vec2 fwRayUV = vec2(0.0);
if (abs(vObjNormal.x) > 0.5) {
  fwRayIn = -sign(vObjNormal.x) * viewRay.x;
  fwRayUV = vec2(viewRay.z, viewRay.y);
} else if (abs(vObjNormal.z) > 0.5) {
  fwRayIn = -sign(vObjNormal.z) * viewRay.z;
  fwRayUV = vec2(viewRay.x, viewRay.y);
}
// Where the ray meets the glass plane, fwRecess behind the wall.
vec2 fwShift = fwRayUV / max(fwRayIn, ${glslFloat(R.minRayIn)}) * fwRecess * fwNearOn;
vec2 fwG = fwP + fwShift;
float fwSdWall = abOpeningSd(fwP, fwHalf, fwShapeK);
float fwSdGlass = abOpeningSd(fwG, fwHalf, fwShapeK);
float fwOpen = 1.0 - smoothstep(-0.5 * fwAA, 0.5 * fwAA, fwSdWall);
float fwGlassIn = fwOpen * (1.0 - smoothstep(-0.5 * fwAA, 0.5 * fwAA, fwSdGlass));
// The rest of the opening is the reveal: the sill's top catches the sky,
// the lintel's soffit and the jambs stand in their own shade.
float fwReveal = max(fwOpen - fwGlassIn, 0.0);
vec2 fwEx = abs(fwG) - fwHalf;
float fwRevShade = (fwEx.y > fwEx.x || (fwG.y > 0.0 && fwShapeK > ${glslFloat(WindowShape.LOFT - 0.5)}))
  ? (fwG.y < 0.0 ? 0.9 : 0.3)
  : 0.5 + 0.08 * sign(fwG.x * fwRayUV.x);
// Sash frame and muntins on the glass plane: (lights.x − 1) muntins
// across, a bar between the lights up each sash, and a meeting rail (at
// the spring of an arch, under a Deco strip's transom).
float fwFrame = 1.0 - smoothstep(fwFrameW - 0.5 * fwAA, fwFrameW + 0.5 * fwAA, -fwSdGlass);
float fwLx = 2.0 * fwHalf.x / max(fwLights.x, 1.0);
float fwMun = fwLights.x > 1.5 ? abLine(abPeriodic(fwG.x + fwHalf.x, 0.0, fwLx), fwFrameW * 0.4, fwAA) : 0.0;
float fwLy = 2.0 * fwHalf.y / max(fwLights.y * fwSashes, 1.0);
float fwBar = fwLights.y > 1.5 ? abLine(abPeriodic(fwG.y + fwHalf.y, 0.0, fwLy), fwFrameW * 0.4, fwAA) : 0.0;
float fwRailY = fwShapeK > ${glslFloat(WindowShape.ARCH - 0.5)} ? fwHalf.y - fwHalf.x
  : fwShapeK > ${glslFloat(WindowShape.LOFT - 0.5)} ? fwHalf.y - 0.75 * fwHalf.x
  : fwShapeK > ${glslFloat(WindowShape.STRIP - 0.5)} ? fwHalf.y - 0.55 : 0.0;
float fwRail = fwSashes > 1.5 ? abLine(abs(fwG.y - fwRailY), fwFrameW * 0.6, fwAA) : 0.0;
float fwSash = clamp(max(max(fwFrame, fwMun), max(fwBar, fwRail)), 0.0, 1.0) * fwNearOn;
// No glass where a brownstone's stoop and front door stand.
float fwPaneNear = fwGlassIn * (1.0 - fwSash) * (1.0 - fwDoorBay);
// Far away the opening is its area share: an arch or a loft head loses a
// little to its spandrels, a sash a little to its frame and muntins; a
// brownstone's ground-floor door bays (a third, up to the parlour floor)
// are not glass.
float fwArea = winPane.x * winPane.y
  * (fwShapeK > ${glslFloat(WindowShape.ARCH - 0.5)} ? 1.0 - 0.1075 * fwHalf.x / max(fwHalf.y, 0.1)
     : fwShapeK > ${glslFloat(WindowShape.LOFT - 0.5)} ? 0.95 : 1.0);
float fwSashMean = fwNearOn * (fwLights.x * fwLights.y * fwSashes > 1.5 ? 0.18 : 0.08);
float fwPaneMean = fwArea * (1.0 - fwSashMean)
  * (1.0 - fwBrown * fwGround * (1.0 - step(2.0 * winPitch.y, vMeters.y)) / ${glslFloat(BROWNSTONE_BAYS)});
pane = mix(fwPaneMean, fwPaneNear, winDetail) * winRow;
// Stone trim around the opening, on the wall plane: a projecting sill
// with the shadow line it throws, a flat lintel (a brownstone's heavier
// hood), or an arch's voussoirs and keystone. Clear of the shop band.
float fwTrimOn = winRow * facade * max(step(4.6, vWorldY), fwBrown) * (1.0 - fwDoorBay);
float fwSillOn = step(0.01, fwSill);
float fwSillK = fwSillOn * abBox(fwP - vec2(0.0, -fwHalf.y - 0.5 * fwSill), vec2(fwHalf.x + ${glslFloat(R.sillOver)}, 0.5 * fwSill), fwAA);
float fwSillShade = fwSillOn * abBox(fwP - vec2(0.0, -fwHalf.y - fwSill - ${glslFloat(R.sillShadow)}), vec2(fwHalf.x + ${glslFloat(R.sillOver)}, ${glslFloat(R.sillShadow)}), fwAA);
float fwArchOn = step(${glslFloat(WindowShape.ARCH - 0.5)}, fwShapeK);
float fwLintK = step(0.01, fwLintel) * (1.0 - fwArchOn)
  * abBox(fwP - vec2(0.0, fwHalf.y + 0.5 * fwLintel), vec2(fwHalf.x + ${glslFloat(R.lintelOver)}, 0.5 * fwLintel), fwAA);
float fwSpring = fwHalf.y - fwHalf.x;
float fwVous = fwArchOn * step(fwSpring, fwP.y)
  * abLine(abs(length(fwP - vec2(0.0, fwSpring)) - fwHalf.x - ${glslFloat(R.voussoir * 0.5)}), ${glslFloat(R.voussoir * 0.5)}, fwAA);
float fwKey = fwArchOn * abBox(fwP - vec2(0.0, fwHalf.y + ${glslFloat(R.keystone[1] * 0.8)}), vec2(${glslFloat(R.keystone[0])}, ${glslFloat(R.keystone[1])}), fwAA);
float fwTrimNear = clamp(max(max(fwSillK, fwLintK), max(fwVous, fwKey)), 0.0, 1.0) * (1.0 - fwOpen);
float fwTrimMean = ((2.0 * fwHalf.x + ${glslFloat(2 * R.sillOver)}) * fwSill
  + (2.0 * fwHalf.x + ${glslFloat(2 * R.lintelOver)}) * fwLintel * (1.0 - fwArchOn)
  + fwArchOn * 3.1416 * (fwHalf.x + ${glslFloat(R.voussoir * 0.5)}) * ${glslFloat(R.voussoir)})
  / max(winPitch.x * winPitch.y, 1.0);
float fwTrim = mix(fwTrimMean, fwTrimNear, winDetail) * fwTrimOn;
float fwShadeK = mix(fwSillOn * (2.0 * fwHalf.x + ${glslFloat(2 * R.sillOver)}) * ${glslFloat(2 * R.sillShadow)} / max(winPitch.x * winPitch.y, 1.0),
  fwSillShade, winDetail) * fwTrimOn;
// Soot streaks run down from some sills — near detail, a mean far away.
float fwSootH = abHash(winCell + 13.0, vBSeed * 41.0);
float fwSootTop = -fwHalf.y - fwSill - ${glslFloat(R.sillShadow * 2)};
float fwSootLen = 0.4 + ${glslFloat(R.sootMax - 0.4)} * abHash(winCell + 29.0, vBSeed * 41.0);
float fwSootNear = step(fwSootH, ${glslFloat(R.sootShare)}) * clamp((fwP.y - fwSootTop + fwSootLen) / fwSootLen, 0.0, 1.0)
  * (1.0 - step(fwSootTop, fwP.y)) * (1.0 - smoothstep(fwHalf.x * 0.45, fwHalf.x * 0.9, abs(fwP.x)));
float fwSoot = mix(${glslFloat(R.sootShare * 0.15)}, fwSootNear, winDetail) * fwTrimOn * fwSillOn;
`;
}

/**
 * After weatheringGlsl(): the wall's material, the trim, the reveal, the
 * glass and the sash — a repaint of the facade's diffuse (roofs, holes and
 * the convex light masks come after, as before).
 */
export function facadeMaterialGlsl(): string {
  const R = RELIEF;
  const S = FacadeStyle;
  const between = (lo: FacadeStyle, hi: FacadeStyle) =>
    `step(${slot(lo)} - 0.5, fwSid) * (1.0 - step(${slot(hi)} + 0.5, fwSid))`;
  return /* glsl */ `
// --- L11 facade materials ---
vec3 fwBase = diffuseColor.rgb;                 // the weathered finish
vec3 fwStone = ${vec3Lit(CORNICE.stone)} * faceJit * soot;
float fwFine = fwNearOn;                        // M3: fine joints near only
float fwMasonry = ${between(S.PREWAR, S.BROWNSTONE)};
float fwDeco = ${between(S.DECO, S.DECO)};
float fwIron = ${between(S.CAST_IRON, S.CAST_IRON)};
float fwOffice = step(${slot(S.MIDCENTURY_OFFICE)} - 0.5, fwSid);
float fwCurtain = 1.0 - step(${slot(S.MODERN_GLASS)} + 0.5, fwSid);
float fwMidGlass = ${between(S.MIDCENTURY_GLASS, S.MIDCENTURY_GLASS)};
// Brick or ashlar: a limestone share of the prewar towers, more of the
// Deco ones, every cast-iron front (iron cast to look like stone), and
// most brownstones are dressed stone; the rest is brick.
float fwRoll = abHash(vec2(5.0, 9.0), vBSeed * 37.0);
float fwAshlar = fwMasonry * (fwSid < ${slot(S.PREWAR)} + 0.5 ? step(fwRoll, 0.3)
  : fwSid < ${slot(S.DECO)} + 0.5 ? step(fwRoll, 0.45)
  : fwSid < ${slot(S.CAST_IRON)} + 0.5 ? 1.0 : step(fwRoll, 0.7));
float fwBrickK = fwMasonry * (1.0 - fwAshlar);
vec2 fwUnit = mix(vec2(${glslFloat(R.brick[0])}, ${glslFloat(R.brick[1])}),
  fwIron > 0.5 ? vec2(${glslFloat(R.ironBlock[0])}, ${glslFloat(R.ironBlock[1])})
  : fwSid > ${slot(S.BROWNSTONE)} - 0.5 ? vec2(${glslFloat(R.brownBlock[0])}, ${glslFloat(R.brownBlock[1])})
  : vec2(${glslFloat(R.ashlar[0])}, ${glslFloat(R.ashlar[1])}), fwAshlar);
// Courses in TIER meters (a setback keeps its own bond), every other
// course offset half a unit — running bond.
float fwCourseI = floor(vMeters.y / fwUnit.y);
float fwRunU = winGrid.x + 0.5 * fwUnit.x * mod(fwCourseI, 2.0);
float fwJointW = mix(${glslFloat(R.brickJoint)}, ${glslFloat(R.ashlarJoint)}, fwAshlar);
float fwUnitDetail = abDetail(fwUnit.y, fwAA) * fwFine;
float fwJointLines = max(abLine(abPeriodic(vMeters.y, 0.0, fwUnit.y), fwJointW, wAA.y),
  abLine(abPeriodic(fwRunU, 0.0, fwUnit.x), fwJointW, wAA.x));
float fwJointMean = 2.0 * fwJointW * (1.0 / fwUnit.y + 1.0 / fwUnit.x);
float fwJoint = mix(fwJointMean, fwJointLines, fwUnitDetail) * fwMasonry;
float fwUnitTone = 1.0 - 0.12 * fwMasonry * fwUnitDetail
  * abHash(vec2(floor(fwRunU / fwUnit.x), fwCourseI), vBSeed * 23.0);
vec3 fwWall = fwBase * fwUnitTone;
// Brick mortar is lighter than the brick; ashlar joints are shadowed.
fwWall = mix(fwWall, fwStone * 0.85, fwBrickK * 0.45 * fwJoint);
fwWall *= 1.0 - fwAshlar * 0.35 * fwJoint;
// The prewar rusticated base (two floors over the shops, on a tower) and
// the brownstone's rusticated garden level: dressed stone, deep grooves.
float fwRust = fwGround * (fwPrewar * step(4.6, vWorldY) * (1.0 - step(4.6 + 2.0 * winPitch.y, vWorldY)) * step(32.0, vBHeight)
  + fwBrown * (1.0 - step(winPitch.y, vWorldY))) * facade;
float fwRustD = abDetail(${glslFloat(R.rustPitch)}, wAA.y);
float fwGroove = abLine(abPeriodic(vWorldY, 0.0, ${glslFloat(R.rustPitch)}), ${glslFloat(R.rustGroove)}, wAA.y);
float fwGrooveLit = abLine(abPeriodic(vWorldY - ${glslFloat(R.rustGroove * 1.6)}, 0.0, ${glslFloat(R.rustPitch)}), ${glslFloat(R.rustGroove * 0.45)}, wAA.y);
fwWall = mix(fwWall, fwStone * 0.8, fwRust * 0.45);
fwWall *= 1.0 - fwRust * mix(${glslFloat((R.rustGroove * 2 * 0.55) / R.rustPitch)}, 0.55 * fwGroove, fwRustD);
fwWall = mix(fwWall, fwStone, fwRust * 0.35 * fwGrooveLit * fwRustD);
// Art Deco: the window strip runs between proud piers; the spandrels in it
// are recessed dark terracotta with chevrons, and each pier throws a
// shadow line along its edge.
float fwStripNear = 1.0 - smoothstep(fwHalf.x - 0.5 * fwAA, fwHalf.x + 0.5 * fwAA, abs(fwP.x));
float fwStrip = mix(winPane.x, fwStripNear, winDetail);
float fwSpandrel = fwDeco * fwStrip * (1.0 - mix(fwArea, fwOpen, winDetail)) * winRow;
float fwPier = fwDeco * (1.0 - fwStrip);
float fwChevD = abDetail(${glslFloat(R.chevron[1])}, fwAA) * fwFine * winDetail;
float fwChev = abLine(abPeriodic(fwP.y - 0.8 * abPeriodic(fwP.x, 0.0, ${glslFloat(R.chevron[0])}), 0.0, ${glslFloat(R.chevron[1])}), 0.035, fwAA) * fwChevD;
float fwPierEdge = fwDeco * winDetail * abLine(abs(abs(fwP.x) - fwHalf.x - ${glslFloat(R.pierEdge)}), ${glslFloat(R.pierEdge)}, fwAA);
fwWall = mix(fwWall, fwStone, 0.22 * fwPier);
fwWall = mix(fwWall, fwBase * 0.3 + fwStone * 0.08, fwSpandrel);
fwWall = mix(fwWall, fwStone * 0.7, fwSpandrel * 0.55 * fwChev);
fwWall *= 1.0 - 0.45 * fwPierEdge;
// Cast iron: painted columns between the bays, fluted up close, and an
// entablature at every floor with its shadow line.
float fwColNear = smoothstep(fwHalf.x + ${glslFloat(R.columnOver)} - 0.5 * fwAA, fwHalf.x + ${glslFloat(R.columnOver)} + 0.5 * fwAA, abs(fwP.x));
float fwCol = fwIron * mix(1.0 - winPane.x, fwColNear, winDetail);
float fwEntNear = smoothstep(0.5 * winPitch.y - ${glslFloat(R.entablature)} - 0.5 * fwAA, 0.5 * winPitch.y - ${glslFloat(R.entablature)} + 0.5 * fwAA, fwP.y);
float fwEnt = fwIron * mix(${glslFloat(R.entablature)} / max(winPitch.y, 1.0), fwEntNear, winDetail);
float fwEntShade = fwIron * winDetail * abLine(abs(fwP.y - 0.5 * winPitch.y + ${glslFloat(R.entablature + 0.05)}), 0.045, fwAA);
float fwFlute = fwIron * fwColNear * winDetail * abDetail(${glslFloat(R.flute)}, fwAA) * fwFine
  * abLine(abPeriodic(fwP.x, 0.0, ${glslFloat(R.flute)}), 0.02, fwAA);
fwWall = mix(fwWall, fwStone, 0.22 * max(fwCol, fwEnt));
fwWall *= 1.0 - 0.3 * fwFlute - 0.45 * fwEntShade;
// Glass towers: aluminium mullion caps catch the light between the cells;
// the slab edge between floors is dark fritted spandrel glass (a
// mid-century box's spandrel is a coloured panel instead).
float fwCapNear = abLine(abs(abs(fwP.x) - 0.5 * winPitch.x), ${glslFloat(R.capHalf)}, fwAA)
  + fwMidGlass * abLine(abPeriodic(fwP.x + fwHalf.x, 0.0, fwLx), ${glslFloat(R.capHalf * 0.7)}, fwAA);
float fwCap = (fwCurtain + fwMidGlass) * mix(${glslFloat(2 * R.capHalf)} / max(winPitch.x, 1.0), clamp(fwCapNear, 0.0, 1.0), winDetail);
float fwSlabNear = smoothstep(fwHalf.y - 0.5 * fwAA, fwHalf.y + 0.5 * fwAA, abs(fwP.y));
float fwSlab = mix(1.0 - winPane.y, fwSlabNear, winDetail) * winRow;
fwWall *= 1.0 - fwCurtain * 0.4 * fwSlab - fwMidGlass * 0.25 * fwSlab;
fwWall = mix(fwWall, fwStone * 0.9, fwCap * 0.6);
// Mid-century office: precast spandrel panels with joints at the floor
// line and at every mullion.
float fwPanelNear = max(abLine(abPeriodic(fwP.x + fwHalf.x, 0.0, fwLx), 0.012, fwAA),
  abLine(abs(abs(fwP.y) - 0.5 * winPitch.y), 0.012, fwAA)) * abDetail(fwLx, fwAA) * fwFine;
fwWall *= 1.0 - fwOffice * 0.3 * fwPanelNear * fwSlabNear * winDetail;
// Trim: projecting stone, the sill's shadow and the soot under it.
fwWall = mix(fwWall, fwStone * (0.9 + 0.1 * faceJit), fwTrim);
fwWall *= (1.0 - 0.45 * fwShadeK) * (1.0 - 0.3 * fwSoot);
// The opening: reveal, then glass, then the sash on the glass — above the
// shop band, whose storefront glass is its own (a brownstone has none).
float fwAboveShop = max(step(4.0, vWorldY), fwBrown) * facade;
float fwRevK = mix(0.0, fwReveal, winDetail) * fwTrimOn;
vec3 fwRevCol = mix(fwBase, fwStone, 0.35 * fwMasonry) * fwRevShade;
fwWall = mix(fwWall, fwRevCol, fwRevK);
vec3 fwGlassCol = mix(${vec3Lit(GLASS_DARK)}, fwBase * 0.85, fwCurtain + fwMidGlass);
float fwGlassK = mix(fwArea, fwGlassIn, winDetail) * winRow * (1.0 - fwDoorBay) * fwAboveShop;
fwWall = mix(fwWall, fwGlassCol, fwGlassK);
vec3 fwSashCol = mix(${vec3Lit(IRON_DARK)}, fwStone, step(fwRoll, 0.5) * (fwPrewar + fwBrown));
fwWall = mix(fwWall, fwSashCol, fwSash * fwGlassIn * winDetail * winRow * (1.0 - fwDoorBay) * fwAboveShop);
// Brownstone door bay: the stoop's stone steps from the pavement up to the
// parlour floor, an iron rail each side, and the front door under its lit
// fanlight (the fanlight's glow is emissive, below).
float fwDoorU = fwP.x;
float fwStoopRow = fwDoorBay * (1.0 - step(0.5, winCell.y));
float fwStoopD = abDetail(${glslFloat(R.stoopRise * 2)}, fwAA) * fwFine;
float fwStep = abLine(abPeriodic(vMeters.y, 0.0, ${glslFloat(R.stoopRise)}), 0.012, wAA.y) * fwStoopD;
float fwStoop = fwStoopRow * (1.0 - smoothstep(1.05 - 0.5 * fwAA, 1.05 + 0.5 * fwAA, abs(fwDoorU)));
float fwRailK = fwStoopRow * abLine(abs(abs(fwDoorU) - 1.08), 0.035, fwAA) * winDetail;
fwWall = mix(fwWall, fwStone * 0.75 * (1.0 - 0.4 * fwStep), fwStoop);
fwWall = mix(fwWall, ${vec3Lit(IRON_DARK)}, fwRailK);
float fwDoorRow = fwDoorBay * step(0.5, winCell.y);
vec2 fwDoorP = vec2(fwDoorU, fwP.y + 0.5 * winPitch.y - ${glslFloat(R.door[1] + 0.05)});
float fwDoor = fwDoorRow * abBox(fwDoorP, vec2(${glslFloat(R.door[0])}, ${glslFloat(R.door[1])}), fwAA);
float fwFan = fwDoorRow * (1.0 - smoothstep(${glslFloat(R.door[0])} - 0.5 * fwAA, ${glslFloat(R.door[0])} + 0.5 * fwAA,
  length(fwDoorP - vec2(0.0, ${glslFloat(R.door[1] + 0.06)})))) * step(${glslFloat(R.door[1] + 0.06)}, fwDoorP.y);
float fwDoorFrame = fwDoorRow * abBox(fwDoorP - vec2(0.0, 0.3), vec2(${glslFloat(R.door[0] + 0.22)}, ${glslFloat(R.door[1] + 0.95)}), fwAA);
fwWall = mix(fwWall, fwStone, fwDoorFrame * 0.6 * (1.0 - fwDoor));
fwWall = mix(fwWall, ${vec3Lit(DOOR_WOOD)}, fwDoor);
fwWall = mix(fwWall, ${vec3Lit(GLASS_DARK)}, fwFan);
diffuseColor.rgb = mix(diffuseColor.rgb, fwWall, facade);
`;
}
