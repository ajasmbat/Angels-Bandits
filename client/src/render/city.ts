// Chunked city renderer. Tiles are aligned to BLOCK_PITCH per the plan — and
// since generateCity() places exactly one building per block, a tile IS one
// building. The whole city stays a single InstancedMesh (1 draw call), now
// with one instance per SOLID (V2 setback tiers, plus H1 hole walls/lintels/
// sills); each frame every instance is placed at its torus image nearest the
// camera, which is what makes the seam invisible. Only the instances whose
// torus image actually flipped are rewritten and uploaded (O2) — a building's
// image changes only as the camera crosses the half-world line from it.

import {
  type Building,
  generateCity,
  solids,
} from "@angels-bandits/common/city";
import {
  type CityIndex,
  buildCityIndex,
} from "@angels-bandits/common/collision";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import { createBuildingsMaterial } from "./buildings-material";
import { LiveClock, crewSchedule } from "./living-windows";
import { roofStyleFor } from "./roofs";
import { ImageCache, InstanceUploads } from "./wrapPlacement";

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

/**
 * One drawable box: a solid of a building (a whole tier, or — H1 — a wall,
 * lintel or sill of a holed tier), at its stack height. Instances come 1:1
 * from the shared solids(), so what is drawn is exactly what collides.
 */
interface SolidInstance {
  building: Building;
  /** Position of the parent tier in the building's stack (0 = street tier). */
  tierIndex: number;
  /** Box center offset from the building's (x, z), meters. */
  dx: number;
  dz: number;
  width: number;
  depth: number;
  height: number;
  /** Ground height the box's base sits at (tier 1 → 0). */
  baseY: number;
}

export class CityRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly buildings: Building[];
  private readonly index: CityIndex;
  private readonly instances: SolidInstance[];
  private readonly scratch = new THREE.Matrix4();
  private readonly images: ImageCache;
  private readonly uploads: InstanceUploads;
  /** L3 living windows: the shader's live clock and its uniform. */
  private readonly liveClock = new LiveClock();
  private readonly liveTime = { value: 0 };

  constructor(seed: number) {
    this.buildings = generateCity(seed);
    // Built once, beside the array it describes, so the per-frame crash probe
    // costs a couple of block lookups instead of a scan of the whole city.
    this.index = buildCityIndex(this.buildings);

    // Flatten the solids: the rendered silhouette is exactly the collision
    // volume, so instances come 1:1 from the shared solids() — a holed tier
    // is a few extra INSTANCES of the same mesh, never an extra draw.
    this.instances = this.buildings.flatMap((building) =>
      solids(building).map((s) => ({ building, ...s })),
    );

    // Unit box with its origin at the base center, so a scale matrix turns it
    // into a tier standing at its base height.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    // Night-neon material with procedural emissive window grids (T5 art pass),
    // branching per instance on the facade archetype (set once below).
    const material = createBuildingsMaterial(this.liveTime);

    this.mesh = new THREE.InstancedMesh(
      geometry,
      material,
      this.instances.length,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.images = new ImageCache(
      this.instances.map((inst) => inst.building.x),
      this.instances.map((inst) => inst.building.z),
    );
    this.uploads = new InstanceUploads([this.mesh.instanceMatrix]);
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

    // VO3 roofs & crowns (roofs.ts decides, the shader paints): per tier
    // aRoof = (roof kind, crown depth on the top tier else 0, roof tone, 0),
    // aLed = boosted LED outline colour (0 = none, every tier of the
    // building agrees), aCrown = crown wash tint × gain (top tier only).
    // Static like aArchetype: set once, never re-uploaded.
    const roof = new Float32Array(this.instances.length * 4);
    const led = new Float32Array(this.instances.length * 3);
    const crown = new Float32Array(this.instances.length * 3);
    const styles = new Map(this.buildings.map((b) => [b, roofStyleFor(b)]));
    this.instances.forEach((inst, i) => {
      const style = styles.get(inst.building);
      if (!style) return;
      const isTop = inst.tierIndex === inst.building.tiers.length - 1;
      roof[i * 4] = style.tierKinds[inst.tierIndex] ?? 0;
      roof[i * 4 + 1] = isTop && style.crown ? style.crown.depth : 0;
      roof[i * 4 + 2] = style.tone;
      style.led?.toArray(led, i * 3);
      if (isTop) style.crown?.color.toArray(crown, i * 3);
    });
    geometry.setAttribute("aRoof", new THREE.InstancedBufferAttribute(roof, 4));
    geometry.setAttribute("aLed", new THREE.InstancedBufferAttribute(led, 3));
    geometry.setAttribute(
      "aCrown",
      new THREE.InstancedBufferAttribute(crown, 3),
    );

    // H1: the facade pattern is painted in the PARENT tier's frame, so a
    // wall and the lintel over a hole carry one continuous window grid and
    // the building keeps one seed. aSubOff = this box's base-center offset
    // inside its parent tier, aParent = the parent tier's (w, h, d), aHole =
    // the tier's hole (across offset, half width, floor above the tier base,
    // ±height: + travels along x, − along z; all 0 = no hole). Static.
    const subOff = new Float32Array(this.instances.length * 3);
    const parent = new Float32Array(this.instances.length * 3);
    const hole = new Float32Array(this.instances.length * 4);
    this.instances.forEach((inst, i) => {
      const b = inst.building;
      const tier = b.tiers[inst.tierIndex];
      if (!tier) return;
      let tierBase = 0;
      for (let k = 0; k < inst.tierIndex; k++) {
        tierBase += b.tiers[k]?.height ?? 0;
      }
      subOff.set([inst.dx, inst.baseY - tierBase, inst.dz], i * 3);
      parent.set([tier.width, tier.height, tier.depth], i * 3);
      const h = b.holes?.find((x) => x.tierIndex === inst.tierIndex);
      if (h) {
        hole.set(
          [
            h.offset,
            h.width / 2,
            h.y0 - tierBase,
            h.axis === "x" ? h.height : -h.height,
          ],
          i * 4,
        );
      }
    });
    geometry.setAttribute(
      "aSubOff",
      new THREE.InstancedBufferAttribute(subOff, 3),
    );
    geometry.setAttribute(
      "aParent",
      new THREE.InstancedBufferAttribute(parent, 3),
    );
    geometry.setAttribute("aHole", new THREE.InstancedBufferAttribute(hole, 4));

    // L3 cleaning crew: aCrew = (visit start, duration, block cycle, 0) in
    // live-clock seconds, the same on every solid of a building; cycle 0 =
    // no crew this cycle. Static like aArchetype.
    const crew = new Float32Array(this.instances.length * 4);
    const rota = crewSchedule(this.buildings, seed);
    this.instances.forEach((inst, i) => {
      const slot = rota.get(inst.building);
      if (slot) crew.set([slot.start, slot.duration, slot.cycle, 0], i * 4);
    });
    geometry.setAttribute("aCrew", new THREE.InstancedBufferAttribute(crew, 4));

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

  /** Instance count actually drawn (one per solid: a tier, or a wall /
   * lintel / sill of a holed tier) — perf reporting/QA. */
  get tierInstanceCount(): number {
    return this.instances.length;
  }

  /** Place every solid at its building's torus image nearest the camera —
   * rewriting and uploading only the solids whose image flipped. */
  update(cameraPos: Vec3): void {
    this.images.update(cameraPos, this.place);
    this.uploads.flush();
  }

  private readonly place = (i: number, x: number, z: number): void => {
    const inst = this.instances[i] as SolidInstance;
    this.scratch.makeScale(inst.width, inst.height, inst.depth);
    this.scratch.setPosition(x + inst.dx, inst.baseY, z + inst.dz);
    this.mesh.setMatrixAt(i, this.scratch);
    this.uploads.mark(i);
  };

  /** L3: advance the living-windows clock (server ms, null before the first
   * snapshot; `nowMs` = the frame's performance.now()). */
  updateLiveWindows(serverMs: number | null, nowMs: number): void {
    this.liveTime.value = this.liveClock.update(serverMs, nowMs);
  }

  /** QA: pin the living-windows clock (live seconds), or null to follow the server. */
  pinLiveWindows(sec: number | null): void {
    this.liveClock.pinned = sec;
  }
}
