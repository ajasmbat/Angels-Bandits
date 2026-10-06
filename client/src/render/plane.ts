// The plane mesh: the human-approved procedural Stearman-style biplane
// (copied verbatim from the ticket's biplane-model.md attachment into
// biplane.ts), shared by the local plane and every remote so the two never
// drift apart visually. The model's nose points +Z while game-forward is −Z
// (yaw 0 faces −Z), so it flies inside a half-turned parent group; its ~9 m
// wingspan already matches the game's plane size, so scale stays 1:1.

import * as THREE from "three";
import { CLASSIC_LIVERY, type Livery, createBiplane } from "./biplane";
import { applyHeroLight, planeHash } from "./planelights";

/**
 * Remote pilots' liveries (VO4): primaries kept clear of the own plane's
 * classic red, the spawn-shimmer cyan (0x9fd8e8) and the pale whites that
 * read as it, the storm-reveal violet (0xe07bff) and the nav red/green — so
 * an opponent never reads as you, as a shimmer, or as a light.
 */
export const LIVERIES: readonly Livery[] = [
  { primary: 0x1f5fd6, secondary: 0x123a85 }, // cobalt
  { primary: 0xe0a316, secondary: 0x86560b }, // amber
  { primary: 0x0f9aa0, secondary: 0x085357 }, // teal
  { primary: 0xf06a12, secondary: 0x8a3b0a }, // orange
  { primary: 0xd61f8c, secondary: 0x7a1150 }, // magenta
  { primary: 0x4b5d78, secondary: 0x262f3d }, // slate
  { primary: 0x8e2bd0, secondary: 0x4c1470 }, // purple
  { primary: 0x7a8a1e, secondary: 0x434c10 }, // olive
];

/**
 * A remote pilot's livery: a stable hash of the plane id, so every client
 * paints the same pilot the same colour and it never shuffles mid-fight.
 * Two pilots can share an entry — name tags carry identity.
 */
export function liveryFor(planeId: string): Livery {
  return LIVERIES[planeHash(planeId) % LIVERIES.length] ?? CLASSIC_LIVERY;
}

/** Build a plane; the own plane takes the default classic livery. */
export function buildPlaneMesh(livery: Livery = CLASSIC_LIVERY): THREE.Group {
  const g = new THREE.Group();
  const model = createBiplane(livery);
  model.rotation.y = Math.PI; // model +Z nose → game −Z forward
  // Per-plane hero light (key/fill/rim/env + exhaust ring), body capped
  // below bloom — night readability on own plane and remotes alike.
  applyHeroLight(model);
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
