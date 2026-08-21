// The plane mesh: the human-approved procedural Stearman-style biplane
// (copied verbatim from the ticket's biplane-model.md attachment into
// biplane.ts), shared by the local plane and every remote so the two never
// drift apart visually. The model's nose points +Z while game-forward is −Z
// (yaw 0 faces −Z), so it flies inside a half-turned parent group; its ~9 m
// wingspan already matches the game's plane size, so scale stays 1:1.

import * as THREE from "three";
import { createBiplane } from "./biplane";

export function buildPlaneMesh(): THREE.Group {
  const g = new THREE.Group();
  const model = createBiplane();
  model.rotation.y = Math.PI; // model +Z nose → game −Z forward
  g.add(model);
  return g;
}

/** Advance the biplane's propeller by `radians` (child group "propeller"). */
export function spinPropeller(plane: THREE.Group, radians: number): void {
  let prop = plane.userData.propeller as THREE.Object3D | undefined;
  if (!prop) {
    prop = plane.getObjectByName("propeller");
    if (!prop) return;
    plane.userData.propeller = prop;
  }
  prop.rotation.z += radians;
}

/** Free a plane group's geometries and materials (remote plane teardown). */
export function disposePlaneMesh(group: THREE.Group): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const material = child.material as THREE.MeshStandardMaterial;
      material.map?.dispose();
      material.dispose();
    }
  });
}
