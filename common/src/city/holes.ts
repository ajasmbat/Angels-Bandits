// H1 fly-through holes — the one seam every consumer of a hole reads.
//
// A hole is a rectangular tunnel that runs the full length of one tier along
// one street axis. Three kinds share the shape:
//   - arch:   through each landmark's 90 m podium, hand-placed axis;
//   - tunnel: through tier 0 of a lot that spans its whole block along the
//             axis, so both mouths sit on lot lines facing streets (never a
//             party wall into a neighbour);
//   - sky:    through the top tier of a tall tower, under a lintel, so the
//             roof (and everything that dresses it) stays intact.
//
// `solids(b)` turns a building's tier stack into the boxes that are actually
// there — a holed tier becomes two side walls, a lintel and (when the floor
// is above the tier base) a sill. Collision, line of sight and the renderer
// all iterate exactly these boxes, so drawing, crashing and seeing agree by
// construction. Pure and shared: client and server run it verbatim.

import {
  ARCH_HEIGHT,
  ARCH_WIDTH,
  BLOCK_PITCH,
  CRANE_JIB_MAX,
  HOLE_CLEARANCE,
  HOLE_CORRIDOR_MARGIN,
  HOLE_LINTEL_MIN,
  HOLE_MIN_FLOOR,
  HOLE_RUN_OUT,
  HOLE_SILL_MIN,
  HOLE_WALL_MIN,
  LANDMARK_HEIGHT,
  SKY_HOLE_CHANCE,
  SKY_HOLE_HEIGHT,
  SKY_HOLE_MIN_HEIGHT,
  SKY_HOLE_WIDTH,
  TUNNEL_CHANCE,
  TUNNEL_HEIGHT,
  TUNNEL_WIDTH,
} from "../constants";
import { type Vec3, canonicalize, wrapDelta } from "../world/index";
import type { Building, Tier } from "./index";
import { CONSTRUCTION_BLOCKS } from "./layout";
import { LOT_LINE } from "./street";

export type HoleKind = "arch" | "tunnel" | "sky";
/** The axis a plane TRAVELS along to fly through the hole. */
export type HoleAxis = "x" | "z";

/** One fly-through hole, in its building's frame. */
export interface Hole {
  kind: HoleKind;
  axis: HoleAxis;
  /** The tier the hole runs through (its full length along `axis`). */
  tierIndex: number;
  /** Across-axis offset of the hole's centreline from the building center. */
  offset: number;
  /** World height of the hole's floor, meters. */
  y0: number;
  /** Clear width across the axis, meters. */
  width: number;
  /** Clear height, meters. */
  height: number;
}

/** One solid box of a building, offset from its (x, z) center. */
export interface SolidBox {
  dx: number;
  dz: number;
  /** Ground height of the box's base, meters. */
  baseY: number;
  width: number;
  height: number;
  depth: number;
  /** The tier this box belongs to (its parent, for rendering). */
  tierIndex: number;
}

/**
 * Sill and lintel reach this far into each side wall. The overlap is inside
 * solid wall either way, so collision is unchanged; it removes the T-junction
 * where a lintel face would otherwise end mid-way along a wall face (sub-pixel
 * cracks). Both faces shade identically in the parent-tier frame, so the
 * overlapping 5 cm never shows.
 */
const SEAM_OVERLAP = 0.05;

/**
 * Hand-placed arch axes per landmark block ("bx,bz"). Like the landmarks
 * themselves these are orientation data: an arch you learn to thread must be
 * where it was after a reseed. Kept here rather than in layout.ts so the
 * layout module stays three lists (tests mock it wholesale).
 */
const ARCH_AXES: Readonly<Record<string, HoleAxis>> = {
  "2,3": "x",
  "7,1": "z",
  "5,8": "x",
  "8,6": "z",
};

/** The archway through a landmark podium at block (bx, bz). */
export function landmarkArch(bx: number, bz: number): Hole {
  return {
    kind: "arch",
    axis: ARCH_AXES[`${bx},${bz}`] ?? "x",
    tierIndex: 0,
    offset: 0,
    y0: HOLE_MIN_FLOOR,
    width: ARCH_WIDTH,
    height: ARCH_HEIGHT,
  };
}

/** A tier's (along, across) sizes for a hole running along `axis`. */
const alongAcross = (t: Tier, axis: HoleAxis) =>
  axis === "x"
    ? { along: t.width, across: t.depth }
    : { along: t.depth, across: t.width };

/** Split one holed tier into its walls, sill and lintel. */
function splitTier(
  t: Tier,
  baseY: number,
  hole: Hole,
  tierIndex: number,
): SolidBox[] {
  const { along, across } = alongAcross(t, hole.axis);
  const top = baseY + t.height;
  const lo = hole.offset - hole.width / 2;
  const hi = hole.offset + hole.width / 2;
  // (across center, across size, base, height) → a box in building frame.
  const box = (
    c: number,
    size: number,
    y: number,
    h: number,
  ): SolidBox =>
    hole.axis === "x"
      ? { dx: 0, dz: c, baseY: y, width: along, height: h, depth: size, tierIndex }
      : { dx: c, dz: 0, baseY: y, width: size, height: h, depth: along, tierIndex };
  const out = [
    box((-across / 2 + lo) / 2, lo + across / 2, baseY, t.height),
    box((hi + across / 2) / 2, across / 2 - hi, baseY, t.height),
  ];
  const span = hole.width + 2 * SEAM_OVERLAP;
  if (hole.y0 > baseY) out.push(box(hole.offset, span, baseY, hole.y0 - baseY));
  const ceiling = hole.y0 + hole.height;
  out.push(box(hole.offset, span, ceiling, top - ceiling));
  return out;
}

function computeSolids(b: Building): SolidBox[] {
  const out: SolidBox[] = [];
  let baseY = 0;
  b.tiers.forEach((t, tierIndex) => {
    const hole = b.holes?.find((h) => h.tierIndex === tierIndex);
    if (hole) {
      out.push(...splitTier(t, baseY, hole, tierIndex));
    } else {
      out.push({
        dx: 0,
        dz: 0,
        baseY,
        width: t.width,
        height: t.height,
        depth: t.depth,
        tierIndex,
      });
    }
    baseY += t.height;
  });
  return out;
}

/** Buildings are immutable once generated, so their solids are too. */
const solidCache = new WeakMap<Building, readonly SolidBox[]>();

/**
 * Every solid box of a building, bottom-up: one per unholed tier, and two
 * walls + lintel (+ sill) per holed tier. All boxes stay inside the tier-1
 * footprint, so footprint-keyed indexes and rejects remain valid.
 */
export function solids(b: Building): readonly SolidBox[] {
  let out = solidCache.get(b);
  if (!out) {
    out = computeSolids(b);
    solidCache.set(b, out);
  }
  return out;
}

/** A hole in world space — the surface bots (B2) and dressing route by. */
export interface HoleSpan {
  building: Building;
  hole: Hole;
  /** Centre of the hole's clear volume, canonical world coordinates. */
  center: Vec3;
  /** Mouth centres on the low- and high-coordinate side of `axis`. */
  entry: Vec3;
  exit: Vec3;
  /** Mouth-to-mouth length along `axis`, meters. */
  length: number;
}

/** Every hole in the city, with its world centreline. */
export function cityHoles(buildings: readonly Building[]): HoleSpan[] {
  const out: HoleSpan[] = [];
  for (const building of buildings) {
    for (const hole of building.holes ?? []) {
      const tier = building.tiers[hole.tierIndex];
      if (!tier) continue;
      const length = alongAcross(tier, hole.axis).along;
      const x = building.x + (hole.axis === "z" ? hole.offset : 0);
      const z = building.z + (hole.axis === "x" ? hole.offset : 0);
      const y = hole.y0 + hole.height / 2;
      const ux = hole.axis === "x" ? length / 2 : 0;
      const uz = hole.axis === "z" ? length / 2 : 0;
      out.push({
        building,
        hole,
        center: canonicalize({ x, y, z }),
        entry: canonicalize({ x: x - ux, y, z: z - uz }),
        exit: canonicalize({ x: x + ux, y, z: z + uz }),
        length,
      });
    }
  }
  return out;
}

// --- Placement: the city-level pass -------------------------------------

/**
 * True when the run-out corridor of a hole through `host` (centred on its
 * footprint, half-length `halfLength` along `axis`, half-width `halfWidth`)
 * comes within a crane's reach of a construction block. Crane jibs sweep
 * CRANE_JIB_MAX around a mast somewhere inside the block, so the whole block
 * grown by that reach is off limits — conservative on purpose.
 */
function nearCrane(
  host: Building,
  axis: HoleAxis,
  halfLength: number,
  halfWidth: number,
): boolean {
  const reach = halfLength + HOLE_RUN_OUT;
  const hx = axis === "x" ? reach : halfWidth;
  const hz = axis === "x" ? halfWidth : reach;
  return CONSTRUCTION_BLOCKS.some(([bx, bz]) => {
    const d = wrapDelta(
      { x: host.x, y: 0, z: host.z },
      { x: (bx + 0.5) * BLOCK_PITCH, y: 0, z: (bz + 0.5) * BLOCK_PITCH },
    );
    const gx = Math.max(0, Math.abs(d.x) - hx - BLOCK_PITCH / 2);
    const gz = Math.max(0, Math.abs(d.z) - hz - BLOCK_PITCH / 2);
    return Math.hypot(gx, gz) < CRANE_JIB_MAX;
  });
}

/**
 * The lowest floor at which a hole through `host` has clear air on both
 * sides: HOLE_CLEARANCE over the tallest OTHER building whose footprint
 * strictly overlaps the run-out corridor — the hole's width plus
 * HOLE_CORRIDOR_MARGIN either side, out to HOLE_RUN_OUT beyond each mouth.
 * Torus-correct via wrapDelta. Whole-building heights, so a setback tower's
 * slim top counts as its full footprint (conservative). Never below
 * HOLE_MIN_FLOOR.
 */
function clearFloor(
  host: Building,
  axis: HoleAxis,
  halfLength: number,
  holeWidth: number,
  buildings: readonly Building[],
): number {
  const band = holeWidth / 2 + HOLE_CORRIDOR_MARGIN;
  let tallest = 0;
  for (const o of buildings) {
    if (o === host) continue;
    const d = wrapDelta({ x: host.x, y: 0, z: host.z }, { x: o.x, y: 0, z: o.z });
    const along = axis === "x" ? d.x : d.z;
    const across = axis === "x" ? d.z : d.x;
    const oAlong = (axis === "x" ? o.width : o.depth) / 2;
    const oAcross = (axis === "x" ? o.depth : o.width) / 2;
    if (Math.abs(across) >= band + oAcross) continue;
    if (Math.abs(along) - oAlong >= halfLength + HOLE_RUN_OUT) continue;
    if (o.height > tallest) tallest = o.height;
  }
  return Math.max(HOLE_MIN_FLOOR, tallest + HOLE_CLEARANCE);
}

/**
 * A hole of `width` × `height` through tier `tierIndex` of `host` along
 * `axis`, at the lowest clear floor — or null when the walls, sill or lintel
 * would come out thinner than their minimums, or a crane could sweep the
 * corridor.
 */
function fitHole(
  kind: HoleKind,
  host: Building,
  axis: HoleAxis,
  tierIndex: number,
  width: number,
  height: number,
  minFloor: number,
  buildings: readonly Building[],
): Hole | null {
  const tier = host.tiers[tierIndex];
  if (!tier) return null;
  const { along, across } = alongAcross(tier, axis);
  if ((across - width) / 2 < HOLE_WALL_MIN) return null;
  let base = 0;
  for (let i = 0; i < tierIndex; i++) base += host.tiers[i]?.height ?? 0;
  const y0 = Math.max(
    minFloor,
    clearFloor(host, axis, along / 2, width, buildings),
  );
  if (y0 + height + HOLE_LINTEL_MIN > base + tier.height) return null;
  if (nearCrane(host, axis, along / 2, width / 2 + HOLE_CORRIDOR_MARGIN)) {
    return null;
  }
  return { kind, axis, tierIndex, offset: 0, y0, width, height };
}

/** The axes along which `b` spans its whole block's buildable extent — both
 * mouths of a tunnel along such an axis open onto a street. */
function spanningAxes(b: Building): HoleAxis[] {
  const fits = (center: number, size: number) => {
    const block = Math.floor(center / BLOCK_PITCH) * BLOCK_PITCH;
    return (
      Math.abs(center - size / 2 - (block + LOT_LINE)) < 0.01 &&
      Math.abs(center + size / 2 - (block + BLOCK_PITCH - LOT_LINE)) < 0.01
    );
  };
  const out: HoleAxis[] = [];
  if (fits(b.x, b.width)) out.push("x");
  if (fits(b.z, b.depth)) out.push("z");
  return out;
}

/**
 * The city-level pass: street tunnels and sky holes, assigned in place.
 *
 * Runs after every block is built because clear air is a property of the
 * NEIGHBOURS (the ticket's "above every neighbour along the axis"), so unlike
 * lots, holes are not a pure function of their own block. Randomness still
 * comes from a separately salted stream per block (`streamFor`), with a fixed
 * three draws per non-landmark building in array order, so no gate shifts
 * another building's roll and the lot streams are untouched. A block keeps at
 * most one tunnel (its first lot that wins the roll AND fits); a building
 * keeps at most one hole.
 */
export function assignHoles(
  buildings: Building[],
  streamFor: (bx: number, bz: number) => () => number,
): void {
  const streams = new Map<string, () => number>();
  const tunnelled = new Set<string>();
  for (const b of buildings) {
    if (b.height >= LANDMARK_HEIGHT || b.holes) continue;
    const bx = Math.floor(b.x / BLOCK_PITCH);
    const bz = Math.floor(b.z / BLOCK_PITCH);
    const key = `${bx},${bz}`;
    let rand = streams.get(key);
    if (!rand) {
      rand = streamFor(bx, bz);
      streams.set(key, rand);
    }
    const rTunnel = rand();
    const rSky = rand();
    const rAxis = rand();

    let hole: Hole | null = null;
    if (!tunnelled.has(key) && rTunnel < TUNNEL_CHANCE) {
      for (const axis of spanningAxes(b)) {
        hole = fitHole(
          "tunnel",
          b,
          axis,
          0,
          TUNNEL_WIDTH,
          TUNNEL_HEIGHT,
          HOLE_MIN_FLOOR,
          buildings,
        );
        if (hole) break;
      }
      if (hole) tunnelled.add(key);
    }
    if (!hole && b.height >= SKY_HOLE_MIN_HEIGHT && rSky < SKY_HOLE_CHANCE) {
      const top = b.tiers.length - 1;
      let base = 0;
      for (let i = 0; i < top; i++) base += b.tiers[i]?.height ?? 0;
      const axes: HoleAxis[] = rAxis < 0.5 ? ["x", "z"] : ["z", "x"];
      for (const axis of axes) {
        hole = fitHole(
          "sky",
          b,
          axis,
          top,
          SKY_HOLE_WIDTH,
          SKY_HOLE_HEIGHT,
          base + HOLE_SILL_MIN,
          buildings,
        );
        if (hole) break;
      }
    }
    if (hole) b.holes = [hole];
  }
}
