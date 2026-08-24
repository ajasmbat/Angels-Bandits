// Facade garnish (ANGE-XY8LH8, client-only dressing): parapet caps along
// every tier's roof edges (kills the sharp-box-top look) and one entrance
// canopy per building on its street-facing base side. Layout is the pure
// seam facadeGarnishFor() — deterministic per building via the shared
// mulberry32 (roofClutterFor idiom, no Math.random), so every client
// dresses identical facades. Street geometry comes from the S1 contract
// (nearestStreet + the S2 sidewalk-clearance formula), never re-derived.
// Garnish is visual-only with no collision — the plan's sanctioned
// exception, same as roof clutter.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import {
  facadeClearances,
  nearestStreet,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { nearestImage } from "./wrapPlacement";

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
  const side = `${onX ? "x" : "z"}${dir < 0 ? 0 : 1}` as const;
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

// --- Renderer (RoofClutter idiom: canonical layout, re-placed each frame) ---

/** Caps slightly lighter than facades so roof edges catch the sky. */
const PARAPET_COLOR = 0x262633;
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

  constructor(buildings: readonly Building[]) {
    const layouts = buildings.map(facadeGarnishFor);
    this.parapets = layouts.flatMap((g) => g.parapets);
    this.canopies = layouts.flatMap((g) => (g.canopy ? [g.canopy] : []));

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

  /** Place everything at its torus image nearest the camera. */
  update(cameraPos: Vec3): void {
    this.parapets.forEach((p, i) => {
      const img = nearestImage(cameraPos, { x: p.x, y: 0, z: p.z });
      this.scratch.makeScale(p.width, PARAPET_HEIGHT, p.depth);
      this.scratch.setPosition(img.x, p.y - LIP_SINK, img.z);
      this.parapetMesh.setMatrixAt(i, this.scratch);
    });
    this.canopies.forEach((c, i) => {
      const img = nearestImage(cameraPos, { x: c.x, y: 0, z: c.z });
      this.scratch.makeScale(c.sizeX, CANOPY_THICKNESS, c.sizeZ);
      this.scratch.setPosition(img.x, c.y, img.z);
      this.canopyMesh.setMatrixAt(i, this.scratch);
    });
    this.parapetMesh.instanceMatrix.needsUpdate = true;
    this.canopyMesh.instanceMatrix.needsUpdate = true;
  }
}
