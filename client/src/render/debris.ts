// D3 collapse debris on the client: the one place a collapse piece's pose
// (common/src/city/collapse.ts piecePose — the same pose the crash check
// collides with) becomes an instance matrix. The city renderer owns the mesh
// (a child of the city mesh with the building material, so a chunk keeps the
// facade it fell from); this module is the pure, tested seam between the two.

import type { PiecePose } from "@angels-bandits/common/city/collapse";
import * as THREE from "three";

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
  quat.setFromAxisAngle(pose.axis === 0 ? AXIS_X : AXIS_Z, pose.phi);
  pos.set(originX + pose.x, pose.y, originZ + pose.z);
  scale.set(2 * pose.hx, 2 * pose.hy, 2 * pose.hz);
  return out.compose(pos, quat, scale).multiply(CENTRE);
}
