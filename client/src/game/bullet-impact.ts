// D1 bullet impacts — the pure classifier. A bullet's frame step (prev →
// pos) is clipped against the city by the shared firstSolidHit (the same
// solids() and slab clip losClear runs, bucketed by the CityIndex), and the
// hit is mapped to what the cosmetic layers need: which building, tier and
// facade face, the canonical hit point, and the WINDOW CELL under it in the
// exact frame the building shader paints its grid in (window-pattern.ts):
// the PARENT tier's meters — run measured from the tier's horizontal centre,
// height from the tier's base — with the per-building jittered pitch from
// the bit-exact pitchSeed of the tier's (w, h, d). Dimensions and ids,
// never translation, so the answer is the same from either side of the seam.
//
// Purely cosmetic: nothing here changes what collides (PLAN.md — combat is
// server-authoritative, and D2 owns structural damage).

import { type Building, solids } from "@angels-bandits/common/city";
import {
  type CityIndex,
  FACE_NX,
  FACE_NY,
  FACE_NZ,
  FACE_PX,
  FACE_PY,
  FACE_PZ,
  type SegmentHit,
  createSegmentHit,
  firstSolidHit,
} from "@angels-bandits/common/collision";
import {
  type Vec3,
  canonicalize,
  wrapCoord,
  wrapDeltaInto,
} from "@angels-bandits/common/world";
import { type FacadeArchetype, archetypeFor } from "../render/archetypes";
import {
  HOLE,
  ROOF,
  facadeFor,
  pitchSeed,
  windowPitch,
} from "../render/window-pattern";

/** What a round struck. Only a "facade" carries a window cell (and so can
 * take decals); the rest are particles only. */
export type ImpactSurface =
  | "facade" // an outer side face of a tier
  | "inner" // a side face inside the tier's extent: a hole's wall or lintel
  | "roof" // a solid's top
  | "underside" // a solid's bottom: a lintel or sky-hole ceiling
  | "structure"; // an R2 roof structure

/** Facade faces of a tier, by outward normal: the damage map's face index. */
export const FacadeFace = { PX: 0, NX: 1, PZ: 2, NZ: 3 } as const;
export type FacadeFace = (typeof FacadeFace)[keyof typeof FacadeFace];

/** Below this world height a tier-1 facade is the V2 shop band, not windows. */
export const SHOP_BAND_HEIGHT = 4;
/** A face this close to the tier's outer extent IS the outer face, meters. */
const OUTER_EPS = 0.02;

/** One classified impact. Caller-owned and reused (allocation-free path). */
export interface BulletImpact {
  surface: ImpactSurface;
  /** Index into the city's Building[] (generateCity order — a stable id). */
  building: number;
  /** The parent tier (for a roof structure: the top tier). */
  tier: number;
  /** FacadeFace for "facade" / "inner", else -1. */
  face: number;
  /** Canonical hit point. */
  point: Vec3;
  /** Outward unit normal of the struck face (y-up for roofs/structures). */
  normal: Vec3;
  /** Along-segment entry, 0..1 — compared against a plane's closest approach. */
  t: number;
  arch: FacadeArchetype;
  /** Window cell in the parent tier's grid (facade only): x is SIGNED (from
   * the tier centre), y counts up from the tier's base. */
  cellX: number;
  cellY: number;
  /** True when the hit is on a pane's glass (facade only). */
  pane: boolean;
}

export function createBulletImpact(): BulletImpact {
  return {
    surface: "roof",
    building: -1,
    tier: 0,
    face: -1,
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    t: 1,
    arch: 0,
    cellX: 0,
    cellY: 0,
    pane: false,
  };
}

const segHit: SegmentHit = createSegmentHit();
const stepD: Vec3 = { x: 0, y: 0, z: 0 };
const centre: Vec3 = { x: 0, y: 0, z: 0 };
const local: Vec3 = { x: 0, y: 0, z: 0 };

/** The ground height of tier `k`'s base. */
export function tierBase(b: Building, k: number): number {
  let base = 0;
  for (let i = 0; i < k; i++) base += b.tiers[i]?.height ?? 0;
  return base;
}

/** The window grid of one tier, exactly as the shader derives it. */
export function tierPitch(b: Building, tier: number): [number, number] {
  const t = b.tiers[tier];
  if (!t) return [1, 1];
  return windowPitch(archetypeFor(b), pitchSeed(t.width, t.height, t.depth));
}

/**
 * Facade-local (run, height) meters → cell + pane test, mirroring the
 * shader's winCell, pane box, winRow roof band, shop band and the H1 hole
 * reveal. `run` is measured from the tier centre along the face, `h` from
 * the tier base. Writes cellX/cellY/pane into `out`.
 */
export function classifyFacadeCell(
  b: Building,
  tier: number,
  face: number,
  run: number,
  h: number,
  out: BulletImpact,
): void {
  const t = b.tiers[tier];
  const [px, py] = tierPitch(b, tier);
  const gx = run / px;
  const gy = h / py;
  out.cellX = Math.floor(gx);
  out.cellY = Math.floor(gy);
  if (!t) {
    out.pane = false;
    return;
  }
  const pane = facadeFor(archetypeFor(b)).pane;
  const fx = gx - Math.floor(gx);
  const fy = gy - Math.floor(gy);
  let onPane =
    Math.abs(fx - 0.5) <= pane[0] * 0.5 && Math.abs(fy - 0.5) <= pane[1] * 0.5;
  // R2: the band under every roof edge is blank spandrel.
  if ((out.cellY + 1) * py > t.height - ROOF.windowBand) onPane = false;
  // V2 storefront glass at street level (tier 1 only) is not the grid.
  const base = tierBase(b, tier);
  if (base + h < SHOP_BAND_HEIGHT) onPane = false;
  // H1: no windows inside a hole's reveal on its mouth faces.
  const hole = b.holes?.find((x) => x.tierIndex === tier);
  if (hole) {
    const alongX = hole.axis === "x";
    const mouth = alongX
      ? face === FacadeFace.PX || face === FacadeFace.NX
      : face === FacadeFace.PZ || face === FacadeFace.NZ;
    if (mouth) {
      const qx = Math.abs(run - hole.offset) - hole.width / 2;
      const y0 = hole.y0 - base;
      const qy = Math.abs(h - y0 - 0.5 * hole.height) - 0.5 * hole.height;
      if (Math.max(qx, qy) <= HOLE.reveal) onPane = false;
    }
  }
  out.pane = onPane;
}

/**
 * Classify a bullet's step `prev → cur` against the city. Returns false when
 * it enters no solid this step (or starts inside one); otherwise fills `out`.
 */
export function classifyBulletStep(
  prev: Vec3,
  cur: Vec3,
  buildings: readonly Building[],
  index: CityIndex,
  out: BulletImpact,
): boolean {
  if (!firstSolidHit(prev, cur, buildings, index, segHit)) return false;
  const b = buildings[segHit.building] as Building;
  const d = wrapDeltaInto(prev, cur, stepD);
  const t = segHit.t;
  out.t = t;
  out.building = segHit.building;
  out.arch = archetypeFor(b);
  out.point.x = prev.x + d.x * t;
  out.point.y = prev.y + d.y * t;
  out.point.z = prev.z + d.z * t;
  out.point.x = wrapCoord(out.point.x);
  out.point.z = wrapCoord(out.point.z);
  out.face = -1;
  out.cellX = 0;
  out.cellY = 0;
  out.pane = false;
  out.normal.x = 0;
  out.normal.y = 1;
  out.normal.z = 0;
  if (segHit.structure >= 0) {
    out.surface = "structure";
    out.tier = b.tiers.length - 1;
    return true;
  }
  const box = solids(b)[segHit.solid];
  if (!box) return false;
  out.tier = box.tierIndex;
  if (segHit.face === FACE_PY) {
    out.surface = "roof";
    return true;
  }
  if (segHit.face === FACE_NY) {
    out.surface = "underside";
    out.normal.y = -1;
    return true;
  }
  const tier = b.tiers[box.tierIndex];
  if (!tier) return false;
  // The hit point in the building frame (tiers are centred on (x, z)).
  centre.x = b.x;
  centre.z = b.z;
  const o = wrapDeltaInto(centre, out.point, local);
  const h = out.point.y - tierBase(b, box.tierIndex);
  let face: number;
  let outer: boolean;
  let run: number;
  out.normal.y = 0;
  if (segHit.face === FACE_PX || segHit.face === FACE_NX) {
    const plus = segHit.face === FACE_PX;
    face = plus ? FacadeFace.PX : FacadeFace.NX;
    out.normal.x = plus ? 1 : -1;
    const plane = box.dx + (plus ? box.width / 2 : -box.width / 2);
    outer = Math.abs(Math.abs(plane) - tier.width / 2) <= OUTER_EPS;
    run = o.z;
  } else if (segHit.face === FACE_PZ || segHit.face === FACE_NZ) {
    const plus = segHit.face === FACE_PZ;
    face = plus ? FacadeFace.PZ : FacadeFace.NZ;
    out.normal.z = plus ? 1 : -1;
    const plane = box.dz + (plus ? box.depth / 2 : -box.depth / 2);
    outer = Math.abs(Math.abs(plane) - tier.depth / 2) <= OUTER_EPS;
    run = o.x;
  } else {
    return false;
  }
  out.face = face;
  if (!outer) {
    out.surface = "inner";
    return true;
  }
  out.surface = "facade";
  classifyFacadeCell(b, box.tierIndex, face, run, h, out);
  return true;
}

/**
 * The canonical centre of window cell (cellX, cellY) on a tier's facade
 * face, nudged `out` meters off the wall along its normal — the inverse of
 * the classifier's mapping (QA aims rounds with it; blasts place shards).
 */
export function facadeCellCentre(
  b: Building,
  tier: number,
  face: number,
  cellX: number,
  cellY: number,
  nudge = 0,
): Vec3 {
  const t = b.tiers[tier];
  const [px, py] = tierPitch(b, tier);
  const run = (cellX + 0.5) * px;
  const y = tierBase(b, tier) + (cellY + 0.5) * py;
  const hw = (t?.width ?? 0) / 2;
  const hd = (t?.depth ?? 0) / 2;
  let x = b.x;
  let z = b.z;
  if (face === FacadeFace.PX || face === FacadeFace.NX) {
    const s = face === FacadeFace.PX ? 1 : -1;
    x += s * (hw + nudge);
    z += run;
  } else {
    const s = face === FacadeFace.PZ ? 1 : -1;
    z += s * (hd + nudge);
    x += run;
  }
  return canonicalize({ x, y, z });
}

const caRel: Vec3 = { x: 0, y: 0, z: 0 };
const caSeg: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Where along the step `prev → cur` (0..1) a round passes closest to
 * `center` — the plane-vs-wall order: a wall entered before this point was
 * struck first. Torus-aware like bulletHitsSphere.
 */
export function closestApproachT(prev: Vec3, cur: Vec3, center: Vec3): number {
  const rel = wrapDeltaInto(prev, center, caRel);
  const seg = wrapDeltaInto(prev, cur, caSeg);
  const len2 = seg.x * seg.x + seg.y * seg.y + seg.z * seg.z;
  if (len2 === 0) return 0;
  const dot = rel.x * seg.x + rel.y * seg.y + rel.z * seg.z;
  return Math.min(1, Math.max(0, dot / len2));
}
