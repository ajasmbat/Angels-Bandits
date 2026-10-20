// D2 broken buildings, the look of them (D1's facade damage map is a
// separate thing: scorch and dark windows on INTACT facades): the GLSL the building material
// splices in for the faces destruction exposed and for the rubble piles.
//
// Geometry comes from the shared solids() (city.ts draws a damaged
// building's boxes 1:1), and each box carries its CUT_* mask in aSubOff.w —
// no new attribute location (the city mesh is at WebGL2's 16). The vertex
// stage turns the mask into one number per FACE: 0 an original facade or
// roof, 1 a face destruction exposed, 2 rubble. All four vertices of a face
// agree, so it interpolates to a constant and needs no `flat`.
//
// An exposed face reads as the building's insides: a concrete floor slab
// every storey with the dark, gutted room between them, a jagged broken rim
// where the face meets the air, and rebar bristling from the slab edges.
// Rubble is broken concrete mixed with chunks of the facade's own finish.
// Both drop the window/shop/LED emissive the facade pass computed; a few
// gutted rooms keep a dim sub-bloom ember (well under the 0.72 threshold —
// not a rung on the emissive ladder).
//
// G7: the insides read as a charred SKELETON at every distance — floor
// slabs and a column every room, round dark (not black) rooms — and every
// per-room / per-patch decision resolves to its mean once its cell is
// sub-pixel (the grid's top-level `wAA`, never a derivative in a branch).
// Near-black rooms with flat orange ember rooms fogged into navy blocks
// and, far away, aliased into orange and black checkerboards.

import { LOOK_DEFAULTS } from "@angels-bandits/common/destruction-tuning";

/** D2 quality switch (quality.ts destructionDetail): 1 = rebar and jagged
 * rims, 0 = flat slabs and rooms. A uniform, so a tier switch compiles
 * nothing. */
export const BROKEN_DETAIL_UNIFORM = { value: 1 };

/** DL1 dying lights (the Destruction Lab's look, destruct-look.ts): the
 * share of a broken floor's lit rooms whose lights are failing — the lower
 * half of it dead, the rest stuttering in bursts. DS2: on by default (the
 * office-light flicker of a broken floor); 0: every lit room steady. */
export const ROOM_FLICKER_UNIFORM = {
  value: LOOK_DEFAULTS.roomFlicker as number,
};

/** Storey pitch of the exposed slabs, meters. */
export const BROKEN_STOREY = 3.6;
/** Slab thickness as a share of the storey (D11: 0.1 → 0.14, a slab edge
 * that reads from across the street). */
const SLAB_SHARE = 0.14;
/** Linear albedo of the slabs, the gutted rooms and the rubble. */
const SLAB_ALBEDO = 0.2;
const ROOM_ALBEDO = 0.1;
/** G7: room width along the face (one structural bay), and the half width
 * of the column at each bay line, meters. */
const ROOM_BAY = 6.0;
const COLUMN_HALF = 0.25;
/** D11: an exposed room's kind by its hash — burning below ROOM_BURNING,
 * its lights still on below ROOM_LIT, dark above (their shares far away).
 * Linear emission, all under the bloom threshold (0.72): a lit room's warm
 * light at the ceiling, a burning room's fire at the floor, the street
 * glow on a slab edge, the embers in a charred rim. */
const ROOM_BURNING = 0.12;
const ROOM_LIT = 0.34;
const ROOM_LIGHT = "vec3(0.36, 0.26, 0.15)";
// (INTERIOR_PEAK below is ROOM_LIGHT's red × PANEL_LIGHT.)
const ROOM_FIRE_LOW = "vec3(0.6, 0.2, 0.03)";
const ROOM_FIRE_HIGH = "vec3(0.32, 0.06, 0.01)";
const SLAB_GLOW = "vec3(0.045, 0.032, 0.02)";
const RIM_EMBER = "vec3(0.3, 0.07, 0.012)";
/** D11: the charred band round an opening, m. */
const CHAR_M = 1.8;
/** D8 scorch: how dark the soot patches get (share of albedo removed). */
const SOOT = 0.7;
/** O1 rubble: a settled pile is dust-covered broken concrete — paler than
 * the slabs still standing (linear albedo), the facade's finish a smaller
 * share of it and dusted over, its soot lighter, and the city's glow
 * bounced off it (linear emission, far under the 0.72 bloom threshold) so
 * a pile at night is a grey mound, not a black hole. The chunks are hashed
 * in the face's own plane: the old xz + y hash ran in diagonal streaks down
 * every side, the smear `ruin-detail` showed. */
const RUBBLE_ALBEDO = 0.3;
const RUBBLE_FINISH = 0.24;
const RUBBLE_SOOT = 0.35;
const RUBBLE_GLOW = "vec3(0.034, 0.03, 0.026)";
/** DS2: a fresh break's soot (share of albedo removed at most). */
const FRESH_SOOT = 0.2;
/** Ember: share of gutted rooms that smoulder, and its linear colour. */
const EMBER_SHARE = 0.14;
const EMBER = "vec3(0.42, 0.13, 0.03)";

/** Packs the face's damage kind above the half-size in vBroken.w (kinds: 0
 * facade, 1 exposed, 2 rubble, 3 steel — D10's columns and rebar — and 4 a
 * DS2 fracture face, a debris piece's fresh break). */
export const KIND_STRIDE = "4096.0";
/** D10 steel: a dark, rust-streaked albedo (linear). */
const STEEL = "vec3(0.075, 0.06, 0.055)";
const RUST = "vec3(0.17, 0.075, 0.035)";

/** DS2: a fresh break's look (linear albedo): concrete's grey cement with
 * its aggregate (stones of a few cm, their mean far away), a masonry wall's
 * brick courses in section, a glass pane's green edge. */
const CEMENT = "vec3(0.3, 0.29, 0.27)";
const STONE_DARK = "vec3(0.17, 0.16, 0.15)";
const STONE_LIGHT = "vec3(0.44, 0.42, 0.38)";
const BRICK = "vec3(0.3, 0.12, 0.07)";
const MORTAR = "vec3(0.36, 0.34, 0.3)";
const GLASS_EDGE = "vec3(0.09, 0.15, 0.14)";
/** Aggregate stone size, m; brick course and length, m. */
const STONE_M = 0.045;
const COURSE_M = 0.075;
const BRICK_M = 0.215;

/** DS2: smooth value noise (the rubble's chunks, the soot) — G7's blocky
 * per-square hashes read as checkerboards on every ruin. */
export const BROKEN_PARS_GLSL = /* glsl */ `
float abVNoise(vec2 p, float s) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = abHash(i, s);
  float b = abHash(i + vec2(1.0, 0.0), s);
  float c = abHash(i + vec2(0.0, 1.0), s);
  float d = abHash(i + vec2(1.0, 1.0), s);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

/** The CUT_* mask (city/destruction.ts) → this face's damage kind, plus the
 * face's in-plane position and half size in meters — ONE vec4 varying:
 * (u, v, half u, half v + kind · KIND_STRIDE). The half sizes and the kind
 * are the same at all four corners, so they interpolate to constants. */
export const BROKEN_VERTEX_GLSL = /* glsl */ `
// D2: which face is this vertex on, and is it one destruction exposed?
// Float bit tests, not int bitwise ops (portable to every GLSL ES driver).
float brkMask = floor(aSubOff.w + 0.5);
// D11: a debris piece not broken yet (city.ts CUT_INTACT, 256) — the
// fracture variant draws it nearly whole; the face bits are what is left.
float brkIntact = step(255.5, brkMask);
brkMask -= 256.0 * brkIntact;
float brkFace = normal.x < -0.5 ? 1.0 : normal.x > 0.5 ? 2.0 : normal.y < -0.5 ? 4.0
  : normal.y > 0.5 ? 8.0 : normal.z < -0.5 ? 16.0 : 32.0;
// D10: CUT_STEEL (128) first — a landed column is CUT_RUBBLE | CUT_STEEL.
float brkKind = brkMask >= 128.0 ? 3.0 : brkMask >= 64.0 ? 2.0 : mod(floor(brkMask / brkFace), 2.0);
// Box-centred meters (the unit box's y runs 0..1).
vec3 brkLocal = (position - vec3(0.0, 0.5, 0.0)) * sScale;
vec2 brkUV = abs(normal.x) > 0.5 ? brkLocal.zy : abs(normal.z) > 0.5 ? brkLocal.xy : brkLocal.xz;
vec2 brkHalf = 0.5 * (abs(normal.x) > 0.5 ? sScale.zy : abs(normal.z) > 0.5 ? sScale.xy : sScale.xz);
vBroken = vec4(brkUV, brkHalf.x, brkHalf.y + brkKind * ${KIND_STRIDE});
`;

/** DS2 exposed interiors: the room behind a broken facade, interior-mapped
 * (the window interiors' idea, window-pattern.ts): the view ray runs into
 * an open-plan floor ROOM_DEPTH deep and hits its ceiling (a grid of tiles
 * with light panels), its floor, or the back wall (the core) with desks,
 * cabinets and screens in silhouette against it; torn cables hang from the
 * ceiling CABLE_DEPTH in. Lit rooms light it from the panels (flickering
 * with the dying lights), burning rooms from the floor. The mean far away
 * (brkRoomDetail, G7) and on tiers without window interiors; never on
 * debris (its faces tumble — the fracture variant skips it). */
const ROOM_DEPTH = 7.5;
const CEIL_TILE = 0.6;
const PANEL_PITCH = 2.4;
const CABLE_DEPTH = 1.1;
const CABLE_PITCH = 1.3;
/** A lit room's light on its panels, ceiling, back wall and floor (× the
 * room light: the panels' 0.36 × 1.6 = 0.58 stays under the bloom
 * threshold). */
const PANEL_LIGHT = 1.6;
/** The brightest a lit room's interior gets (linear, its panels' peak
 * channel) — under the bloom threshold. */
export const INTERIOR_PEAK = 0.36 * PANEL_LIGHT;
const INTERIOR_GLSL = /* glsl */ `
#ifndef AB_FRACTURE
    float imOn = step(0.5, uWinInterior) * brkRoomDetail * (1.0 - step(0.5, brkN.y)) * (1.0 - brkSlab);
    vec3 imV = normalize(vBWorldPos - cameraPosition);
    float imRd = -dot(imV, vObjNormal);
    if (imOn > 0.0 && imRd > 0.02) {
      vec3 imUax = brkN.x > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
      float imRu = dot(imV, imUax);
      float imRv = imV.y;
      float imSh = ${((SLAB_SHARE * BROKEN_STOREY) / 2).toFixed(3)};
      float imTop = ${BROKEN_STOREY.toFixed(1)} - imSh;
      float imPv = clamp(brkInSlab * ${BROKEN_STOREY.toFixed(1)}, imSh, imTop);
      float imTb = ${ROOM_DEPTH.toFixed(1)} / imRd;
      float imTv = imRv > 0.0 ? (imTop - imPv) / imRv : imRv < 0.0 ? (imSh - imPv) / imRv : 1e6;
      float imT = min(imTb, imTv);
      float imHu = brkW.x + imRu * imT;
      float imHd = imRd * imT;
      float imHv = clamp(imPv + imRv * imT, imSh, imTop);
      float imY = (imHv - imSh) / (imTop - imSh);
      float imAA = brkAA * (1.0 + imT * 0.6);
      vec3 imCol;
      float imLight;
      float imStuff = 0.0;
      if (imTb <= imTv) {
        // The back wall: desks with screens, cabinets, in silhouette.
        float imCell = floor(imHu / 1.6);
        float imKind = abHash(vec2(imCell, floor(brkStorey)), vBSeed * 53.0);
        float imFu = fract(imHu / 1.6);
        float imH = imKind < 0.55 ? 0.24 + 0.14 * step(0.3, imFu) * step(imFu, 0.62) : imKind < 0.8 ? 0.62 : 0.0;
        imStuff = (1.0 - step(imH, imY)) * mix(0.5, 1.0, abDetail(1.6, imAA));
        imCol = vec3(${ROOM_ALBEDO.toFixed(2)}) * (0.9 + 0.3 * imY);
        imLight = 0.35 + 0.45 * imY;
      } else if (imRv > 0.0) {
        // The ceiling: tiles, a light panel every PANEL_PITCH.
        vec2 imC = vec2(imHu, imHd);
        float imGrid = max(abLine(abPeriodic(imC.x, 0.0, ${CEIL_TILE.toFixed(1)}), 0.02, imAA),
          abLine(abPeriodic(imC.y, 0.0, ${CEIL_TILE.toFixed(1)}), 0.02, imAA));
        vec2 imP = abs(mod(imC + 0.5 * ${PANEL_PITCH.toFixed(1)}, ${PANEL_PITCH.toFixed(1)}) - 0.5 * ${PANEL_PITCH.toFixed(1)});
        float imPanel = abBox(imP, vec2(0.3, 0.6), imAA);
        imPanel = mix(0.125, imPanel, abDetail(${PANEL_PITCH.toFixed(1)}, imAA));
        imCol = vec3(0.24) * (1.0 - 0.45 * imGrid * abDetail(${CEIL_TILE.toFixed(1)}, imAA));
        imLight = 0.5 + ${(PANEL_LIGHT - 0.5).toFixed(2)} * imPanel;
      } else {
        // The floor: dark carpet, scattered debris.
        float imDeb = abVNoise(vec2(imHu, imHd) * 1.4, vBSeed * 61.0);
        imCol = vec3(${ROOM_ALBEDO.toFixed(2)}) * (0.55 + 0.6 * imDeb);
        imLight = 0.22;
      }
      // Deeper is darker (the light falls off into the floor plate).
      float imFall = exp(-imHd / 9.0);
      // Torn cables hanging from the ceiling, a little way in.
      float imTc = ${CABLE_DEPTH.toFixed(1)} / imRd;
      if (imTc < imT) {
        float imCu = brkW.x + imRu * imTc;
        float imCv = imPv + imRv * imTc;
        float imCi = floor(imCu / ${CABLE_PITCH.toFixed(1)});
        float imCh = abHash(vec2(imCi, floor(brkStorey)), vBSeed * 71.0);
        float imLen = 0.3 + 1.6 * imCh;
        float imDrop = clamp((imTop - imCv) / imLen, 0.0, 1.0);
        float imSway = 0.18 * imDrop * imDrop * (abHash(vec2(imCi, 3.0), vBSeed * 71.0) - 0.5);
        float imCx = abs(mod(imCu - imSway, ${CABLE_PITCH.toFixed(1)}) - 0.5 * ${CABLE_PITCH.toFixed(1)});
        float imCable = abLine(imCx, 0.012, brkAA) * step(imCv, imTop) * step(imTop - imLen, imCv)
          * step(0.45, imCh) * abDetail(0.3, brkAA);
        imStuff = max(imStuff, imCable);
        imCol = mix(imCol, vec3(0.03), imCable);
      }
      diffuseColor.rgb = mix(diffuseColor.rgb, imCol * (1.0 - 0.75 * imStuff) * (0.35 + 0.65 * imFall), imOn);
      brkLightK = mix(brkLightK, imLight * imFall, imOn);
      brkFireV = mix(brkFireV, imY, imOn);
      brkStuffK = mix(brkStuffK, imStuff, imOn);
    }
#endif
`;

/** After the facade, roof and hole passes: repaint exposed faces/rubble. */
export const BROKEN_COLOR_GLSL = /* glsl */ `
// --- D2 exposed insides and rubble ---
float brkDmg = floor(vBroken.w / ${KIND_STRIDE});
float brkEmber = 0.0;
// D11: the exposed storey's room — burning, lit, how high in it, contents
// (and dangling bars) in silhouette — its slab edge, and the charred rim.
float brkFire = 0.0;
float brkLit = 0.0;
float brkRoomV = 0.0;
float brkStuffK = 0.0;
float brkSlabK = 0.0;
float brkChar = 0.0;
float brkRoomH = 0.0;
float brkRoomD = 0.0;
// DS2: how bright a lit room's light is here (the interior's ceiling
// panels, walls and floor), and the fire's height in the room.
float brkLightK = 0.0;
float brkFireV = 0.0;
float brkRubble = 0.0;
float brkFresh = 0.0;
if (brkDmg > 0.5) {
  vec3 brkN = abs(vObjNormal);
  // World-anchored in-plane coordinates for the patterns (seam-safe: the
  // instance sits at its nearest torus image, like every other pattern).
  vec2 brkW = brkN.x > 0.5 ? vPatPos.zy : brkN.z > 0.5 ? vPatPos.xy : vPatPos.xz;
  float brkAA = max(wAA.x, wAA.y);
  float brkNoise = mix(0.5, abVNoise(brkW * 1.7, vBSeed * 31.0), abDetail(0.6, brkAA));
  if (brkDmg > 3.5) {
    // DS2 fracture face: the material's fresh break, by library class.
#ifdef AB_FRACTURE
    float frCls = vFrClass;
#else
    float frCls = 0.0;
#endif
    brkFresh = 1.0;
    if (frCls > 1.5) {
      // A pane's edge: dark green glass.
      diffuseColor.rgb = ${GLASS_EDGE} * (0.8 + 0.4 * brkNoise);
    } else if (frCls > 0.5) {
      // Brick courses in section: staggered bricks in mortar.
      float brC = floor(brkW.y / ${COURSE_M});
      float brU = brkW.x / ${BRICK_M} + 0.5 * mod(brC, 2.0);
      float brJoint = max(
        abLine(abPeriodic(brkW.y, 0.0, ${COURSE_M}), 0.006, brkAA),
        abLine(abPeriodic(brU, 0.0, 1.0) * ${BRICK_M}, 0.006, brkAA));
      float brTone = mix(0.5, abHash(vec2(floor(brU), brC), vBSeed * 11.0), abCellDetail(${BRICK_M}, brkAA));
      vec3 brBrick = ${BRICK} * (0.75 + 0.5 * brTone);
      diffuseColor.rgb = mix(brBrick, ${MORTAR}, mix(0.2, brJoint, abDetail(${COURSE_M}, brkAA))) * (0.85 + 0.3 * brkNoise);
    } else {
      // Aggregate: stones in grey cement, their mean far away.
      float agS = abHash(floor(brkW / ${STONE_M}), vBSeed * 9.0);
      float agIn = step(0.45, abHash(floor(brkW / ${STONE_M}) + 17.0, vBSeed * 5.0));
      vec3 agStone = mix(${STONE_DARK}, ${STONE_LIGHT}, agS);
      vec3 agNear = mix(${CEMENT}, agStone, agIn);
      vec3 agMean = mix(${CEMENT}, mix(${STONE_DARK}, ${STONE_LIGHT}, 0.5), 0.55);
      diffuseColor.rgb = mix(agMean, agNear, abDetail(${STONE_M * 2}, brkAA)) * (0.78 + 0.4 * brkNoise);
    }
  } else if (brkDmg > 2.5) {
    // D10 steel: a column or I-beam segment, rebar — dark, streaked rust.
    float brkStreak = abHash(vec2(floor(brkW.x * 3.0), floor(brkW.y * 0.7)), vBSeed * 17.0);
    diffuseColor.rgb = mix(${STEEL}, ${RUST}, smoothstep(0.35, 0.95, brkStreak)) * (0.8 + 0.4 * brkNoise);
  } else if (brkDmg > 1.5) {
    // Rubble: dusty broken concrete, with chunks of the facade's own finish
    // (dusted over too) — hashed in the face's plane, O1.
    brkRubble = 1.0;
    float brkChunk = abVNoise(brkW * 1.3, vBSeed * 7.0);
    vec3 brkConcrete = vec3(${RUBBLE_ALBEDO.toFixed(2)}) * (0.7 + 0.45 * brkNoise);
    vec3 brkFinish = mix(diffuseColor.rgb * 0.8, brkConcrete, 0.35);
    diffuseColor.rgb = mix(brkConcrete, brkFinish,
      mix(${RUBBLE_FINISH.toFixed(2)}, smoothstep(${(0.62 - 0.04).toFixed(2)}, ${(0.62 + 0.04).toFixed(2)}, brkChunk), abDetail(0.77, brkAA)));
  } else {
    float brkStorey = vPatY / ${BROKEN_STOREY.toFixed(1)};
    float brkInSlab = fract(brkStorey);
    // The skeleton: a slab every storey and a column every bay, filtered
    // (they thin to their area share far away); a floor or ceiling face
    // (normal ±y) is all slab.
    float brkSlabLine = abLine(abPeriodic(vPatY, ${((SLAB_SHARE * BROKEN_STOREY) / 2).toFixed(3)}, ${BROKEN_STOREY.toFixed(1)}),
      ${((SLAB_SHARE * BROKEN_STOREY) / 2).toFixed(3)}, wAA.y);
    float brkColumn = abLine(abPeriodic(brkW.x, 0.0, ${ROOM_BAY.toFixed(1)}), ${COLUMN_HALF.toFixed(2)}, wAA.x);
    float brkSlab = max(max(brkSlabLine, brkColumn), step(0.5, brkN.y));
    // Per room: its coin flips resolve to their means once a room is
    // sub-pixel.
    float brkRoomDetail = min(abCellDetail(${ROOM_BAY.toFixed(1)}, wAA.x), abCellDetail(${BROKEN_STOREY.toFixed(1)}, wAA.y));
    float brkRoom = abHash(vec2(floor(brkW.x / ${ROOM_BAY.toFixed(1)}), floor(brkStorey)), vBSeed * 13.0);
    vec3 brkRoomCol = vec3(${ROOM_ALBEDO.toFixed(3)}) * (0.6 + 0.8 * mix(0.5, brkRoom, brkRoomDetail));
    vec3 brkSlabCol = vec3(${SLAB_ALBEDO.toFixed(2)}) * (0.75 + 0.4 * brkNoise);
    diffuseColor.rgb = mix(brkRoomCol, brkSlabCol, brkSlab);
    // D11: inside the room — 0 at its floor, 1 at its ceiling — its
    // contents against the back wall (their mean far away), lights still on
    // in some rooms and fire in others (their shares far away), the
    // charred rim round the opening.
    float brkV = clamp((brkInSlab - ${SLAB_SHARE.toFixed(2)}) / ${(1 - SLAB_SHARE).toFixed(2)}, 0.0, 1.0);
    float brkStuff = mix(0.25, step(brkV, 0.2 + 0.22 * abHash(floor(brkW.xx / 1.6), vBSeed * 19.0 + floor(brkStorey))),
      abCellDetail(1.6, wAA.x));
    diffuseColor.rgb *= 1.0 - 0.5 * brkStuff * (1.0 - brkSlab);
    vec2 brkHalf2 = vec2(vBroken.z, vBroken.w - brkDmg * ${KIND_STRIDE});
    vec2 brkFrom2 = brkHalf2 - abs(vBroken.xy);
    brkChar = (1.0 - smoothstep(0.0, ${CHAR_M.toFixed(1)}, min(brkFrom2.x, brkFrom2.y))) * (1.0 - step(0.5, brkN.y));
    diffuseColor.rgb *= 1.0 - 0.5 * brkChar;
    brkFire = (1.0 - brkSlab) * mix(${ROOM_BURNING.toFixed(2)}, step(brkRoom, ${ROOM_BURNING.toFixed(2)}), brkRoomDetail);
    brkLit = (1.0 - brkSlab) * mix(${(ROOM_LIT - ROOM_BURNING).toFixed(2)},
      step(${ROOM_BURNING.toFixed(2)}, brkRoom) * step(brkRoom, ${ROOM_LIT.toFixed(2)}), brkRoomDetail);
    brkRoomV = brkV;
    brkStuffK = brkStuff;
    brkRoomH = abHash(vec2(floor(brkW.x / ${ROOM_BAY.toFixed(1)}), floor(brkStorey)), vBSeed * 41.0);
    brkRoomD = brkRoomDetail;
    brkSlabK = brkSlab * (1.0 - step(0.5, brkN.y));
    brkLightK = 0.3 + 0.7 * brkV;
    brkFireV = brkV;
${INTERIOR_GLSL}
    if (uBrokenDetail > 0.5) {
      // Jagged rim: within a noisy band of the face's edge the concrete is
      // broken — lighter, chunkier — and rebar sticks out of it.
      vec2 brkHalfSize = vec2(vBroken.z, vBroken.w - brkDmg * ${KIND_STRIDE});
      vec2 brkFromEdge = brkHalfSize - abs(vBroken.xy);
      float brkEdge = min(brkFromEdge.x, brkFromEdge.y);
      float brkJag = 0.35 + 0.9 * abHash(floor(brkW * 2.3), vBSeed * 3.0);
      float brkRim = 1.0 - step(brkJag, brkEdge);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${SLAB_ALBEDO.toFixed(2)}) * (0.9 + 0.5 * brkNoise), brkRim * 0.85);
      // Rebar: thin rusty bars every 0.3 m off the slab edges and the rim.
      float brkBarU = abs(fract(brkW.x / 0.3) - 0.5);
      float brkNearSlab = 1.0 - step(0.12 + 0.18 * brkNoise, brkInSlab - ${SLAB_SHARE.toFixed(2)});
      float brkBar = (1.0 - step(0.08, brkBarU)) * max(brkNearSlab, brkRim) * (1.0 - step(0.5, brkN.y));
      // D11: and bars dangling from the slab above, each its own length
      // (gone once a bar is sub-pixel).
      float brkHangU = abs(fract(brkW.x / 0.45) - 0.5);
      float brkHangL = 0.08 + 0.4 * abHash(vec2(floor(brkW.x / 0.45), floor(brkStorey)), vBSeed * 29.0);
      float brkHang = (1.0 - step(0.06, brkHangU)) * step(1.0 - brkHangL, brkV) * (1.0 - brkSlab)
        * step(0.55, abHash(vec2(floor(brkW.x / 0.45), floor(brkStorey) + 7.0), vBSeed * 37.0))
        * abDetail(0.45, brkAA);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.05, 0.035), max(brkBar, brkHang));
      brkStuffK = max(brkStuffK, brkHang);
    }
    // A smouldering room glows along its floor, fading up into the dark —
    // embers lighting a room, not a lit orange tile (its mean far away).
    brkEmber = (1.0 - brkSlab) * mix(${EMBER_SHARE.toFixed(2)} * 0.4,
      step(brkRoom, ${EMBER_SHARE.toFixed(2)}) * (1.0 - smoothstep(0.1, 0.7, brkInSlab)), brkRoomDetail);
  }
  // D8 scorch: soot-blackened patches over everything destruction exposed —
  // the stump's cut faces and the rubble alike.
  // DS2: smooth soot (G7's 2.2 m squares read as black boxes), and a
  // fresh break is cleaner than the faces that burned.
  float brkSoot = mix(0.325, smoothstep(0.45, 0.8, abVNoise(brkW * 0.45, vBSeed * 5.0)), abDetail(2.2, brkAA));
  diffuseColor.rgb *= 1.0 - mix(mix(${SOOT.toFixed(2)}, ${RUBBLE_SOOT.toFixed(2)}, brkRubble), ${FRESH_SOOT.toFixed(2)}, brkFresh) * brkSoot;
}
`;

/** After every emissive pass: an exposed face or rubble emits nothing the
 * facade computed — only the gutted rooms' embers; D11: and the broken
 * floor's rooms behind it — the lights still on in some (brightest at the
 * ceiling, the contents in silhouette), fire in others (hottest at the
 * floor, flickering), the street's glow on the slab edges, embers in the
 * charred rim. All under the bloom threshold. */
export const BROKEN_EMISSIVE_GLSL = /* glsl */ `
if (brkDmg > 0.5) {
  totalEmissiveRadiance = ${EMBER} * brkEmber;
  // O1: the city's glow off a settled pile (its up faces most).
  totalEmissiveRadiance += ${RUBBLE_GLOW} * brkRubble * (0.55 + 0.45 * step(0.5, vObjNormal.y));
  float brkFlick = 0.75 + 0.25 * sin(6.2832 * (uFirePhase.x + vBSeed * 5.0 + brkRoomV));
  // DL1: dying lights — a share of the lit rooms dead or stuttering in
  // bursts (their mean once a room is sub-pixel, G7). Off: exactly 1.
  float brkPower = 1.0;
  if (uRoomFlicker > 0.0) {
    float brkFault = step(brkRoomH, uRoomFlicker);
    float brkDead = step(brkRoomH, 0.5 * uRoomFlicker);
    float brkBurst = step(0.55, abHash(vec2(floor(uFirePhase.y * 6.0), brkRoomH * 17.0), 5.0));
    float brkBlink = step(0.4, abHash(vec2(floor(uFirePhase.x * 13.0), brkRoomH * 23.0), 7.0));
    float brkOne = mix(1.0, mix(mix(1.0, brkBlink, brkBurst), 0.0, brkDead), brkFault);
    brkPower = mix(1.0 - uRoomFlicker * (0.5 + 0.5 * 0.45 * 0.4), brkOne, brkRoomD);
  }
  totalEmissiveRadiance += ${ROOM_LIGHT} * brkLit * brkLightK * (1.0 - 0.75 * brkStuffK) * brkPower;
  totalEmissiveRadiance += mix(${ROOM_FIRE_LOW}, ${ROOM_FIRE_HIGH}, brkFireV) * brkFire * brkFlick * (1.0 - 0.5 * brkStuffK);
  totalEmissiveRadiance += ${SLAB_GLOW} * brkSlabK;
  totalEmissiveRadiance += ${RIM_EMBER} * brkChar * brkChar * 0.4 * brkFlick;
}
`;
