// D3 collapse debris on the client: the one place a collapse piece's pose
// (common/src/city/collapse.ts piecePose — the same pose the crash check
// collides with) becomes an instance matrix. The city renderer owns the mesh
// (a child of the city mesh with the building material, so a chunk keeps the
// facade it fell from); this module is the pure, tested seam between the two.
//
// D10: the mesh's shape. A piece is still the oriented box it collides as,
// but it is DRAWN as a broken one inside that box: the fracture geometry
// below is the unit box subdivided, every vertex carrying a chip depth in
// metres (uv.x) that the debris material pushes it inward by — per boundary
// axis, scaled by a per-piece hash and clamped to FRACTURE_MAX_SHARE of the
// piece's half extent on that axis — so corners are knocked off and edges
// are torn on a 20 m slab and a 1.2 m column alike, and nothing ever pokes
// out of the box (drawn ⊆ collided). Rebar ribbons (uv.y 1–4) span each
// chipped edge midpoint, from the broken concrete out to where the edge was,
// painted as steel. `fractureInset` is the shader's displacement in JS — the
// tests hold the GLSL to it.

import { mulberry32 } from "@angels-bandits/common/city";
import type { PiecePose } from "@angels-bandits/common/city/collapse";
import * as THREE from "three";
import { KIND_STRIDE } from "./broken-shading";

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
  // DS1: a physics pose carries its own rotation.
  if (pose.quat) quat.set(pose.qx, pose.qy, pose.qz, pose.qw);
  else quat.setFromAxisAngle(pose.axis === 0 ? AXIS_X : AXIS_Z, pose.phi);
  pos.set(originX + pose.x, pose.y, originZ + pose.z);
  scale.set(2 * pose.hx, 2 * pose.hy, 2 * pose.hz);
  return out.compose(pos, quat, scale).multiply(CENTRE);
}

/** D10: pieceMatrixAt()'s torus-image origin — set once per collapse, so
 * the per-piece call carries no doubles (O5's rule: a double handed to a
 * call V8 does not inline is boxed, and there are ~4× D3's pieces). */
export const pieceOrigin = { x: 0, z: 0 };

/** pieceMatrix at `pieceOrigin`. Allocation-free. */
export function pieceMatrixAt(
  pose: PiecePose,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  // DS1: a physics pose carries its own rotation.
  if (pose.quat) quat.set(pose.qx, pose.qy, pose.qz, pose.qw);
  else quat.setFromAxisAngle(pose.axis === 0 ? AXIS_X : AXIS_Z, pose.phi);
  pos.set(pieceOrigin.x + pose.x, pose.y, pieceOrigin.z + pose.z);
  scale.set(2 * pose.hx, 2 * pose.hy, 2 * pose.hz);
  return out.compose(pos, quat, scale).multiply(CENTRE);
}

// --- D10 fracture geometry ----------------------------------------------------

/** Segments per axis of the subdivided unit box. */
export const FRACTURE_SEGMENTS = 2;
/** A vertex never moves in further than this share of the piece's half
 * extent on any axis. */
export const FRACTURE_MAX_SHARE = 0.3;
/** Chip depth ranges, m: a knocked-off corner, a torn edge, a face's
 * roughness. */
export const CHIP_CORNER: readonly [number, number] = [1.0, 2.6];
export const CHIP_EDGE: readonly [number, number] = [0.4, 1.8];
export const CHIP_FACE: readonly [number, number] = [0, 0.25];
/** The per-piece hash scales a chip into [FRACTURE_HASH_MIN, 1]. */
export const FRACTURE_HASH_MIN = 0.45;
/** D11: the share of its chips an intact piece (CUT_INTACT) keeps. */
export const INTACT_CHIP = 0.1;
/** Half width of a rebar ribbon, m. */
export const REBAR_HALF = 0.05;
/** D11: the falling debris's ember (chipped concrete) and uplight colours,
 * linear — their sum stays under the bloom threshold. */
const FRACTURE_EMBER = "vec3(0.42, 0.12, 0.025)";
const FRACTURE_UPLIGHT = "vec3(0.16, 0.1, 0.05)";
/** uv.y role codes: 0 the box surface; 1/2 a rebar ribbon's inner end
 * (side −/+), 3/4 its outer end (side −/+). */
export const ROLE_SURFACE = 0;

/** Which axes `p` (unit box, y in [0, 1]) lies on the boundary of. */
function boundary(
  p: readonly [number, number, number],
): [boolean, boolean, boolean] {
  return [
    Math.abs(p[0]) > 0.4999,
    p[1] < 0.0001 || p[1] > 0.9999,
    Math.abs(p[2]) > 0.4999,
  ];
}

/** The chip depth of a surface vertex at unit position `p`, m — keyed on
 * the position (a vertex shared by several faces gets one depth, so the
 * broken box stays closed). */
export function chipAt(p: readonly [number, number, number]): number {
  const q = (v: number) => Math.round((v + 0.5) * 8);
  const rand = mulberry32(
    (Math.imul(q(p[0]) + 3, 0x9e3779b1) ^
      Math.imul(q(p[1]) + 5, 0x85ebca6b) ^
      Math.imul(q(p[2]) + 7, 0xc2b2ae35)) >>>
      0,
  );
  const n = boundary(p).filter(Boolean).length;
  const [lo, hi] = n >= 3 ? CHIP_CORNER : n === 2 ? CHIP_EDGE : CHIP_FACE;
  return lo + (hi - lo) * rand();
}

/**
 * The shader's displacement in JS: unit-box vertex `p` with chip `chip`
 * (m) and role `role` on a piece of size `size` (m) whose per-piece hash
 * is `h01`, as a displaced unit position. Inward along each boundary axis
 * by min(chip · (MIN + (1 − MIN)·h01), MAX_SHARE · half) metres; a rebar
 * end also steps REBAR_HALF along its edge, and its outer end stays put.
 */
export function fractureInset(
  p: readonly [number, number, number],
  chip: number,
  role: number,
  size: readonly [number, number, number],
  h01: number,
  intact = false,
): [number, number, number] {
  const c = [p[0], p[1] - 0.5, p[2]];
  const b = boundary(p);
  const out: [number, number, number] = [p[0], p[1], p[2]];
  const depth =
    chip *
    (FRACTURE_HASH_MIN + (1 - FRACTURE_HASH_MIN) * h01) *
    (intact ? INTACT_CHIP : 1);
  const outer = role > 2.5;
  for (let a = 0; a < 3; a++) {
    const s = Math.max(size[a] as number, 1e-4);
    if (b[a] && !outer) {
      const d = Math.min(depth, FRACTURE_MAX_SHARE * 0.5 * s);
      out[a] = (out[a] as number) - (Math.sign(c[a] as number) * d) / s;
    }
    if (role > 0.5 && !b[a]) {
      const side = role === 2 || role === 4 ? 1 : -1;
      out[a] = (out[a] as number) + (side * REBAR_HALF) / s;
    }
  }
  return out;
}

/** The debris material's vertex displacement (after VERTEX_MAIN: `sScale`,
 * `brkHalf` and three's `transformed` in scope). Bit for bit the formula of
 * fractureInset; the per-piece hash is keyed on the piece's own offset in
 * its tier frame (aSubOff.xyz — static, unique per piece) and the vertex,
 * never on the slot, so a re-layout never re-rolls a shape. */
export const FRACTURE_VERTEX_GLSL = /* glsl */ `
#ifdef AB_FRACTURE
{
  vec3 frC = position - vec3(0.0, 0.5, 0.0);
  vec3 frB = vec3(
    step(0.4999, abs(frC.x)),
    max(step(position.y, 0.0001), step(0.9999, position.y)),
    step(0.4999, abs(frC.z))
  );
  float frH = fract(sin(dot(aSubOff.xyz, vec3(12.9898, 78.233, 37.719)) +
    dot(position, vec3(91.7, 23.1, 57.3))) * 43758.5453);
  // D11: an intact piece (CUT_INTACT) keeps INTACT_CHIP of its chips.
  float frDepth = uv.x * (${FRACTURE_HASH_MIN.toFixed(2)} + ${(1 - FRACTURE_HASH_MIN).toFixed(2)} * frH)
    * (1.0 - ${(1 - INTACT_CHIP).toFixed(2)} * brkIntact);
  vec3 frS = max(sScale, vec3(1e-4));
  vec3 frD = min(vec3(frDepth), ${FRACTURE_MAX_SHARE.toFixed(2)} * 0.5 * frS);
  float frOuter = step(2.5, uv.y);
  transformed -= sign(frC) * frB * frD / frS * (1.0 - frOuter);
  float frRebar = step(0.5, uv.y);
  float frSide = (abs(uv.y - 2.0) < 0.5 || abs(uv.y - 4.0) < 0.5) ? 1.0 : -1.0;
  transformed += (vec3(1.0) - frB) * frRebar * frSide * ${REBAR_HALF.toFixed(2)} / frS;
  // Rebar paints as steel whatever face it leaves from.
  if (frRebar > 0.5) vBroken.w = brkHalf.y + 3.0 * ${KIND_STRIDE};
  // D11: the facade passes read the DISPLACED surface. A rebar ribbon's
  // four corners share one unit-box position, so the undisplaced meters
  // had no screen derivative: the facade's AA band collapsed to
  // smoothstep(0, 0, x) — undefined, NaN on SwiftShader (O7's detector).
  vMeters = transformed * sScale + aSubOff.xyz;
  vWorldY = transformed.y * sScale.y + instanceMatrix[3].y;
  vBWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  // D11 lit debris: falling (no CUT_RUBBLE bit yet), the chip depth, and
  // how far this face looks down once posed (a box face's direction under
  // R·S is R·n — the scale only lengthens it).
  vFrLit = vec3(
    (1.0 - mod(floor(brkMask / 64.0), 2.0)) * (1.0 - brkIntact),
    uv.x,
    max(0.0, -normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal).y)
  );
}
#endif
`;

/** D11: the fracture variant's own varyings (both stages). */
export const FRACTURE_PARS_GLSL = /* glsl */ `
#ifdef AB_FRACTURE
// (falling, chip depth m, how far the face looks down)
varying vec3 vFrLit;
#endif
`;

/** D11: debris that reads at range — while a piece falls, the faces the
 * fracture exposed (its broken concrete, not its facade) glow with the fire
 * it came out of at the knocked-off corners (CHIP_CORNER) and, looking
 * down, take the street's warm glow from below. Off once it rests (the rubble is the D2 look). Both
 * under the bloom threshold (0.72). */
export const FRACTURE_EMISSIVE_GLSL = /* glsl */ `
#ifdef AB_FRACTURE
if (vFrLit.x > 0.5 && brkDmg > 0.5) {
  float frEdge = smoothstep(1.0, 2.0, vFrLit.y);
  totalEmissiveRadiance += ${FRACTURE_EMBER} * frEdge + ${FRACTURE_UPLIGHT} * vFrLit.z;
}
#endif
`;

/**
 * The debris mesh's geometry: the unit box (y in [0, 1]) subdivided
 * FRACTURE_SEGMENTS per axis with every vertex's chip depth in uv.x, plus
 * a two-sided rebar ribbon at every edge midpoint. Pure; built once.
 */
export function fractureGeometry(): THREE.BufferGeometry {
  const n = FRACTURE_SEGMENTS;
  const box = new THREE.BoxGeometry(1, 1, 1, n, n, n);
  box.translate(0, 0.5, 0);
  const P = box.getAttribute("position") as THREE.BufferAttribute;
  const N = box.getAttribute("normal") as THREE.BufferAttribute;
  const index = box.getIndex();
  if (!index) throw new Error("BoxGeometry without an index");
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = Array.from(index.array as ArrayLike<number>);
  const rebarAt = new Map<string, [number, number, number]>();
  for (let i = 0; i < P.count; i++) {
    const p: [number, number, number] = [P.getX(i), P.getY(i), P.getZ(i)];
    positions.push(...p);
    normals.push(N.getX(i), N.getY(i), N.getZ(i));
    uvs.push(chipAt(p), ROLE_SURFACE);
    const b = boundary(p);
    if (b.filter(Boolean).length === 2) {
      rebarAt.set(p.map((v) => v.toFixed(4)).join(","), p);
    }
  }
  // Rebar: inner end on the chipped edge, outer end where the edge was.
  for (const p of rebarAt.values()) {
    const b = boundary(p);
    const out = b[0] ? 0 : 2; // the ribbon's outward axis (x first)
    const nx = out === 0 ? Math.sign(p[0]) : 0;
    const nz = out === 2 ? Math.sign(p[2]) : 0;
    const chip = chipAt(p);
    const first = positions.length / 3;
    for (const role of [1, 2, 3, 4]) {
      positions.push(...p);
      normals.push(nx, 0, nz);
      uvs.push(chip, role);
    }
    // Two-sided: both windings.
    indices.push(first, first + 2, first + 1, first + 1, first + 2, first + 3);
    indices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
  }
  box.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}
