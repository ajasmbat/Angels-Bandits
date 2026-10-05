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

/**
 * VO2 "Neon Blue Hour" facade albedo — real building materials instead of
 * C3's near-black desaturated slabs. Each archetype is a FAMILY of finishes
 * (glass: teal / steel-blue / bronze; masonry: terracotta / red brick /
 * sandstone; office: limestone / warm concrete / cool grey), picked and
 * varied deterministically from the building's own dimensions (shared by
 * all its tiers, seam-safe — never its translation), so a dense block reads
 * as many neighbouring buildings. Albedo only: the lights and the window
 * emissive do the rest, and the brightest finish stays far under the bloom
 * threshold once lit (client/test/facade-palette.test.ts). setHSL is in
 * three's LINEAR working space, so `l` here is (roughly) linear albedo: the
 * pale finishes are pulled to ~0.25 so they don't read as daylit concrete
 * next to the windows.
 */
export function facadeColor(
  b: Pick<Building, "width" | "depth" | "height">,
  arch: number,
  out = new THREE.Color(),
): THREE.Color {
  const t = ((b.height * 7 + b.width * 3 + b.depth) % 17) / 17;
  const v = ((b.width * 13 + b.depth * 7 + b.height * 3) % 23) / 23;
  if (b.height >= LANDMARK_HEIGHT) {
    return out.setHSL(0.52, 0.42, 0.22); // landmark teal — orientation
  }
  if (arch === FacadeArchetype.GLASS) {
    if (v < 0.22) return out.setHSL(0.09 + t * 0.03, 0.34, 0.156 + t * 0.047); // bronze
    if (v < 0.6) return out.setHSL(0.5 + t * 0.04, 0.32, 0.14 + t * 0.055); // teal
    return out.setHSL(0.58 + t * 0.05, 0.3, 0.156 + t * 0.055); // steel blue
  }
  if (arch === FacadeArchetype.MASONRY) {
    if (v < 0.4) return out.setHSL(0.03 + t * 0.02, 0.46, 0.172 + t * 0.047); // terracotta
    if (v < 0.75) return out.setHSL(0.0 + t * 0.02, 0.4, 0.14 + t * 0.039); // red brick
    return out.setHSL(0.08 + t * 0.03, 0.36, 0.19 + t * 0.04); // sandstone
  }
  if (v < 0.45) return out.setHSL(0.1 + t * 0.03, 0.16, 0.185 + t * 0.04); // limestone
  if (v < 0.8) return out.setHSL(0.07 + t * 0.03, 0.1, 0.175 + t * 0.04); // warm concrete
  return out.setHSL(0.6 + t * 0.04, 0.1, 0.165 + t * 0.04); // cool grey
}

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

    // Facade albedo per building (VO2 palette — see facadeColor above).
    const color = new THREE.Color();
    this.instances.forEach((inst, i) => {
      this.mesh.setColorAt(
        i,
        facadeColor(inst.building, archetypeFor(inst.building), color),
      );
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
