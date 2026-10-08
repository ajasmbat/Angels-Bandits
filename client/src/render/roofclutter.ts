// Roof clutter + landmark beacons (V2, R2): the renderer. Layout is pure and
// lives elsewhere — roof-layout.ts (roofClutterFor: HVAC units, the solid
// structures' masts, the beacon) and roof-details.ts (roofDetailsFor: every
// structure body 1:1 with its collider, and the ≤ 2.5 m dressing). The THREE
// instancing below is a thin adapter, same pattern as Streetlights: canonical
// positions, re-placed only when an instance's torus image flips. Clutter
// (≤ ROOF_CLUTTER_MAX_HEIGHT) is the plan's sanctioned visual-without-
// collision exception; everything taller is a solid roof structure from the
// shared seam (common/src/city/roof-structures.ts). Beacons pulse on
// server-synced time so all clients pulse together.
//
// Draw calls: boxes, cylinders, masts, mast tips, beacons (V2), plus ONE lit
// box batch for door lamps and billboard faces and frames (R2).

import type { Building } from "@angels-bandits/common/city";
import { EMISSIVE_BEACON } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { type RoofPart, roofDetailsFor } from "./roof-details";
import { type Mast, roofClutterFor } from "./roof-layout";
import { ImageCache, InstanceUploads } from "./wrapPlacement";

// The layout seam's long-standing import site.
export {
  type AcBox,
  type Mast,
  type RoofClutter,
  type WaterTower,
  roofClutterFor,
} from "./roof-layout";

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
 * lightened per instance). Tones are sRGB hex (roof-details.ts), converted
 * to linear by THREE.Color. */
const CLUTTER_MATERIAL_COLOR = 0xffffff;
const MAST_TONE = 0x737a85;

/**
 * One instanced batch of roof parts. Each part's rotation × scale is
 * composed ONCE here into a per-instance base matrix; the frame loop only
 * writes the translation of the instances whose torus image flipped (O2), so
 * nothing is allocated or recomposed per frame. Fine detail is sorted last,
 * so a quality tier drops it by instance count alone (no recompile).
 */
class PartBatch {
  readonly mesh: THREE.InstancedMesh;
  /** Instances that are not fine detail (they come first). */
  readonly coarse: number;
  private readonly base: Float32Array;
  private readonly ys: Float32Array;
  private readonly images: ImageCache;
  private readonly uploads: InstanceUploads;
  private readonly scratch = new THREE.Matrix4();

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    parts: readonly RoofPart[],
  ) {
    const sorted = [
      ...parts.filter((p) => !p.fine),
      ...parts.filter((p) => p.fine),
    ];
    this.coarse = parts.length - parts.filter((p) => p.fine).length;
    this.mesh = new THREE.InstancedMesh(geometry, material, sorted.length);
    this.base = new Float32Array(sorted.length * 16);
    this.ys = new Float32Array(sorted.length);
    const yaw = new THREE.Matrix4();
    const tilt = new THREE.Matrix4();
    const scale = new THREE.Matrix4();
    const color = new THREE.Color();
    sorted.forEach((p, i) => {
      yaw.makeRotationY(p.yaw);
      tilt.makeRotationX(p.tilt);
      scale.makeScale(p.sx, p.sy, p.sz);
      this.scratch.multiplyMatrices(yaw, tilt).multiply(scale);
      this.scratch.toArray(this.base, i * 16);
      this.ys[i] = p.y;
      color.setHex(p.tone);
      if (p.boost > 0) color.multiplyScalar(p.boost);
      this.mesh.setColorAt(i, color);
    });
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances move relative to the camera every frame
    this.images = new ImageCache(
      sorted.map((p) => p.x),
      sorted.map((p) => p.z),
    );
    this.uploads = new InstanceUploads([this.mesh.instanceMatrix]);
  }

  private readonly place = (i: number, x: number, z: number): void => {
    this.scratch.fromArray(this.base, i * 16);
    const e = this.scratch.elements;
    e[12] = x;
    e[13] = this.ys[i] as number;
    e[14] = z;
    this.mesh.setMatrixAt(i, this.scratch);
    this.uploads.mark(i);
  };

  update(cameraPos: Vec3): void {
    this.images.update(cameraPos, this.place);
    this.uploads.flush();
  }

  /** Draw everything, or only the coarse parts (Low / Mobile). */
  setFine(on: boolean): void {
    this.mesh.count = on ? this.images.length : this.coarse;
  }
}

/** The instanced roof renderer: structures, clutter, masts, beacons. */
export class RoofClutterRenderer {
  readonly group = new THREE.Group();
  private readonly boxes: PartBatch;
  private readonly cylinders: PartBatch;
  private readonly lit: PartBatch;
  private readonly masts: Mast[];
  private readonly beacons: { x: number; z: number; y: number }[];
  private readonly mastMesh: THREE.InstancedMesh;
  private readonly tipMesh: THREE.InstancedMesh;
  private readonly beaconMesh: THREE.InstancedMesh;
  private readonly beaconMaterial: THREE.MeshBasicMaterial;
  private readonly scratch = new THREE.Matrix4();
  /** O2: per-kind torus-image caches — only flipped instances re-upload. */
  private readonly mastImages: ImageCache;
  private readonly beaconImages: ImageCache;
  private readonly mastUploads: InstanceUploads;
  private readonly beaconUploads: InstanceUploads;

  constructor(buildings: readonly Building[]) {
    const layouts = buildings.map(roofClutterFor);
    const details = buildings.map(roofDetailsFor);
    this.masts = layouts.flatMap((c) => c.masts);
    this.beacons = layouts.flatMap((c) => (c.beacon ? [c.beacon] : []));

    const dark = new THREE.MeshStandardMaterial({
      color: CLUTTER_MATERIAL_COLOR,
      roughness: 1,
    });

    // Unit shapes with their base at y=0 so a scale matrix stands them on
    // the roof (same idiom as the city's unit box).
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    boxGeometry.translate(0, 0.5, 0);
    this.boxes = new PartBatch(
      boxGeometry,
      dark,
      details.flatMap((d) => d.boxes),
    );
    // Twelve sides: a round tank's flats sit within 3.5 % of its collider.
    const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 12);
    cylinderGeometry.translate(0, 0.5, 0);
    this.cylinders = new PartBatch(
      cylinderGeometry,
      dark,
      details.flatMap((d) => d.cylinders),
    );
    // R2: lamps and billboard art. Unlit, white × the per-instance emissive
    // colour (roof-details.ts lifts each to its rung, all under SIGN).
    this.lit = new PartBatch(
      boxGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      details.flatMap((d) => d.lit),
    );

    // Masts: the drawn base radius IS the collider's (MAST_RADIUS).
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

    const tone = new THREE.Color();
    this.masts.forEach((_, i) => {
      this.mastMesh.setColorAt(i, tone.setHex(MAST_TONE));
    });

    for (const mesh of [this.mastMesh, this.tipMesh, this.beaconMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // instances move relative to the camera every frame
    }
    this.group.add(
      this.boxes.mesh,
      this.cylinders.mesh,
      this.lit.mesh,
      this.mastMesh,
      this.tipMesh,
      this.beaconMesh,
    );
    const cache = (items: { x: number; z: number }[]): ImageCache =>
      new ImageCache(
        items.map((t) => t.x),
        items.map((t) => t.z),
      );
    this.mastImages = cache(this.masts);
    this.beaconImages = cache(this.beacons);
    this.mastUploads = new InstanceUploads([
      this.mastMesh.instanceMatrix,
      this.tipMesh.instanceMatrix,
    ]);
    this.beaconUploads = new InstanceUploads([this.beaconMesh.instanceMatrix]);
  }

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

  /** Total roof instances drawn (all tiers' worth) — perf reporting/QA. */
  get instanceCount(): number {
    return (
      this.boxes.mesh.count +
      this.cylinders.mesh.count +
      this.lit.mesh.count +
      this.masts.length * 2 +
      this.beacons.length
    );
  }

  /** O3: Low and Mobile drop the fine detail (drains, hatches, walkways,
   * rods, dishes, braces, cables). Every structure body stays on every tier
   * — it is solid. */
  setQuality(tier: QualityTier): void {
    const fine = QUALITY_PROFILES[tier].roofDetail;
    this.boxes.setFine(fine);
    this.cylinders.setFine(fine);
    this.lit.setFine(fine);
  }

  /**
   * Place everything at its torus image nearest the camera; `timeMs` is
   * server-synced time so every client's beacons pulse in phase.
   */
  update(cameraPos: Vec3, timeMs: number): void {
    this.boxes.update(cameraPos);
    this.cylinders.update(cameraPos);
    this.lit.update(cameraPos);
    this.mastImages.update(cameraPos, this.placeMast);
    this.beaconImages.update(cameraPos, this.placeBeacon);
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
