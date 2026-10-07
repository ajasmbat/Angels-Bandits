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
import {
  EMISSIVE_BEACON,
  LANDMARK_HEIGHT,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { RoofKind, roofStyleFor } from "./roofs";
import { ImageCache, InstanceUploads } from "./wrapPlacement";

/** Buildings at least this tall grow antenna masts (with red tips). */
const MAST_MIN_HEIGHT = 120;
/** Smallest top-roof side that fits a water tower, meters. */
const TOWER_MIN_ROOF = 24;
/** How far a helipad roof's corner units may wander in from the corner, m —
 * small enough that the smallest pad roof (34 m) keeps them off the pad. */
const HELIPAD_CORNER_SPAN = 2;
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

  // VO3 helipad roofs take their OWN placement path (so every other roof's
  // stream, and the steam vents that follow acBoxes[0], stay byte-identical):
  // no water tower, a few units pushed into the corners, clear of the pad
  // circle and its perimeter lights. Helipads only exist under the mast
  // height (roofs.ts), so there are no masts to place.
  if (roofStyleFor(b).tierKinds[b.tiers.length - 1] === RoofKind.HELIPAD) {
    const units = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < units; i++) {
      const width = 1.6 + rand() * 2.4;
      const depth = 1.6 + rand() * 2.4;
      const sx = rand() < 0.5 ? -1 : 1;
      const sz = rand() < 0.5 ? -1 : 1;
      clutter.acBoxes.push({
        x: b.x + sx * (halfW - width / 2 - 1 - rand() * HELIPAD_CORNER_SPAN),
        z: b.z + sz * (halfD - depth / 2 - 1 - rand() * HELIPAD_CORNER_SPAN),
        y: b.height,
        width,
        depth,
        height: 1.2 + rand() * 1.6,
      });
    }
    return clutter;
  }

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
/** Beacon red pushed to its ladder rung at pulse PEAK — above lamp heads,
 * below tracers; the pulse trough falls under the threshold so beacons breathe. */
const BEACON_COLOR = new THREE.Color(1.0, 0.12, 0.1);
const BEACON_BOOST = emissiveBoost(BEACON_COLOR, EMISSIVE_BEACON);
/** Beacon pulse period, ms of synced server time — all clients in phase. */
const BEACON_PERIOD_MS = 2000;
/** Antenna tips stay UNDER the bloom threshold: visible red dots, no halo. */
const TIP_COLOR = 0xff2620;
const TIP_BOOST = 1.5;

/** VO3: clutter is lit and lighter — galvanized ducts, painted plant,
 * weathered timber tanks — so roofs read as working decks, not black holes.
 * The material is WHITE and every instance carries its tone in instanceColor
 * (three multiplies the two, so a dark material colour could never be
 * lightened per instance). sRGB hex, converted to linear by THREE.Color. */
const CLUTTER_MATERIAL_COLOR = 0xffffff;
const TOWER_TONES = [0x7a6552, 0x6e7680, 0x86705a] as const; // timber / steel
const BOX_TONES = [0x9aa1aa, 0x9c9585, 0x8a929c, 0xa7a49b] as const; // plant
const MAST_TONE = 0x737a85;
/** Stable per-item pick from its canonical position (never a torus image). */
const toneOf = <T>(tones: readonly T[], x: number, z: number): T =>
  tones[
    ((Math.imul(Math.round(x * 8), 73856093) ^
      Math.imul(Math.round(z * 8), 19349663)) >>>
      0) %
      tones.length
  ] as T;

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
  /** O2: per-kind torus-image caches — only flipped instances re-upload. */
  private readonly towerImages: ImageCache;
  private readonly boxImages: ImageCache;
  private readonly mastImages: ImageCache;
  private readonly beaconImages: ImageCache;
  private readonly towerUploads: InstanceUploads;
  private readonly boxUploads: InstanceUploads;
  private readonly mastUploads: InstanceUploads;
  private readonly beaconUploads: InstanceUploads;

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
    this.boxMesh = new THREE.InstancedMesh(
      boxGeometry,
      dark,
      this.boxes.length,
    );

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

    // Per-instance tones (static — set once, before the first compile).
    const tone = new THREE.Color();
    this.towers.forEach((t, i) => {
      this.towerMesh.setColorAt(i, tone.setHex(toneOf(TOWER_TONES, t.x, t.z)));
    });
    this.boxes.forEach((box, i) => {
      this.boxMesh.setColorAt(i, tone.setHex(toneOf(BOX_TONES, box.x, box.z)));
    });
    this.masts.forEach((_, i) => {
      this.mastMesh.setColorAt(i, tone.setHex(MAST_TONE));
    });

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
    const cache = (items: { x: number; z: number }[]): ImageCache =>
      new ImageCache(
        items.map((t) => t.x),
        items.map((t) => t.z),
      );
    this.towerImages = cache(this.towers);
    this.boxImages = cache(this.boxes);
    this.mastImages = cache(this.masts);
    this.beaconImages = cache(this.beacons);
    this.towerUploads = new InstanceUploads([this.towerMesh.instanceMatrix]);
    this.boxUploads = new InstanceUploads([this.boxMesh.instanceMatrix]);
    this.mastUploads = new InstanceUploads([
      this.mastMesh.instanceMatrix,
      this.tipMesh.instanceMatrix,
    ]);
    this.beaconUploads = new InstanceUploads([this.beaconMesh.instanceMatrix]);
  }

  private readonly placeTower = (i: number, x: number, z: number): void => {
    const t = this.towers[i] as WaterTower;
    this.scratch.makeScale(t.radius, t.height, t.radius);
    this.scratch.setPosition(x, t.y, z);
    this.towerMesh.setMatrixAt(i, this.scratch);
    this.towerUploads.mark(i);
  };

  private readonly placeBox = (i: number, x: number, z: number): void => {
    const box = this.boxes[i] as AcBox;
    this.scratch.makeScale(box.width, box.height, box.depth);
    this.scratch.setPosition(x, box.y, z);
    this.boxMesh.setMatrixAt(i, this.scratch);
    this.boxUploads.mark(i);
  };

  private readonly placeMast = (i: number, x: number, z: number): void => {
    const m = this.masts[i] as Mast;
    this.scratch.makeScale(1, m.height, 1);
    this.scratch.setPosition(x, m.y, z);
    this.mastMesh.setMatrixAt(i, this.scratch);
    this.scratch.makeTranslation(x, m.y + m.height, z);
    this.tipMesh.setMatrixAt(i, this.scratch);
    this.mastUploads.mark(i);
  };

  private readonly placeBeacon = (i: number, x: number, z: number): void => {
    const b = this.beacons[i] as { x: number; z: number; y: number };
    this.scratch.makeTranslation(x, b.y, z);
    this.beaconMesh.setMatrixAt(i, this.scratch);
    this.beaconUploads.mark(i);
  };

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
    this.towerImages.update(cameraPos, this.placeTower);
    this.boxImages.update(cameraPos, this.placeBox);
    this.mastImages.update(cameraPos, this.placeMast);
    this.beaconImages.update(cameraPos, this.placeBeacon);
    this.towerUploads.flush();
    this.boxUploads.flush();
    this.mastUploads.flush();
    this.beaconUploads.flush();

    // Sin-pulse: peak ≈ 1.0 luminance (blooms), trough falls under the
    // threshold so the beacon visibly breathes instead of burning steady.
    const pulse =
      0.25 +
      0.75 * (0.5 + 0.5 * Math.sin((timeMs / BEACON_PERIOD_MS) * 2 * Math.PI));
    this.beaconMaterial.color
      .copy(BEACON_COLOR)
      .multiplyScalar(BEACON_BOOST * pulse);
  }
}
