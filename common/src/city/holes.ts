// H1 fly-through holes — the one seam every consumer of a hole reads.
//
// A hole is a rectangular tunnel that runs the full length of one tier along
// one street axis. Four kinds share the shape:
//   - arch:   through each landmark's 90 m podium, hand-placed axis;
//   - tunnel: (H2) a ROW tunnel — one straight line through tier 0 of every
//             lot it crosses in a block, so the run's outer mouths open on
//             clear air (never a party wall into a neighbour); each lot it
//             cuts carries its own Hole, tied together by `run`;
//   - gate:   (H2) the big opening through a tall slab tower;
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
  GATE_CHANCE,
  GATE_HEIGHT,
  GATE_MIN_HEIGHT,
  GATE_WIDTH,
  HOLE_CLEARANCE,
  HOLE_CORRIDOR_MARGIN,
  HOLE_LINTEL_MIN,
  HOLE_MIN_FLOOR,
  HOLE_RUN_OUT,
  HOLE_SILL_MIN,
  HOLE_WALL_MIN,
  LANDMARK_HEIGHT,
  ROW_TUNNEL_CHANCE,
  SKY_HOLE_CHANCE,
  SKY_HOLE_HEIGHT,
  SKY_HOLE_MIN_HEIGHT,
  SKY_HOLE_WIDTH,
  TUNNEL_HEIGHT,
  TUNNEL_WIDTH,
  WORLD_SIZE,
} from "../constants";
import { type Vec3, canonicalize, wrapDelta } from "../world/index";
import type { Building, Tier } from "./index";
import { CONSTRUCTION_BLOCKS } from "./layout";
import type { RoofStructure } from "./roof-structures";
import { LOT_LINE, nextIntersection } from "./street";

/** "bridge" is L11's underpass under a river bridge (city/river.ts
 * bridgeSpans) — never a hole in a Building, only an edge of the bots'
 * street graph. */
export type HoleKind = "arch" | "tunnel" | "gate" | "sky" | "bridge";
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
  /** H2 row tunnels: the id every lot cut by the same line shares (its
   * block's key). cityHoles() merges a run into one HoleSpan. */
  run?: number;
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
  const box = (c: number, size: number, y: number, h: number): SolidBox =>
    hole.axis === "x"
      ? {
          dx: 0,
          dz: c,
          baseY: y,
          width: along,
          height: h,
          depth: size,
          tierIndex,
        }
      : {
          dx: c,
          dz: 0,
          baseY: y,
          width: size,
          height: h,
          depth: along,
          tierIndex,
        };
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

/** A hole in world space — the surface bots and dressing route by. A row
 * tunnel is ONE span over its whole run: `hole` is its first host's (same
 * axis, floor and size on every host), the mouths are the run's outer ones. */
export interface HoleSpan {
  building: Building;
  hole: Hole;
  /** Every building the hole cuts: one, several for a row tunnel, none for
   * an L11 bridge underpass. */
  hosts: readonly Building[];
  /** Centre of the hole's clear volume, canonical world coordinates. */
  center: Vec3;
  /** Mouth centres on the low- and high-coordinate side of `axis`. */
  entry: Vec3;
  exit: Vec3;
  /** Mouth-to-mouth length along `axis`, meters. */
  length: number;
}

/** One hole's world extent along its axis and its world centreline across. */
function holeExtent(building: Building, hole: Hole) {
  const tier = building.tiers[hole.tierIndex];
  if (!tier) return null;
  const half = alongAcross(tier, hole.axis).along / 2;
  const x = hole.axis === "x";
  const along = x ? building.x : building.z;
  return {
    lo: along - half,
    hi: along + half,
    across: (x ? building.z : building.x) + hole.offset,
  };
}

/**
 * Every hole in the city, with its world centreline. A row tunnel's hosts
 * merge into one span from the low edge of its first host to the high edge
 * of its last — lots never cross a block edge, so a run never wraps and its
 * extent is plain arithmetic in canonical coordinates.
 */
export function cityHoles(buildings: readonly Building[]): HoleSpan[] {
  const out: HoleSpan[] = [];
  const runs = new Map<number, { span: HoleSpan; lo: number; hi: number }>();
  for (const building of buildings) {
    for (const hole of building.holes ?? []) {
      const e = holeExtent(building, hole);
      if (!e) continue;
      const run = hole.run === undefined ? undefined : runs.get(hole.run);
      if (run) {
        run.lo = Math.min(run.lo, e.lo);
        run.hi = Math.max(run.hi, e.hi);
        (run.span.hosts as Building[]).push(building);
        continue;
      }
      const span: HoleSpan = {
        building,
        hole,
        hosts: [building],
        center: { x: 0, y: 0, z: 0 },
        entry: { x: 0, y: 0, z: 0 },
        exit: { x: 0, y: 0, z: 0 },
        length: 0,
      };
      out.push(span);
      if (hole.run !== undefined)
        runs.set(hole.run, { span, lo: e.lo, hi: e.hi });
      setSpanExtent(span, e.lo, e.hi, e.across);
    }
  }
  for (const r of runs.values()) {
    const e = holeExtent(r.span.building, r.span.hole);
    if (e) setSpanExtent(r.span, r.lo, r.hi, e.across);
  }
  return out;
}

/** Fill a span's centre, mouths and length from its along extent [lo, hi]. */
function setSpanExtent(
  span: HoleSpan,
  lo: number,
  hi: number,
  across: number,
): void {
  const { axis, y0, height } = span.hole;
  const y = y0 + height / 2;
  const at = (along: number): Vec3 =>
    canonicalize(
      axis === "x" ? { x: along, y, z: across } : { x: across, y, z: along },
    );
  span.center = at((lo + hi) / 2);
  span.entry = at(lo);
  span.exit = at(hi);
  span.length = hi - lo;
}

/**
 * Do both of the span's mouths open on a street — its run spans the block's
 * whole buildable extent, lot line to lot line? (A tunnel whose mouths open
 * over low roofs mid-block is threaded from above the roofs, like a sky hole.)
 */
export function opensOnStreets(span: HoleSpan): boolean {
  const x = span.hole.axis === "x";
  const inBlock = (v: number) =>
    ((v % BLOCK_PITCH) + BLOCK_PITCH) % BLOCK_PITCH;
  const a = inBlock(x ? span.entry.x : span.entry.z);
  const b = inBlock(x ? span.exit.x : span.exit.z);
  return (
    Math.abs(a - LOT_LINE) < 0.5 && Math.abs(b - (BLOCK_PITCH - LOT_LINE)) < 0.5
  );
}

/**
 * H2 × R2: drop every roof structure that would stand in a hole's clear air.
 * Holes are cut before roofs are dressed, and clearFloor only knows roofs, so
 * a mast or penthouse on a roof in a run-out corridor could rise past the
 * HOLE_CLEARANCE margin into it. A structure on a building OTHER than the
 * hole's hosts, overlapping the corridor (the hole plus HOLE_RUN_OUT beyond
 * each outer mouth, HOLE_CORRIDOR_MARGIN either side) and topping out above
 * half the clearance under the floor, goes. Hosts keep theirs: their roofs
 * sit over the lintel. Arches keep their hand-placed H1 approach.
 */
export function clearHoleAir(buildings: readonly Building[]): void {
  const spans = clearAirSpans(buildings);
  if (spans.length === 0) return;
  for (const b of buildings) {
    if (!b.roof) continue;
    const kept = b.roof.filter((r) => !inHoleAir(b, r, spans));
    if (kept.length === b.roof.length) continue;
    b.roof = kept.length > 0 ? kept : undefined;
  }
}

/** The spans whose clear air clearHoleAir keeps (every hole but the arches
 * and river underpasses). */
export function clearAirSpans(buildings: readonly Building[]): HoleSpan[] {
  return cityHoles(buildings).filter(
    (s) => s.hole.kind !== "arch" && s.hole.kind !== "bridge",
  );
}

/** Would roof structure `r` of `b` stand in one of `spans`' clear air? */
export function inHoleAir(
  b: Building,
  r: RoofStructure,
  spans: readonly HoleSpan[],
): boolean {
  return spans.some((s) => {
    if (s.hosts.includes(b)) return false;
    if (r.baseY + r.height <= s.hole.y0 - HOLE_CLEARANCE / 2) return false;
    const x = s.hole.axis === "x";
    const d = wrapDelta(
      { x: s.center.x, y: 0, z: s.center.z },
      { x: b.x + r.dx, y: 0, z: b.z + r.dz },
    );
    const along = Math.abs(x ? d.x : d.z) - (x ? r.width : r.depth) / 2;
    const across = Math.abs(x ? d.z : d.x) - (x ? r.depth : r.width) / 2;
    return (
      along < s.length / 2 + HOLE_RUN_OUT &&
      across < s.hole.width / 2 + HOLE_CORRIDOR_MARGIN
    );
  });
}

// --- Bot routing (B2): holes as edges of the street graph ---------------

/**
 * One directed pass through a hole: an edge of the bots' street graph. Its
 * two nodes are where the hole's axis crosses the perpendicular street behind
 * the mouth it enters by and beyond the one it leaves by — the lattice's own
 * nextIntersection, run along the hole's line instead of a street's. For an
 * arch (mid-block) that street is 55 m from the mouth, for a tunnel (a lot
 * spanning its block) it is the sidewalk in front of it.
 */
export interface HoleEdge {
  span: HoleSpan;
  /** +1 flies entry → exit (increasing `axis` coordinate), −1 the reverse. */
  dir: 1 | -1;
  /** Mouth centres the plane enters by and leaves by (centreline height). */
  mouthIn: Vec3;
  mouthOut: Vec3;
  /** The street-graph nodes behind mouthIn and beyond mouthOut, at
   * centreline height. */
  from: Vec3;
  to: Vec3;
}

/** Both directed edges of every hole, in cityHoles() order. */
export function holeEdges(spans: readonly HoleSpan[]): HoleEdge[] {
  const out: HoleEdge[] = [];
  for (const span of spans) {
    const { axis } = span.hole;
    const centerline = axis === "x" ? span.center.z : span.center.x;
    const node = (mouth: Vec3, dir: 1 | -1): Vec3 => ({
      ...nextIntersection(mouth, { axis, centerline }, dir),
      y: span.center.y,
    });
    for (const dir of [1, -1] as const) {
      const mouthIn = dir === 1 ? span.entry : span.exit;
      const mouthOut = dir === 1 ? span.exit : span.entry;
      out.push({
        span,
        dir,
        mouthIn,
        mouthOut,
        from: node(mouthIn, dir === 1 ? -1 : 1),
        to: node(mouthOut, dir),
      });
    }
  }
  return out;
}

/** A point in an edge's own frame, meters (torus-correct via wrapDelta). */
export interface EdgeFrame {
  /** Distance travelled past mouthIn along the edge (negative: before it). */
  along: number;
  /** Offset off the hole's centreline across the axis (world-axis sign). */
  lateral: number;
  /** Height above the centreline. */
  up: number;
}

export function edgeFrame(edge: HoleEdge, p: Vec3): EdgeFrame {
  const d = wrapDelta(edge.mouthIn, p);
  const x = edge.span.hole.axis === "x";
  return {
    along: (x ? d.x : d.z) * edge.dir,
    lateral: x ? d.z : d.x,
    up: d.y,
  };
}

/**
 * Did the straight move a → b pass through `span`'s clear volume? Tests where
 * it crosses the hole's mid-plane, so a 20 Hz track through a 16 m sky hole
 * still registers. Returns the travel direction (+1 along increasing `axis`,
 * −1 against it), or 0 for no transit.
 */
export function segmentThroughHole(
  span: HoleSpan,
  a: Vec3,
  b: Vec3,
): 0 | 1 | -1 {
  const x = span.hole.axis === "x";
  const da = wrapDelta(span.center, a);
  const db = wrapDelta(span.center, b);
  const alongA = x ? da.x : da.z;
  const alongB = x ? db.x : db.z;
  if (alongA === alongB || Math.sign(alongA) === Math.sign(alongB)) return 0;
  // A teleport across the map is not a transit (and would interpolate junk).
  if (Math.abs(alongB - alongA) > span.length + 2 * span.hole.width) return 0;
  const t = alongA / (alongA - alongB);
  const lateral =
    (x ? da.z : da.x) + ((x ? db.z : db.x) - (x ? da.z : da.x)) * t;
  const y = a.y + (b.y - a.y) * t;
  const { width, y0, height } = span.hole;
  if (Math.abs(lateral) > width / 2 || y < y0 || y > y0 + height) return 0;
  return alongB > alongA ? 1 : -1;
}

// --- Placement: the city-level pass -------------------------------------

/**
 * True when the run-out corridor of a hole centred on (cx, cz), half-length
 * `halfLength` along `axis`, half-width `halfWidth`, comes within a crane's
 * reach of a construction block. Crane jibs sweep CRANE_JIB_MAX around a mast
 * somewhere inside the block, so the whole block grown by that reach is off
 * limits — conservative on purpose.
 */
function nearCrane(
  cx: number,
  cz: number,
  axis: HoleAxis,
  halfLength: number,
  halfWidth: number,
): boolean {
  const reach = halfLength + HOLE_RUN_OUT;
  const hx = axis === "x" ? reach : halfWidth;
  const hz = axis === "x" ? halfWidth : reach;
  return CONSTRUCTION_BLOCKS.some(([bx, bz]) => {
    const d = wrapDelta(
      { x: cx, y: 0, z: cz },
      { x: (bx + 0.5) * BLOCK_PITCH, y: 0, z: (bz + 0.5) * BLOCK_PITCH },
    );
    const gx = Math.max(0, Math.abs(d.x) - hx - BLOCK_PITCH / 2);
    const gz = Math.max(0, Math.abs(d.z) - hz - BLOCK_PITCH / 2);
    return Math.hypot(gx, gz) < CRANE_JIB_MAX;
  });
}

/**
 * The lowest floor at which a hole centred on (cx, cz) has clear air on both
 * sides: HOLE_CLEARANCE over the tallest building, other than its own hosts,
 * whose footprint strictly overlaps the run-out corridor — the hole's width
 * plus HOLE_CORRIDOR_MARGIN either side, out to HOLE_RUN_OUT beyond each
 * mouth (and so every lot a row tunnel passes over, too). Torus-correct via
 * wrapDelta. Each tier is tested on its own footprint, so a setback tower
 * only counts as tall where its upper tiers actually stand (H2 — whole
 * footprints threw away most tunnel lines). Never below HOLE_MIN_FLOOR.
 */
function clearFloor(
  cx: number,
  cz: number,
  axis: HoleAxis,
  halfLength: number,
  holeWidth: number,
  hosts: readonly Building[],
  buildings: readonly Building[],
): number {
  const band = holeWidth / 2 + HOLE_CORRIDOR_MARGIN;
  let tallest = 0;
  for (const o of buildings) {
    if (hosts.includes(o)) continue;
    const d = wrapDelta({ x: cx, y: 0, z: cz }, { x: o.x, y: 0, z: o.z });
    const along = axis === "x" ? d.x : d.z;
    const across = axis === "x" ? d.z : d.x;
    // Tiers are centred, so test each tier's own footprint: a setback
    // tower's slim top only counts where it actually stands.
    let top = 0;
    for (const t of o.tiers) {
      const oAlong = (axis === "x" ? t.width : t.depth) / 2;
      const oAcross = (axis === "x" ? t.depth : t.width) / 2;
      const inside =
        Math.abs(across) < band + oAcross &&
        Math.abs(along) - oAlong < halfLength + HOLE_RUN_OUT;
      top += t.height;
      if (inside && top > tallest) tallest = top;
    }
  }
  return Math.max(HOLE_MIN_FLOOR, tallest + HOLE_CLEARANCE);
}

/** Ground height of tier `tierIndex`'s base, meters. */
function tierBase(b: Building, tierIndex: number): number {
  let base = 0;
  for (let i = 0; i < tierIndex; i++) base += b.tiers[i]?.height ?? 0;
  return base;
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
  const base = tierBase(host, tierIndex);
  const y0 = Math.max(
    minFloor,
    clearFloor(host.x, host.z, axis, along / 2, width, [host], buildings),
  );
  if (y0 + height + HOLE_LINTEL_MIN > base + tier.height) return null;
  if (
    nearCrane(host.x, host.z, axis, along / 2, width / 2 + HOLE_CORRIDOR_MARGIN)
  ) {
    return null;
  }
  return { kind, axis, tierIndex, offset: 0, y0, width, height };
}

/** One lot a row tunnel cuts, and the tier it cuts through. */
interface RowHost {
  b: Building;
  tier: number;
}

/** One candidate row tunnel: the lots it cuts, its line and its floor. */
interface RowFit {
  axis: HoleAxis;
  /** World across coordinate of the centreline. */
  line: number;
  y0: number;
  hosts: RowHost[];
}

/** A footprint's (along centre, along half, across centre, across half). */
const frame = (b: Building, axis: HoleAxis) =>
  axis === "x"
    ? { a: b.x, ha: b.width / 2, c: b.z, hc: b.depth / 2 }
    : { a: b.z, ha: b.depth / 2, c: b.x, hc: b.width / 2 };

/** Does tier `t` of `b` (centred) keep HOLE_WALL_MIN walls round [lo, hi]? */
function tierWalls(
  b: Building,
  t: number,
  axis: HoleAxis,
  lo: number,
  hi: number,
): boolean {
  const tier = b.tiers[t];
  if (!tier) return false;
  const c = axis === "x" ? b.z : b.x;
  const half = alongAcross(tier, axis).across / 2;
  return c - half <= lo - HOLE_WALL_MIN && c + half >= hi + HOLE_WALL_MIN;
}

/**
 * The tier of `b` a row tunnel with floor `y0` cuts: it keeps HOLE_WALL_MIN
 * walls round the band and a HOLE_LINTEL_MIN lintel, its base is at or under
 * the floor (a sill fills any gap), and — above tier 0 — the roof of the tier
 * below sits HOLE_CLEARANCE under the floor, like any roof the run passes
 * over (the setback terrace either side of the cut tier is open air). Lowest
 * such tier, or -1.
 */
function hostTier(
  b: Building,
  axis: HoleAxis,
  lo: number,
  hi: number,
  y0: number,
): number {
  let base = 0;
  for (let t = 0; t < b.tiers.length; t++) {
    const tier = b.tiers[t] as Tier;
    const top = base + tier.height;
    if (
      (t === 0 || base <= y0 - HOLE_CLEARANCE) &&
      top >= y0 + TUNNEL_HEIGHT + HOLE_LINTEL_MIN &&
      tierWalls(b, t, axis, lo, hi)
    ) {
      return t;
    }
    base = top;
  }
  return -1;
}

/**
 * Fit a TUNNEL_WIDTH × TUNNEL_HEIGHT row tunnel along `axis` at world across
 * coordinate `line` through the lots of one block. Every lot the hole band
 * crosses is either
 *   (i)   passed over — its roof sits HOLE_CLEARANCE under the floor (it is
 *         in the run-out corridor, so clearFloor already put the floor there):
 *         an open-sky slot in the run;
 *   (ii)  a host — one of its tiers keeps HOLE_WALL_MIN walls either side and
 *         a HOLE_LINTEL_MIN lintel round the hole (hostTier), and is cut;
 *   (iii) or else the whole line is rejected.
 * The run spans its hosts' cut tiers; the floor is the clear floor over the
 * whole run from its OUTER mouths. Hosts and floor depend on each other (a lot
 * passed over moves the mouths in), so they are settled by a short fixed
 * point.
 */
function fitRow(
  block: readonly Building[],
  axis: HoleAxis,
  line: number,
  buildings: readonly Building[],
): RowFit | null {
  const w = TUNNEL_WIDTH;
  const lo = line - w / 2;
  const hi = line + w / 2;
  const crossing = block.filter((b) => {
    const f = frame(b, axis);
    return f.c - f.hc < hi && f.c + f.hc > lo;
  });
  // Lots with a tier that could carry walls round the band are host
  // candidates; any other lot the band crosses must end up under the floor.
  let cand = crossing.filter(
    (b) => !b.holes && b.tiers.some((_, t) => tierWalls(b, t, axis, lo, hi)),
  );
  let y0 = 0;
  let hosts: RowHost[] = [];
  for (let pass = 0; ; pass++) {
    if (cand.length === 0 || pass === 4) return null;
    // The run's extent: each candidate's widest wall-keeping tier for now.
    let aLo = Number.POSITIVE_INFINITY;
    let aHi = Number.NEGATIVE_INFINITY;
    for (const b of cand) {
      const t = b.tiers.findIndex((_, k) => tierWalls(b, k, axis, lo, hi));
      const half = alongAcross(b.tiers[t] as Tier, axis).along / 2;
      const a = axis === "x" ? b.x : b.z;
      aLo = Math.min(aLo, a - half);
      aHi = Math.max(aHi, a + half);
    }
    const mid = (aLo + aHi) / 2;
    const cx = axis === "x" ? mid : line;
    const cz = axis === "x" ? line : mid;
    y0 = clearFloor(cx, cz, axis, (aHi - aLo) / 2, w, cand, buildings);
    // A candidate whose whole roof is under the floor is passed over.
    const next = cand.filter((b) => b.height > y0 - HOLE_CLEARANCE);
    if (next.length < cand.length) {
      cand = next;
      continue;
    }
    hosts = [];
    for (const b of cand) {
      const tier = hostTier(b, axis, lo, hi, y0);
      if (tier < 0) return null; // (iii)
      hosts.push({ b, tier });
    }
    if (
      nearCrane(cx, cz, axis, (aHi - aLo) / 2, w / 2 + HOLE_CORRIDOR_MARGIN)
    ) {
      return null;
    }
    break;
  }
  for (const b of crossing) {
    if (hosts.some((h) => h.b === b)) continue;
    if (b.height > y0 - HOLE_CLEARANCE) return null; // (iii)
  }
  return { axis, line, y0, hosts };
}

/** Meters of a fit's run that are actually cut (tunnel, not open slot). */
const cutLength = (r: RowFit) =>
  r.hosts.reduce(
    (n, h) => n + alongAcross(h.b.tiers[h.tier] as Tier, r.axis).along,
    0,
  );

/** More tunnel first, then the lower floor. */
const better = (a: RowFit, b: RowFit) => {
  const d = cutLength(a) - cutLength(b);
  return d > 1e-6 || (d > -1e-6 && a.y0 < b.y0);
};

/** The best row tunnel for one block over every candidate line (each lot's
 * across centre, and ± a quarter of its wall slack), on the axes in `order`:
 * the most tunnel actually cut, then the lowest floor. Ties keep the first,
 * so the result is order-stable. */
function bestRow(
  block: readonly Building[],
  order: readonly HoleAxis[],
  buildings: readonly Building[],
): RowFit | null {
  let best: RowFit | null = null;
  for (const axis of order) {
    for (const b of block) {
      const f = frame(b, axis);
      const slack = f.hc - TUNNEL_WIDTH / 2 - HOLE_WALL_MIN;
      if (slack < 0) continue;
      for (const k of [0, -0.25, 0.25]) {
        const fit = fitRow(block, axis, f.c + k * slack, buildings);
        if (fit && (!best || better(fit, best))) best = fit;
      }
    }
  }
  return best;
}

/**
 * The city-level pass: row tunnels, gates and sky holes, assigned in place.
 *
 * Runs after every block is built because clear air is a property of the
 * NEIGHBOURS (the ticket's "above every neighbour along the axis"), so unlike
 * lots, holes are not a pure function of their own block. Randomness still
 * comes from separately salted streams per block: `rowStreamFor` draws a
 * fixed two per block (the row tunnel's roll and axis order), `streamFor` a
 * fixed three per non-landmark building in array order, so no gate shifts
 * another building's roll and the lot streams are untouched. A block keeps
 * at most one row tunnel; a building keeps at most one hole.
 */
export function assignHoles(
  buildings: Building[],
  streamFor: (bx: number, bz: number) => () => number,
  rowStreamFor: (bx: number, bz: number) => () => number,
): void {
  // Buildings are generated block by block, so a block is a contiguous run.
  const blocks = new Map<number, Building[]>();
  for (const b of buildings) {
    const bx = Math.floor(b.x / BLOCK_PITCH);
    const bz = Math.floor(b.z / BLOCK_PITCH);
    const key = bx * (WORLD_SIZE / BLOCK_PITCH) + bz;
    let list = blocks.get(key);
    if (!list) {
      list = [];
      blocks.set(key, list);
    }
    list.push(b);
  }

  for (const [key, block] of blocks) {
    if (block.some((b) => b.height >= LANDMARK_HEIGHT || b.holes)) continue;
    const bx = Math.floor(key / (WORLD_SIZE / BLOCK_PITCH));
    const bz = key % (WORLD_SIZE / BLOCK_PITCH);
    const rowRand = rowStreamFor(bx, bz);
    const rRow = rowRand();
    const rRowAxis = rowRand();
    if (rRow < ROW_TUNNEL_CHANCE) {
      const order: HoleAxis[] = rRowAxis < 0.5 ? ["x", "z"] : ["z", "x"];
      const row = bestRow(block, order, buildings);
      if (row) {
        for (const { b, tier } of row.hosts) {
          const f = frame(b, row.axis);
          b.holes = [
            {
              kind: "tunnel",
              axis: row.axis,
              tierIndex: tier,
              offset: row.line - f.c,
              y0: row.y0,
              width: TUNNEL_WIDTH,
              height: TUNNEL_HEIGHT,
              run: key,
            },
          ];
        }
      }
    }

    const rand = streamFor(bx, bz);
    for (const b of block) {
      const rGate = rand();
      const rSky = rand();
      const rAxis = rand();
      if (b.holes) continue;
      const axes: HoleAxis[] = rAxis < 0.5 ? ["x", "z"] : ["z", "x"];
      let hole: Hole | null = null;
      if (b.height >= GATE_MIN_HEIGHT && rGate < GATE_CHANCE) {
        // The lowest tier that takes it: a big opening low in the slab.
        for (let t = 0; t < b.tiers.length && !hole; t++) {
          for (const axis of axes) {
            hole = fitHole(
              "gate",
              b,
              axis,
              t,
              GATE_WIDTH,
              GATE_HEIGHT,
              tierBase(b, t) + HOLE_SILL_MIN,
              buildings,
            );
            if (hole) break;
          }
        }
      }
      if (!hole && b.height >= SKY_HOLE_MIN_HEIGHT && rSky < SKY_HOLE_CHANCE) {
        const top = b.tiers.length - 1;
        for (const axis of axes) {
          hole = fitHole(
            "sky",
            b,
            axis,
            top,
            SKY_HOLE_WIDTH,
            SKY_HOLE_HEIGHT,
            tierBase(b, top) + HOLE_SILL_MIN,
            buildings,
          );
          if (hole) break;
        }
      }
      if (hole) b.holes = [hole];
    }
  }
}
