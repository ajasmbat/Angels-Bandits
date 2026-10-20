// D3 collapse debris on the client: the one place a collapse piece's pose
// (common/src/city/collapse.ts piecePose — the same pose the crash check
// collides with) becomes an instance matrix. The city renderer owns the mesh
// (a child of the city mesh with the building material, so a chunk keeps the
// facade it fell from); this module is the pure, tested seam between the two.
//
// D10: the mesh's shape. A piece is still the oriented box it collides as,
// but it is DRAWN as a broken one inside that box. DS2: the shape is one of
// the fracture library's baked cells (fracture-library.ts) — a Voronoi-style
// convex polytope inside the unit box, per material class (concrete slab,
// masonry, glass, steel) and variant — read by the vertex shader from the
// library texture by gl_VertexID, rotated onto the piece's own thin (or, for
// steel, long) axis. Every cell lies inside the box, so nothing ever pokes
// out of it (drawn ⊆ collided); rebar ribbons run from inside the torn
// concrete out into the space the break opened, a metric REBAR_HALF wide,
// and a steel member is thinned, twisted and bowed inside its box.
// `libraryVertex` is the shader's vertex in JS — the tests hold the GLSL to
// it.

import type { PiecePose } from "@angels-bandits/common/city/collapse";
import * as THREE from "three";
import { KIND_STRIDE } from "./broken-shading";
import {
  FRACTURE_VARIANTS,
  FracClass,
  INTACT_ROW,
  LIB_VERTS,
  ROW_TEXELS,
  intactCell,
  libraryIndices,
  libraryTexels,
} from "./fracture-library";

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const quat = new THREE.Quaternion();
const pos = new THREE.Vector3();
const scale = new THREE.Vector3();
/** The city's unit box stands on its base (y in [0, 1]); a pose is centred. */
const CENTRE = new THREE.Matrix4().makeTranslation(0, -0.5, 0);

/**
 * The instance matrix of a piece posed at `pose`, drawn at the torus image
 * whose building centre is (`originX`, `originZ`). Allocation-free.
 */
export function pieceMatrix(
  pose: PiecePose,
  originX: number,
  originZ: number,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  if (pose.quat) {
    matOrigin.x = originX;
    matOrigin.z = originZ;
    return quatMatrix(pose, matOrigin, out);
  }
  quat.setFromAxisAngle(pose.axis === 0 ? AXIS_X : AXIS_Z, pose.phi);
  pos.set(originX + pose.x, pose.y, originZ + pose.z);
  scale.set(2 * pose.hx, 2 * pose.hy, 2 * pose.hz);
  return out.compose(pos, quat, scale).multiply(CENTRE);
}

/** D10: pieceMatrixAt()'s torus-image origin — set once per collapse, so
 * the per-piece call carries no doubles (O5's rule: a double handed to a
 * call V8 does not inline is boxed, and there are ~4× D3's pieces). */
export const pieceOrigin = { x: 0, z: 0 };

/** pieceMatrix's own origin for a physics pose (pieceOrigin is the
 * per-collapse loops'). */
const matOrigin = { x: 0, z: 0 };

/** pieceMatrix at `pieceOrigin`. Allocation-free. */
export function pieceMatrixAt(
  pose: PiecePose,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  if (pose.quat) return quatMatrix(pose, pieceOrigin, out);
  quat.setFromAxisAngle(pose.axis === 0 ? AXIS_X : AXIS_Z, pose.phi);
  pos.set(pieceOrigin.x + pose.x, pose.y, pieceOrigin.z + pose.z);
  scale.set(2 * pose.hx, 2 * pose.hy, 2 * pose.hz);
  return out.compose(pos, quat, scale).multiply(CENTRE);
}

/**
 * DS1: a physics pose's matrix at `pieceOrigin` — three's compose(position,
 * quaternion, scale) × CENTRE written straight into `out.elements`: handing
 * a quaternion's four doubles to three's setters (calls V8 does not inline)
 * boxed each of them, per piece per frame (O5's rule). Allocation-free.
 */
function quatMatrix(
  pose: PiecePose,
  origin: { x: number; z: number },
  out: THREE.Matrix4,
): THREE.Matrix4 {
  const te = out.elements;
  const x = pose.qx;
  const y = pose.qy;
  const z = pose.qz;
  const w = pose.qw;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const sx = 2 * pose.hx;
  const sy = 2 * pose.hy;
  const sz = 2 * pose.hz;
  te[0] = (1 - (yy + zz)) * sx;
  te[1] = (xy + wz) * sx;
  te[2] = (xz - wy) * sx;
  te[3] = 0;
  te[4] = (xy - wz) * sy;
  te[5] = (1 - (xx + zz)) * sy;
  te[6] = (yz + wx) * sy;
  te[7] = 0;
  te[8] = (xz + wy) * sz;
  te[9] = (yz - wx) * sz;
  te[10] = (1 - (xx + yy)) * sz;
  te[11] = 0;
  // × CENTRE: the unit box stands on its base, the pose is its centre.
  te[12] = origin.x + pose.x - 0.5 * (te[4] as number);
  te[13] = pose.y - 0.5 * (te[5] as number);
  te[14] = origin.z + pose.z - 0.5 * (te[6] as number);
  te[15] = 1;
  return out;
}

// --- DS2 fracture geometry (the library, posed) -----------------------------

/** Half width of a rebar ribbon, m, and the longest a bar sticks out of
 * the break, m (a bar in a 20 m slab's unit cell would run for metres). */
export const REBAR_HALF = 0.05;
export const REBAR_MAX_M = 1.4;
/** DS2: once a piece rests, its cuts are filled back this far toward its
 * box (a pile of thin crushed slabs, cut deep, is all dark slits). */
export const REST_FILL = 0.55;
/** A broken steel member's cross-section share of its box, its twist at
 * the ends (rad, at most) and its bow (unit-box share, at most): the
 * rotated, bowed section stays inside the box. */
export const STEEL_THIN = 0.55;
export const STEEL_TWIST = 0.6;
export const STEEL_BOW = 0.5 - 0.5 * STEEL_THIN * Math.SQRT2;
/** D11: the falling debris's ember (fresh-broken concrete) and uplight
 * colours, linear — their sum stays under the bloom threshold. */
const FRACTURE_EMBER = "vec3(0.42, 0.12, 0.025)";
const FRACTURE_UPLIGHT = "vec3(0.16, 0.1, 0.05)";
/** DS2: the share of falling pieces whose broken faces glow with the fire
 * they came out of, and the glow the rest keep. */
const FRACTURE_HOT_SHARE = "0.3";
const FRACTURE_COOL = "0.15";
/** CUT_STEEL (city/destruction.ts), CUT_RUBBLE and city.ts CUT_INTACT. */
const STEEL_BIT = 128;
const RUBBLE_BIT = 64;
const INTACT_BIT = 256;

/** The library's class for a piece: steel if CUT_STEEL; a plate whose thin
 * axis is y is a floor slab (concrete); a facade plate breaks as its
 * building's facade (archetype 0 glass, 1 masonry, 2 office concrete). */
export function pieceClass(
  steel: boolean,
  thinAxis: number,
  archetype: number,
): FracClass {
  if (steel) return FracClass.STEEL;
  if (thinAxis === 1) return FracClass.CONCRETE;
  const arch = Math.floor(archetype + 0.01);
  return arch < 1
    ? FracClass.GLASS
    : arch < 2
      ? FracClass.MASONRY
      : FracClass.CONCRETE;
}

/** The piece's special axis: a plate's thinnest, steel's longest. */
export function pieceAxis(
  size: readonly [number, number, number],
  steel: boolean,
): number {
  const [x, y, z] = size;
  if (steel) return x >= y && x >= z ? 0 : y >= z ? 1 : 2;
  return x <= y && x <= z ? 0 : y <= z ? 1 : 2;
}

/** Canonical (Y special) → the piece's axes: cyclic, so windings hold. */
export function permute(
  c: readonly [number, number, number],
  axis: number,
): [number, number, number] {
  if (axis === 1) return [c[0], c[1], c[2]];
  if (axis === 0) return [c[1], c[2], c[0]];
  return [c[2], c[0], c[1]];
}

/** A resting piece's cell vertex filled back toward the box: REST_FILL of
 * the way to where the ray from the centre leaves the box. Inside the box
 * (a mix of two points inside it). */
export function restFill(
  c: readonly [number, number, number],
): [number, number, number] {
  const m = Math.max(Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2]), 1e-6);
  const k = 1 + REST_FILL * (0.5 / m - 1);
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** The steel's twist-and-bow of canonical point `c` (the shader's, in JS):
 * the section thinned to STEEL_THIN, turned by up to ±STEEL_TWIST from end
 * to end, bowed by up to STEEL_BOW in the middle. `h2`, `h3` in [0, 1). */
export function steelBend(
  c: readonly [number, number, number],
  h2: number,
  h3: number,
): [number, number, number] {
  const t = c[1] + 0.5;
  const th = (h2 - 0.5) * 2 * STEEL_TWIST * (2 * t - 1);
  const x = c[0] * STEEL_THIN;
  const z = c[2] * STEEL_THIN;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const bow = STEEL_BOW * (2 * h3 - 1) * 4 * t * (1 - t);
  return [cs * x - sn * z + bow, c[1], sn * x + cs * z];
}

/**
 * The shader's vertex in JS: vertex `v` of library row `row` (texels from
 * libraryTexels) on a piece of size `size` (m) whose special axis is
 * `axis`, as a unit-box position (y in [0, 1]). `steel` applies the bend.
 */
export function libraryVertex(
  texels: Float32Array,
  row: number,
  v: number,
  size: readonly [number, number, number],
  axis: number,
  steel: { h2: number; h3: number } | null,
  rest = false,
  barLen = 1,
): [number, number, number] {
  const at = (r: number) => ((row * ROW_TEXELS + r) * LIB_VERTS + v) * 4;
  let c: [number, number, number] = [
    texels[at(0)] as number,
    texels[at(0) + 1] as number,
    texels[at(0) + 2] as number,
  ];
  if ((texels[at(3) + 3] as number) > 0.5) {
    // A bar's outer end, held to REBAR_MAX_M (× barLen in [0.5, 1]).
    const a = [texels[at(3)], texels[at(3) + 1], texels[at(3) + 2]] as [
      number,
      number,
      number,
    ];
    const d = permute([c[0] - a[0], c[1] - a[1], c[2] - a[2]], axis);
    const m = Math.hypot(d[0] * size[0], d[1] * size[1], d[2] * size[2]);
    const k = Math.min(1, (REBAR_MAX_M * barLen) / Math.max(m, 1e-6));
    c = [
      a[0] + (c[0] - a[0]) * k,
      a[1] + (c[1] - a[1]) * k,
      a[2] + (c[2] - a[2]) * k,
    ];
  }
  if (rest && (texels[at(0) + 3] as number) < 1.5) c = restFill(c);
  if (steel) c = steelBend(c, steel.h2, steel.h3);
  const o = permute(
    [
      texels[at(2)] as number,
      texels[at(2) + 1] as number,
      texels[at(2) + 2] as number,
    ],
    axis,
  );
  const p = permute(c, axis);
  return [
    p[0] + (o[0] * REBAR_HALF) / Math.max(size[0], 1e-4),
    p[1] + 0.5 + (o[1] * REBAR_HALF) / Math.max(size[1], 1e-4),
    p[2] + (o[2] * REBAR_HALF) / Math.max(size[2], 1e-4),
  ];
}

/** DS2: the library's vertex-stage pars — the texture, the rebar share,
 * and `position` / `normal` redefined as the library vertex (abFrInit, the
 * first thing main does, fills them; the facade passes read them as they
 * read the box's). */
export const FRACTURE_VERTEX_PARS_GLSL = /* glsl */ `
#ifdef AB_FRACTURE
uniform highp sampler2D uFracLib;
uniform float uRebar;
vec3 abFrPos;
vec3 abFrN;
vec3 abFrTrueN;
float abFrOn;
float abFrClass;
float abFrHash;
void abFrInit() {
  vec3 frSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  float frMask = floor(aSubOff.w + 0.5);
  float frIntact = step(${INTACT_BIT - 0.5}, frMask);
  frMask -= ${INTACT_BIT}.0 * frIntact;
  float frSteel = step(${STEEL_BIT - 0.5}, frMask);
  float frRest = mod(floor(frMask / ${RUBBLE_BIT}.0), 2.0);
  int frAx;
  if (frSteel > 0.5) {
    frAx = frSize.x >= frSize.y && frSize.x >= frSize.z ? 0 : frSize.y >= frSize.z ? 1 : 2;
  } else {
    frAx = frSize.x <= frSize.y && frSize.x <= frSize.z ? 0 : frSize.y <= frSize.z ? 1 : 2;
  }
  float frArch = floor(aArchetype.x + 0.01);
  abFrClass = frSteel > 0.5 ? ${FracClass.STEEL}.0 : frAx == 1 ? ${FracClass.CONCRETE}.0
    : frArch < 0.5 ? ${FracClass.GLASS}.0 : frArch < 1.5 ? ${FracClass.MASONRY}.0 : ${FracClass.CONCRETE}.0;
  // The per-piece hash: its own offset in its tier frame (static, unique
  // per piece) and its tier — never the slot, so a re-layout never re-rolls.
  float frH = fract(sin(dot(aSubOff.xyz + 0.37 * aParent, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  abFrHash = frH;
  float frH2 = fract(frH * 7.13 + 0.31);
  float frH3 = fract(frH * 13.7 + 0.57);
  int frRow = frIntact > 0.5 ? ${INTACT_ROW}
    : int(abFrClass) * ${FRACTURE_VARIANTS} + int(min(floor(frH * ${FRACTURE_VARIANTS}.0), ${FRACTURE_VARIANTS - 1}.0));
  ivec2 frTc = ivec2(gl_VertexID, frRow * ${ROW_TEXELS});
  vec4 frT0 = texelFetch(uFracLib, frTc, 0);
  vec4 frT1 = texelFetch(uFracLib, frTc + ivec2(0, 1), 0);
  vec4 frT2 = texelFetch(uFracLib, frTc + ivec2(0, 2), 0);
  vec4 frT3 = texelFetch(uFracLib, frTc + ivec2(0, 3), 0);
  vec3 frC = frT0.xyz;
  vec3 frN = frT1.xyz;
  vec3 frO = frT2.xyz;
  abFrOn = frT0.w;
  // A bar's outer end, held to REBAR_MAX_M (its own length, 0.5–1 of it).
  if (frT3.w > 0.5) {
    vec3 frD = frC - frT3.xyz;
    vec3 frDP = frAx == 1 ? frD : frAx == 0 ? frD.yzx : frD.zxy;
    float frM = length(frDP * frSize);
    float frLen = ${REBAR_MAX_M.toFixed(2)} * (0.5 + 0.5 * fract(frH * 3.7 + frT1.w * 0.29));
    frC = frT3.xyz + frD * min(1.0, frLen / max(frM, 1e-6));
  }
  // A resting piece's cuts filled back toward its box (restFill, in JS).
  if (frRest > 0.5 && abFrOn < 1.5) {
    vec3 frAbs = abs(frC);
    float frMx = max(max(frAbs.x, frAbs.y), max(frAbs.z, 1e-6));
    frC *= 1.0 + ${REST_FILL.toFixed(2)} * (0.5 / frMx - 1.0);
  }
  // DL1 rebar share: a bar past it collapses to a point.
  if (abFrOn > 1.5 && fract(frH * 5.3 + frT1.w * 0.618) >= uRebar) {
    frC = vec3(0.0);
    frO = vec3(0.0);
  }
  // Steel twists and bows (steelBend, in JS), inside its box.
  if (abFrClass > 2.5 && frIntact < 0.5) {
    float frT = frC.y + 0.5;
    float frTh = (frH2 - 0.5) * ${(2 * STEEL_TWIST).toFixed(3)} * (2.0 * frT - 1.0);
    float frCs = cos(frTh);
    float frSn = sin(frTh);
    vec2 frXZ = frC.xz * ${STEEL_THIN.toFixed(3)};
    frC.xz = vec2(frCs * frXZ.x - frSn * frXZ.y, frSn * frXZ.x + frCs * frXZ.y);
    frC.x += ${STEEL_BOW.toFixed(4)} * (2.0 * frH3 - 1.0) * 4.0 * frT * (1.0 - frT);
    frN.xz = vec2(frCs * frN.x - frSn * frN.z, frSn * frN.x + frCs * frN.z);
  }
  vec3 frP = frAx == 1 ? frC : frAx == 0 ? frC.yzx : frC.zxy;
  vec3 frPN = frAx == 1 ? frN : frAx == 0 ? frN.yzx : frN.zxy;
  vec3 frPO = frAx == 1 ? frO : frAx == 0 ? frO.yzx : frO.zxy;
  abFrPos = frP + vec3(0.0, 0.5, 0.0) + frPO * ${REBAR_HALF.toFixed(2)} / max(frSize, vec3(1e-4));
  abFrTrueN = frPN;
  // The facade passes want a box face's axis: the cut face's nearest.
  vec3 frA = abs(frPN);
  abFrN = frA.x >= frA.y && frA.x >= frA.z ? vec3(sign(frPN.x), 0.0, 0.0)
    : frA.y >= frA.z ? vec3(0.0, sign(frPN.y), 0.0) : vec3(0.0, 0.0, sign(frPN.z));
}
#define position abFrPos
#define normal abFrN
#endif
`;

/** The debris material's vertex stage after VERTEX_MAIN (`brkMask`,
 * `brkIntact`, `brkHalf`, `sScale` in scope): a cut face paints as broken
 * concrete (kind 4: aggregate, brick or glass edge by class), rebar as
 * steel; patterns ride the piece. */
export const FRACTURE_VERTEX_GLSL = /* glsl */ `
#ifdef AB_FRACTURE
{
  float frKind = floor(vBroken.w / ${KIND_STRIDE});
  if (abFrOn > 1.5) {
    // Rebar paints as steel whatever face it leaves from.
    vBroken.w = brkHalf.y + 3.0 * ${KIND_STRIDE};
  } else if (abFrOn > 0.5 && frKind < 2.5) {
    vBroken.w = brkHalf.y + 4.0 * ${KIND_STRIDE};
  }
  // DS1: patterns ride the piece (its tier frame, in metres) — a storey's
  // slab lines along its own storeys, however it lands or tumbles.
  vPatPos = vMeters;
  vPatY = vMeters.y;
  // D11 lit debris: falling (no CUT_RUBBLE bit yet), on a cut face, and how
  // far this face looks down once posed (R·n — the scale only lengthens it).
  vFrLit = vec3(
    (1.0 - mod(floor(brkMask / 64.0), 2.0)) * (1.0 - brkIntact),
    // a cut face — the hot ones (a few pieces) glow fully
    step(0.5, abFrOn) * step(abFrOn, 1.5) * mix(${FRACTURE_COOL}, 1.0, step(abFrHash, ${FRACTURE_HOT_SHARE})),
    max(0.0, -normalize(mat3(modelMatrix) * mat3(instanceMatrix) * abFrTrueN).y)
  );
  vFrClass = abFrClass;
}
#endif
`;

/** D11: the fracture variant's own varyings (both stages). */
export const FRACTURE_PARS_GLSL = /* glsl */ `
#ifdef AB_FRACTURE
// (falling, on a cut face, how far the face looks down)
varying vec3 vFrLit;
// DS2: the library class (fracture-library.ts FracClass).
flat varying float vFrClass;
#endif
`;

/** D11: debris that reads at range — while a piece falls, the faces the
 * break exposed (its broken concrete, not its facade) glow with the fire it
 * came out of and, looking down, take the street's warm glow from below.
 * Off once it rests (the rubble is the D2 look). Both under the bloom
 * threshold (0.72). */
export const FRACTURE_EMISSIVE_GLSL = /* glsl */ `
#ifdef AB_FRACTURE
if (vFrLit.x > 0.5 && brkDmg > 0.5) {
  totalEmissiveRadiance += ${FRACTURE_EMBER} * 0.6 * vFrLit.y + ${FRACTURE_UPLIGHT} * vFrLit.z;
}
#endif
`;

/**
 * The debris mesh's geometry: LIB_VERTS vertices sharing the library's
 * index buffer. Its own position / normal are the intact box's (bounds,
 * and three's attribute set); the shader reads the real ones by
 * gl_VertexID. Pure; built once.
 */
export function fractureGeometry(): THREE.BufferGeometry {
  const intact = libraryTexels([intactCell()]);
  const pos = new Float32Array(LIB_VERTS * 3);
  const nrm = new Float32Array(LIB_VERTS * 3);
  for (let v = 0; v < LIB_VERTS; v++) {
    pos[v * 3] = intact[v * 4] as number;
    pos[v * 3 + 1] = (intact[v * 4 + 1] as number) + 0.5;
    pos[v * 3 + 2] = intact[v * 4 + 2] as number;
    const n = (LIB_VERTS + v) * 4;
    nrm[v * 3] = intact[n] as number;
    nrm[v * 3 + 1] = intact[n + 1] as number;
    nrm[v * 3 + 2] = intact[n + 2] as number;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geometry.setIndex(libraryIndices());
  return geometry;
}
