// Roof clutter + landmark beacons (V2, client-only dressing). Layout is the
// pure seam roofClutterFor(): deterministic per building from its position
// and dimensions via the shared mulberry32 — no Math.random, so every client
// dresses identical roofs. The THREE instancing below is a thin adapter, same
// pattern as Streetlights: canonical positions, re-placed every frame at the
// torus image nearest the camera. Clutter is the plan's ONE sanctioned
// visual-without-collision exception (small enough that clipping it is
// forgivable); beacons pulse on server-synced time so all clients pulse
// together.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { nearestImage } from "./wrapPlacement";

/** Buildings at least this tall grow antenna masts (with red tips). */
const MAST_MIN_HEIGHT = 120;
/** Smallest top-roof side that fits a water tower, meters. */
const TOWER_MIN_ROOF = 24;
/** Beacon hover above the landmark crown, meters. */
const BEACON_LIFT = 3;

export interface WaterTower {
  x: number;
  z: number;
  /** Roof height the item stands on (== building height). */
  y: number;
  radius: number;
  height: number;
}

export interface AcBox {
  x: number;
  z: number;
  y: number;
  width: number;
  depth: number;
  height: number;
}

export interface Mast {
  x: number;
  z: number;
  y: number;
  height: number;
}

export interface RoofClutter {
  waterTowers: WaterTower[];
  acBoxes: AcBox[];
  /** Every mast carries a tiny red emissive tip. */
  masts: Mast[];
  /** Pulsing red beacon — landmarks only. */
  beacon: { x: number; z: number; y: number } | null;
}

/**
 * Deterministic clutter for one building's TOP tier roof. Landmarks get a
 * beacon and stay otherwise clean (the crown is the read); everything else
 * rolls water towers, AC boxes, and (when tall) antenna masts from a PRNG
 * seeded by the building itself.
 */
export function roofClutterFor(b: Building): RoofClutter {
  const none: RoofClutter = {
    waterTowers: [],
    acBoxes: [],
    masts: [],
    beacon: null,
  };
  if (b.height >= LANDMARK_HEIGHT) {
    return { ...none, beacon: { x: b.x, z: b.z, y: b.height + BEACON_LIFT } };
  }

  const rand = mulberry32(
    (Math.imul(b.x, 73856093) ^
      Math.imul(b.z, 19349663) ^
      Math.imul(b.height, 83492791)) >>>
      0,
  );
  const top = b.tiers[b.tiers.length - 1];
  if (!top) return none;
  const halfW = top.width / 2;
  const halfD = top.depth / 2;
  /** Uniform offset keeping an item of half-extent `e` fully on the roof. */
  const offset = (half: number, e: number) =>
    (rand() * 2 - 1) * Math.max(0, half - e - 1);

  const clutter: RoofClutter = { ...none };

  if (Math.min(top.width, top.depth) >= TOWER_MIN_ROOF && rand() < 0.55) {
    const radius = 2.2 + rand() * 1.3;
    clutter.waterTowers.push({
      x: b.x + offset(halfW, radius),
      z: b.z + offset(halfD, radius),
      y: b.height,
      radius,
      height: 5 + rand() * 2,
    });
  }

  const boxes = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < boxes; i++) {
    const width = 1.6 + rand() * 2.4;
    const depth = 1.6 + rand() * 2.4;
    clutter.acBoxes.push({
      x: b.x + offset(halfW, width / 2),
      z: b.z + offset(halfD, depth / 2),
      y: b.height,
      width,
      depth,
      height: 1.2 + rand() * 1.6,
    });
  }

  if (b.height >= MAST_MIN_HEIGHT) {
    const masts = rand() < 0.35 ? 2 : 1;
    for (let i = 0; i < masts; i++) {
      clutter.masts.push({
        x: b.x + offset(halfW, 0),
        z: b.z + offset(halfD, 0),
        y: b.height,
        height: 8 + rand() * 8,
      });
    }
  }

  return clutter;
}

// --- Emissive rungs (V1 bloom ladder: threshold 0.72, tracers ~1.5) ---
/** Beacon red pushed so its PEAK luminance ≈ 1.0 — above lamp heads, below
 * tracers; the pulse trough falls under the threshold so beacons breathe. */
const BEACON_COLOR = new THREE.Color(1.0, 0.12, 0.1);
const BEACON_BOOST = 3.3;
/** Beacon pulse period, ms of synced server time — all clients in phase. */
const BEACON_PERIOD_MS = 2000;
/** Antenna tips stay UNDER the bloom threshold: visible red dots, no halo. */
const TIP_COLOR = 0xff2620;
const TIP_BOOST = 1.5;

const CLUTTER_MATERIAL_COLOR = 0x1a1a26; // same dark dressing as lamp poles

/** The instanced roof-clutter renderer + pulsing landmark beacons. */
export class RoofClutterRenderer {
  readonly group = new THREE.Group();
  private readonly towers: WaterTower[];
  private readonly boxes: AcBox[];
  private readonly masts: Mast[];
  private readonly beacons: { x: number; z: number; y: number }[];
  private readonly towerMesh: THREE.InstancedMesh;
  private readonly boxMesh: THREE.InstancedMesh;
  private readonly mastMesh: THREE.InstancedMesh;
  private readonly tipMesh: THREE.InstancedMesh;
  private readonly beaconMesh: THREE.InstancedMesh;
  private readonly beaconMaterial: THREE.MeshBasicMaterial;
  private readonly scratch = new THREE.Matrix4();

  constructor(buildings: readonly Building[]) {
    const layouts = buildings.map(roofClutterFor);
    this.towers = layouts.flatMap((c) => c.waterTowers);
    this.boxes = layouts.flatMap((c) => c.acBoxes);
    this.masts = layouts.flatMap((c) => c.masts);
    this.beacons = layouts.flatMap((c) => (c.beacon ? [c.beacon] : []));

    const dark = new THREE.MeshStandardMaterial({
      color: CLUTTER_MATERIAL_COLOR,
      roughness: 1,
    });

    // Unit shapes with their base at y=0 so a scale matrix stands them on
    // the roof (same idiom as the city's unit box).
    const towerGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
    towerGeometry.translate(0, 0.5, 0);
    this.towerMesh = new THREE.InstancedMesh(
      towerGeometry,
      dark,
      this.towers.length,
    );

    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    boxGeometry.translate(0, 0.5, 0);
    this.boxMesh = new THREE.InstancedMesh(boxGeometry, dark, this.boxes.length);

    const mastGeometry = new THREE.CylinderGeometry(0.08, 0.14, 1, 5);
    mastGeometry.translate(0, 0.5, 0);
    this.mastMesh = new THREE.InstancedMesh(
      mastGeometry,
      dark,
      this.masts.length,
    );

    const tipMaterial = new THREE.MeshBasicMaterial({ color: TIP_COLOR });
    tipMaterial.color.multiplyScalar(TIP_BOOST);
    this.tipMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.35, 6, 5),
      tipMaterial,
      this.masts.length,
    );

    this.beaconMaterial = new THREE.MeshBasicMaterial({ color: BEACON_COLOR });
    this.beaconMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1.4, 12, 10),
      this.beaconMaterial,
      this.beacons.length,
    );

    for (const mesh of [
      this.towerMesh,
      this.boxMesh,
      this.mastMesh,
      this.tipMesh,
      this.beaconMesh,
    ]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // instances move relative to the camera every frame
      this.group.add(mesh);
    }
  }

  /** Total clutter+beacon instances drawn — perf reporting/QA. */
  get instanceCount(): number {
    return (
      this.towers.length +
      this.boxes.length +
      this.masts.length * 2 +
      this.beacons.length
    );
  }

  /**
   * Place everything at its torus image nearest the camera; `timeMs` is
   * server-synced time so every client's beacons pulse in phase.
   */
  update(cameraPos: Vec3, timeMs: number): void {
    this.towers.forEach((t, i) => {
      const p = nearestImage(cameraPos, { x: t.x, y: 0, z: t.z });
      this.scratch.makeScale(t.radius, t.height, t.radius);
      this.scratch.setPosition(p.x, t.y, p.z);
      this.towerMesh.setMatrixAt(i, this.scratch);
    });
    this.boxes.forEach((box, i) => {
      const p = nearestImage(cameraPos, { x: box.x, y: 0, z: box.z });
      this.scratch.makeScale(box.width, box.height, box.depth);
      this.scratch.setPosition(p.x, box.y, p.z);
      this.boxMesh.setMatrixAt(i, this.scratch);
    });
    this.masts.forEach((m, i) => {
      const p = nearestImage(cameraPos, { x: m.x, y: 0, z: m.z });
      this.scratch.makeScale(1, m.height, 1);
      this.scratch.setPosition(p.x, m.y, p.z);
      this.mastMesh.setMatrixAt(i, this.scratch);
      this.scratch.makeTranslation(p.x, m.y + m.height, p.z);
      this.tipMesh.setMatrixAt(i, this.scratch);
    });
    this.beacons.forEach((b, i) => {
      const p = nearestImage(cameraPos, { x: b.x, y: 0, z: b.z });
      this.scratch.makeTranslation(p.x, b.y, p.z);
      this.beaconMesh.setMatrixAt(i, this.scratch);
    });
    this.towerMesh.instanceMatrix.needsUpdate = true;
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.mastMesh.instanceMatrix.needsUpdate = true;
    this.tipMesh.instanceMatrix.needsUpdate = true;
    this.beaconMesh.instanceMatrix.needsUpdate = true;

    // Sin-pulse: peak ≈ 1.0 luminance (blooms), trough falls under the
    // threshold so the beacon visibly breathes instead of burning steady.
    const pulse =
      0.25 + 0.75 * (0.5 + 0.5 * Math.sin((timeMs / BEACON_PERIOD_MS) * 2 * Math.PI));
    this.beaconMaterial.color
      .copy(BEACON_COLOR)
      .multiplyScalar(BEACON_BOOST * pulse);
  }
}
