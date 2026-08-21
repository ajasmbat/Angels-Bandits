// Placeholder low-poly plane mesh (proper model is T5 polish) — shared by the
// local plane and every remote plane so the two never drift apart visually.

import * as THREE from "three";

/** Boxy stand-in plane; `accentColor` tints fin + nose (remote vs local). */
export function buildPlaneMesh(accentColor = 0x27e0c0): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({
    color: 0x8a94a8,
    roughness: 0.5,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: accentColor,
    emissive: accentColor,
    emissiveIntensity: 0.6,
  });
  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1, 6), body);
  const wings = new THREE.Mesh(new THREE.BoxGeometry(9, 0.18, 1.8), body);
  wings.position.z = 0.3;
  const tailplane = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.15, 1), body);
  tailplane.position.z = 2.6;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, 1), accent);
  fin.position.set(0, 0.8, 2.6);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.8), accent);
  nose.position.z = -3.2;
  g.add(fuselage, wings, tailplane, fin, nose);
  return g;
}

/** Free a plane group's geometries and materials (remote plane teardown). */
export function disposePlaneMesh(group: THREE.Group): void {
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
}
