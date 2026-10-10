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
//
// D8: a damaged roof sheds what stood on it. Structure bodies, their
// dressing and masts are drawn exactly while their structure is in the live
// `b.roof` (structureDrawn — what collides); free clutter and beacons while
// decorStands keeps them (the roofclutter StandingLayer). Hidden instances
// are written as a zero-scale matrix in every place path, so a torus flip
// never brings one back.

import {
  type Building,
  type LocalBox,
  generatedRoof,
} from "@angels-bandits/common/city";
import type { RoofStructure } from "@angels-bandits/common/city/roof-structures";
import { EMISSIVE_BEACON } from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import {
  type RoofPart,
  partBox,
  roofDetailsFor,
  structureDrawn,
} from "./roof-details";
import { type Mast, roofClutterFor } from "./roof-layout";
import {
  type StandingLayer,
  StandingMask,
  StandingWatch,
} from "./standing-watch";
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

/** Beacon sphere radius, m (its mesh below). */
const BEACON_RADIUS = 1.4;
/** Mast tip sphere radius, m (its mesh below). */
const TIP_RADIUS = 0.35;

/** Each building's mast structures, in roofClutterFor().masts order. */
const mastStructures = (b: Building): RoofStructure[] =>
  (generatedRoof(b) ?? []).filter((s) => s.kind === "mast");

/**
 * D8: everything this renderer draws on building `index`, in its item
 * order — roofDetailsFor's boxes, cylinders and lit parts, then the masts
 * (with their tips), then the beacon — as boxes in the building's frame.
 */
export function roofClutterStandingLayer(
  buildings: readonly Building[],
): StandingLayer {
  const cache = new Map<number, LocalBox[]>();
  return {
    boxes(index: number): readonly LocalBox[] {
      let out = cache.get(index);
      if (out) return out;
      out = [];
      const b = buildings[index];
      if (b) {
        const d = roofDetailsFor(b);
        for (const p of d.boxes) out.push(partBox(b, p, false));
        for (const p of d.cylinders) out.push(partBox(b, p, true));
        for (const p of d.lit) out.push(partBox(b, p, false));
        const c = roofClutterFor(b);
        for (const m of c.masts) {
          const x = wrapDeltaAxis(b.x, m.x);
          const z = wrapDeltaAxis(b.z, m.z);
          out.push({
            x0: x - TIP_RADIUS,
            x1: x + TIP_RADIUS,
            y0: m.y,
            y1: m.y + m.height + TIP_RADIUS,
            z0: z - TIP_RADIUS,
            z1: z + TIP_RADIUS,
          });
        }
        if (c.beacon) {
          const x = wrapDeltaAxis(b.x, c.beacon.x);
          const z = wrapDeltaAxis(b.z, c.beacon.z);
          out.push({
            x0: x - BEACON_RADIUS,
            x1: x + BEACON_RADIUS,
            y0: c.beacon.y - BEACON_RADIUS,
            y1: c.beacon.y + BEACON_RADIUS,
            z0: z - BEACON_RADIUS,
            z1: z + BEACON_RADIUS,
          });
        }
      }
      cache.set(index, out);
      return out;
    },
  };
}

/** A part as a batch takes it: which building, its D8 item slot there. */
interface TaggedPart {
  part: RoofPart;
  owner: number;
  slot: number;
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

const pushTo = (map: Map<number, number[]>, key: number, v: number): void => {
  const list = map.get(key);
  if (list) list.push(v);
  else map.set(key, [v]);
};

/** DT2 distance LOD: a part with aFade > 0 folds into its own base (the
 * unit shape's y = 0 pivot, before the instance matrix moves it to its
 * torus image) between 0.7× and 1× aFade of camera distance. aFade = 0 —
 * every solid body and every pre-DT2 part — is never touched, so what is
 * drawn still equals what collides on every tier. */
const ROOF_FADE_PARS = /* glsl */ `#include <common>
attribute float aFade;
`;
const ROOF_FADE_VERTEX = /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
if (aFade > 0.0) {
  float rcDist = distance((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz, cameraPosition);
  transformed *= 1.0 - smoothstep(aFade * 0.7, aFade, rcDist);
}
#endif
`;

/** Patch a roof batch material with the aFade fold (unique program key). */
function withRoofFade<M extends THREE.Material>(m: M, key: string): M {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", ROOF_FADE_PARS)
      .replace("#include <begin_vertex>", ROOF_FADE_VERTEX);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

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
  /** D8: each instance's building, item slot there and structure. */
  private readonly owner: Int32Array;
  private readonly slot: Int32Array;
  private readonly structure: (RoofStructure | null)[];
  /** D8: each building's instances. */
  private readonly byOwner = new Map<number, number[]>();

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    tagged: readonly TaggedPart[],
    private readonly hidden: (
      owner: number,
      slot: number,
      structure: RoofStructure | null,
    ) => boolean,
  ) {
    const sortedTags = [
      ...tagged.filter((t) => !t.part.fine),
      ...tagged.filter((t) => t.part.fine),
    ];
    const sorted = sortedTags.map((t) => t.part);
    this.coarse = sortedTags.length - tagged.filter((t) => t.part.fine).length;
    this.owner = Int32Array.from(sortedTags, (t) => t.owner);
    this.slot = Int32Array.from(sortedTags, (t) => t.slot);
    this.structure = sorted.map((p) => p.structure);
    sortedTags.forEach((t, i) => pushTo(this.byOwner, t.owner, i));
    // DT2: each batch owns its geometry so it can carry its own aFade.
    const own = geometry.clone();
    own.setAttribute(
      "aFade",
      new THREE.InstancedBufferAttribute(
        Float32Array.from(sorted, (p) => p.fade),
        1,
      ),
    );
    this.mesh = new THREE.InstancedMesh(own, material, sorted.length);
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
    if (
      this.hidden(
        this.owner[i] as number,
        this.slot[i] as number,
        this.structure[i] ?? null,
      )
    ) {
      this.mesh.setMatrixAt(i, ZERO);
      this.uploads.mark(i);
      return;
    }
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

  /** D8: re-place building `b`'s instances on the next update. */
  refresh(b: number): void {
    for (const i of this.byOwner.get(b) ?? []) this.images.dirty(i);
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
  /** D8: each mast's building and structure, each beacon's building and
   * item slot, and the instances per building. */
  private readonly mastOwner: Int32Array;
  private readonly mastStructure: RoofStructure[];
  private readonly beaconOwner: Int32Array;
  private readonly beaconSlot: Int32Array;
  private readonly mastsOf = new Map<number, number[]>();
  private readonly beaconsOf = new Map<number, number[]>();
  private readonly mask: StandingMask;
  private readonly watch: StandingWatch;
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

  constructor(private readonly buildings: readonly Building[]) {
    const layouts = buildings.map(roofClutterFor);
    const details = buildings.map(roofDetailsFor);
    this.masts = layouts.flatMap((c) => c.masts);
    this.beacons = layouts.flatMap((c) => (c.beacon ? [c.beacon] : []));
    this.mask = new StandingMask(
      buildings,
      roofClutterStandingLayer(buildings),
    );
    this.watch = new StandingWatch(buildings);
    // D8: tag every part with its building and its slot in the layer's item
    // order (boxes, cylinders, lit, masts, beacon).
    const boxParts: TaggedPart[] = [];
    const cylinderParts: TaggedPart[] = [];
    const litParts: TaggedPart[] = [];
    const mastOwner: number[] = [];
    const mastStructure: RoofStructure[] = [];
    const beaconOwner: number[] = [];
    const beaconSlot: number[] = [];
    details.forEach((d, owner) => {
      let slot = 0;
      for (const part of d.boxes) boxParts.push({ part, owner, slot: slot++ });
      for (const part of d.cylinders)
        cylinderParts.push({ part, owner, slot: slot++ });
      for (const part of d.lit) litParts.push({ part, owner, slot: slot++ });
      const c = layouts[owner];
      const structures = mastStructures(buildings[owner] as Building);
      c?.masts.forEach((_, k) => {
        pushTo(this.mastsOf, owner, mastOwner.length);
        mastOwner.push(owner);
        mastStructure.push(structures[k] as RoofStructure);
        slot++;
      });
      if (c?.beacon) {
        pushTo(this.beaconsOf, owner, beaconOwner.length);
        beaconOwner.push(owner);
        beaconSlot.push(slot++);
      }
    });
    this.mastOwner = Int32Array.from(mastOwner);
    this.mastStructure = mastStructure;
    this.beaconOwner = Int32Array.from(beaconOwner);
    this.beaconSlot = Int32Array.from(beaconSlot);

    const dark = new THREE.MeshStandardMaterial({
      color: CLUTTER_MATERIAL_COLOR,
      roughness: 1,
    });

    // Unit shapes with their base at y=0 so a scale matrix stands them on
    // the roof (same idiom as the city's unit box).
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    boxGeometry.translate(0, 0.5, 0);
    // DT2: boxes and cylinders share one faded twin of `dark` (the masts
    // keep `dark` itself — their geometry carries no aFade).
    const faded = withRoofFade(
      new THREE.MeshStandardMaterial({
        color: CLUTTER_MATERIAL_COLOR,
        roughness: 1,
      }),
      "dt2-roof-fade-standard",
    );
    this.boxes = new PartBatch(boxGeometry, faded, boxParts, this.hidden);
    // Twelve sides: a round tank's flats sit within 3.5 % of its collider.
    const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 12);
    cylinderGeometry.translate(0, 0.5, 0);
    this.cylinders = new PartBatch(
      cylinderGeometry,
      faded,
      cylinderParts,
      this.hidden,
    );
    // R2: lamps and billboard art. Unlit, white × the per-instance emissive
    // colour (roof-details.ts lifts each to its rung, all under SIGN).
    this.lit = new PartBatch(
      boxGeometry,
      withRoofFade(
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
        "dt2-roof-fade-basic",
      ),
      litParts,
      this.hidden,
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
      new THREE.SphereGeometry(TIP_RADIUS, 6, 5),
      tipMaterial,
      this.masts.length,
    );

    this.beaconMaterial = new THREE.MeshBasicMaterial({ color: BEACON_COLOR });
    this.beaconMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(BEACON_RADIUS, 12, 10),
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

  /** D8: is an item hidden? A structure's parts follow the live roof; the
   * rest follow decorStands (the mask, refreshed by the watch). */
  private readonly hidden = (
    owner: number,
    slot: number,
    structure: RoofStructure | null,
  ): boolean =>
    structure
      ? !structureDrawn(this.buildings[owner] as Building, structure)
      : this.mask.isHidden(owner, slot);

  /** D8: building `b`'s standing moved — re-evaluate and re-place it. */
  private readonly restand = (b: number): void => {
    this.mask.evaluate(b);
    this.boxes.refresh(b);
    this.cylinders.refresh(b);
    this.lit.refresh(b);
    for (const i of this.mastsOf.get(b) ?? []) this.mastImages.dirty(i);
    for (const i of this.beaconsOf.get(b) ?? []) this.beaconImages.dirty(i);
  };

  private readonly placeMast = (i: number, x: number, z: number): void => {
    const m = this.masts[i] as Mast;
    const owner = this.mastOwner[i] as number;
    if (
      !structureDrawn(
        this.buildings[owner] as Building,
        this.mastStructure[i] as RoofStructure,
      )
    ) {
      this.mastMesh.setMatrixAt(i, ZERO);
      this.tipMesh.setMatrixAt(i, ZERO);
      this.mastUploads.mark(i);
      return;
    }
    this.scratch.makeScale(1, m.height, 1);
    this.scratch.setPosition(x, m.y, z);
    this.mastMesh.setMatrixAt(i, this.scratch);
    this.scratch.makeTranslation(x, m.y + m.height, z);
    this.tipMesh.setMatrixAt(i, this.scratch);
    this.mastUploads.mark(i);
  };

  private readonly placeBeacon = (i: number, x: number, z: number): void => {
    const b = this.beacons[i] as { x: number; z: number; y: number };
    if (
      this.mask.isHidden(
        this.beaconOwner[i] as number,
        this.beaconSlot[i] as number,
      )
    ) {
      this.beaconMesh.setMatrixAt(i, ZERO);
      this.beaconUploads.mark(i);
      return;
    }
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
    this.watch.poll(this.restand);
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
