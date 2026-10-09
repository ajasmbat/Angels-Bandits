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

/** D2 quality switch (quality.ts destructionDetail): 1 = rebar and jagged
 * rims, 0 = flat slabs and rooms. A uniform, so a tier switch compiles
 * nothing. */
export const BROKEN_DETAIL_UNIFORM = { value: 1 };

/** Storey pitch of the exposed slabs, meters. */
export const BROKEN_STOREY = 3.6;
/** Slab thickness as a share of the storey. */
const SLAB_SHARE = 0.1;
/** Linear albedo of the slabs, the gutted rooms and the rubble. */
const SLAB_ALBEDO = 0.2;
const ROOM_ALBEDO = 0.03;
/** Ember: share of gutted rooms that smoulder, and its linear colour. */
const EMBER_SHARE = 0.14;
const EMBER = "vec3(0.42, 0.13, 0.03)";

/** Packs the face's damage kind above the half-size in vBroken.w. */
const KIND_STRIDE = "4096.0";

/** The CUT_* mask (city/destruction.ts) → this face's damage kind, plus the
 * face's in-plane position and half size in meters — ONE vec4 varying:
 * (u, v, half u, half v + kind · KIND_STRIDE). The half sizes and the kind
 * are the same at all four corners, so they interpolate to constants. */
export const BROKEN_VERTEX_GLSL = /* glsl */ `
// D2: which face is this vertex on, and is it one destruction exposed?
// Float bit tests, not int bitwise ops (portable to every GLSL ES driver).
float brkMask = floor(aSubOff.w + 0.5);
float brkFace = normal.x < -0.5 ? 1.0 : normal.x > 0.5 ? 2.0 : normal.y < -0.5 ? 4.0
  : normal.y > 0.5 ? 8.0 : normal.z < -0.5 ? 16.0 : 32.0;
float brkKind = brkMask >= 64.0 ? 2.0 : mod(floor(brkMask / brkFace), 2.0);
// Box-centred meters (the unit box's y runs 0..1).
vec3 brkLocal = (position - vec3(0.0, 0.5, 0.0)) * sScale;
vec2 brkUV = abs(normal.x) > 0.5 ? brkLocal.zy : abs(normal.z) > 0.5 ? brkLocal.xy : brkLocal.xz;
vec2 brkHalf = 0.5 * (abs(normal.x) > 0.5 ? sScale.zy : abs(normal.z) > 0.5 ? sScale.xy : sScale.xz);
vBroken = vec4(brkUV, brkHalf.x, brkHalf.y + brkKind * ${KIND_STRIDE});
`;

/** After the facade, roof and hole passes: repaint exposed faces/rubble. */
export const BROKEN_COLOR_GLSL = /* glsl */ `
// --- D2 exposed insides and rubble ---
float brkDmg = floor(vBroken.w / ${KIND_STRIDE});
float brkEmber = 0.0;
if (brkDmg > 0.5) {
  vec3 brkN = abs(vObjNormal);
  // World-anchored in-plane coordinates for the patterns (seam-safe: the
  // instance sits at its nearest torus image, like every other pattern).
  vec2 brkW = brkN.x > 0.5 ? vBWorldPos.zy : brkN.z > 0.5 ? vBWorldPos.xy : vBWorldPos.xz;
  float brkNoise = abHash(floor(brkW * 1.7), vBSeed * 31.0);
  if (brkDmg > 1.5) {
    // Rubble: broken concrete, with chunks of the facade's own finish.
    float brkChunk = abHash(floor(vBWorldPos.xz * 1.3 + vBWorldPos.y * 2.1), vBSeed * 7.0);
    vec3 brkConcrete = vec3(${SLAB_ALBEDO.toFixed(2)}) * (0.45 + 0.7 * brkNoise);
    diffuseColor.rgb = mix(brkConcrete, diffuseColor.rgb * 0.8, step(0.62, brkChunk));
  } else {
    float brkStorey = vWorldY / ${BROKEN_STOREY.toFixed(1)};
    float brkInSlab = fract(brkStorey);
    // A floor or ceiling face (normal ±y) is all slab.
    float brkSlab = max(step(brkInSlab, ${SLAB_SHARE.toFixed(2)}), step(0.5, brkN.y));
    float brkRoom = abHash(vec2(floor(brkW.x / 6.0), floor(brkStorey)), vBSeed * 13.0);
    vec3 brkRoomCol = vec3(${ROOM_ALBEDO.toFixed(2)}) * (0.6 + 0.8 * brkRoom);
    vec3 brkSlabCol = vec3(${SLAB_ALBEDO.toFixed(2)}) * (0.75 + 0.4 * brkNoise);
    diffuseColor.rgb = mix(brkRoomCol, brkSlabCol, brkSlab);
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
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.05, 0.035), brkBar);
    }
    brkEmber = (1.0 - brkSlab) * step(brkRoom, ${EMBER_SHARE.toFixed(2)});
  }
}
`;

/** After every emissive pass: an exposed face or rubble emits nothing the
 * facade computed — only the gutted rooms' embers. */
export const BROKEN_EMISSIVE_GLSL = /* glsl */ `
if (brkDmg > 0.5) {
  totalEmissiveRadiance = ${EMBER} * brkEmber;
}
`;
