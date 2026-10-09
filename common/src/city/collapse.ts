// D3 collapses — when a building loses what holds it up, the section above
// comes down, shared verbatim by client and server.
//
// Two halves, the movers idiom applied to destruction:
//
//   1. PLANNING (server only, from the live damage): `planCollapses` runs
//      the support test over D2's chunk graph and says which chunks fall,
//      and how. The server turns each plan into a CollapseWire — the event —
//      marks its chunks fallen in its CityDamage and broadcasts the wire.
//   2. DEBRIS (both sides, from the wire alone): `buildCollapse` turns one
//      wire plus the city's GENERATED geometry into pieces whose every pose
//      is a pure function of (wire, server time) — `piecePose`. Nothing about
//      a falling chunk is ever streamed; a late joiner rebuilds the same
//      debris from the same records. Collision (`collideCollapses`) and the
//      renderer both pose through `piecePose`, so what you see falling is
//      exactly what kills you (draw == collide).
//
// Support rule (exact): per tier and floor band, bottom-up,
//   V(c) = standing ∧ (ground ∨ some D2 `on` link to a chunk with S)
//          — a lintel's `on` links run sideways inside its band; those are
//          iterated to a fixed point over V;
//   S(c) = V(c) ∨ (standing ∧ a same-band 4-neighbour with V).
// D2's graph alone is column-only (one shot-out chunk would drop the whole
// column above it); the one-step brace lets a wall span a single hole. On top
// of that, a band with fewer than COLLAPSE_BAND_MIN of its chunks standing
// fails outright and takes everything above it down. Anything standing but
// not S also falls, so no chunk is ever left floating.
//
// Styles: no survivors (or survivors centred) under the section → PANCAKE,
// the floors drop straight down in a cascade and crush the column under them
// to the ground; survivors off to one side → TOPPLE, the section tips over
// its base edge toward the missing side (snapped to ±x/±z: streets run
// along the axes), breaks up mid-fall and scatters across the street. Every
// piece ends as a flat rubble box resting on the ground or on the rubble
// under it — never on something that could later be shot away.

import {
  CHAIN_COALESCE_M,
  CHAIN_IMPACTS_MAX,
  CHAIN_IMPACTS_PER_BUILDING,
  CHUNK_FLOOR,
  COLLAPSE_BAND_MIN,
  COLLAPSE_BAND_STAGGER_MS,
  COLLAPSE_GRAVITY,
  COLLAPSE_LEAD_MS,
  COLLAPSE_PANCAKE_TILT,
  COLLAPSE_RUBBLE_RATIO,
  COLLAPSE_SQUASH_MS,
  COLLAPSE_SYMMETRY,
  COLLAPSE_TOPPLE_ALPHA_MAX,
  COLLAPSE_TOPPLE_ALPHA_MIN,
  COLLAPSE_TOPPLE_BREAK,
  COLLAPSE_TOPPLE_K,
  COLLAPSE_ZONE_TAIL_MS,
  CRANE_MAST_SIDE,
} from "../constants";
import { type Vec3, canonicalize, wrapDeltaAxis } from "../world/index";
import {
  type LocalBox,
  type TierGrid,
  cellBox,
  cellIndex,
  cellSolids,
  chunkAt,
  chunkBuilding,
  chunkCell,
  chunkId,
  chunkMask,
  chunkTier,
  decodeChunkIds,
  encodeChunkIds,
  supportGraph,
  tierGrids,
} from "./destruction";
import type { Building } from "./index";
// movers.ts ↔ collapse.ts is a module cycle (collideMovers reads the field;
// a crane fall reads the crane's boxes). Every use is at call time.
import { type CraneSite, craneBoxesAt, slewAngle } from "./movers";
import { mulberry32 } from "./rng";

export const PANCAKE = 0;
export const TOPPLE = 1;
export type CollapseStyle = typeof PANCAKE | typeof TOPPLE;

/** What came down (CollapseWire.k): a building section, or (D5) a tower
 * crane. A crane wire's `b` is the crane SITE id — a separate namespace from
 * building indices, so every consumer that reads `buildings[c.building]`
 * filters on the kind first. */
export const KIND_BUILDING = 0;
export const KIND_CRANE = 1;

/** Topple directions, D2's face order: −x, +x, −z, +z. */
export const DIR_NEG_X = 0;
export const DIR_POS_X = 1;
export const DIR_NEG_Z = 2;
export const DIR_POS_Z = 3;

/**
 * One collapse event on the wire — and the ONLY input its debris is built
 * from. Changing what `buildCollapse` derives from it is a protocol break,
 * exactly like generateCity.
 */
export interface CollapseWire {
  /** Per-room sequence number. */
  id: number;
  /** Building index (the chunk id prefix). */
  b: number;
  /** Server snapshot clock of the event, ms. */
  t: number;
  /** PANCAKE or TOPPLE. */
  s: number;
  /** Topple direction (DIR_*); 0 for a pancake. */
  d: number;
  /** The chunks that fall, encodeChunkIds ([] for a crane). */
  c: number[];
  /** D5: KIND_CRANE for a falling tower crane (b = its site id); absent for
   * a building section, so D3 records are unchanged on the wire. */
  k?: number;
}

/** A wire's kind (absent = a building section). */
export const wireKind = (w: CollapseWire): number =>
  w.k === KIND_CRANE ? KIND_CRANE : KIND_BUILDING;

/** What planCollapses decided for one event. */
export interface CollapsePlan {
  style: CollapseStyle;
  dir: number;
  /** Ascending chunk ids. */
  chunks: number[];
}

// --- Support -----------------------------------------------------------------

interface Links {
  /** Per tier, per cell: 1 when the cell stands on the ground. */
  ground: Uint8Array[];
  /** Per tier, per cell: flattened (tier, cell) pairs it rests on. */
  on: (readonly number[])[][];
}

const NO_LINKS: readonly number[] = [];
const linkCache = new WeakMap<Building, Links>();

/** D2's support graph as per-tier arrays (cached; pure in the shape). */
function linksOf(b: Building): Links {
  let links = linkCache.get(b);
  if (!links) {
    const grids = tierGrids(b);
    const ground = grids.map((g) => new Uint8Array(g.nx * g.ny * g.nz));
    const on = grids.map((g) =>
      new Array<readonly number[]>(g.nx * g.ny * g.nz).fill(NO_LINKS),
    );
    // Index 0: only the (tier, cell) halves of the ids are read here.
    for (const s of supportGraph(b, 0)) {
      const k = chunkTier(s.id);
      const c = chunkCell(s.id);
      (ground[k] as Uint8Array)[c] = s.ground ? 1 : 0;
      (on[k] as (readonly number[])[])[c] = s.on.flatMap((id) => [
        chunkTier(id),
        chunkCell(id),
      ]);
    }
    links = { ground, on };
    linkCache.set(b, links);
  }
  return links;
}

/** Per tier: 1 where a chunk still stands (exists and is not gone). */
export function standingOf(b: Building): Uint8Array[] {
  const cells = b.damage?.cells;
  return chunkMask(b).map((mask, k) => {
    const gone = cells?.[k];
    const out = new Uint8Array(mask.length);
    for (let c = 0; c < mask.length; c++) {
      out[c] = mask[c] && !gone?.[c] ? 1 : 0;
    }
    return out;
  });
}

/** Per tier: 1 where a standing chunk is supported (S in the header). */
export function supportedOf(
  b: Building,
  standing: readonly Uint8Array[],
): Uint8Array[] {
  const grids = tierGrids(b);
  const { ground, on } = linksOf(b);
  const V = grids.map((g) => new Uint8Array(g.nx * g.ny * g.nz));
  const S = grids.map((g) => new Uint8Array(g.nx * g.ny * g.nz));
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k] as TierGrid;
    const st = standing[k] as Uint8Array;
    const v = V[k] as Uint8Array;
    const s = S[k] as Uint8Array;
    const gk = ground[k] as Uint8Array;
    const ok = on[k] as (readonly number[])[];
    const bandSize = g.nx * g.nz;
    for (let iy = 0; iy < g.ny; iy++) {
      const from = iy * bandSize;
      const to = from + bandSize;
      const sameBand = (lt: number, lc: number) =>
        lt === k && lc >= from && lc < to;
      for (let c = from; c < to; c++) {
        if (!st[c]) continue;
        if (gk[c]) {
          v[c] = 1;
          continue;
        }
        const links = ok[c] as readonly number[];
        for (let j = 0; j < links.length; j += 2) {
          const lt = links[j] as number;
          const lc = links[j + 1] as number;
          if (sameBand(lt, lc)) continue;
          if ((S[lt] as Uint8Array)[lc]) {
            v[c] = 1;
            break;
          }
        }
      }
      // Lintels: carried sideways by walls in their own band.
      let changed = true;
      while (changed) {
        changed = false;
        for (let c = from; c < to; c++) {
          if (!st[c] || v[c]) continue;
          const links = ok[c] as readonly number[];
          for (let j = 0; j < links.length; j += 2) {
            const lt = links[j] as number;
            const lc = links[j + 1] as number;
            if (sameBand(lt, lc) && v[lc]) {
              v[c] = 1;
              changed = true;
              break;
            }
          }
        }
      }
      // The one-step brace.
      for (let c = from; c < to; c++) {
        if (!st[c]) continue;
        if (v[c]) {
          s[c] = 1;
          continue;
        }
        const ix = (c - from) % g.nx;
        const iz = Math.floor((c - from) / g.nx);
        if (
          (ix > 0 && v[c - 1]) ||
          (ix < g.nx - 1 && v[c + 1]) ||
          (iz > 0 && v[c - g.nx]) ||
          (iz < g.nz - 1 && v[c + g.nx])
        ) {
          s[c] = 1;
        }
      }
    }
  }
  return S;
}

/** Standing chunks that nothing holds up, as (tier, cell) pairs. */
function unsupported(b: Building, standing: readonly Uint8Array[]): number[] {
  const S = supportedOf(b, standing);
  const out: number[] = [];
  standing.forEach((st, k) => {
    const s = S[k] as Uint8Array;
    for (let c = 0; c < st.length; c++) if (st[c] && !s[c]) out.push(k, c);
  });
  return out;
}

/** The lowest band under COLLAPSE_BAND_MIN with anything standing above. */
function failingBand(
  grids: readonly TierGrid[],
  masks: readonly Uint8Array[],
  standing: readonly Uint8Array[],
): { tier: number; band: number } | null {
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k] as TierGrid;
    const mask = masks[k] as Uint8Array;
    const st = standing[k] as Uint8Array;
    const bandSize = g.nx * g.nz;
    for (let iy = 0; iy < g.ny; iy++) {
      let exist = 0;
      let up = 0;
      for (let c = iy * bandSize; c < (iy + 1) * bandSize; c++) {
        exist += mask[c] as number;
        up += st[c] as number;
      }
      if (exist === 0 || up >= COLLAPSE_BAND_MIN * exist) continue;
      if (anyStandingAbove(grids, standing, k, iy))
        return { tier: k, band: iy };
    }
  }
  return null;
}

function anyStandingAbove(
  grids: readonly TierGrid[],
  standing: readonly Uint8Array[],
  tier: number,
  band: number,
): boolean {
  const g = grids[tier] as TierGrid;
  const st = standing[tier] as Uint8Array;
  for (let c = (band + 1) * g.nx * g.nz; c < st.length; c++) {
    if (st[c]) return true;
  }
  for (let k = tier + 1; k < standing.length; k++) {
    if ((standing[k] as Uint8Array).includes(1)) return true;
  }
  return false;
}

/** Pancake or topple (and which way) from the failed band's survivors. */
function styleOf(
  g: TierGrid,
  mask: Uint8Array,
  st: Uint8Array,
  band: number,
): { style: CollapseStyle; dir: number } {
  const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  let ax = 0;
  let az = 0;
  let an = 0;
  let sx = 0;
  let sz = 0;
  let sn = 0;
  const bandSize = g.nx * g.nz;
  for (let c = band * bandSize; c < (band + 1) * bandSize; c++) {
    if (!mask[c]) continue;
    cellBox(g, c, box);
    const cx = (box.x0 + box.x1) / 2;
    const cz = (box.z0 + box.z1) / 2;
    ax += cx;
    az += cz;
    an++;
    if (st[c]) {
      sx += cx;
      sz += cz;
      sn++;
    }
  }
  if (sn === 0) return { style: PANCAKE, dir: 0 };
  // From the survivors toward what is missing: the weak side.
  const ox = (ax / an - sx / sn) / g.width;
  const oz = (az / an - sz / sn) / g.depth;
  if (Math.max(Math.abs(ox), Math.abs(oz)) < COLLAPSE_SYMMETRY) {
    return { style: PANCAKE, dir: 0 };
  }
  if (Math.abs(ox) >= Math.abs(oz)) {
    return { style: TOPPLE, dir: ox > 0 ? DIR_POS_X : DIR_NEG_X };
  }
  return { style: TOPPLE, dir: oz > 0 ? DIR_POS_Z : DIR_NEG_Z };
}

/** Standing chunks under `set` (plan overlap, top at or below the set
 * chunk's base): what a pancake crushes on its way to the ground. */
function crushedUnder(
  grids: readonly TierGrid[],
  standing: readonly Uint8Array[],
  set: readonly number[],
): number[] {
  // One footprint per (tier, column), at its lowest base.
  const feet = new Map<number, LocalBox>();
  const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  for (let j = 0; j < set.length; j += 2) {
    const k = set[j] as number;
    const c = set[j + 1] as number;
    const g = grids[k] as TierGrid;
    cellBox(g, c, box);
    const key = k * 1e6 + (c % (g.nx * g.nz));
    const f = feet.get(key);
    if (!f) feet.set(key, { ...box });
    else f.y0 = Math.min(f.y0, box.y0);
  }
  const inSet = new Set<number>();
  for (let j = 0; j < set.length; j += 2) {
    inSet.add((set[j] as number) * 1e6 + (set[j + 1] as number));
  }
  const out: number[] = [];
  standing.forEach((st, k) => {
    const g = grids[k] as TierGrid;
    for (let c = 0; c < st.length; c++) {
      if (!st[c] || inSet.has(k * 1e6 + c)) continue;
      cellBox(g, c, box);
      for (const f of feet.values()) {
        if (
          box.y1 <= f.y0 + 1e-6 &&
          Math.min(box.x1, f.x1) - Math.max(box.x0, f.x0) > 1e-6 &&
          Math.min(box.z1, f.z1) - Math.max(box.z0, f.z0) > 1e-6
        ) {
          out.push(k, c);
          break;
        }
      }
    }
  });
  return out;
}

/** The next collapse in `standing`, or null when everything is held up. */
function nextPlan(
  b: Building,
  index: number,
  standing: readonly Uint8Array[],
): CollapsePlan | null {
  const grids = tierGrids(b);
  const masks = chunkMask(b);
  const fail = failingBand(grids, masks, standing);
  let set: number[] = [];
  let style: CollapseStyle = PANCAKE;
  let dir = 0;
  if (fail) {
    standing.forEach((st, k) => {
      if (k < fail.tier) return;
      const g = grids[k] as TierGrid;
      const first = k === fail.tier ? (fail.band + 1) * g.nx * g.nz : 0;
      for (let c = first; c < st.length; c++) if (st[c]) set.push(k, c);
    });
    const g = grids[fail.tier] as TierGrid;
    ({ style, dir } = styleOf(
      g,
      masks[fail.tier] as Uint8Array,
      standing[fail.tier] as Uint8Array,
      fail.band,
    ));
  } else {
    set = unsupported(b, standing);
    if (set.length === 0) return null;
  }
  if (style === PANCAKE) set = set.concat(crushedUnder(grids, standing, set));
  const chunks: number[] = [];
  for (let j = 0; j < set.length; j += 2) {
    chunks.push(chunkId(index, set[j] as number, set[j + 1] as number));
  }
  chunks.sort((x, y) => x - y);
  return { style, dir, chunks };
}

/**
 * Every collapse building `index` (= `b`) owes in its current damage state,
 * in order: each plan is applied before the next is looked for (a pancake's
 * crush can fail a lower band, or leave a ledge unsupported). Afterwards no
 * standing chunk is unsupported. Pure in (shape, damage).
 */
export function planCollapses(b: Building, index: number): CollapsePlan[] {
  const standing = standingOf(b);
  const plans: CollapsePlan[] = [];
  // Each plan removes at least one chunk, so this ends; the bound is a
  // backstop against a bug, never a limit on a real building.
  for (let guard = 0; guard < 256; guard++) {
    const plan = nextPlan(b, index, standing);
    if (!plan) break;
    for (const id of plan.chunks) {
      (standing[chunkTier(id)] as Uint8Array)[chunkCell(id)] = 0;
    }
    plans.push(plan);
  }
  return plans;
}

/**
 * D5 demolition: a charge line under tier 0's second floor band. Every
 * standing chunk above tier 0's bottom band (and every upper tier) falls as
 * ONE event — TOPPLE in `dir`, or a PANCAKE that also crushes what stands
 * under it. What stays is a supported stump, so nothing is left floating.
 * Null when nothing above the bottom band still stands. Pure in (shape,
 * damage).
 */
export function demolitionPlan(
  b: Building,
  index: number,
  style: CollapseStyle,
  dir: number,
): CollapsePlan | null {
  const grids = tierGrids(b);
  const standing = standingOf(b);
  let set: number[] = [];
  standing.forEach((st, k) => {
    const g = grids[k] as TierGrid;
    const first = k === 0 ? g.nx * g.nz : 0;
    for (let c = first; c < st.length; c++) if (st[c]) set.push(k, c);
  });
  if (set.length === 0) return null;
  if (style === PANCAKE) set = set.concat(crushedUnder(grids, standing, set));
  const chunks: number[] = [];
  for (let j = 0; j < set.length; j += 2) {
    chunks.push(chunkId(index, set[j] as number, set[j + 1] as number));
  }
  chunks.sort((x, y) => x - y);
  return { style, dir: style === TOPPLE ? dir : 0, chunks };
}

/** A plan as the wire event `id` at server time `t`. */
export function collapseWire(
  plan: CollapsePlan,
  building: number,
  id: number,
  t: number,
): CollapseWire {
  return {
    id,
    b: building,
    t,
    s: plan.style,
    d: plan.style === TOPPLE ? plan.dir : 0,
    c: encodeChunkIds(plan.chunks),
  };
}

// --- Debris ----------------------------------------------------------------

/**
 * One collapse's debris, derived once from its wire. Positions are relative
 * to the building's centre (`x`, `z`, canonical); y is altitude. Per-piece
 * arrays are indexed by piece. Pieces rotate only about the x or z axis
 * (`axis` 0 / 1), so every rest box is axis-aligned.
 */
export interface Collapse {
  readonly id: number;
  /** KIND_BUILDING or KIND_CRANE. */
  readonly kind: number;
  /** Building index — or, for KIND_CRANE, the crane's site id. */
  readonly building: number;
  /** Event time, ms (server clock). */
  readonly t0: number;
  readonly style: CollapseStyle;
  readonly dir: number;
  /** The building's centre, canonical. */
  readonly x: number;
  readonly z: number;
  /** The chunks that fell (ascending). */
  readonly chunks: readonly number[];
  /** Pieces. */
  readonly n: number;
  readonly chunk: Int32Array;
  readonly tier: Uint8Array;
  /** D2 CUT_* faces of the piece as it stood (renderer shading). */
  readonly cut: Uint8Array;
  /** Standing pose: centre and half extents. */
  readonly ox: Float64Array;
  readonly oy: Float64Array;
  readonly oz: Float64Array;
  readonly hx: Float64Array;
  readonly hy: Float64Array;
  readonly hz: Float64Array;
  /** Seconds after t0 at which the piece starts to move. */
  readonly start: Float64Array;
  /** Rotation axis (0 = x, 1 = z). */
  readonly axis: Uint8Array;
  /** Pancake: the tilt a piece leans toward, rad (signed). */
  readonly tilt: Float64Array;
  /** Topple: pivot (on the base edge), sign of the rotation about `axis`,
   * angular acceleration, break-up time (s after start) and spin rate. */
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  readonly sign: number;
  readonly alpha: number;
  readonly tBreak: number;
  readonly omega: number;
  /** Topple: centre and velocity at break-up. */
  readonly bx: Float64Array;
  readonly by: Float64Array;
  readonly bz: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  /** Landing: seconds after start, centre and angle there. */
  readonly land: Float64Array;
  readonly lx: Float64Array;
  readonly ly: Float64Array;
  readonly lz: Float64Array;
  readonly lphi: Float64Array;
  /** Rest: centre, local half extents, angle (a multiple of π/2). */
  readonly rx: Float64Array;
  readonly ry: Float64Array;
  readonly rz: Float64Array;
  readonly rhx: Float64Array;
  readonly rhy: Float64Array;
  readonly rhz: Float64Array;
  readonly rphi: Float64Array;
  /** Rest box as a world-axis AABB's half extents. */
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  readonly az: Float64Array;
  /** Ms after t0 when the last piece is at rest. */
  readonly endMs: number;
  /** Everything the debris ever covers (centre-relative), and its rest
   * boxes, for the per-event reject. */
  readonly bounds: LocalBox;
  readonly restBounds: LocalBox;
}

/** One piece's pose. x/z relative to the collapse's building centre. */
export interface PiecePose {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  axis: number;
  phi: number;
  /** Fully at rest (a static rubble box). */
  rest: boolean;
}

export const blankPose = (): PiecePose => ({
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  axis: 0,
  phi: 0,
  rest: false,
});

const G = COLLAPSE_GRAVITY;
const SQUASH_S = COLLAPSE_SQUASH_MS / 1000;
const HALF_PI = Math.PI / 2;

/** Half extent along world y of a box rotated by `phi` about x (0) / z (1). */
function vertExtent(
  axis: number,
  phi: number,
  hx: number,
  hy: number,
  hz: number,
): number {
  const c = Math.abs(Math.cos(phi));
  const s = Math.abs(Math.sin(phi));
  return axis === 0 ? c * hy + s * hz : s * hx + c * hy;
}

/** Rotate (x, y, z) by `phi` about x (0) / z (1), into `out`. */
function rotate(
  axis: number,
  phi: number,
  x: number,
  y: number,
  z: number,
  out: Vec3,
): Vec3 {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  if (axis === 0) {
    out.x = x;
    out.y = y * c - z * s;
    out.z = y * s + z * c;
  } else {
    out.x = x * c - y * s;
    out.y = x * s + y * c;
    out.z = z;
  }
  return out;
}

const rot: Vec3 = { x: 0, y: 0, z: 0 };

/** Mutable working copy of a Collapse while it is being built. */
type Draft = { -readonly [K in keyof Collapse]: Collapse[K] };

/** flight()'s time argument. D6: a double handed to a call V8 does not
 * inline (flight is too big to) is boxed — one HeapNumber per falling piece
 * per frame — so it travels in this object instead (O5's rule). */
const flightAt = { tau: 0 };

/** The in-flight pose (before landing) of piece `i` at `flightAt.tau` s
 * after its start. Writes centre + angle; half extents are the standing
 * ones. */
function flight(c: Collapse, i: number, out: PiecePose): void {
  const tau = flightAt.tau;
  if (c.style === PANCAKE) {
    out.x = c.ox[i] as number;
    out.y = (c.oy[i] as number) - 0.5 * G * tau * tau;
    out.z = c.oz[i] as number;
    out.phi = ((c.tilt[i] as number) * tau) / (tau + 1.5);
    return;
  }
  if (tau < c.tBreak) {
    const theta = 0.5 * c.alpha * tau * tau;
    const phi = c.sign * theta;
    rotate(
      c.axis[i] as number,
      phi,
      (c.ox[i] as number) - c.px,
      (c.oy[i] as number) - c.py,
      (c.oz[i] as number) - c.pz,
      rot,
    );
    out.x = c.px + rot.x;
    out.y = c.py + rot.y;
    out.z = c.pz + rot.z;
    out.phi = phi;
    return;
  }
  const dt = tau - c.tBreak;
  out.x = (c.bx[i] as number) + (c.vx[i] as number) * dt;
  out.y = (c.by[i] as number) + (c.vy[i] as number) * dt - 0.5 * G * dt * dt;
  out.z = (c.bz[i] as number) + (c.vz[i] as number) * dt;
  out.phi = c.sign * (COLLAPSE_TOPPLE_BREAK + c.omega * dt);
}

/**
 * Piece `i` of `c` at server time `tMs` (ms), into `out`. Closed-form and
 * allocation-free: standing until its start (and for any time before the
 * event — a client's render clock trails the message), falling, squashing
 * into its rubble slab, then at rest for good. `tMs = Infinity` is the
 * rest state (a client with no clock yet draws and collides with that).
 */
export function piecePose(
  c: Collapse,
  i: number,
  tMs: number,
  out: PiecePose,
): PiecePose {
  const tau = (tMs - c.t0) / 1000 - (c.start[i] as number);
  const land = c.land[i] as number;
  out.axis = c.axis[i] as number;
  if (!(tau > 0)) {
    out.x = c.ox[i] as number;
    out.y = c.oy[i] as number;
    out.z = c.oz[i] as number;
    out.hx = c.hx[i] as number;
    out.hy = c.hy[i] as number;
    out.hz = c.hz[i] as number;
    out.phi = 0;
    out.rest = false;
    return out;
  }
  if (tau >= land + SQUASH_S) {
    out.x = c.rx[i] as number;
    out.y = c.ry[i] as number;
    out.z = c.rz[i] as number;
    out.hx = c.rhx[i] as number;
    out.hy = c.rhy[i] as number;
    out.hz = c.rhz[i] as number;
    out.phi = c.rphi[i] as number;
    out.rest = true;
    return out;
  }
  out.rest = false;
  if (tau < land) {
    flightAt.tau = tau;
    flight(c, i, out);
    out.hx = c.hx[i] as number;
    out.hy = c.hy[i] as number;
    out.hz = c.hz[i] as number;
    return out;
  }
  const u = (tau - land) / SQUASH_S;
  const k = u * u * (3 - 2 * u);
  // D6: the lerp written out — a closure here was an allocation per
  // squashing piece per frame, and a helper call (not inlined this deep)
  // boxed each result.
  const lx = c.lx[i] as number;
  const ly = c.ly[i] as number;
  const lz = c.lz[i] as number;
  const hx = c.hx[i] as number;
  const hy = c.hy[i] as number;
  const hz = c.hz[i] as number;
  const lphi = c.lphi[i] as number;
  out.x = lx + ((c.rx[i] as number) - lx) * k;
  out.y = ly + ((c.ry[i] as number) - ly) * k;
  out.z = lz + ((c.rz[i] as number) - lz) * k;
  out.hx = hx + ((c.rhx[i] as number) - hx) * k;
  out.hy = hy + ((c.rhy[i] as number) - hy) * k;
  out.hz = hz + ((c.rhz[i] as number) - hz) * k;
  out.phi = lphi + ((c.rphi[i] as number) - lphi) * k;
  return out;
}

/** First tau ≥ 0 at which piece `i`'s lowest point reaches `floor`. */
function landingTime(c: Collapse, i: number, floor: number): number {
  const pose = blankPose();
  const hx = c.hx[i] as number;
  const hy = c.hy[i] as number;
  const hz = c.hz[i] as number;
  const axis = c.axis[i] as number;
  const gap = (tau: number) => {
    flightAt.tau = tau;
    flight(c, i, pose);
    return pose.y - vertExtent(axis, pose.phi, hx, hy, hz) - floor;
  };
  if (gap(0) <= 0) return 0;
  const step = 0.02;
  let lo = 0;
  let hi = step;
  // Free fall from the tallest tower lands in well under 10 s.
  while (gap(hi) > 0 && hi < 60) {
    lo = hi;
    hi += step;
  }
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (gap(mid) > 0) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Per-event deterministic stream: the event id and the chunk, never a
 * position. */
const pieceRand = (id: number, chunk: number) =>
  mulberry32((Math.imul(id + 1, 0x9e3779b1) ^ chunk) >>> 0);

/**
 * The debris of one collapse — a pure function of the wire and the city's
 * generated shape (never its live damage), so the server, every live client
 * and every late joiner build the same pieces bit for bit. Null when the
 * wire names no real chunk of a real building.
 */
export function buildCollapse(
  buildings: readonly Building[],
  wire: CollapseWire,
): Collapse | null {
  // A crane wire names a crane site, not a building: CollapseField routes it
  // to buildCraneCollapse.
  if (wireKind(wire) !== KIND_BUILDING) return null;
  const b = buildings[wire.b];
  if (!b || !Number.isFinite(wire.t)) return null;
  const masks = chunkMask(b);
  const chunks = decodeChunkIds(wire.c).filter(
    (id) =>
      chunkBuilding(id) === wire.b &&
      masks[chunkTier(id)]?.[chunkCell(id)] === 1,
  );
  if (chunks.length === 0) return null;
  const style: CollapseStyle = wire.s === TOPPLE ? TOPPLE : PANCAKE;
  const dir = style === TOPPLE ? Math.min(3, Math.max(0, wire.d | 0)) : 0;

  // Pieces: each chunk's generated solid volume.
  const raw: RawPiece[] = [];
  for (const id of chunks) {
    for (const s of cellSolids(b, chunkTier(id), chunkCell(id))) {
      raw.push({
        chunk: id,
        tier: s.tierIndex,
        cut: s.cut,
        x: s.dx,
        y: s.baseY + s.height / 2,
        z: s.dz,
        hx: s.width / 2,
        hy: s.height / 2,
        hz: s.depth / 2,
      });
    }
  }
  return assembleCollapse(
    raw,
    {
      id: wire.id,
      kind: KIND_BUILDING,
      building: wire.b,
      t0: wire.t,
      style,
      dir,
      x: b.x,
      z: b.z,
      chunks,
    },
    null,
  );
}

/** One piece as it stood: the chunk it came from, its tier and exposed
 * faces, centre (relative to the collapse's centre) and half extents. */
interface RawPiece {
  chunk: number;
  tier: number;
  cut: number;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
}

/** What a Collapse is besides its pieces. */
interface CollapseMeta {
  id: number;
  kind: number;
  building: number;
  t0: number;
  style: CollapseStyle;
  dir: number;
  x: number;
  z: number;
  chunks: readonly number[];
}

/**
 * Trajectories, landings, rest boxes and bounds for `raw` — the shared
 * second half of a building section's and (D5) a crane's debris. A topple
 * pivots on the base edge of the pieces on the fall side, or on
 * `pivotEdge` (the fall-axis coordinate) when given: a crane tips over its
 * mast foot, not the tip of its jib.
 */
function assembleCollapse(
  raw: readonly RawPiece[],
  meta: CollapseMeta,
  pivotEdge: number | null,
): Collapse | null {
  const { style, dir } = meta;
  const n = raw.length;
  if (n === 0) return null;
  const f64 = () => new Float64Array(n);
  const c: Draft = {
    id: meta.id,
    kind: meta.kind,
    building: meta.building,
    t0: meta.t0,
    style,
    dir,
    x: meta.x,
    z: meta.z,
    chunks: meta.chunks,
    n,
    chunk: Int32Array.from(raw, (p) => p.chunk),
    tier: Uint8Array.from(raw, (p) => p.tier),
    cut: Uint8Array.from(raw, (p) => p.cut),
    ox: Float64Array.from(raw, (p) => p.x),
    oy: Float64Array.from(raw, (p) => p.y),
    oz: Float64Array.from(raw, (p) => p.z),
    hx: Float64Array.from(raw, (p) => p.hx),
    hy: Float64Array.from(raw, (p) => p.hy),
    hz: Float64Array.from(raw, (p) => p.hz),
    start: f64(),
    axis: new Uint8Array(n),
    tilt: f64(),
    px: 0,
    py: 0,
    pz: 0,
    sign: 1,
    alpha: 0,
    tBreak: Number.POSITIVE_INFINITY,
    omega: 0,
    bx: f64(),
    by: f64(),
    bz: f64(),
    vx: f64(),
    vy: f64(),
    vz: f64(),
    land: f64(),
    lx: f64(),
    ly: f64(),
    lz: f64(),
    lphi: f64(),
    rx: f64(),
    ry: f64(),
    rz: f64(),
    rhx: f64(),
    rhy: f64(),
    rhz: f64(),
    rphi: f64(),
    ax: f64(),
    ay: f64(),
    az: f64(),
    endMs: 0,
    bounds: { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 },
    restBounds: { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 },
  };
  const lead = COLLAPSE_LEAD_MS / 1000;
  let base = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    base = Math.min(base, (c.oy[i] as number) - (c.hy[i] as number));
    top = Math.max(top, (c.oy[i] as number) + (c.hy[i] as number));
  }
  /** Rest floor per piece (pancake stacks; a topple lands on the ground). */
  const floor = f64();

  if (style === PANCAKE) {
    // Floors drop in a cascade: a later start the higher a piece's base,
    // so nothing overtakes what is under it.
    for (let i = 0; i < n; i++) {
      const rand = pieceRand(meta.id, c.chunk[i] as number);
      c.axis[i] = rand() < 0.5 ? 0 : 1;
      c.tilt[i] = (rand() * 2 - 1) * COLLAPSE_PANCAKE_TILT;
      const bottom = (c.oy[i] as number) - (c.hy[i] as number);
      c.start[i] =
        lead +
        ((bottom - base) / CHUNK_FLOOR) * (COLLAPSE_BAND_STAGGER_MS / 1000);
    }
    // Stack: bottom-up, each slab rests on the highest slab already placed
    // under its (untilted) footprint — pure geometry, no trig.
    const order = [...Array(n).keys()].sort(
      (p, q) =>
        (c.oy[p] as number) -
          (c.hy[p] as number) -
          ((c.oy[q] as number) - (c.hy[q] as number)) || p - q,
    );
    for (let a = 0; a < n; a++) {
      const i = order[a] as number;
      let y = 0;
      for (let k = 0; k < a; k++) {
        const j = order[k] as number;
        const overlapX =
          Math.min(
            (c.ox[i] as number) + (c.hx[i] as number),
            (c.ox[j] as number) + (c.hx[j] as number),
          ) -
          Math.max(
            (c.ox[i] as number) - (c.hx[i] as number),
            (c.ox[j] as number) - (c.hx[j] as number),
          );
        const overlapZ =
          Math.min(
            (c.oz[i] as number) + (c.hz[i] as number),
            (c.oz[j] as number) + (c.hz[j] as number),
          ) -
          Math.max(
            (c.oz[i] as number) - (c.hz[i] as number),
            (c.oz[j] as number) - (c.hz[j] as number),
          );
        if (overlapX > 1e-6 && overlapZ > 1e-6) {
          y = Math.max(
            y,
            (floor[j] as number) +
              2 * (c.hy[j] as number) * COLLAPSE_RUBBLE_RATIO,
          );
        }
      }
      floor[i] = y;
    }
  } else {
    // Topple: the section tips over its base edge on the weak side.
    const xAxisFall = dir === DIR_NEG_X || dir === DIR_POS_X;
    const positive = dir === DIR_POS_X || dir === DIR_POS_Z;
    let edge = positive ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (let i = 0; i < n && pivotEdge === null; i++) {
      const o = (xAxisFall ? c.ox[i] : c.oz[i]) as number;
      const h = (xAxisFall ? c.hx[i] : c.hz[i]) as number;
      edge = positive ? Math.max(edge, o + h) : Math.min(edge, o - h);
    }
    if (pivotEdge !== null) edge = pivotEdge;
    // Falling along x turns about z, along z about x. Signs: +φ about z
    // tips the top toward −x; +φ about x tips it toward +z.
    const axis = xAxisFall ? 1 : 0;
    c.sign = xAxisFall ? (positive ? -1 : 1) : positive ? 1 : -1;
    c.px = xAxisFall ? edge : 0;
    c.py = base;
    c.pz = xAxisFall ? 0 : edge;
    c.alpha = Math.min(
      COLLAPSE_TOPPLE_ALPHA_MAX,
      Math.max(
        COLLAPSE_TOPPLE_ALPHA_MIN,
        (COLLAPSE_TOPPLE_K * G) / Math.max(1, top - base),
      ),
    );
    c.tBreak = Math.sqrt((2 * COLLAPSE_TOPPLE_BREAK) / c.alpha);
    c.omega = c.alpha * c.tBreak;
    for (let i = 0; i < n; i++) {
      c.axis[i] = axis;
      c.start[i] = lead;
      // Break-up: centre on the swing, velocity ω (k × r) for the spin.
      const phi = c.sign * COLLAPSE_TOPPLE_BREAK;
      rotate(
        axis,
        phi,
        (c.ox[i] as number) - c.px,
        (c.oy[i] as number) - c.py,
        (c.oz[i] as number) - c.pz,
        rot,
      );
      c.bx[i] = c.px + rot.x;
      c.by[i] = c.py + rot.y;
      c.bz[i] = c.pz + rot.z;
      const w = c.sign * c.omega;
      if (axis === 0) {
        // k = +x: k × r = (0, −r.z, r.y)
        c.vx[i] = 0;
        c.vy[i] = -w * rot.z;
        c.vz[i] = w * rot.y;
      } else {
        // k = +z: k × r = (−r.y, r.x, 0)
        c.vx[i] = -w * rot.y;
        c.vy[i] = w * rot.x;
        c.vz[i] = 0;
      }
    }
  }

  // Landing and rest, per piece.
  const pose = blankPose();
  let end = 0;
  for (let i = 0; i < n; i++) {
    const land = landingTime(c, i, floor[i] as number);
    c.land[i] = land;
    flightAt.tau = land;
    flight(c, i, pose);
    c.lx[i] = pose.x;
    c.ly[i] = pose.y;
    c.lz[i] = pose.z;
    c.lphi[i] = pose.phi;
    const quarter = Math.round(pose.phi / HALF_PI);
    const odd = Math.abs(quarter) % 2 === 1;
    const axis = c.axis[i] as number;
    const hx = c.hx[i] as number;
    const hy = c.hy[i] as number;
    const hz = c.hz[i] as number;
    const slab = 2 * hy * COLLAPSE_RUBBLE_RATIO;
    c.rphi[i] = quarter * HALF_PI;
    // The local axis that ends up vertical is squashed to the slab.
    c.rhx[i] = odd && axis === 1 ? slab / 2 : hx;
    c.rhy[i] = odd ? hy : slab / 2;
    c.rhz[i] = odd && axis === 0 ? slab / 2 : hz;
    c.rx[i] = pose.x;
    c.ry[i] = (floor[i] as number) + slab / 2;
    c.rz[i] = pose.z;
    // World AABB of the rest box: a quarter turn swaps two extents.
    c.ax[i] = odd && axis === 1 ? hy : (c.rhx[i] as number);
    c.ay[i] = slab / 2;
    c.az[i] = odd && axis === 0 ? hy : (c.rhz[i] as number);
    end = Math.max(end, (c.start[i] as number) + land + SQUASH_S);
  }
  c.endMs = end * 1000;

  // Bounds: every pose the debris takes (sampled finely, padded by the
  // distance a piece can cover between samples) and the rest boxes.
  const all = c.bounds;
  all.x0 = all.y0 = all.z0 = Number.POSITIVE_INFINITY;
  all.x1 = all.y1 = all.z1 = Number.NEGATIVE_INFINITY;
  const grow = (box: LocalBox, x: number, y: number, z: number, r: number) => {
    box.x0 = Math.min(box.x0, x - r);
    box.x1 = Math.max(box.x1, x + r);
    box.y0 = Math.min(box.y0, y - r);
    box.y1 = Math.max(box.y1, y + r);
    box.z0 = Math.min(box.z0, z - r);
    box.z1 = Math.max(box.z1, z + r);
  };
  const step = 0.05;
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(
      c.hx[i] as number,
      c.hy[i] as number,
      c.hz[i] as number,
    );
    const last = (c.start[i] as number) + (c.land[i] as number) + SQUASH_S;
    for (let t = 0; t <= last + step; t += step) {
      piecePose(c, i, c.t0 + t * 1000, pose);
      grow(all, pose.x, pose.y, pose.z, r + 4);
    }
  }
  const rest = c.restBounds;
  rest.x0 = rest.y0 = rest.z0 = Number.POSITIVE_INFINITY;
  rest.x1 = rest.y1 = rest.z1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const x = c.rx[i] as number;
    const y = c.ry[i] as number;
    const z = c.rz[i] as number;
    rest.x0 = Math.min(rest.x0, x - (c.ax[i] as number));
    rest.x1 = Math.max(rest.x1, x + (c.ax[i] as number));
    rest.y0 = Math.min(rest.y0, y - (c.ay[i] as number));
    rest.y1 = Math.max(rest.y1, y + (c.ay[i] as number));
    rest.z0 = Math.min(rest.z0, z - (c.az[i] as number));
    rest.z1 = Math.max(rest.z1, z + (c.az[i] as number));
  }
  grow(all, rest.x0, rest.y0, rest.z0, 0);
  grow(all, rest.x1, rest.y1, rest.z1, 0);
  return c;
}

// --- D5 crane falls ----------------------------------------------------------

/** A crane's mast and booms break into pieces at most this long, m. */
const CRANE_SEGMENT = 12;

/** Topple direction of a crane whose jib is slewed to quarter turn `q`:
 * the jib points along (cos θ, −sin θ), so θ = 0 is +x, π/2 is −z, π is −x,
 * 3π/2 is +z. A tower crane goes over jib first. */
const CRANE_DIRS = [DIR_POS_X, DIR_NEG_Z, DIR_NEG_X, DIR_POS_Z] as const;

/** The quarter turn (0..3) nearest a slew angle. */
export const slewQuarter = (theta: number): number =>
  (((Math.round(theta / HALF_PI) % 4) + 4) % 4) as number;

/** The direction a crane falls when it goes over at `tMs`. */
export const craneFallDir = (site: CraneSite, tMs: number): number =>
  CRANE_DIRS[slewQuarter(slewAngle(site, tMs))] as number;

/**
 * The first server time ≥ `fromMs` at which `site`'s jib lies along a street
 * axis (its slew angle a multiple of π/2), whole ms. A crane only goes over
 * then, so its debris (axis-aligned boxes) matches the crane exactly.
 */
export function craneAlignAfter(site: CraneSite, fromMs: number): number {
  const a = slewAngle(site, fromMs);
  const w = site.omega;
  if (w === 0) return Number.POSITIVE_INFINITY;
  const q = a / HALF_PI;
  const next = w > 0 ? Math.ceil(q) * HALF_PI - a : a - Math.floor(q) * HALF_PI;
  return Math.round(fromMs + (next / Math.abs(w)) * 1000);
}

/**
 * D5: the debris of a crane fall — the crane's own boxes (craneBoxesAt, the
 * shapes it collides as) at the wire's instant, its slew snapped to the
 * nearest quarter turn (the server only fells a crane while its jib lies
 * along a street axis, so the snap is sub-millimetre), cut into segments
 * and tipped over the mast foot jib first. Pure in (site, wire). Null for a
 * wire that is not this crane's.
 */
export function buildCraneCollapse(
  site: CraneSite,
  wire: CollapseWire,
): Collapse | null {
  if (wireKind(wire) !== KIND_CRANE || wire.b !== site.id) return null;
  if (!Number.isFinite(wire.t)) return null;
  const q = slewQuarter(slewAngle(site, wire.t));
  const alongX = q % 2 === 0;
  const raw: RawPiece[] = [];
  for (const box of craneBoxesAt(site, q * HALF_PI)) {
    if (box.kind === "cable") continue;
    const x = wrapDeltaAxis(site.x, box.x);
    const z = wrapDeltaAxis(site.z, box.z);
    // A quarter-turn yaw only swaps the local x/z extents.
    const hx = alongX ? box.hx : box.hz;
    const hz = alongX ? box.hz : box.hx;
    const hy = box.hy;
    const axis = hy >= Math.max(hx, hz) ? 1 : hx >= hz ? 0 : 2;
    const half = axis === 1 ? hy : axis === 0 ? hx : hz;
    const k = Math.max(1, Math.ceil((2 * half) / CRANE_SEGMENT));
    const seg = half / k;
    for (let j = 0; j < k; j++) {
      const off = -half + (2 * j + 1) * seg;
      raw.push({
        chunk: -1,
        tier: 0,
        cut: 0,
        x: x + (axis === 0 ? off : 0),
        y: box.y + (axis === 1 ? off : 0),
        z: z + (axis === 2 ? off : 0),
        hx: axis === 0 ? seg : hx,
        hy: axis === 1 ? seg : hy,
        hz: axis === 2 ? seg : hz,
      });
    }
  }
  const dir = CRANE_DIRS[q] as number;
  const positive = dir === DIR_POS_X || dir === DIR_POS_Z;
  return assembleCollapse(
    raw,
    {
      id: wire.id,
      kind: KIND_CRANE,
      building: site.id,
      t0: wire.t,
      style: TOPPLE,
      dir,
      x: site.x,
      z: site.z,
      chunks: [],
    },
    ((positive ? 1 : -1) * CRANE_MAST_SIDE) / 2,
  );
}

// --- D5 chain reactions ------------------------------------------------------

/** Falling debris entering another building: when (server ms), which
 * building, and where (canonical world position). */
export interface CollapseImpact {
  t: number;
  building: number;
  x: number;
  y: number;
  z: number;
}

/** Trajectory sampling step for collapseImpacts, s. */
const IMPACT_STEP_S = 0.1;

/**
 * D5: where collapse `c`'s falling pieces first drive into ANOTHER
 * building's standing chunks (a crane's debris: any building) — the instant
 * a piece's centre enters a chunk of it that still stands. A per-building
 * AABB reject against the debris' swept bounds, then each piece sampled
 * every IMPACT_STEP_S until it lands. Coalesced: per building at most
 * CHAIN_IMPACTS_PER_BUILDING impacts at least CHAIN_COALESCE_M apart, and
 * CHAIN_IMPACTS_MAX in all, earliest first. Pure in (c, buildings' shape
 * and damage); the server lands each one as a D2 blast at its instant.
 */
export function collapseImpacts(
  c: Collapse,
  buildings: readonly Building[],
): CollapseImpact[] {
  const near: { i: number; dx: number; dz: number }[] = [];
  const box = c.bounds;
  for (let i = 0; i < buildings.length; i++) {
    if (c.kind === KIND_BUILDING && i === c.building) continue;
    const b = buildings[i] as Building;
    const dx = wrapDeltaAxis(c.x, b.x);
    const dz = wrapDeltaAxis(c.z, b.z);
    if (dx + b.width / 2 < box.x0 || dx - b.width / 2 > box.x1) continue;
    if (dz + b.depth / 2 < box.z0 || dz - b.depth / 2 > box.z1) continue;
    if (box.y0 > b.height) continue;
    near.push({ i, dx, dz });
  }
  if (near.length === 0) return [];
  const found: CollapseImpact[] = [];
  const pose = blankPose();
  const hit = new Set<number>();
  const local: Vec3 = { x: 0, y: 0, z: 0 };
  for (let p = 0; p < c.n; p++) {
    hit.clear();
    const start = c.start[p] as number;
    const land = c.land[p] as number;
    for (let tau = IMPACT_STEP_S; tau < land; tau += IMPACT_STEP_S) {
      const tMs = c.t0 + (start + tau) * 1000;
      piecePose(c, p, tMs, pose);
      for (const n of near) {
        if (hit.has(n.i)) continue;
        const b = buildings[n.i] as Building;
        local.x = pose.x - n.dx;
        local.y = pose.y;
        local.z = pose.z - n.dz;
        const at = chunkAt(b, local);
        if (!at || chunkMask(b)[at.tier]?.[at.cell] !== 1) continue;
        if (b.damage?.cells[at.tier]?.[at.cell]) continue;
        hit.add(n.i);
        const w = canonicalize({ x: c.x + pose.x, y: 0, z: c.z + pose.z });
        found.push({ t: tMs, building: n.i, x: w.x, y: pose.y, z: w.z });
      }
    }
  }
  found.sort((a, b) => a.t - b.t || a.building - b.building);
  const out: CollapseImpact[] = [];
  for (const f of found) {
    if (out.length >= CHAIN_IMPACTS_MAX) break;
    let same = 0;
    let close = false;
    for (const o of out) {
      if (o.building !== f.building) continue;
      same++;
      const d = Math.hypot(
        wrapDeltaAxis(o.x, f.x),
        f.y - o.y,
        wrapDeltaAxis(o.z, f.z),
      );
      if (d < CHAIN_COALESCE_M) close = true;
    }
    if (close || same >= CHAIN_IMPACTS_PER_BUILDING) continue;
    out.push(f);
  }
  return out;
}

// --- Collision -------------------------------------------------------------

/** What a collapse collision reports. Allocated only on a hit. */
export interface CollapseHit {
  collapse: Collapse;
  piece: number;
  /** The piece was still moving (or about to): falling debris, not rubble. */
  falling: boolean;
}

const scratchPose = blankPose();

/** Does a sphere at (dx, dy, dz) from the box centre touch the oriented
 * box? */
function sphereHitsPiece(
  p: PiecePose,
  dx: number,
  dy: number,
  dz: number,
  radius: number,
): boolean {
  // Into the piece's frame: rotate by −phi about its axis.
  let lx = dx;
  let ly = dy;
  let lz = dz;
  if (p.phi !== 0) {
    const cs = Math.cos(p.phi);
    const sn = Math.sin(p.phi);
    if (p.axis === 0) {
      ly = dy * cs + dz * sn;
      lz = -dy * sn + dz * cs;
    } else {
      lx = dx * cs + dy * sn;
      ly = -dx * sn + dy * cs;
    }
  }
  const ex = Math.max(0, Math.abs(lx) - p.hx);
  const ey = Math.max(0, Math.abs(ly) - p.hy);
  const ez = Math.max(0, Math.abs(lz) - p.hz);
  return ex * ex + ey * ey + ez * ez <= radius * radius;
}

/** Does a sphere at `pos` touch piece `i` of `c` at `tMs`? (The per-piece
 * test collideCollapses runs; tests check the drawn boxes against it.) */
export function collidePiece(
  c: Collapse,
  i: number,
  pos: Vec3,
  radius: number,
  tMs: number,
): boolean {
  const p = piecePose(c, i, tMs, scratchPose);
  return sphereHitsPiece(
    p,
    wrapDeltaAxis(c.x, pos.x) - p.x,
    pos.y - p.y,
    wrapDeltaAxis(c.z, pos.z) - p.z,
    radius,
  );
}

const outside = (
  box: LocalBox,
  x: number,
  y: number,
  z: number,
  r: number,
): boolean =>
  x < box.x0 - r ||
  x > box.x1 + r ||
  y < box.y0 - r ||
  y > box.y1 + r ||
  z < box.z0 - r ||
  z > box.z1 + r;

/**
 * The first collapse piece a sphere at `pos` touches at server time `tMs`,
 * or null — falling chunks (still standing during the lead beat) and the
 * rubble they became. Torus-correct and allocation-free on a miss: a
 * per-event reject, then per piece. `fallingOnly` skips pieces at rest (the
 * kill-credit check). `tMs = Infinity` tests the rest state.
 */
export function collideCollapses(
  pos: Vec3,
  radius: number,
  list: readonly Collapse[],
  tMs: number,
  fallingOnly = false,
): CollapseHit | null {
  for (let e = 0; e < list.length; e++) {
    const c = list[e] as Collapse;
    const dx = wrapDeltaAxis(c.x, pos.x);
    const dz = wrapDeltaAxis(c.z, pos.z);
    if (tMs >= c.t0 + c.endMs) {
      if (fallingOnly || outside(c.restBounds, dx, pos.y, dz, radius)) continue;
      for (let i = 0; i < c.n; i++) {
        const ex = Math.max(
          0,
          Math.abs(dx - (c.rx[i] as number)) - (c.ax[i] as number),
        );
        const ey = Math.max(
          0,
          Math.abs(pos.y - (c.ry[i] as number)) - (c.ay[i] as number),
        );
        const ez = Math.max(
          0,
          Math.abs(dz - (c.rz[i] as number)) - (c.az[i] as number),
        );
        if (ex * ex + ey * ey + ez * ez <= radius * radius) {
          return { collapse: c, piece: i, falling: false };
        }
      }
      continue;
    }
    if (outside(c.bounds, dx, pos.y, dz, radius)) continue;
    for (let i = 0; i < c.n; i++) {
      const p = piecePose(c, i, tMs, scratchPose);
      if (fallingOnly && p.rest) continue;
      const bound = Math.hypot(p.hx, p.hy, p.hz) + radius;
      const ox = dx - p.x;
      const oy = pos.y - p.y;
      const oz = dz - p.z;
      if (ox * ox + oy * oy + oz * oz > bound * bound) continue;
      if (sphereHitsPiece(p, ox, oy, oz, radius)) {
        return { collapse: c, piece: i, falling: !p.rest };
      }
    }
  }
  return null;
}

/**
 * Bots only: is a probe sphere at `pos` inside an ACTIVE collapse's zone
 * (everything its debris sweeps, from the event until COLLAPSE_ZONE_TAIL_MS
 * after its last chunk rests) at `tMs`? A zone that already holds `from`
 * (where the bot is now) does not count — it blocks entry, never escape.
 */
export function collapseZoneHit(
  pos: Vec3,
  radius: number,
  list: readonly Collapse[],
  tMs: number,
  from?: Vec3,
): boolean {
  for (let e = 0; e < list.length; e++) {
    const c = list[e] as Collapse;
    if (tMs < c.t0 || tMs > c.t0 + c.endMs + COLLAPSE_ZONE_TAIL_MS) continue;
    const dx = wrapDeltaAxis(c.x, pos.x);
    const dz = wrapDeltaAxis(c.z, pos.z);
    if (outside(c.bounds, dx, pos.y, dz, radius)) continue;
    if (
      from &&
      !outside(
        c.bounds,
        wrapDeltaAxis(c.x, from.x),
        from.y,
        wrapDeltaAxis(c.z, from.z),
        0,
      )
    ) {
      continue;
    }
    return true;
  }
  return false;
}

// --- The field -------------------------------------------------------------

/**
 * One room's collapses: the wire records (the replay) and their debris.
 * Holds bare records until bind(buildings) — a client's socket sees them
 * before its city is built — like CityDamage. reset() empties THIS object
 * in place: bots and the room's MoverField hold it for the room's life.
 */
export class CollapseField {
  private buildings: readonly Building[] | null = null;
  /** D5: the room's crane sites (a crane fall's wire names one by id). */
  private cranes: readonly CraneSite[] = [];
  private readonly wires: CollapseWire[] = [];
  /** Built debris, in event order (empty until bound). */
  readonly list: Collapse[] = [];
  /** D5: felled crane site id → the instant it went over (its earliest
   * fall record). A crane stands for any time before that — render clocks
   * trail the server — and is debris from then on. */
  readonly felled = new Map<number, number>();
  /** Bumped on every change. */
  version = 0;

  /** Attach to the city the records name; builds every held record. */
  bind(buildings: readonly Building[]): void {
    this.buildings = buildings;
    this.rebuild();
  }

  /** D5: the crane sites crane-fall records name (the room's movers). Re-
   * builds every record, so it may come before or after bind(). */
  bindCranes(cranes: readonly CraneSite[]): void {
    this.cranes = cranes;
    if (this.buildings) this.rebuild();
  }

  /** Every record, in event order — the welcome's replay. */
  get records(): readonly CollapseWire[] {
    return this.wires;
  }

  /** Add one event; returns its debris once bound (null before, or for a
   * record naming nothing real). */
  add(wire: CollapseWire): Collapse | null {
    this.wires.push(wire);
    this.version++;
    this.noteFelled(wire);
    if (!this.buildings) return null;
    const c = this.build(wire);
    if (c) this.list.push(c);
    return c;
  }

  /** Make the records exactly `wires` (a welcome, or a room reset). */
  reset(wires: readonly CollapseWire[]): void {
    this.wires.length = 0;
    this.list.length = 0;
    this.felled.clear();
    for (const w of wires) this.add(w);
    this.version++;
  }

  /** D5 rebuild: drop every record (and its debris and rubble) of building
   * `index`. Returns the dropped records' ids. */
  removeBuilding(index: number): number[] {
    return this.remove(KIND_BUILDING, index);
  }

  /** D5 rebuild: the crane at site `id` stands again. Returns the dropped
   * records' ids. */
  removeCrane(id: number): number[] {
    return this.remove(KIND_CRANE, id);
  }

  private remove(kind: number, target: number): number[] {
    const ids: number[] = [];
    const keep = this.wires.filter((w) => {
      const drop = wireKind(w) === kind && w.b === target;
      if (drop) ids.push(w.id);
      return !drop;
    });
    if (ids.length === 0) return ids;
    this.wires.length = 0;
    this.wires.push(...keep);
    for (let k = this.list.length - 1; k >= 0; k--) {
      const c = this.list[k] as Collapse;
      if (c.kind === kind && c.building === target) this.list.splice(k, 1);
    }
    if (kind === KIND_CRANE) this.felled.delete(target);
    this.version++;
    return ids;
  }

  private rebuild(): void {
    this.list.length = 0;
    for (const w of this.wires) {
      const c = this.build(w);
      if (c) this.list.push(c);
    }
    this.version++;
  }

  private build(wire: CollapseWire): Collapse | null {
    if (wireKind(wire) === KIND_CRANE) {
      const site = this.cranes.find((s) => s.id === wire.b);
      return site ? buildCraneCollapse(site, wire) : null;
    }
    return buildCollapse(this.buildings as readonly Building[], wire);
  }

  private noteFelled(wire: CollapseWire): void {
    if (wireKind(wire) !== KIND_CRANE || !Number.isFinite(wire.t)) return;
    const at = this.felled.get(wire.b);
    if (at === undefined || wire.t < at) this.felled.set(wire.b, wire.t);
  }
}

/** D5: is crane site `id` down at server time `tMs`? */
export function craneDown(
  field: CollapseField | undefined,
  id: number,
  tMs: number,
): boolean {
  if (!field || field.felled.size === 0) return false;
  const at = field.felled.get(id);
  return at !== undefined && tMs >= at;
}

/** The chunk ids a record drops (for CityDamage.collapse). */
export const collapseChunks = (wire: CollapseWire): number[] =>
  wireKind(wire) === KIND_BUILDING ? decodeChunkIds(wire.c) : [];

/** Grid helper for tests and tools: chunk id of (tier, ix, iy, iz). */
export function chunkAtCell(
  b: Building,
  index: number,
  tier: number,
  ix: number,
  iy: number,
  iz: number,
): number {
  const g = tierGrids(b)[tier] as TierGrid;
  return chunkId(index, tier, cellIndex(g, ix, iy, iz));
}
