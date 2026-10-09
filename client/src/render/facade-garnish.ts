// Facade garnish (ANGE-XY8LH8, client-only dressing): parapet caps along
// every tier's roof edges (kills the sharp-box-top look) and one entrance
// canopy per building on its street-facing base side. Layout is the pure
// seam facadeGarnishFor() — deterministic per building via the shared
// mulberry32 (roofClutterFor idiom, no Math.random), so every client
// dresses identical facades. Street geometry comes from the S1 contract
// (nearestStreet + the S2 sidewalk-clearance formula), never re-derived.
// Garnish is visual-only with no collision — the plan's sanctioned
// exception, same as roof clutter.

import {
  type Building,
  type LocalBox,
  STAND_OUT,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  facadeClearances,
  nearestStreet,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { type StandingLayer, StandingMask } from "./standing-watch";
import { ImageCache, InstanceUploads } from "./wrapPlacement";

/** Parapet lip thickness across the edge, meters. */
const LIP_THICKNESS = 1.1;
/** Parapet overhang past each facade end, meters. */
const LIP_OVERHANG = 0.55;
/** Parapet lip height, meters (renderer scale — part of the layout contract). */
export const PARAPET_HEIGHT = 1.5;

/** Canopy footprint along the facade, meters. */
const CANOPY_WIDTH = 9;
/** How far the awning would like to protrude toward the curb, meters. */
const CANOPY_MAX_DEPTH = 3.2;
/** Underside height of the awning, meters (over a door, under the shops). */
export const CANOPY_Y = 3.6;
/** Awning slab thickness, meters. */
export const CANOPY_THICKNESS = 0.6;
/** Faces with less sidewalk than this get no canopy (S2 clearance rule). */
const MIN_CLEARANCE = 1.2;

/** One thin cap along a tier roof edge, axis-aligned like everything else. */
export interface ParapetLip {
  x: number;
  z: number;
  /** Roof height the lip sits on (== the tier's top). */
  y: number;
  width: number;
  depth: number;
}

/** One entrance awning, protruding from the tier-1 facade over the sidewalk. */
export interface Canopy {
  x: number;
  z: number;
  /** Underside height of the awning slab. */
  y: number;
  sizeX: number;
  sizeZ: number;
}

export interface FacadeGarnish {
  parapets: ParapetLip[];
  canopy: Canopy | null;
}

/**
 * Deterministic garnish for one building: four parapet lips per tier, and —
 * when the sidewalk is deep enough — one canopy on the facade that faces the
 * building's nearest street (entrance offset rolled from a PRNG seeded by
 * the building itself).
 */
export function facadeGarnishFor(b: Building): FacadeGarnish {
  const parapets: ParapetLip[] = [];
  let top = 0;
  for (const tier of b.tiers) {
    top += tier.height;
    const spanX = tier.width + LIP_OVERHANG * 2;
    const spanZ = tier.depth + LIP_OVERHANG * 2;
    parapets.push(
      {
        x: b.x,
        z: b.z - tier.depth / 2,
        y: top,
        width: spanX,
        depth: LIP_THICKNESS,
      },
      {
        x: b.x,
        z: b.z + tier.depth / 2,
        y: top,
        width: spanX,
        depth: LIP_THICKNESS,
      },
      {
        x: b.x - tier.width / 2,
        z: b.z,
        y: top,
        width: LIP_THICKNESS,
        depth: spanZ,
      },
      {
        x: b.x + tier.width / 2,
        z: b.z,
        y: top,
        width: LIP_THICKNESS,
        depth: spanZ,
      },
    );
  }

  return { parapets, canopy: canopyFor(b) };
}

function canopyFor(b: Building): Canopy | null {
  const street = nearestStreet({ x: b.x, y: 0, z: b.z });
  // The facade facing that street: for a north–south street (axis "z", a
  // line of constant x) it is an x facade; dir points building → street.
  const onX = street.axis === "z";
  const facadeHalf = onX ? b.width / 2 : b.depth / 2;
  const faceLength = onX ? b.depth : b.width;
  const dir = -street.side;
  const plane = (onX ? b.x : b.z) + dir * facadeHalf;
  // Sidewalk depth in front of THIS facade, from the street contract. Since
  // C1 a lot is not centered in its block, the facade nearest a street is
  // often a party wall with no sidewalk at all — an awning there would hang
  // inside the neighbouring building.
  // H1: never an awning on a facade with a hole mouth in it.
  const axis = onX ? "x" : "z";
  if (b.holes?.some((h) => h.tierIndex === 0 && h.axis === axis)) return null;
  const side = `${axis}${dir < 0 ? 0 : 1}` as const;
  const clearance = facadeClearances(b.x, b.z, b.width, b.depth)[side];
  if (clearance < MIN_CLEARANCE) return null;
  const depth = Math.min(CANOPY_MAX_DEPTH, clearance - 0.3);

  // Entrance position along the facade — deterministic per building, kept
  // clear of the corners (same hash recipe as roofClutterFor).
  const rand = mulberry32(
    (Math.imul(b.x, 73856093) ^
      Math.imul(b.z, 19349663) ^
      Math.imul(b.height, 83492791) ^
      0x5bd1e995) >>>
      0,
  );
  const offset = (rand() * 2 - 1) * Math.max(0, faceLength / 2 - CANOPY_WIDTH);

  const center = plane + (dir * depth) / 2;
  return {
    x: onX ? center : b.x + offset,
    z: onX ? b.z + offset : center,
    y: CANOPY_Y,
    sizeX: onX ? depth : CANOPY_WIDTH,
    sizeZ: onX ? CANOPY_WIDTH : depth,
  };
}

// --- D8: what still stands ------------------------------------------------

/**
 * Building `index`'s garnish as building-local boxes for the standing
 * filter: its parapet lips in facadeGarnishFor order, then its canopy. A
 * canopy can stand proud of its facade by more than STAND_OUT, so it is
 * judged by its ANCHOR — the strip of slab within STAND_OUT of the wall.
 */
export function facadeGarnishStandingLayer(
  buildings: readonly Building[],
): StandingLayer {
  const cache = new Map<number, LocalBox[]>();
  return {
    boxes(index) {
      let out = cache.get(index);
      if (out) return out;
      const b = buildings[index] as Building;
      const g = facadeGarnishFor(b);
      out = g.parapets.map((p) => {
        const x = wrapDeltaAxis(b.x, p.x);
        const z = wrapDeltaAxis(b.z, p.z);
        return {
          x0: x - p.width / 2,
          x1: x + p.width / 2,
          y0: p.y - LIP_SINK,
          y1: p.y - LIP_SINK + PARAPET_HEIGHT,
          z0: z - p.depth / 2,
          z1: z + p.depth / 2,
        };
      });
      const c = g.canopy;
      if (c) {
        const x = wrapDeltaAxis(b.x, c.x);
        const z = wrapDeltaAxis(b.z, c.z);
        const box = {
          x0: x - c.sizeX / 2,
          x1: x + c.sizeX / 2,
          y0: c.y,
          y1: c.y + CANOPY_THICKNESS,
          z0: z - c.sizeZ / 2,
          z1: z + c.sizeZ / 2,
        };
        // The anchor: clip the slab to STAND_OUT past the tier-1 wall.
        const hw = b.width / 2 + STAND_OUT;
        const hd = b.depth / 2 + STAND_OUT;
        box.x0 = Math.max(box.x0, -hw);
        box.x1 = Math.min(box.x1, hw);
        box.z0 = Math.max(box.z0, -hd);
        box.z1 = Math.min(box.z1, hd);
        out.push(box);
      }
      cache.set(index, out);
      return out;
    },
  };
}

// --- Renderer (RoofClutter idiom: canonical layout, re-placed each frame) ---

/** VO3: precast coping, light enough that every roof edge reads as a clean
 * line against the deck (it was near-black — roofs merged into the street). */
const PARAPET_COLOR = 0x6b6a70;
/** Awnings darker than the shop band behind them — a silhouette over the door. */
const CANOPY_COLOR = 0x0a0a14;
/** Lips sink this far into the tier top (kills z-gaps on the roof line). */
const LIP_SINK = 0.2;

/** The instanced parapet + canopy renderer: two draw calls for the city. */
export class FacadeGarnishRenderer {
  readonly group = new THREE.Group();
  private readonly parapets: ParapetLip[];
  private readonly canopies: Canopy[];
  private readonly parapetMesh: THREE.InstancedMesh;
  private readonly canopyMesh: THREE.InstancedMesh;
  private readonly scratch = new THREE.Matrix4();
  private readonly parapetImages: ImageCache;
  private readonly canopyImages: ImageCache;
  private readonly parapetUploads: InstanceUploads;
  private readonly canopyUploads: InstanceUploads;
  /** D8: each instance's building, its item index there, and each
   * building's first parapet / canopy slot (−1 = none). */
  private readonly parapetB: Int32Array;
  private readonly parapetK: Int32Array;
  private readonly canopyB: Int32Array;
  private readonly canopyK: Int32Array;
  private readonly firstParapet: Int32Array;
  private readonly canopyOf: Int32Array;
  private readonly standing: StandingMask;

  constructor(buildings: readonly Building[]) {
    const layouts = buildings.map(facadeGarnishFor);
    this.parapets = layouts.flatMap((g) => g.parapets);
    this.canopies = layouts.flatMap((g) => (g.canopy ? [g.canopy] : []));
    this.parapetB = new Int32Array(this.parapets.length);
    this.parapetK = new Int32Array(this.parapets.length);
    this.canopyB = new Int32Array(this.canopies.length);
    this.canopyK = new Int32Array(this.canopies.length);
    this.firstParapet = new Int32Array(buildings.length + 1);
    this.canopyOf = new Int32Array(buildings.length).fill(-1);
    let p = 0;
    let c = 0;
    layouts.forEach((g, b) => {
      this.firstParapet[b] = p;
      g.parapets.forEach((_, k) => {
        this.parapetB[p] = b;
        this.parapetK[p++] = k;
      });
      if (g.canopy) {
        this.canopyOf[b] = c;
        this.canopyB[c] = b;
        this.canopyK[c++] = g.parapets.length;
      }
    });
    this.firstParapet[buildings.length] = p;
    this.standing = new StandingMask(
      buildings,
      facadeGarnishStandingLayer(buildings),
      (b) => {
        const to = this.firstParapet[b + 1] as number;
        for (let i = this.firstParapet[b] as number; i < to; i++)
          this.parapetImages.dirty(i);
        const j = this.canopyOf[b] as number;
        if (j >= 0) this.canopyImages.dirty(j);
      },
    );

    // Unit box with its base at y=0 so a scale matrix stands it up
    // (same idiom as the city's unit box).
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);

    this.parapetMesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: PARAPET_COLOR, roughness: 1 }),
      this.parapets.length,
    );
    this.canopyMesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: CANOPY_COLOR, roughness: 1 }),
      this.canopies.length,
    );
    for (const mesh of [this.parapetMesh, this.canopyMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // instances move relative to the camera every frame
      this.group.add(mesh);
    }
    this.parapetImages = new ImageCache(
      this.parapets.map((p) => p.x),
      this.parapets.map((p) => p.z),
    );
    this.canopyImages = new ImageCache(
      this.canopies.map((c) => c.x),
      this.canopies.map((c) => c.z),
    );
    this.parapetUploads = new InstanceUploads([
      this.parapetMesh.instanceMatrix,
    ]);
    this.canopyUploads = new InstanceUploads([this.canopyMesh.instanceMatrix]);
  }

  /** Total garnish instances drawn — perf reporting/QA. */
  get instanceCount(): number {
    return this.parapets.length + this.canopies.length;
  }

  /** Seam QA: where the parapet nearest canonical (x, z) is drawn right now
   * (matrix read-back, same contract as Streetlights/Signage imageOf). */
  imageOf(x: number, z: number): { x: number; z: number } | null {
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    this.parapets.forEach((p, i) => {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) return null;
    this.parapetMesh.getMatrixAt(best, this.scratch);
    return {
      x: this.scratch.elements[12],
      z: this.scratch.elements[14],
    };
  }

  /** Place everything at its torus image nearest the camera — rewriting
   * and uploading only what flipped image (O2). */
  update(cameraPos: Vec3): void {
    this.standing.update(); // D8: hides re-place through the image caches
    this.parapetImages.update(cameraPos, this.placeParapet);
    this.canopyImages.update(cameraPos, this.placeCanopy);
    this.parapetUploads.flush();
    this.canopyUploads.flush();
  }

  private readonly placeParapet = (i: number, x: number, z: number): void => {
    const p = this.parapets[i] as ParapetLip;
    const gone = this.standing.isHidden(
      this.parapetB[i] as number,
      this.parapetK[i] as number,
    );
    if (gone) this.scratch.makeScale(0, 0, 0);
    else this.scratch.makeScale(p.width, PARAPET_HEIGHT, p.depth);
    this.scratch.setPosition(x, p.y - LIP_SINK, z);
    this.parapetMesh.setMatrixAt(i, this.scratch);
    this.parapetUploads.mark(i);
  };

  private readonly placeCanopy = (i: number, x: number, z: number): void => {
    const c = this.canopies[i] as Canopy;
    const gone = this.standing.isHidden(
      this.canopyB[i] as number,
      this.canopyK[i] as number,
    );
    if (gone) this.scratch.makeScale(0, 0, 0);
    else this.scratch.makeScale(c.sizeX, CANOPY_THICKNESS, c.sizeZ);
    this.scratch.setPosition(x, c.y, z);
    this.canopyMesh.setMatrixAt(i, this.scratch);
    this.canopyUploads.mark(i);
  };
}
