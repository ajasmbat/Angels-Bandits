// Roof clutter layout (V2, R2) — the pure seam every roof consumer reads:
// rooftop-life (L8), roof-details (R2), citylife's terrace people (A1) and
// the steam vents all keep clear of what this module says stands on a roof.
// Kept apart from the renderer (roofclutter.ts) so those modules can import
// it without an import cycle through the renderer.
//
// R2: everything taller than ROOF_CLUTTER_MAX_HEIGHT is a SOLID roof
// structure from the shared seam (common/src/city/roof-structures.ts, stored
// on Building.roof) — the water tanks and antenna masts moved there. What is
// left here is the ≤ 2.5 m HVAC units and the landmark beacon.

import {
  type Building,
  generatedRoof,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  BILLBOARD_CATWALK,
  BILLBOARD_THICKNESS,
  ROOF_CLUTTER_MAX_HEIGHT,
  type RoofStructure,
} from "@angels-bandits/common/city/roof-structures";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";
import { RoofKind, roofStyleFor } from "./roofs";

/** How far a helipad roof's corner units may wander in from the corner, m —
 * small enough that the smallest pad roof (34 m) keeps them off the pad. */
const HELIPAD_CORNER_SPAN = 2;
/** Beacon hover above the landmark crown, meters. */
const BEACON_LIFT = 3;
/** Tallest HVAC unit: its condenser fan shroud (rooftop-life, 0.3 m) on top
 * still stays at the clutter line. */
export const AC_MAX_HEIGHT = ROOF_CLUTTER_MAX_HEIGHT - 0.3;
/** Clear air kept between an HVAC unit and a structure, m. */
const AC_GAP = 0.8;
const AC_TRIES = 4;

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
  /** R2: the building's solid structures (Building.roof), as stored. */
  structures: readonly RoofStructure[];
  /** Water tanks among the structures, in world coordinates. */
  waterTowers: WaterTower[];
  acBoxes: AcBox[];
  /** Antenna masts among the structures. Every mast carries a tiny red
   * emissive tip (roofclutter) and an aviation light (rooftop-life). */
  masts: Mast[];
  /** Pulsing red beacon — landmarks only. */
  beacon: { x: number; z: number; y: number } | null;
}

/** An axis-aligned keep-out rectangle in canonical coordinates. */
export interface Rect {
  x: number;
  z: number;
  hw: number;
  hd: number;
}
export const overlaps = (a: Rect, b: Rect, margin: number): boolean =>
  Math.abs(a.x - b.x) < a.hw + b.hw + margin &&
  Math.abs(a.z - b.z) < a.hd + b.hd + margin;

/** A structure's footprint as a keep-out — a billboard reserves its catwalk
 * (in front) and leg braces (behind) as well as the panel. */
export function structureRect(b: Building, s: RoofStructure): Rect {
  const across = BILLBOARD_THICKNESS / 2 + BILLBOARD_CATWALK + 0.2;
  const billboard = s.kind === "billboard";
  return {
    x: b.x + s.dx,
    z: b.z + s.dz,
    hw: billboard && s.face < 2 ? across : s.width / 2,
    hd: billboard && s.face >= 2 ? across : s.depth / 2,
  };
}

/** Every footprint the clutter layout puts on a roof: structures and HVAC
 * units. The shared keep-out list for everything placed after it. */
export function clutterRects(b: Building, c: RoofClutter): Rect[] {
  return [
    ...c.structures.map((s) => structureRect(b, s)),
    ...c.acBoxes.map((a) => ({
      x: a.x,
      z: a.z,
      hw: a.width / 2,
      hd: a.depth / 2,
    })),
  ];
}

/**
 * Deterministic clutter for one building's TOP tier roof. Landmarks get a
 * beacon and stay otherwise clean (the crown is the read); everything else
 * rolls HVAC units from a PRNG seeded by the building itself, clear of its
 * solid structures.
 */
export function roofClutterFor(b: Building): RoofClutter {
  // D8: as generated — a damaged roof loses structures (b.roof follows the
  // stump), and the clutter laid out around them must not shift.
  const structures = generatedRoof(b) ?? [];
  const none: RoofClutter = {
    structures,
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

  const clutter: RoofClutter = {
    ...none,
    waterTowers: structures
      .filter((s) => s.kind === "waterTank")
      .map((s) => ({
        x: b.x + s.dx,
        z: b.z + s.dz,
        y: s.baseY,
        radius: s.width / 2,
        height: s.height,
      })),
    masts: structures
      .filter((s) => s.kind === "mast")
      .map((s) => ({
        x: b.x + s.dx,
        z: b.z + s.dz,
        y: s.baseY,
        height: s.height,
      })),
  };

  // VO3 helipad roofs take their OWN placement path: a few units pushed into
  // the corners, clear of the pad circle and its perimeter lights. Helipad
  // roofs carry no structures (the shared seam keeps them clear).
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
        height: 1.2 + rand() * (AC_MAX_HEIGHT - 1.2),
      });
    }
    return clutter;
  }

  // HVAC units: one to three per roof, never inside a structure.
  const solid = structures.map((s) => structureRect(b, s));
  const boxes = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < boxes; i++) {
    const width = 1.6 + rand() * 2.4;
    const depth = 1.6 + rand() * 2.4;
    const height = 1.2 + rand() * (AC_MAX_HEIGHT - 1.2);
    for (let t = 0; t < AC_TRIES; t++) {
      const box: AcBox = {
        x: b.x + offset(halfW, width / 2),
        z: b.z + offset(halfD, depth / 2),
        y: b.height,
        width,
        depth,
        height,
      };
      const r = { x: box.x, z: box.z, hw: width / 2, hd: depth / 2 };
      if (solid.every((s) => !overlaps(r, s, AC_GAP))) {
        clutter.acBoxes.push(box);
        solid.push(r);
        break;
      }
    }
  }

  return clutter;
}
