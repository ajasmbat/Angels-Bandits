// Chunked city renderer. Tiles are aligned to BLOCK_PITCH per the plan — and
// since generateCity() places exactly one building per block, a tile IS one
// building. All buildings live in a single InstancedMesh (1 draw call); each
// frame every instance is placed at its torus image nearest the camera, which
// is what makes the seam invisible. Matrices for ~100 instances are a few KB —
// re-uploading them per frame is far cheaper than extra draw calls.

import { type Building, generateCity } from "@angels-bandits/common/city";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { nearestImage } from "./wrapPlacement";

export class CityRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly buildings: Building[];
  private readonly scratch = new THREE.Matrix4();

  constructor(seed: number) {
    this.buildings = generateCity(seed);

    // Unit box with its origin at the base center, so a scale matrix turns it
    // into a building standing on the ground.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.85,
      metalness: 0.15,
    });

    this.mesh = new THREE.InstancedMesh(
      geometry,
      material,
      this.buildings.length,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances move relative to the camera every frame

    // Dusk palette: dark blue-grey towers, slightly varied per building
    // (deterministic from the building itself); landmarks get a neon accent
    // so orientation — and the "never two images at once" QA check — works.
    const color = new THREE.Color();
    this.buildings.forEach((b, i) => {
      if (b.height >= LANDMARK_HEIGHT) {
        color.setHSL(0.52, 0.55, 0.32);
      } else {
        const t = (b.height * 7 + b.width * 3 + b.depth) % 17;
        color.setHSL(0.62 + (t / 17) * 0.06, 0.25, 0.1 + (t / 17) * 0.08);
      }
      this.mesh.setColorAt(i, color);
    });
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** The same Building[] the renderer draws — collision's single source of truth. */
  get cityBuildings(): readonly Building[] {
    return this.buildings;
  }

  /** Place every building at its torus image nearest the camera. */
  update(cameraPos: Vec3): void {
    this.buildings.forEach((b, i) => {
      const p = nearestImage(cameraPos, { x: b.x, y: 0, z: b.z });
      this.scratch.makeScale(b.width, b.height, b.depth);
      this.scratch.setPosition(p.x, 0, p.z);
      this.mesh.setMatrixAt(i, this.scratch);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
