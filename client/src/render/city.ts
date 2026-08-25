// Chunked city renderer. Tiles are aligned to BLOCK_PITCH per the plan — and
// since generateCity() places exactly one building per block, a tile IS one
// building. The whole city stays a single InstancedMesh (1 draw call), now
// with one instance per TIER (V2 setback towers, ~200 instances); each frame
// every instance is placed at its torus image nearest the camera, which is
// what makes the seam invisible. Matrices for ~200 instances are a few KB —
// re-uploading them per frame is far cheaper than extra draw calls.

import { type Building, generateCity } from "@angels-bandits/common/city";
import {
  type CityIndex,
  buildCityIndex,
} from "@angels-bandits/common/collision";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import { createBuildingsMaterial } from "./buildings-material";
import { nearestImage } from "./wrapPlacement";

/** One drawable box: a tier of a building, at its stack height. */
interface TierInstance {
  building: Building;
  width: number;
  depth: number;
  height: number;
  /** Ground height the tier's base sits at (tier 1 → 0). */
  baseY: number;
}

export class CityRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly buildings: Building[];
  private readonly index: CityIndex;
  private readonly instances: TierInstance[];
  private readonly scratch = new THREE.Matrix4();

  constructor(seed: number) {
    this.buildings = generateCity(seed);
    // Built once, beside the array it describes, so the per-frame crash probe
    // costs a couple of block lookups instead of a scan of the whole city.
    this.index = buildCityIndex(this.buildings);

    // Flatten the tier stacks: the rendered silhouette is exactly the
    // collision volume, so instances come 1:1 from the shared tier data.
    this.instances = this.buildings.flatMap((building) => {
      let baseY = 0;
      return building.tiers.map((t) => {
        const inst: TierInstance = { building, ...t, baseY };
        baseY += t.height;
        return inst;
      });
    });

    // Unit box with its origin at the base center, so a scale matrix turns it
    // into a tier standing at its base height.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    // Night-neon material with procedural emissive window grids (T5 art pass),
    // branching per instance on the facade archetype (set once below).
    const material = createBuildingsMaterial();

    this.mesh = new THREE.InstancedMesh(
      geometry,
      material,
      this.instances.length,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances move relative to the camera every frame

    // Facade archetype per instance (all tiers of a building agree) — the
    // shader branches window pitch/pattern/lit-bias on this. Static: set at
    // construction, never re-uploaded.
    const archetypes = new Float32Array(this.instances.length);
    this.instances.forEach((inst, i) => {
      archetypes[i] = archetypeFor(inst.building);
    });
    geometry.setAttribute(
      "aArchetype",
      new THREE.InstancedBufferAttribute(archetypes, 1),
    );

    // Dusk palette (C3 "Sparse Late Shift"): the same three archetype families
    // — steel-blue glass, warm brick masonry, grey-blue concrete offices — but
    // DESATURATED hard (glass 0.40 → 0.14, masonry 0.28 → 0.13, office 0.12 →
    // 0.05) so the surface reads as painted concrete and dirty glass instead
    // of saturated toy plastic, with a WIDER per-building hue/lightness spread
    // so a dense BSP block is many buildings rather than one long wall. The
    // variation is deterministic from the building itself (shared by all its
    // tiers). Landmarks keep their neon accent so orientation — and the "never
    // two images at once" QA check — still works.
    const color = new THREE.Color();
    this.instances.forEach((inst, i) => {
      const b = inst.building;
      const t = ((b.height * 7 + b.width * 3 + b.depth) % 17) / 17;
      if (b.height >= LANDMARK_HEIGHT) {
        color.setHSL(0.52, 0.4, 0.26);
      } else if (archetypes[i] === FacadeArchetype.GLASS) {
        color.setHSL(0.6 + t * 0.05, 0.14, 0.075 + t * 0.05);
      } else if (archetypes[i] === FacadeArchetype.MASONRY) {
        color.setHSL(0.06 + t * 0.04, 0.13, 0.065 + t * 0.045);
      } else {
        color.setHSL(0.62 + t * 0.05, 0.05, 0.07 + t * 0.05);
      }
      this.mesh.setColorAt(i, color);
    });
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** The same Building[] the renderer draws — collision's single source of truth. */
  get cityBuildings(): readonly Building[] {
    return this.buildings;
  }

  /** Block index over `cityBuildings`, for collideCity's 4th argument. */
  get cityIndex(): CityIndex {
    return this.index;
  }

  /** Instance count actually drawn (one per tier) — perf reporting/QA. */
  get tierInstanceCount(): number {
    return this.instances.length;
  }

  /** Place every tier at its torus image nearest the camera. */
  update(cameraPos: Vec3): void {
    this.instances.forEach((inst, i) => {
      const b = inst.building;
      const p = nearestImage(cameraPos, { x: b.x, y: 0, z: b.z });
      this.scratch.makeScale(inst.width, inst.height, inst.depth);
      this.scratch.setPosition(p.x, inst.baseY, p.z);
      this.mesh.setMatrixAt(i, this.scratch);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
