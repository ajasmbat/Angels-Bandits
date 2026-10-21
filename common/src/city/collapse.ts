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
// Styles: no survivors (or survivors centred) under the section → PANCAKE;
// survivors off to one side → TOPPLE, the section tips over its base edge
// toward the missing side (snapped to ±x/±z: streets run along the axes).
// D10 made both read like real buildings coming down:
//
//   - Pre-fracture: a chunk falls as storey slabs, with facade sheets off
//     the building's outline and column / I-beam segments (`fracture`), not
//     as one 20 × 12 × 20 m block. Every piece is still an oriented box —
//     what it collides as; the renderer draws a broken shape inside it.
//   - PANCAKE is progressive: a creep, then the upper block lets go and a
//     crush front drives down from the failure height (the wire's `f`); each
//     storey under it starts when the front reaches it, at the front's
//     speed, so floors give way one after another, faster and faster, and
//     the facade sheets peel off into the street as they go.
//   - TOPPLE bends as it swings: its top breaks off first, its base at the
//     D3 angle. An unsupported wing or corner with open air outside it
//     shears off the same way (`shearDir`) and leaves the rest standing.
//   - Slenderness weighs the choice: a slender section topples at half the
//     offset a squat one needs (`toppleThreshold`).
//
// Every piece ends as a rubble box — slumped a little askew, a column stub
// leaning out of the pile — resting on the ground or on the rubble under it,
// never on something that could later be shot away.
//
// G9: a PANCAKE ends as a HEAP, not a cake of storeys. Its pieces land as
// they always did, on the stack, then slide (`slide`) down to their heap
// pose: each storey slab a broken plate (a seeded share of its bay), tilted
// to the slope it lies on, the upper storeys out on the flanks and a few in
// the street, the lower ones buried. The mound of fine rubble they lie in
// (`heap`, city/repose.ts: the angle of repose, 30–40°) rises as they come
// to rest, and is drawn and collided as the same triangles.
//
// DL1: every tunable above reads a DestructionTuning (common/src/
// destruction-tuning.ts) — the planner, the builder and the chain probe take
// one as a trailing `tuning = DEFAULT_DESTRUCTION_TUNING` (held in `T` for
// the call's duration: they are synchronous), and each Collapse keeps the
// gravity, squash time and lead it was built with, so posing it needs no
// tuning at all. With the defaults every number is the constant it mirrors —
// bit for bit (common/test/destruction-parity.test.ts). A Destruction Lab
// room stamps its build tuning on the wire (`dt`); only a lab CollapseField
// builds from it.
//
// DS1: in a physics room (the solo sim worker's) the planner fails floors by
// their COLUMNS instead of the band rule (city/structure.ts; `structural`),
// and the debris built here is simulated, not posed in closed form: the
// host's Rapier world (server/src/debris-physics.ts) moves the very pieces
// built here and streams their poses, and each Collapse it took gets
// `phys` (city/physpose.ts). poseNow and collideCollapses read `phys` first,
// so every renderer and every collision check — host bots and the page's
// plane alike — pose from the same frames. The closed form below remains
// the whole model for multiplayer, far collapses, cranes and anything over
// the physics' body budget.

import {
  CHAIN_COALESCE_M,
  COLLAPSE_COLUMN_SIDE,
  COLLAPSE_FLOOR_EVENTS_MAX,
  COLLAPSE_SHEET_THICK,
  COLLAPSE_TOPPLE_ALPHA_MAX,
  COLLAPSE_TOPPLE_ALPHA_MIN,
  COLLAPSE_TOPPLE_MAX_SPAN,
  COLLAPSE_TOPPLE_RISE_MAX,
  COLLAPSE_ZONE_TAIL_MS,
  CRANE_MAST_SIDE,
} from "../constants";
import {
  DEFAULT_DESTRUCTION_TUNING,
  type DestructionTuning,
  tuningFromStamp,
} from "../destruction-tuning";
import { type Vec3, canonicalize, wrapDeltaAxis } from "../world/index";
import {
  CUT_NEG_X,
  CUT_NEG_Y,
  CUT_NEG_Z,
  CUT_POS_X,
  CUT_POS_Y,
  CUT_POS_Z,
  CUT_STEEL,
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
import type { SolidBox } from "./holes";
import type { Building } from "./index";
// movers.ts ↔ collapse.ts is a module cycle (collideMovers reads the field;
// a crane fall reads the crane's boxes). Every use is at call time.
import { type CraneSite, craneBoxesAt, slewAngle } from "./movers";
import type { PhysPoses, PhysRegistry, RubbleHeap } from "./physpose";
import { PHYS_CLOCK, heapHeight, sphereHitsHeap } from "./physpose";
import {
  heapGrid,
  pileBox,
  reposeFit,
  reposeMound,
  reposeSlope,
} from "./repose";
import { mulberry32 } from "./rng";
import {
  MAT_CONCRETE,
  MAT_STEEL,
  buildingFrame,
  failingFloor,
  floorLoad,
  leanDir,
} from "./structure";

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
  /** D10 pancake: the failure height, whole decimetres — where the crush
   * front starts. Absent: the section's base (every piece lets go at once). */
  f?: number;
  /** DL1: a Destruction Lab room's build tuning — the BUILD fields that
   * differ from the defaults (destruction-tuning.ts buildStamp). Never set
   * by a normal room, and read only by a lab CollapseField. */
  dt?: Record<string, number>;
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
  /** D10: the failure height, m — the base of the section that let go
   * (what a pancake crushes lies below it). */
  fail: number;
}

/** DL1: the tuning the planner / builder / chain probe in progress reads
 * (set for the duration of the exported call; they never yield). */
let T: Readonly<DestructionTuning> = DEFAULT_DESTRUCTION_TUNING;

/** DS1: the planner in progress plans a PHYSICS room — floors fail by
 * their columns (city/structure.ts), not by D3's band rule (set for the
 * call's duration, like `T`). */
let STRUCT = false;

/** Run `fn` with `tuning` as `T`, restoring the previous one after (so a
 * nested call — a builder inside a planner — sees its own). */
function withTuning<R>(tuning: Readonly<DestructionTuning>, fn: () => R): R {
  const prev = T;
  T = tuning;
  try {
    return fn();
  } finally {
    T = prev;
  }
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
      if (exist === 0 || up >= T.bandMin * exist) continue;
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

/** D10: the topple threshold for a section `height` m tall over a tier
 * `g`: COLLAPSE_SYMMETRY scaled by clamp(3 / s, 0.5, 1.5), s = height ÷
 * min(width, depth). A slender section topples at half the offset that
 * tips today's s = 3 section; a squat one needs half again as much. */
export function toppleThreshold(
  g: TierGrid,
  height: number,
  tuning: Readonly<DestructionTuning> = T,
): number {
  if (tuning !== T)
    return withTuning(tuning, () => toppleThreshold(g, height, tuning));
  const s = Math.max(1e-6, height) / Math.max(1, Math.min(g.width, g.depth));
  return T.symmetry * Math.min(1.5, Math.max(0.5, 3 / s));
}

/** Pancake or topple (and which way) from the failed band's survivors,
 * for a section `height` m tall above it. */
function styleOf(
  g: TierGrid,
  mask: Uint8Array,
  st: Uint8Array,
  band: number,
  height: number,
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
  // T1: a supertall's section comes straight down, whatever survives.
  if (height > COLLAPSE_TOPPLE_MAX_SPAN) return { style: PANCAKE, dir: 0 };
  // From the survivors toward what is missing: the weak side.
  const ox = (ax / an - sx / sn) / g.width;
  const oz = (az / an - sz / sn) / g.depth;
  if (Math.max(Math.abs(ox), Math.abs(oz)) < toppleThreshold(g, height)) {
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

/** Lowest base and highest top of the (tier, cell) pairs in `set`, m. */
function spanOf(
  grids: readonly TierGrid[],
  set: readonly number[],
): { base: number; top: number } {
  const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  let base = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < set.length; j += 2) {
    cellBox(grids[set[j] as number] as TierGrid, set[j + 1] as number, box);
    base = Math.min(base, box.y0);
    top = Math.max(top, box.y1);
  }
  return { base, top };
}

/** Outward unit step of a DIR_* along x (−1/+1) or 0. */
const stepX = (d: number) => (d === DIR_NEG_X ? -1 : d === DIR_POS_X ? 1 : 0);
const stepZ = (d: number) => (d === DIR_NEG_Z ? -1 : d === DIR_POS_Z ? 1 : 0);

/**
 * D10 partial collapse: may the unsupported `set` shear off its building as
 * a wing / corner peeling outward (a TOPPLE over its own outer base edge)?
 * Only into open air — nothing left standing above any of its cells, or
 * outward of them along the direction in their tier, the tier flush with
 * the street tier on that side — and only when something of the building
 * stays standing (the jagged remainder). A rigid swing outward about the
 * outer base edge moves every point outward (and the inner ones up, into
 * the empty air over the set), so it passes through nothing that stands.
 * Returns the DIR_* (the side the set leans furthest toward), or −1.
 */
function shearDir(
  grids: readonly TierGrid[],
  standing: readonly Uint8Array[],
  set: readonly number[],
): number {
  if (set.length < 6) return -1; // under three chunks: a plain drop
  const after = standing.map((st) => st.slice());
  for (let j = 0; j < set.length; j += 2) {
    (after[set[j] as number] as Uint8Array)[set[j + 1] as number] = 0;
  }
  if (!after.some((st) => st.includes(1))) return -1; // nothing stays
  const g0 = grids[0] as TierGrid;
  const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  const other: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  let cx = 0;
  let cz = 0;
  const open = [true, true, true, true];
  for (let j = 0; j < set.length; j += 2) {
    const k = set[j] as number;
    const c = set[j + 1] as number;
    const g = grids[k] as TierGrid;
    const st = after[k] as Uint8Array;
    const ix = c % g.nx;
    const iz = Math.floor(c / g.nx) % g.nz;
    const iy = Math.floor(c / (g.nx * g.nz));
    cellBox(g, c, box);
    cx += (box.x0 + box.x1) / 2;
    cz += (box.z0 + box.z1) / 2;
    // Nothing standing above it: its own column, then every higher tier.
    for (let y = iy + 1; y < g.ny; y++) {
      if (st[cellIndex(g, ix, y, iz)]) return -1;
    }
    for (let kk = k + 1; kk < grids.length; kk++) {
      const gk = grids[kk] as TierGrid;
      const sk = after[kk] as Uint8Array;
      for (let cc = 0; cc < sk.length; cc++) {
        if (!sk[cc]) continue;
        cellBox(gk, cc, other);
        if (
          Math.min(other.x1, box.x1) - Math.max(other.x0, box.x0) > 1e-6 &&
          Math.min(other.z1, box.z1) - Math.max(other.z0, box.z0) > 1e-6
        ) {
          return -1;
        }
      }
    }
    // Open outward along each direction (in its tier, flush with tier 0).
    for (let d = 0; d < 4; d++) {
      if (!open[d]) continue;
      const sx = stepX(d);
      const sz = stepZ(d);
      const flush =
        sx !== 0
          ? g.width / 2 >= g0.width / 2 - 0.5
          : g.depth / 2 >= g0.depth / 2 - 0.5;
      if (!flush) {
        open[d] = false;
        continue;
      }
      // The swing rises as it goes out: this band and every one above it,
      // out to the tier's edge, must be clear…
      for (
        let x = ix + sx, z = iz + sz;
        open[d] && x >= 0 && x < g.nx && z >= 0 && z < g.nz;
        x += sx, z += sz
      ) {
        for (let y = iy; y < g.ny; y++) {
          if (st[cellIndex(g, x, y, z)]) {
            open[d] = false;
            break;
          }
        }
      }
      if (!open[d]) continue;
      // …and so must every higher tier over that strip.
      const sx0 = sx < 0 ? -g.width / 2 : box.x0;
      const sx1 = sx > 0 ? g.width / 2 : box.x1;
      const sz0 = sz < 0 ? -g.depth / 2 : box.z0;
      const sz1 = sz > 0 ? g.depth / 2 : box.z1;
      for (let kk = k + 1; kk < grids.length && open[d]; kk++) {
        const gk = grids[kk] as TierGrid;
        const sk = after[kk] as Uint8Array;
        for (let cc = 0; cc < sk.length; cc++) {
          if (!sk[cc]) continue;
          cellBox(gk, cc, other);
          if (
            Math.min(other.x1, sx1) - Math.max(other.x0, sx0) > 1e-6 &&
            Math.min(other.z1, sz1) - Math.max(other.z0, sz0) > 1e-6
          ) {
            open[d] = false;
            break;
          }
        }
      }
    }
  }
  const n = set.length / 2;
  cx /= n;
  cz /= n;
  let best = -1;
  let lean = 0;
  for (let d = 0; d < 4; d++) {
    if (!open[d]) continue;
    const off = stepX(d) * cx + stepZ(d) * cz;
    if (off > lean + 1e-6) {
      lean = off;
      best = d;
    }
  }
  return best;
}

/** The next collapse in `standing`, or null when everything is held up. */
function nextPlan(
  b: Building,
  index: number,
  standing: readonly Uint8Array[],
): CollapsePlan | null {
  const grids = tierGrids(b);
  const masks = chunkMask(b);
  const fail = STRUCT
    ? failingFloor(b, standing, T.columnStrength)
    : failingBand(grids, masks, standing);
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
    const span = spanOf(grids, set);
    const height = set.length > 0 ? span.top - span.base : 0;
    if (STRUCT) {
      // DS1: where the columns failed — the survivors' centroid off to one
      // side leans the section over them, centred it pancakes.
      const load = floorLoad(buildingFrame(b), standing, fail.tier, fail.band);
      const d = leanDir(load, g, toppleThreshold(g, height));
      style = d < 0 ? PANCAKE : TOPPLE;
      dir = d < 0 ? 0 : d;
    } else {
      ({ style, dir } = styleOf(
        g,
        masks[fail.tier] as Uint8Array,
        standing[fail.tier] as Uint8Array,
        fail.band,
        height,
      ));
    }
  } else {
    set = unsupported(b, standing);
    if (set.length === 0) return null;
    const d = shearDir(grids, standing, set);
    const span = spanOf(grids, set);
    // T1: a supertall's wing comes straight down too.
    if (d >= 0 && span.top - span.base <= COLLAPSE_TOPPLE_MAX_SPAN) {
      style = TOPPLE;
      dir = d;
    }
  }
  const failY = set.length > 0 ? spanOf(grids, set).base : 0;
  if (style === PANCAKE) set = set.concat(crushedUnder(grids, standing, set));
  const chunks: number[] = [];
  for (let j = 0; j < set.length; j += 2) {
    chunks.push(chunkId(index, set[j] as number, set[j + 1] as number));
  }
  chunks.sort((x, y) => x - y);
  return { style, dir, chunks, fail: failY };
}

/**
 * Every collapse building `index` (= `b`) owes in its current damage state,
 * in order: each plan is applied before the next is looked for (a pancake's
 * crush can fail a lower band, or leave a ledge unsupported). Afterwards no
 * standing chunk is unsupported. Pure in (shape, damage).
 */
export function planCollapses(
  b: Building,
  index: number,
  tuning: Readonly<DestructionTuning> = DEFAULT_DESTRUCTION_TUNING,
  /** DS1: a physics room — floors fail by their columns
   * (tuning.columnStrength), and where they failed picks the style. */
  structural = false,
): CollapsePlan[] {
  if (tuning !== T)
    return withTuning(tuning, () =>
      planCollapses(b, index, tuning, structural),
    );
  if (structural !== STRUCT) {
    const prev = STRUCT;
    STRUCT = structural;
    try {
      return planCollapses(b, index, tuning, structural);
    } finally {
      STRUCT = prev;
    }
  }
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

/** D8: share of a TOPPLE stump's back-most row that keeps a third band. */
const STUMP_SPIKE_SHARE = 0.6;

/**
 * D8: how many of tier 0's bands column (ix, iz) keeps when the tower over
 * it topples in `dir` — a stepped, broken stump instead of one flat cut.
 * Fall-side columns keep the bottom band; the back half (away from the fall
 * edge — at least half of band 1, so it never fails COLLAPSE_BAND_MIN) keeps
 * two; a hashed share of the back-most row keeps three. Kept height never
 * drops going away from the fall edge, so nothing that tips over the edge
 * swings through the stump.
 */
function stumpBands(
  g: TierGrid,
  index: number,
  dir: number,
  ix: number,
  iz: number,
): number {
  const alongX = dir === DIR_NEG_X || dir === DIR_POS_X;
  const n = alongX ? g.nx : g.nz;
  const i = alongX ? ix : iz;
  // Distance (in columns) from the fall edge.
  const r = dir === DIR_POS_X || dir === DIR_POS_Z ? n - 1 - i : i;
  if (n < 2 || r < Math.floor(n / 2)) return 1;
  let bands = 2;
  if (n >= 3 && r === n - 1) {
    const across = alongX ? iz : ix;
    const roll = mulberry32(
      (Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(across + 7, 0x85ebca6b)) >>>
        0,
    )();
    if (roll < STUMP_SPIKE_SHARE) bands = 3;
  }
  return Math.min(bands, g.ny);
}

/**
 * D5 demolition: a charge line under tier 0's second floor band. Every
 * standing chunk above tier 0's bottom band (and every upper tier) falls as
 * ONE event — TOPPLE in `dir`, or a PANCAKE that also crushes what stands
 * under it. What stays is a supported stump, so nothing is left floating.
 * D8: a TOPPLE leaves a stepped, broken stump (stumpBands) when that stump
 * owes no collapse of its own; otherwise the flat one. Null when nothing
 * above the bottom band still stands. Pure in (shape, damage).
 */
export function demolitionPlan(
  b: Building,
  index: number,
  style: CollapseStyle,
  dir: number,
  tuning: Readonly<DestructionTuning> = DEFAULT_DESTRUCTION_TUNING,
): CollapsePlan | null {
  if (tuning !== T) {
    return withTuning(tuning, () =>
      demolitionPlan(b, index, style, dir, tuning),
    );
  }
  const grids = tierGrids(b);
  const standing = standingOf(b);
  const g0 = grids[0] as TierGrid;
  const pick = (jagged: boolean): number[] => {
    const out: number[] = [];
    standing.forEach((st, k) => {
      const g = grids[k] as TierGrid;
      const band = g.nx * g.nz;
      for (let c = k === 0 ? band : 0; c < st.length; c++) {
        if (!st[c]) continue;
        if (k === 0 && jagged) {
          const ix = c % g.nx;
          const iz = Math.floor(c / g.nx) % g.nz;
          if (Math.floor(c / band) < stumpBands(g, index, dir, ix, iz))
            continue;
        }
        out.push(k, c);
      }
    });
    return out;
  };
  let set = pick(false);
  if (set.length === 0) return null;
  const span = spanOf(grids, set);
  const failY = span.base;
  // T1: a supertall is brought straight down, whichever way it was asked
  // to fall — and so is a section too squat to tip that way.
  const tall = span.top - span.base;
  const along =
    dir === DIR_POS_X || dir === DIR_NEG_X
      ? (g0?.width ?? 0)
      : (g0?.depth ?? 0);
  const how: CollapseStyle =
    tall > COLLAPSE_TOPPLE_MAX_SPAN ||
    Math.hypot(along, tall) - tall > COLLAPSE_TOPPLE_RISE_MAX
      ? PANCAKE
      : style;
  if (how === TOPPLE && g0) {
    const jagged = pick(true);
    // Keep the broken stump only if, with the section gone, it owes nothing
    // (no band under COLLAPSE_BAND_MIN with chunks above, nothing unheld).
    const after = standing.map((st) => st.slice());
    for (let j = 0; j < jagged.length; j += 2) {
      (after[jagged[j] as number] as Uint8Array)[jagged[j + 1] as number] = 0;
    }
    if (jagged.length > 0 && !nextPlan(b, index, after)) set = jagged;
  }
  if (how === PANCAKE) set = set.concat(crushedUnder(grids, standing, set));
  const chunks: number[] = [];
  for (let j = 0; j < set.length; j += 2) {
    chunks.push(chunkId(index, set[j] as number, set[j + 1] as number));
  }
  chunks.sort((x, y) => x - y);
  return { style: how, dir: how === TOPPLE ? dir : 0, chunks, fail: failY };
}

/** A plan as the wire event `id` at server time `t`. */
export function collapseWire(
  plan: CollapsePlan,
  building: number,
  id: number,
  t: number,
): CollapseWire {
  const wire: CollapseWire = {
    id,
    b: building,
    t,
    s: plan.style,
    d: plan.style === TOPPLE ? plan.dir : 0,
    c: encodeChunkIds(plan.chunks),
  };
  // D10: a pancake carries where it failed (a topple pivots on its base).
  if (plan.style === PANCAKE && Number.isFinite(plan.fail)) {
    wire.f = Math.round(plan.fail * 10);
  }
  return wire;
}

// --- Debris ----------------------------------------------------------------

/** D10 fragment roles: a storey slab (floor plate and the storey's walls),
 * a facade sheet peeling off the outline, a column / I-beam segment. */
export const ROLE_SLAB = 0;
export const ROLE_SHEET = 1;
export const ROLE_COLUMN = 2;

/** D10 per-piece motion: a straight DROP (start, initial speed, effective
 * g, a slow tilt about its own centre), or a HINGE — a swing about its own
 * pivot (which may itself be dropping) until it breaks off into a ballistic
 * arc, spinning on. */
export const MODE_DROP = 0;
export const MODE_HINGE = 1;

/**
 * One collapse's debris, derived once from its wire. Positions are relative
 * to the building's centre (`x`, `z`, canonical); y is altitude. Per-piece
 * arrays are indexed by piece. Pieces rotate only about the x or z axis
 * (`axis` 0 / 1); at rest a piece lies at a quarter turn plus a small slump
 * about that same axis (an oriented box — what it collides as).
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
  /** D10: the failure height, m (the crush front starts here). */
  readonly fail: number;
  /** The chunks that fell (ascending). */
  readonly chunks: readonly number[];
  /** Pieces. */
  readonly n: number;
  readonly chunk: Int32Array;
  readonly tier: Uint8Array;
  /** D2 CUT_* faces of the piece as it stood (renderer shading); CUT_STEEL
   * on a column. */
  readonly cut: Uint8Array;
  /** D10: ROLE_*, MODE_*, and 1 on the pieces the chain-impact probe
   * follows (a chunk solid's middle slab, a sheet, a crane segment). */
  readonly role: Uint8Array;
  readonly mode: Uint8Array;
  readonly rep: Uint8Array;
  /** D10: the volume a rep piece stands for (its whole chunk solid, or
   * itself), m³; 0 on the rest. */
  readonly vol: Float64Array;
  /** DS1: each piece's material (city/structure.ts MAT_*): a slab's
   * concrete, a column's steel, a sheet's facade (glass, masonry, office) —
   * the physics' density, and DS2's per-piece look. */
  readonly mat: Uint8Array;
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
  /** DROP: the tilt a piece leans toward, rad (signed). */
  readonly tilt: Float64Array;
  /** DROP: downward speed at the start, m/s, and acceleration, m/s² (a
   * HINGE's pivot drops the same way; 0 for a fixed pivot). */
  readonly v0: Float64Array;
  readonly dg: Float64Array;
  /** DROP, a crushed storey: how long it is crushed for, s after its start
   * (its top rides the front down while its base holds, until it is
   * COLLAPSE_RUBBLE_RATIO of its height; 0 for a piece that only falls),
   * and that crushed half height, m. */
  readonly crush: Float64Array;
  readonly chy: Float64Array;
  /** Half height at landing, m (where the squash starts from). */
  readonly lhy: Float64Array;
  /** HINGE: pivot, sign of the rotation about `axis`, angular acceleration,
   * break-up time (s after start), tilt there and spin rate after it. */
  readonly hpx: Float64Array;
  readonly hpy: Float64Array;
  readonly hpz: Float64Array;
  readonly hsign: Float64Array;
  readonly halpha: Float64Array;
  readonly hbreak: Float64Array;
  readonly hang: Float64Array;
  readonly homega: Float64Array;
  /** Topple: the section's pivot (on the base edge), sign, angular
   * acceleration, LATEST break-up time (s after start: every piece is
   * ballistic by then) and the spin rate at the base's break. */
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  readonly sign: number;
  readonly alpha: number;
  readonly tBreak: number;
  readonly omega: number;
  /** HINGE: centre and velocity at break-up. */
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
  /** Rest: centre, local half extents, angle (a quarter turn + slump). */
  readonly rx: Float64Array;
  readonly ry: Float64Array;
  readonly rz: Float64Array;
  readonly rhx: Float64Array;
  readonly rhy: Float64Array;
  readonly rhz: Float64Array;
  readonly rphi: Float64Array;
  /** Rest box as a world-axis AABB's half extents (it bounds the slumped
   * box; the collision itself is the oriented box). */
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  readonly az: Float64Array;
  /** G9: how long a piece slides from where it landed to its rest pose,
   * s, on top of the squash (0 but for a heap's pieces). */
  readonly slide: Float64Array;
  /** Ms after t0 when the last piece is at rest. */
  readonly endMs: number;
  /** G9: a pancake's fine-rubble heap (centre-relative; city/repose.ts) —
   * drawn and collided as the same triangles — or null. It rises as the
   * pieces come to rest: `heapRise` is its share of full height at even
   * steps from `heapFrom` to `endMs` (ms after t0); `heapShareAt` reads it. */
  readonly heap: RubbleHeap | null;
  readonly heapFrom: number;
  readonly heapRise: Float32Array | null;
  /** DL1: what it was built with — gravity on its ballistic arcs, m/s²,
   * the landing squash, s, and the lead beat, ms (the defaults' constants
   * outside a Destruction Lab). Posing reads these, never a tuning. */
  readonly g: number;
  readonly squashS: number;
  readonly leadMs: number;
  /** Everything the debris ever covers (centre-relative), and its rest
   * boxes, for the per-event reject. */
  readonly bounds: LocalBox;
  readonly restBounds: LocalBox;
  /** DS1: the physics' poses when a physics room simulates this collapse
   * (city/physpose.ts) — then every pose and collision reads them instead
   * of the closed form above; null for an analytic collapse (multiplayer,
   * a far one, one over the body budget, a crane). */
  phys: PhysPoses | null;
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
  /** DS1: a physics pose — the box is rotated by the unit quaternion
   * (qx, qy, qz, qw), not by `phi` about `axis`. */
  quat: boolean;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
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
  quat: false,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
});

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
 * after its start. Writes centre, angle and half height (the standing one,
 * but for a storey being crushed); hx / hz are the standing ones. */
function flight(c: Collapse, i: number, out: PiecePose): void {
  const tau = flightAt.tau;
  const v0 = c.v0[i] as number;
  const g = c.dg[i] as number;
  out.hy = c.hy[i] as number;
  if (c.mode[i] === MODE_DROP) {
    out.x = c.ox[i] as number;
    out.z = c.oz[i] as number;
    const k1 = c.crush[i] as number;
    if (k1 > 0) {
      // A crushed storey: its top rides the front down, its base holds…
      const base = (c.oy[i] as number) - (c.hy[i] as number);
      out.phi = 0;
      if (tau < k1) {
        const top =
          (c.oy[i] as number) +
          (c.hy[i] as number) -
          v0 * tau -
          0.5 * g * tau * tau;
        out.y = (top + base) / 2;
        out.hy = (top - base) / 2;
        return;
      }
      // …then, crushed flat, it falls with the column.
      const dt = tau - k1;
      const v1 = v0 + g * k1;
      const h = c.chy[i] as number;
      out.y = base + h - v1 * dt - 0.5 * g * dt * dt;
      out.hy = h;
      return;
    }
    out.y = (c.oy[i] as number) - v0 * tau - 0.5 * g * tau * tau;
    out.phi = ((c.tilt[i] as number) * tau) / (tau + 1.5);
    return;
  }
  const tb = c.hbreak[i] as number;
  const sign = c.hsign[i] as number;
  if (tau < tb) {
    const phi = sign * 0.5 * (c.halpha[i] as number) * tau * tau;
    const px = c.hpx[i] as number;
    const py = c.hpy[i] as number;
    const pz = c.hpz[i] as number;
    rotate(
      c.axis[i] as number,
      phi,
      (c.ox[i] as number) - px,
      (c.oy[i] as number) - py,
      (c.oz[i] as number) - pz,
      rot,
    );
    out.x = px + rot.x;
    out.y = py + rot.y - v0 * tau - 0.5 * g * tau * tau;
    out.z = pz + rot.z;
    out.phi = phi;
    return;
  }
  const dt = tau - tb;
  out.x = (c.bx[i] as number) + (c.vx[i] as number) * dt;
  out.y = (c.by[i] as number) + (c.vy[i] as number) * dt - 0.5 * c.g * dt * dt;
  out.z = (c.bz[i] as number) + (c.vz[i] as number) * dt;
  out.phi = sign * ((c.hang[i] as number) + (c.homega[i] as number) * dt);
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
  poseClock.tMs = tMs;
  return poseNow(c, i, out);
}

/** poseNow()'s time. D10: the collision loop poses ~4× the pieces D3 did,
 * and a double handed to a call V8 does not inline is boxed (O5's rule) —
 * so the loop sets the clock once and poses with no double argument. */
const poseClock = PHYS_CLOCK;

/** D10: set the clock posePieceNow() poses at (once per frame, not once
 * per piece — the per-frame posing loops' allocation-free path). */
export function setPoseClock(tMs: number): void {
  poseClock.tMs = tMs;
}

/** piecePose at the clock setPoseClock() last set. */
export function posePieceNow(
  c: Collapse,
  i: number,
  out: PiecePose,
): PiecePose {
  return poseNow(c, i, out);
}

/** DS1: server ms from which collapse `c` lies still for good — its
 * closed-form end, or a physics collapse's final frame (+∞ until then). */
export const collapseSettledAt = (c: Collapse): number =>
  c.phys !== null ? c.phys.settledAt : c.t0 + c.endMs;

/** G9: the share of its full height collapse `c`'s heap stands at server
 * ms `tMs` (0 without a heap; 1 once the collapse lies still) — what the
 * renderer scales the mound by and the collision reads it at. */
export function heapShareAt(c: Collapse, tMs: number): number {
  const rise = c.heapRise;
  if (rise === null) return 0;
  const t = tMs - c.t0;
  if (t >= c.endMs) return 1;
  if (!(t > c.heapFrom)) return 0;
  const f = ((t - c.heapFrom) / (c.endMs - c.heapFrom)) * (rise.length - 1);
  const j = Math.floor(f);
  const a = rise[j] as number;
  return a + ((rise[j + 1] as number) - a) * (f - j);
}

/** piecePose at `poseClock.tMs`. */
function poseNow(c: Collapse, i: number, out: PiecePose): PiecePose {
  // DS1: a physics collapse poses from its frames (and a crane never is).
  if (c.phys !== null) return c.phys.pose(c, i, out);
  out.quat = false;
  const tau = (poseClock.tMs - c.t0) / 1000 - (c.start[i] as number);
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
  const squash = c.squashS + (c.slide[i] as number);
  if (tau >= land + squash) {
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
    out.hz = c.hz[i] as number;
    return out;
  }
  const u = (tau - land) / squash;
  const k = u * u * (3 - 2 * u);
  // D6: the lerp written out — a closure here was an allocation per
  // squashing piece per frame, and a helper call (not inlined this deep)
  // boxed each result.
  const lx = c.lx[i] as number;
  const ly = c.ly[i] as number;
  const lz = c.lz[i] as number;
  const hx = c.hx[i] as number;
  const hy = c.lhy[i] as number;
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

/** Piece `i`'s rest pose (an oriented box), into `out`. */
function restPose(c: Collapse, i: number, out: PiecePose): PiecePose {
  out.quat = false;
  out.x = c.rx[i] as number;
  out.y = c.ry[i] as number;
  out.z = c.rz[i] as number;
  out.hx = c.rhx[i] as number;
  out.hy = c.rhy[i] as number;
  out.hz = c.rhz[i] as number;
  out.axis = c.axis[i] as number;
  out.phi = c.rphi[i] as number;
  out.rest = true;
  return out;
}

/** Landing search step, s, then bisection to well under a millimetre. */
const LAND_STEP_S = 0.05;

/** The smallest t ≥ 0 with y0 − v·t − ½·g·t² ≤ level (y0 > level), or
 * Infinity when it never gets there (g = 0 and v ≤ 0). */
function dropTime(y0: number, v: number, g: number, level: number): number {
  const d = y0 - level;
  if (d <= 0) return 0;
  if (g <= 0) return v > 0 ? d / v : Number.POSITIVE_INFINITY;
  return (-v + Math.sqrt(v * v + 2 * g * d)) / g;
}

/** The range of a box's vertical half extent over tilts |φ| ≤ `max` about
 * `axis` (a·cos φ + b·sin φ peaks at atan(b / a)). */
function extentRange(
  axis: number,
  max: number,
  hx: number,
  hy: number,
  hz: number,
): { lo: number; hi: number } {
  const b = axis === 0 ? hz : hx;
  const at0 = hy;
  const atMax = vertExtent(axis, max, hx, hy, hz);
  const peak = max >= Math.atan2(b, hy) ? Math.hypot(hy, b) : atMax;
  return {
    lo: Math.min(at0, atMax),
    hi: Math.max(at0, atMax, peak),
  };
}

/**
 * First tau ≥ 0 at which piece `i`'s lowest point reaches `floor`. A DROP
 * and a ballistic arc fall on a parabola, so the landing lies between the
 * times its centre reaches floor + the largest and the smallest vertical
 * half extent its tilt allows: bracket there, step through the bracket (a
 * spinning piece can touch, lift and touch again) and bisect. A swing is
 * stepped from its start.
 */
function landingTime(c: Collapse, i: number, floor: number): number {
  const pose = blankPose();
  const hx = c.hx[i] as number;
  const hy = c.hy[i] as number;
  const hz = c.hz[i] as number;
  const axis = c.axis[i] as number;
  const gap = (tau: number) => {
    flightAt.tau = tau;
    flight(c, i, pose);
    return pose.y - vertExtent(axis, pose.phi, hx, pose.hy, hz) - floor;
  };
  if (gap(0) <= 0) return 0;
  const k1 = c.crush[i] as number;
  if (k1 > 0) {
    // A crushed storey lands once its base, crushed, has dropped to the
    // floor: a parabola from the end of its crush.
    const base = (c.oy[i] as number) - hy;
    const v1 = (c.v0[i] as number) + (c.dg[i] as number) * k1;
    return k1 + dropTime(base, v1, c.dg[i] as number, floor);
  }
  const search = (from: number, to: number): number => {
    let lo = from;
    let hi = Math.min(to, from + LAND_STEP_S);
    while (gap(hi) > 0) {
      if (hi >= to) return Number.NaN;
      lo = hi;
      hi = Math.min(to, hi + LAND_STEP_S);
    }
    for (let k = 0; k < 26; k++) {
      const mid = (lo + hi) / 2;
      if (gap(mid) > 0) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  // Nothing in this model falls for a minute: the backstop of the searches.
  const LAST = 60;
  if (c.mode[i] === MODE_DROP) {
    const tilt = Math.abs(c.tilt[i] as number);
    const r = extentRange(axis, tilt, hx, hy, hz);
    const y0 = c.oy[i] as number;
    const v = c.v0[i] as number;
    const g = c.dg[i] as number;
    const from = dropTime(y0, v, g, floor + r.hi);
    const to = Math.min(LAST, dropTime(y0, v, g, floor + r.lo) + LAND_STEP_S);
    const t = search(Math.min(from, to), to);
    return Number.isNaN(t) ? search(to, LAST) : t;
  }
  const tb = c.hbreak[i] as number;
  const swing = search(0, Math.min(tb, LAST));
  if (!Number.isNaN(swing)) return swing;
  // Ballistic from tb: y = by + vy·dt − ½·G·dt² (vy may point up).
  const r = Math.hypot(hx, hy, hz);
  const lo = Math.min(hx, hy, hz);
  const by = c.by[i] as number;
  const vy = -(c.vy[i] as number);
  const from = tb + dropTime(by, vy, c.g, floor + r);
  const to = Math.min(
    LAST,
    tb + dropTime(by, vy, c.g, floor + lo) + LAND_STEP_S,
  );
  const t = search(Math.max(tb, Math.min(from, to)), to);
  return Number.isNaN(t) ? search(Math.min(tb, LAST), LAST) : t;
}

/** D8: gap between a toppled building's fall-side face and its rubble, m. */
const REST_CLEAR = 0.3;

/** A small integer hash of (a, b, c) → a mulberry32 stream. */
const streamOf = (a: number, b: number, c: number) =>
  mulberry32(
    (Math.imul(a + 1, 0x9e3779b1) ^
      Math.imul(b + 0x632be5ab, 0x85ebca6b) ^
      Math.imul(c + 7, 0xc2b2ae35)) >>>
      0,
  );

/** Per-event deterministic stream: the event id, the chunk and the piece's
 * index in it — never a position. */
const pieceRand = (id: number, chunk: number, sub: number) =>
  streamOf(id, chunk, sub);

/** One piece as it stood: the chunk it came from, its tier and exposed
 * faces, centre (relative to the collapse's centre) and half extents; its
 * role, whether it is its solid's chain probe (and the solid's volume),
 * its index in the chunk, and — a sheet — the DIR_* it peels toward. */
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
  role: number;
  rep: number;
  vol: number;
  sub: number;
  face: number;
  /** DS1: MAT_* (city/structure.ts). */
  mat: number;
}

/** CUT_* bit of each DIR_* face (−x, +x, −z, +z) and of its opposite. */
const FACE_CUT = [CUT_NEG_X, CUT_POS_X, CUT_NEG_Z, CUT_POS_Z] as const;
const BACK_CUT = [CUT_POS_X, CUT_NEG_X, CUT_POS_Z, CUT_NEG_Z] as const;

/**
 * D10 pre-fracture: one chunk solid (centre-relative extents) as storey
 * slabs, maybe a facade sheet off the building's outline and maybe a column
 * segment — what falls instead of one 20 × 12 × 20 m block. Pure in the
 * building's shape and the chunk (never the event), so a tower always
 * breaks along the same lines. The pieces tile the solid (the column sits
 * inside the slabs, inset, like the steel in the concrete), so the standing
 * pose looks exactly like the chunk did.
 */
function fracture(
  b: Building,
  s: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number },
  solidCut: number,
  tier: number,
  chunk: number,
  solid: number,
  out: RawPiece[],
): void {
  let cut = solidCut;
  // DS1: a sheet is the building's facade, a slab its concrete.
  const facade = buildingFrame(b).material;
  const rand = streamOf(chunk, solid, 0x0d10);
  const sheetRoll = rand();
  const faceRoll = rand();
  const columnRoll = rand();
  const cornerRoll = rand();
  const g0 = tierGrids(b)[0] as TierGrid;
  const h = s.y1 - s.y0;
  const r = { ...s };
  const vol = (s.x1 - s.x0) * h * (s.z1 - s.z0);
  let sub = 0;
  let sheet: RawPiece | null = null;
  // A facade sheet: an original face on the street outline, wide enough to
  // leave a slab behind it.
  if (sheetRoll < T.sheetShare && h >= T.slabStorey) {
    const T = COLLAPSE_SHEET_THICK;
    const faces: number[] = [];
    const wide = s.x1 - s.x0 >= 2 * T + 2;
    const deep = s.z1 - s.z0 >= 2 * T + 2;
    if (wide && !(cut & CUT_NEG_X) && s.x0 <= -g0.width / 2 + 0.5)
      faces.push(DIR_NEG_X);
    if (wide && !(cut & CUT_POS_X) && s.x1 >= g0.width / 2 - 0.5)
      faces.push(DIR_POS_X);
    if (deep && !(cut & CUT_NEG_Z) && s.z0 <= -g0.depth / 2 + 0.5)
      faces.push(DIR_NEG_Z);
    if (deep && !(cut & CUT_POS_Z) && s.z1 >= g0.depth / 2 - 0.5)
      faces.push(DIR_POS_Z);
    if (faces.length > 0) {
      const face = faces[Math.floor(faceRoll * faces.length)] as number;
      const box = { ...r };
      if (face === DIR_NEG_X) {
        box.x1 = r.x0 + T;
        r.x0 = box.x1;
      } else if (face === DIR_POS_X) {
        box.x0 = r.x1 - T;
        r.x1 = box.x0;
      } else if (face === DIR_NEG_Z) {
        box.z1 = r.z0 + T;
        r.z0 = box.z1;
      } else {
        box.z0 = r.z1 - T;
        r.z1 = box.z0;
      }
      sheet = {
        chunk,
        tier,
        // Its outer face is the facade; its inner face is the building's
        // insides, now open.
        cut: (cut | (BACK_CUT[face] as number)) & ~(FACE_CUT[face] as number),
        x: (box.x0 + box.x1) / 2,
        y: (box.y0 + box.y1) / 2,
        z: (box.z0 + box.z1) / 2,
        hx: (box.x1 - box.x0) / 2,
        hy: (box.y1 - box.y0) / 2,
        hz: (box.z1 - box.z0) / 2,
        role: ROLE_SHEET,
        // A sheet flies its own path: it probes for itself.
        rep: 1,
        vol: (box.x1 - box.x0) * (box.y1 - box.y0) * (box.z1 - box.z0),
        sub: 0,
        face,
        mat: facade,
      };
      // What the sheet came off now shows the gutted storeys there.
      cut |= FACE_CUT[face] as number;
    }
  }
  // Storey slabs, bottom-up.
  // DL1: × (1 + slabGrowth · height / 300 m) — exactly the slab height
  // while slabGrowth is 0 (the default).
  const slab = T.slabStorey * (1 + T.slabGrowth * (b.height / 300));
  const k = Math.max(1, Math.round(h / slab));
  const mid = Math.floor(k / 2);
  for (let j = 0; j < k; j++) {
    const y0 = r.y0 + (h * j) / k;
    const y1 = j === k - 1 ? r.y1 : r.y0 + (h * (j + 1)) / k;
    let c = cut;
    if (j > 0) c |= CUT_NEG_Y;
    if (j < k - 1) c |= CUT_POS_Y;
    out.push({
      chunk,
      tier,
      cut: c,
      x: (r.x0 + r.x1) / 2,
      y: (y0 + y1) / 2,
      z: (r.z0 + r.z1) / 2,
      hx: (r.x1 - r.x0) / 2,
      hy: (y1 - y0) / 2,
      hz: (r.z1 - r.z0) / 2,
      role: ROLE_SLAB,
      rep: j === mid ? 1 : 0,
      vol: j === mid ? vol : 0,
      sub: sub++,
      face: -1,
      mat: MAT_CONCRETE,
    });
  }
  if (sheet) {
    sheet.sub = sub++;
    out.push(sheet);
  }
  // A column / I-beam segment in one corner, inset (hidden while it
  // stands; it is the steel left sticking out of the pile).
  const side = COLLAPSE_COLUMN_SIDE;
  if (
    columnRoll < T.columnShare &&
    r.x1 - r.x0 >= 4 * side &&
    r.z1 - r.z0 >= 4 * side &&
    h >= T.slabStorey
  ) {
    const corner = Math.floor(cornerRoll * 4);
    const inset = 0.4;
    const cx = corner & 1 ? r.x1 - inset - side / 2 : r.x0 + inset + side / 2;
    const cz = corner & 2 ? r.z1 - inset - side / 2 : r.z0 + inset + side / 2;
    out.push({
      chunk,
      tier,
      cut:
        CUT_NEG_X |
        CUT_POS_X |
        CUT_NEG_Y |
        CUT_POS_Y |
        CUT_NEG_Z |
        CUT_POS_Z |
        CUT_STEEL,
      x: cx,
      y: (s.y0 + s.y1) / 2,
      z: cz,
      hx: side / 2,
      hy: h / 2 - 0.2,
      hz: side / 2,
      role: ROLE_COLUMN,
      rep: 0,
      vol: 0,
      sub: sub++,
      face: -1,
      mat: MAT_STEEL,
    });
  }
}

/**
 * The debris of one collapse — a pure function of the wire and the city's
 * generated shape (never its live damage), so the server, every live client
 * and every late joiner build the same pieces bit for bit. Null when the
 * wire names no real chunk of a real building.
 */
export function buildCollapse(
  buildings: readonly Building[],
  wire: CollapseWire,
  tuning: Readonly<DestructionTuning> = DEFAULT_DESTRUCTION_TUNING,
): Collapse | null {
  if (tuning !== T)
    return withTuning(tuning, () => buildCollapse(buildings, wire, tuning));
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

  // Pieces: each chunk's generated solid volume, pre-fractured.
  const raw: RawPiece[] = [];
  for (const id of chunks) {
    const solids = cellSolids(b, chunkTier(id), chunkCell(id));
    for (let j = 0; j < solids.length; j++) {
      const s = solids[j] as SolidBox;
      fracture(
        b,
        {
          x0: s.dx - s.width / 2,
          x1: s.dx + s.width / 2,
          y0: s.baseY,
          y1: s.baseY + s.height,
          z0: s.dz - s.depth / 2,
          z1: s.dz + s.depth / 2,
        },
        s.cut,
        s.tierIndex,
        id,
        j,
        raw,
      );
    }
  }
  if (raw.length === 0) return null;
  let base = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (const p of raw) {
    base = Math.min(base, p.y - p.hy);
    top = Math.max(top, p.y + p.hy);
  }
  if (style === PANCAKE && top > base) {
    // G9: a pancake's lower storeys end deep in its heap, and their column
    // stubs are hidden in the slabs until then: never seen, they go.
    for (let k = raw.length - 1; k >= 0; k--) {
      const p = raw[k] as RawPiece;
      if (p.role === ROLE_COLUMN && (p.y - base) / (top - base) < COLUMN_KEEP)
        raw.splice(k, 1);
    }
  }
  const f = wire.f;
  let fail =
    style === PANCAKE && typeof f === "number" && Number.isFinite(f)
      ? Math.min(top, Math.max(base, Math.round(f) / 10))
      : base;
  if (style === PANCAKE) {
    // H1: the wire carries whole decimetres, but a storey edge need not be
    // one (a 317 m tier's 26 floors are 12.19 m each). Snap back to the
    // piece edge the wire names, or the block's bottom slab — standing
    // exactly on the failure — would read as crushed under it and the
    // column would pass through itself.
    let snap = Number.POSITIVE_INFINITY;
    for (const p of raw) {
      for (const e of [p.y - p.hy, p.y + p.hy]) {
        if (Math.abs(e - fail) < Math.abs(snap - fail)) snap = e;
      }
    }
    if (Math.abs(snap - fail) <= 0.05 + 1e-9) fail = snap;
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
      fail,
      chunks,
    },
    null,
  );
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
  fail: number;
  chunks: readonly number[];
}

/** Rotation axis and sign that tip a top toward DIR_* `d` (signs: +φ about
 * z tips the top toward −x; +φ about x tips it toward +z). */
const hingeAxis = (d: number) => (d === DIR_NEG_X || d === DIR_POS_X ? 1 : 0);
const hingeSign = (d: number) =>
  d === DIR_POS_X ? -1 : d === DIR_NEG_X ? 1 : d === DIR_POS_Z ? 1 : -1;

/** Break piece `i`'s hinge off at its `hbreak`: centre and velocity there
 * (ω × r, plus a dropping pivot's own fall), keeping `drift` of the
 * horizontal part. */
function breakUp(c: Draft, i: number, drift = 1): void {
  const axis = c.axis[i] as number;
  const sign = c.hsign[i] as number;
  const alpha = c.halpha[i] as number;
  const tb = c.hbreak[i] as number;
  const v0 = c.v0[i] as number;
  const g = c.dg[i] as number;
  const ang = 0.5 * alpha * tb * tb;
  const omega = alpha * tb;
  c.hang[i] = ang;
  c.homega[i] = omega;
  const px = c.hpx[i] as number;
  const py = c.hpy[i] as number;
  const pz = c.hpz[i] as number;
  rotate(
    axis,
    sign * ang,
    (c.ox[i] as number) - px,
    (c.oy[i] as number) - py,
    (c.oz[i] as number) - pz,
    rot,
  );
  c.bx[i] = px + rot.x;
  c.by[i] = py + rot.y - v0 * tb - 0.5 * g * tb * tb;
  c.bz[i] = pz + rot.z;
  const w = sign * omega;
  const fall = v0 + g * tb;
  if (axis === 0) {
    // k = +x: k × r = (0, −r.z, r.y)
    c.vx[i] = 0;
    c.vy[i] = -w * rot.z - fall;
    c.vz[i] = w * rot.y * drift;
  } else {
    // k = +z: k × r = (−r.y, r.x, 0)
    c.vx[i] = -w * rot.y * drift;
    c.vy[i] = w * rot.x - fall;
    c.vz[i] = 0;
  }
}

/** G9 heaps: the closed-form mound's grid cell, m, and most cells a side
 * (it is drawn whole: 4 m holds a supertall's to ~3k triangles); its crest, as a share of the stack it slumps from (about the
 * stack's volume, spread out at the angle of repose); the share of upper
 * plates that spill out past its toe into the street; a plate's share of
 * its storey's bay (seeded, per side); how far a plate is jostled on the
 * plan, a share of its bay; and the slide down the pile, m/s, and its
 * longest, s. */
const HEAP_CELL_M = 4;
const HEAP_CELLS_MAX = 96;
const HEAP_CREST = 0.55;
const HEAP_SPILL = 0.08;
const PLATE_MIN = 0.4;
const PLATE_SPAN = 0.35;
const PLATE_JOSTLE = 0.4;
const SLIDE_SPEED = 9;
const SLIDE_MAX_S = 2.5;
/** Most a plate lies tilted, rad (~46°: steeper than the pile, it slid). */
const PLATE_TILT_MAX = 0.8;
/** Steps of a heap's rise table. */
const HEAP_RISE_STEPS = 16;
/** A pancake keeps the column stubs of its upper storeys only (a share of
 * its height): the lower ones are buried in the heap. */
const COLUMN_KEEP = 0.5;

/**
 * G9: a PANCAKE's heap and its pieces' rest poses on it. `floor` is the
 * stack each piece lands on (D10's: bottom-up, slab on slab). The stack
 * slumps to the angle of repose: its heights, × HEAP_CREST, become the
 * pile `reposeMound` spreads; then every slab and column gets a rest pose
 * on that mound — a slab as a broken plate (a seeded share of its bay),
 * jostled, the upper storeys pushed out down the flanks (a few out into
 * the street), tilted to the slope under it, and buried by how low in the
 * stack it was. A slab's rest box is written here (`rx`… `az`, and the
 * axis it tilts about); a column's centre on the plan (`rx`, `rz`) — its
 * box is sized at landing, as before. Returns each piece's share of the
 * heap's height (what the heap stands at once it is at rest), or null for
 * no heap (nothing stacked).
 */
function planHeap(
  c: Draft,
  floor: Float64Array,
  raw: readonly RawPiece[],
): Float64Array | null {
  const n = c.n;
  let stack = 0;
  let fx0 = Number.POSITIVE_INFINITY;
  let fx1 = Number.NEGATIVE_INFINITY;
  let fz0 = Number.POSITIVE_INFINITY;
  let fz1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    if (c.role[i] !== ROLE_SLAB) continue;
    stack = Math.max(
      stack,
      (floor[i] as number) + 2 * (c.hy[i] as number) * T.rubbleRatio,
    );
    fx0 = Math.min(fx0, (c.ox[i] as number) - (c.hx[i] as number));
    fx1 = Math.max(fx1, (c.ox[i] as number) + (c.hx[i] as number));
    fz0 = Math.min(fz0, (c.oz[i] as number) - (c.hz[i] as number));
    fz1 = Math.max(fz1, (c.oz[i] as number) + (c.hz[i] as number));
  }
  if (!(stack > 0.5)) return null;
  const fit = reposeFit(HEAP_CREST * stack, reposeSlope(c.id));
  const slope = fit.slope;
  const crest = fit.crest;
  const run = crest / slope;
  const heap = heapGrid(
    fx0,
    fx1,
    fz0,
    fz1,
    run + 2 * HEAP_CELL_M,
    HEAP_CELL_M,
    HEAP_CELLS_MAX,
  );
  for (let i = 0; i < n; i++) {
    if (c.role[i] !== ROLE_SLAB) continue;
    const ox = c.ox[i] as number;
    const oz = c.oz[i] as number;
    const hx = c.hx[i] as number;
    const hz = c.hz[i] as number;
    const top = (floor[i] as number) + 2 * (c.hy[i] as number) * T.rubbleRatio;
    pileBox(heap, ox - hx, ox + hx, oz - hz, oz + hz, (crest * top) / stack);
  }
  reposeMound(heap, slope, c.id, crest + 1);
  c.heap = heap;
  const fcx = (fx0 + fx1) / 2;
  const fcz = (fz0 + fz1) / 2;
  const hwx = Math.max(1, (fx1 - fx0) / 2);
  const hwz = Math.max(1, (fz1 - fz0) / 2);
  const lo = heap.cell;
  const xHi = heap.x0 + heap.nx * heap.cell - lo;
  const zHi = heap.z0 + heap.nz * heap.cell - lo;
  const surface = (x: number, z: number) => Math.max(0, heapHeight(heap, x, z));
  const share = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const role = c.role[i] as number;
    if (role === ROLE_SHEET) continue;
    const p = raw[i] as RawPiece;
    const rand = pieceRand(c.id ^ 0x4ea9, p.chunk, p.sub);
    const ox = c.ox[i] as number;
    const oz = c.oz[i] as number;
    const hx = c.hx[i] as number;
    const hy = c.hy[i] as number;
    const hz = c.hz[i] as number;
    // Its storey's place in the stack: 0 at the bottom, 1 on top.
    const u = Math.min(1, (floor[i] as number) / stack);
    const nx = (ox - fcx) / hwx;
    const nz = (oz - fcz) / hwz;
    let x = ox + (rand() - 0.5) * 2 * PLATE_JOSTLE * hx;
    let z = oz + (rand() - 0.5) * 2 * PLATE_JOSTLE * hz;
    if (role === ROLE_SLAB && u > 0.4 && rand() < HEAP_SPILL) {
      // Spilled: out to the toe on the side it was nearest.
      const far = run * (0.6 + 0.4 * rand());
      if (Math.abs(nx) >= Math.abs(nz)) x = fcx + Math.sign(nx) * (hwx + far);
      else z = fcz + Math.sign(nz) * (hwz + far);
    } else {
      // The upper storeys slide furthest, an edge bay out down its flank.
      const out = run * u * rand() * (role === ROLE_COLUMN ? 0.6 : 1);
      x += Math.sign(nx) * nx * nx * out;
      z += Math.sign(nz) * nz * nz * out;
    }
    x = Math.min(xHi, Math.max(heap.x0 + lo, x));
    z = Math.min(zHi, Math.max(heap.z0 + lo, z));
    const ground = surface(x, z);
    // Buried by how low in the stack it was (the top third of the storeys
    // lie on it, in a jumble).
    const depth = (1 - u) ** 3 * ground;
    share[i] = ground > 0 ? (ground - depth) / Math.max(ground, heap.top) : 0;
    c.rx[i] = x;
    c.rz[i] = z;
    if (role !== ROLE_SLAB) {
      // A column: on the mound where it lands (its box is sized later).
      c.ry[i] = ground - depth;
      continue;
    }
    // A broken plate: a seeded share of the bay, about as thick as the
    // crushed storey.
    const rhx = hx * (PLATE_MIN + PLATE_SPAN * rand());
    const rhz = hz * (PLATE_MIN + PLATE_SPAN * rand());
    const rhy = Math.max(0.2, hy * T.rubbleRatio * (0.7 + 0.6 * rand()));
    // Tilted to the slope under it (from the mound a cell either side),
    // about the axis across its steeper fall, then jostled ±14°. On the
    // crest it lies at whatever angle it came down at.
    const g = 2 * heap.cell;
    const gx = (surface(x + g, z) - surface(x - g, z)) / (2 * g);
    const gz = (surface(x, z + g) - surface(x, z - g)) / (2 * g);
    let axis: number;
    let phi: number;
    if (Math.abs(gx) + Math.abs(gz) < 0.08) {
      axis = rand() < 0.5 ? 0 : 1;
      phi = (rand() - 0.5) * 0.9;
    } else if (Math.abs(gx) >= Math.abs(gz)) {
      // +phi about z raises the +x edge.
      axis = 1;
      phi = Math.atan(gx);
    } else {
      // +phi about x lowers the +z edge.
      axis = 0;
      phi = -Math.atan(gz);
    }
    phi += (rand() - 0.5) * 0.5;
    phi = Math.max(-PLATE_TILT_MAX, Math.min(PLATE_TILT_MAX, phi));
    c.axis[i] = axis;
    c.rhx[i] = rhx;
    c.rhy[i] = rhy;
    c.rhz[i] = rhz;
    c.rphi[i] = phi;
    const cs = Math.abs(Math.cos(phi));
    const sn = Math.abs(Math.sin(phi));
    c.ax[i] = axis === 1 ? cs * rhx + sn * rhy : rhx;
    c.ay[i] = vertExtent(axis, phi, rhx, rhy, rhz);
    c.az[i] = axis === 0 ? sn * rhy + cs * rhz : rhz;
    // Half buried in the mound at its depth (never through the street).
    c.ry[i] = Math.max(
      c.ay[i] as number,
      ground - depth + rhy * (1.4 * rand() - 0.6),
    );
  }
  return share;
}

/**
 * Trajectories, landings, rest boxes and bounds for `raw` — the shared
 * second half of a building section's and (D5) a crane's debris. A topple
 * pivots on the base edge of the pieces on the fall side, or on
 * `pivotEdge` (the fall-axis coordinate) when given: a crane tips over its
 * mast foot, not the tip of its jib (and breaks up all at once — it is one
 * lattice, not a stack of floors).
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
    fail: meta.fail,
    chunks: meta.chunks,
    n,
    chunk: Int32Array.from(raw, (p) => p.chunk),
    tier: Uint8Array.from(raw, (p) => p.tier),
    cut: Uint8Array.from(raw, (p) => p.cut),
    role: Uint8Array.from(raw, (p) => p.role),
    mode: new Uint8Array(n),
    rep: Uint8Array.from(raw, (p) => p.rep),
    vol: Float64Array.from(raw, (p) => p.vol),
    mat: Uint8Array.from(raw, (p) => p.mat),
    ox: Float64Array.from(raw, (p) => p.x),
    oy: Float64Array.from(raw, (p) => p.y),
    oz: Float64Array.from(raw, (p) => p.z),
    hx: Float64Array.from(raw, (p) => p.hx),
    hy: Float64Array.from(raw, (p) => p.hy),
    hz: Float64Array.from(raw, (p) => p.hz),
    start: f64(),
    axis: new Uint8Array(n),
    tilt: f64(),
    v0: f64(),
    dg: f64(),
    crush: f64(),
    chy: f64(),
    lhy: f64(),
    hpx: f64(),
    hpy: f64(),
    hpz: f64(),
    hsign: f64(),
    halpha: f64(),
    hbreak: f64(),
    hang: f64(),
    homega: f64(),
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
    slide: f64(),
    endMs: 0,
    heap: null,
    heapFrom: 0,
    heapRise: null,
    g: T.gravity,
    squashS: T.squashMs / 1000,
    leadMs: T.leadMs,
    bounds: { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 },
    restBounds: { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 },
    phys: null,
  };
  const lead = T.leadMs / 1000;
  const G = T.gravity;
  const SQUASH_S = c.squashS;
  let base = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    base = Math.min(base, (c.oy[i] as number) - (c.hy[i] as number));
    top = Math.max(top, (c.oy[i] as number) + (c.hy[i] as number));
  }
  /** Rest floor per piece (pancake stacks; everything else lands on the
   * ground). */
  const floor = f64();
  const rands = raw.map((p) => pieceRand(meta.id, p.chunk, p.sub));
  /** G9: each piece's share of its heap's height at rest (null: no heap). */
  let heapShare: Float64Array | null = null;

  if (style === PANCAKE) {
    // Progressive collapse: the creep, then the upper block lets go and
    // drives down from the failure height at the column's effective g. A
    // storey under it is reached when the block — less the storeys already
    // crushed flat under it in that column (`off`) — comes down to its top;
    // it is crushed (its top rides the block down, its base holds) to
    // COLLAPSE_RUBBLE_RATIO of its height, then falls with the column. Each
    // storey is reached a little sooner than the last: they give way one
    // after another, faster and faster, and the column never passes
    // through itself.
    const gc = T.crushG * G;
    const release = lead + T.creepMs / 1000;
    const failY = meta.fail;
    const off = f64();
    for (let i = 0; i < n; i++) {
      const bottom = (c.oy[i] as number) - (c.hy[i] as number);
      if (bottom >= failY - 1e-6) continue;
      const top = (c.oy[i] as number) + (c.hy[i] as number);
      for (let k = 0; k < n; k++) {
        if (k === i || c.role[k] !== ROLE_SLAB) continue;
        const kb = (c.oy[k] as number) - (c.hy[k] as number);
        const kt = (c.oy[k] as number) + (c.hy[k] as number);
        if (kb >= failY - 1e-6 || kt <= top + 1e-6) continue;
        if (
          Math.min(
            (c.ox[i] as number) + (c.hx[i] as number),
            (c.ox[k] as number) + (c.hx[k] as number),
          ) -
            Math.max(
              (c.ox[i] as number) - (c.hx[i] as number),
              (c.ox[k] as number) - (c.hx[k] as number),
            ) <=
            1e-6 ||
          Math.min(
            (c.oz[i] as number) + (c.hz[i] as number),
            (c.oz[k] as number) + (c.hz[k] as number),
          ) -
            Math.max(
              (c.oz[i] as number) - (c.hz[i] as number),
              (c.oz[k] as number) - (c.hz[k] as number),
            ) <=
            1e-6
        ) {
          continue;
        }
        off[i] = (off[i] as number) + 2 * (c.hy[k] as number) * T.rubbleRatio;
      }
    }
    for (let i = 0; i < n; i++) {
      const rand = rands[i] as () => number;
      const role = c.role[i] as number;
      const hx = c.hx[i] as number;
      const hz = c.hz[i] as number;
      const axis = rand() < 0.5 ? 0 : 1;
      // Slabs drop nearly flat (an edge rises at most ~1 m); a column can
      // lean as far as today's chunks did.
      const across = axis === 0 ? hz : hx;
      const amp =
        role === ROLE_COLUMN
          ? T.pancakeTilt
          : Math.min(T.pancakeTilt, 1 / Math.max(1, across));
      c.axis[i] = axis;
      c.tilt[i] = (rand() * 2 - 1) * amp;
      const pieceTop = (c.oy[i] as number) + (c.hy[i] as number);
      const bottom = (c.oy[i] as number) - (c.hy[i] as number);
      const crushed = bottom < failY - 1e-6;
      // How far the block has come down when it reaches this piece.
      const reach = crushed
        ? Math.max(0, failY - (off[i] as number) - pieceTop)
        : 0;
      c.start[i] = release + Math.sqrt((2 * reach) / gc);
      c.v0[i] = Math.sqrt(2 * gc * reach);
      c.dg[i] = gc;
      c.mode[i] = MODE_DROP;
      if (crushed && role === ROLE_SLAB) {
        const h = 2 * (c.hy[i] as number);
        const flat = h * T.rubbleRatio;
        c.crush[i] =
          Math.sqrt((2 * (reach + h - flat)) / gc) -
          Math.sqrt((2 * reach) / gc);
        c.chy[i] = flat / 2;
        c.tilt[i] = 0;
      }
      if (role === ROLE_SHEET) {
        // A facade sheet peels outward off its own base edge as it goes,
        // that edge dropping with the storeys behind it.
        const face = (raw[i] as RawPiece).face;
        const ax = hingeAxis(face);
        c.mode[i] = MODE_HINGE;
        c.axis[i] = ax;
        c.tilt[i] = 0;
        c.hsign[i] = hingeSign(face);
        c.hpx[i] =
          face === DIR_POS_X
            ? (c.ox[i] as number) + hx
            : face === DIR_NEG_X
              ? (c.ox[i] as number) - hx
              : (c.ox[i] as number);
        c.hpy[i] = bottom;
        c.hpz[i] =
          face === DIR_POS_Z
            ? (c.oz[i] as number) + hz
            : face === DIR_NEG_Z
              ? (c.oz[i] as number) - hz
              : (c.oz[i] as number);
        c.halpha[i] = Math.min(
          COLLAPSE_TOPPLE_ALPHA_MAX,
          Math.max(
            COLLAPSE_TOPPLE_ALPHA_MIN,
            (T.toppleK * G) / Math.max(1, 2 * (c.hy[i] as number)),
          ),
        );
        c.hbreak[i] = Math.sqrt((2 * T.sheetBreak) / (c.halpha[i] as number));
        breakUp(c, i, T.sheetDrift);
      }
    }
    // Stack: bottom-up, each slab rests on the highest slab already placed
    // under its (untilted) footprint — pure geometry, no trig. Sheets land
    // in the street and columns stand in the pile: neither carries anything.
    const order = [...Array(n).keys()].sort(
      (p, q) =>
        (c.oy[p] as number) -
          (c.hy[p] as number) -
          ((c.oy[q] as number) - (c.hy[q] as number)) || p - q,
    );
    const placed: number[] = [];
    for (let a = 0; a < n; a++) {
      const i = order[a] as number;
      const role = c.role[i] as number;
      if (role === ROLE_SHEET) continue;
      let y = 0;
      const ix0 = (c.ox[i] as number) - (c.hx[i] as number);
      const ix1 = (c.ox[i] as number) + (c.hx[i] as number);
      const iz0 = (c.oz[i] as number) - (c.hz[i] as number);
      const iz1 = (c.oz[i] as number) + (c.hz[i] as number);
      for (let k = 0; k < placed.length; k++) {
        const j = placed[k] as number;
        const overlapX =
          Math.min(ix1, (c.ox[j] as number) + (c.hx[j] as number)) -
          Math.max(ix0, (c.ox[j] as number) - (c.hx[j] as number));
        if (overlapX <= 1e-6) continue;
        const overlapZ =
          Math.min(iz1, (c.oz[j] as number) + (c.hz[j] as number)) -
          Math.max(iz0, (c.oz[j] as number) - (c.hz[j] as number));
        if (overlapZ > 1e-6) {
          y = Math.max(
            y,
            (floor[j] as number) + 2 * (c.hy[j] as number) * T.rubbleRatio,
          );
        }
      }
      floor[i] = y;
      if (role === ROLE_SLAB) placed.push(i);
    }
    // G9: and the stack slumps into a heap.
    if (meta.kind === KIND_BUILDING) heapShare = planHeap(c, floor, raw);
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
    const axis = hingeAxis(dir);
    c.sign = hingeSign(dir);
    c.px = xAxisFall ? edge : 0;
    c.py = base;
    c.pz = xAxisFall ? 0 : edge;
    c.alpha = Math.min(
      COLLAPSE_TOPPLE_ALPHA_MAX,
      Math.max(
        COLLAPSE_TOPPLE_ALPHA_MIN,
        (T.toppleK * G) / Math.max(1, top - base),
      ),
    );
    c.omega = c.alpha * Math.sqrt((2 * T.toppleBreak) / c.alpha);
    let latest = 0;
    for (let i = 0; i < n; i++) {
      const rand = rands[i] as () => number;
      c.axis[i] = axis;
      c.start[i] = lead;
      c.mode[i] = MODE_HINGE;
      c.hpx[i] = c.px;
      c.hpy[i] = c.py;
      c.hpz[i] = c.pz;
      c.hsign[i] = c.sign;
      c.halpha[i] = c.alpha;
      // The section bends as it swings: its top breaks off first, its base
      // at today's angle (so nothing new swings over a stump). A crane is
      // one lattice and goes all at once.
      let brk = T.toppleBreak;
      if (pivotEdge === null && top > base) {
        const h01 = Math.min(
          1,
          Math.max(
            0,
            ((c.oy[i] as number) - (c.hy[i] as number) - base) / (top - base),
          ),
        );
        brk -=
          (T.toppleBreak - T.toppleBreakTop) * h01 * (0.75 + 0.25 * rand());
      }
      c.hbreak[i] = Math.sqrt((2 * brk) / c.alpha);
      latest = Math.max(latest, c.hbreak[i] as number);
      // D11: a building's chunks keep COLLAPSE_TOPPLE_DRIFT of the swing's
      // throw (a crane's lattice, one piece, keeps all of it).
      breakUp(c, i, pivotEdge === null ? T.toppleDrift : 1);
    }
    c.tBreak = latest;
  }

  // Landing and rest, per piece.
  const pose = blankPose();
  let end = 0;
  for (let i = 0; i < n; i++) {
    const rand = rands[i] as () => number;
    const role = c.role[i] as number;
    const land = landingTime(c, i, floor[i] as number);
    c.land[i] = land;
    flightAt.tau = land;
    flight(c, i, pose);
    c.lx[i] = pose.x;
    c.ly[i] = pose.y;
    c.lz[i] = pose.z;
    c.lphi[i] = pose.phi;
    c.lhy[i] = pose.hy;
    // G9: a heap's piece slides from where it landed to the pose planHeap
    // gave it (a slab's whole rest box; a column's place on the mound).
    const heaped = heapShare !== null && role !== ROLE_SHEET;
    const tx = c.rx[i] as number;
    const ty = c.ry[i] as number;
    const tz = c.rz[i] as number;
    if (heaped && role === ROLE_SLAB) {
      const slide = Math.min(
        SLIDE_MAX_S,
        Math.hypot(tx - pose.x, ty - pose.y, tz - pose.z) / SLIDE_SPEED,
      );
      c.slide[i] = slide;
      end = Math.max(end, (c.start[i] as number) + land + SQUASH_S + slide);
      continue;
    }
    const quarter = Math.round(pose.phi / HALF_PI);
    const odd = Math.abs(quarter) % 2 === 1;
    const axis = c.axis[i] as number;
    const hx = c.hx[i] as number;
    const hy = c.hy[i] as number;
    const hz = c.hz[i] as number;
    // The local axis that ends up vertical is squashed (a column keeps half
    // its height; nothing gets thicker than it was).
    const ratio = role === ROLE_COLUMN ? T.columnRubble : T.rubbleRatio;
    const upright = odd ? (axis === 1 ? hx : hz) : hy;
    const slab = Math.min(2 * upright, 2 * hy * ratio);
    c.rhx[i] = odd && axis === 1 ? slab / 2 : hx;
    c.rhy[i] = odd ? hy : slab / 2;
    c.rhz[i] = odd && axis === 0 ? slab / 2 : hz;
    // D10 slump: rubble settles a little askew about the axis it fell on —
    // the far edge of a slab rises at most COLLAPSE_SLUMP_RISE; a column
    // stub leans like the steel left standing in a pile.
    const across = odd
      ? (c.rhy[i] as number)
      : axis === 0
        ? (c.rhz[i] as number)
        : (c.rhx[i] as number);
    const sgn = rand() < 0.5 ? -1 : 1;
    const slump =
      role === ROLE_COLUMN && !odd
        ? sgn * T.columnLean * (0.4 + 0.6 * rand())
        : sgn *
          rand() *
          Math.min(T.slumpMax, T.slumpRise / Math.max(1, across));
    const phi = quarter * HALF_PI + slump;
    c.rphi[i] = phi;
    const cs = Math.abs(Math.cos(phi));
    const sn = Math.abs(Math.sin(phi));
    const rhx = c.rhx[i] as number;
    const rhy = c.rhy[i] as number;
    const rhz = c.rhz[i] as number;
    // World AABB of the slumped rest box.
    c.ax[i] = axis === 1 ? cs * rhx + sn * rhy : rhx;
    c.ay[i] = vertExtent(axis, phi, rhx, rhy, rhz);
    c.az[i] = axis === 0 ? sn * rhy + cs * rhz : rhz;
    c.rx[i] = pose.x;
    c.ry[i] = (floor[i] as number) + (c.ay[i] as number);
    c.rz[i] = pose.z;
    if (heaped) {
      // A column stub: two thirds of it out of the mound, leaning.
      c.rx[i] = tx;
      c.ry[i] = Math.max(c.ay[i] as number, ty + 0.4 * (c.ay[i] as number));
      c.rz[i] = tz;
      c.slide[i] = Math.min(
        SLIDE_MAX_S,
        Math.hypot(tx - pose.x, (c.ry[i] as number) - pose.y, tz - pose.z) /
          SLIDE_SPEED,
      );
    }
    // D8: a toppled building's rubble never comes to rest back over its own
    // footprint (behind the pivot edge) — the stump stands there, and rubble
    // lying on a chunk that can later be shot away would float. A slow piece
    // that drops short slides off over the edge as it squashes. D10: a
    // peeled facade sheet comes to rest out in the street the same way.
    let fall = -1;
    let edgeAt = 0;
    if (style === TOPPLE && pivotEdge === null) {
      fall = dir;
      edgeAt = dir === DIR_NEG_X || dir === DIR_POS_X ? c.px : c.pz;
    } else if (role === ROLE_SHEET) {
      fall = (raw[i] as RawPiece).face;
      edgeAt =
        fall === DIR_NEG_X || fall === DIR_POS_X
          ? (c.hpx[i] as number)
          : (c.hpz[i] as number);
    }
    if (fall >= 0) {
      const xFall = fall === DIR_NEG_X || fall === DIR_POS_X;
      const pos = fall === DIR_POS_X || fall === DIR_POS_Z;
      const half = (xFall ? c.ax[i] : c.az[i]) as number;
      const at = (xFall ? c.rx[i] : c.rz[i]) as number;
      const back = pos ? at - half : at + half;
      if (pos ? back < edgeAt + REST_CLEAR : back > edgeAt - REST_CLEAR) {
        const moved = pos
          ? edgeAt + REST_CLEAR + half
          : edgeAt - REST_CLEAR - half;
        if (xFall) c.rx[i] = moved;
        else c.rz[i] = moved;
      }
    }
    end = Math.max(
      end,
      (c.start[i] as number) + land + SQUASH_S + (c.slide[i] as number),
    );
  }
  c.endMs = end * 1000;
  if (heapShare !== null) riseHeap(c, heapShare);
  sweepBounds(c);
  return c;
}

/** G9: when `c`'s heap rises: from the first of its pieces at rest, to the
 * share of full height its highest piece at rest so far stands at (`share`,
 * planHeap's), all of it once the collapse lies still. */
function riseHeap(c: Draft, share: Float64Array): void {
  const at = new Float64Array(c.n);
  let from = Number.POSITIVE_INFINITY;
  for (let i = 0; i < c.n; i++) {
    if (c.role[i] === ROLE_SHEET) continue;
    at[i] =
      ((c.start[i] as number) +
        (c.land[i] as number) +
        c.squashS +
        (c.slide[i] as number)) *
      1000;
    from = Math.min(from, at[i] as number);
  }
  if (!(from < c.endMs)) from = 0;
  const rise = new Float32Array(HEAP_RISE_STEPS + 1);
  for (let j = 0; j <= HEAP_RISE_STEPS; j++) {
    const t = from + ((c.endMs - from) * j) / HEAP_RISE_STEPS;
    let k = j > 0 ? (rise[j - 1] as number) : 0;
    for (let i = 0; i < c.n; i++) {
      if (c.role[i] !== ROLE_SHEET && (at[i] as number) <= t) {
        k = Math.max(k, share[i] as number);
      }
    }
    rise[j] = Math.min(1, k);
  }
  rise[HEAP_RISE_STEPS] = 1;
  c.heapFrom = from;
  c.heapRise = rise;
}

/** Samples of a hinge's swing for the swept bounds. */
const SWING_SAMPLES = 12;

/**
 * Everything the debris ever covers (`bounds`) and its rest boxes
 * (`restBounds`), from the closed-form motion: a DROP is a vertical column
 * over its piece, a swing is sampled (padded by the furthest a point moves
 * between samples — an arc never strays further from its chord), a
 * ballistic arc is bounded by its ends and its apex, and the squash by its
 * two ends. Every box is padded by the piece's bounding radius.
 */
function sweepBounds(c: Draft): void {
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
  const pose = blankPose();
  for (let i = 0; i < c.n; i++) {
    const r =
      Math.hypot(c.hx[i] as number, c.hy[i] as number, c.hz[i] as number) + 1;
    const land = c.land[i] as number;
    grow(all, c.ox[i] as number, c.oy[i] as number, c.oz[i] as number, r);
    grow(all, c.lx[i] as number, c.ly[i] as number, c.lz[i] as number, r);
    if (c.mode[i] === MODE_HINGE) {
      const tb = Math.min(land, c.hbreak[i] as number);
      let px = c.ox[i] as number;
      let py = c.oy[i] as number;
      let pz = c.oz[i] as number;
      for (let k = 1; k <= SWING_SAMPLES; k++) {
        flightAt.tau = (tb * k) / SWING_SAMPLES;
        flight(c, i, pose);
        const step = Math.hypot(pose.x - px, pose.y - py, pose.z - pz);
        grow(all, pose.x, pose.y, pose.z, r + step);
        grow(all, px, py, pz, r + step);
        px = pose.x;
        py = pose.y;
        pz = pose.z;
      }
      if (land > tb) {
        // Ballistic: x and z are linear, y peaks once.
        const vy = c.vy[i] as number;
        const apex = vy / c.g;
        if (apex > 0 && tb + apex < land) {
          flightAt.tau = tb + apex;
          flight(c, i, pose);
          grow(all, pose.x, pose.y, pose.z, r);
        }
      }
    }
  }
  const rest = c.restBounds;
  rest.x0 = rest.y0 = rest.z0 = Number.POSITIVE_INFINITY;
  rest.x1 = rest.y1 = rest.z1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < c.n; i++) {
    const x = c.rx[i] as number;
    const y = c.ry[i] as number;
    const z = c.rz[i] as number;
    rest.x0 = Math.min(rest.x0, x - (c.ax[i] as number));
    rest.x1 = Math.max(rest.x1, x + (c.ax[i] as number));
    rest.y0 = Math.min(rest.y0, y - (c.ay[i] as number));
    rest.y1 = Math.max(rest.y1, y + (c.ay[i] as number));
    rest.z0 = Math.min(rest.z0, z - (c.az[i] as number));
    rest.z1 = Math.max(rest.z1, z + (c.az[i] as number));
    // The squash slides the landing box to the rest box.
    const r =
      Math.hypot(c.hx[i] as number, c.hy[i] as number, c.hz[i] as number) + 1;
    grow(all, x, y, z, r);
  }
  // G9: and the heap the rubble lies in.
  const heap = c.heap;
  if (heap !== null) {
    grow(rest, heap.x0, 0, heap.z0, 0);
    grow(
      rest,
      heap.x0 + heap.nx * heap.cell,
      heap.top,
      heap.z0 + heap.nz * heap.cell,
      0,
    );
  }
  grow(all, rest.x0, rest.y0, rest.z0, 0);
  grow(all, rest.x1, rest.y1, rest.z1, 0);
}

// --- D10 floor events --------------------------------------------------------

/** What a floor event is: the failure floor giving way, a storey crushed
 * by the front, a section breaking up in the air, debris landing. */
export const BEAT_GIVE = 0;
export const BEAT_CRUSH = 1;
export const BEAT_BREAK = 2;
export const BEAT_LAND = 3;

/** One beat of a collapse — squibs, roars and the ground's jolts key off
 * these. Position centre-relative (add the collapse's x/z). */
export interface FloorEvent {
  /** Ms after the collapse's t0. */
  t: number;
  x: number;
  y: number;
  z: number;
  /** 0..1: this beat's share of the biggest one. */
  size: number;
  /** BEAT_*. */
  kind: number;
}

const floorEventCache = new WeakMap<Collapse, readonly FloorEvent[]>();

/**
 * D10: `c`'s beats, in time order, at most COLLAPSE_FLOOR_EVENTS_MAX —
 * pure in the collapse (cached). Each piece contributes its volume to the
 * moment the front reaches it (a crushed storey), its break-up (a hinge)
 * and its landing; the failure floor giving way opens the list. Merged
 * into equal time bins over the collapse's span.
 */
export function collapseFloorEvents(c: Collapse): readonly FloorEvent[] {
  const hit = floorEventCache.get(c);
  if (hit) return hit;
  const raw: {
    t: number;
    x: number;
    y: number;
    z: number;
    w: number;
    k: number;
  }[] = [];
  const pose = blankPose();
  let first = Number.POSITIVE_INFINITY;
  for (let i = 0; i < c.n; i++) {
    const w =
      8 * (c.hx[i] as number) * (c.hy[i] as number) * (c.hz[i] as number);
    const start = (c.start[i] as number) * 1000;
    first = Math.min(first, start);
    const x = c.ox[i] as number;
    const z = c.oz[i] as number;
    if (c.style === PANCAKE && (c.v0[i] as number) > 0) {
      raw.push({
        t: start,
        x,
        y: (c.oy[i] as number) + (c.hy[i] as number),
        z,
        w,
        k: BEAT_CRUSH,
      });
    }
    const tb = c.hbreak[i] as number;
    if (c.mode[i] === MODE_HINGE && tb < (c.land[i] as number)) {
      raw.push({
        t: start + tb * 1000,
        x: c.bx[i] as number,
        y: c.by[i] as number,
        z: c.bz[i] as number,
        w: 0.5 * w,
        k: BEAT_BREAK,
      });
    }
    piecePose(c, i, Number.POSITIVE_INFINITY, pose);
    raw.push({
      t: start + (c.land[i] as number) * 1000,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      w,
      k: BEAT_LAND,
    });
  }
  let total = 0;
  for (const e of raw) total += e.w;
  raw.push({
    t: Number.isFinite(first) ? first : 0,
    x: 0,
    y: c.fail,
    z: 0,
    w: Math.max(1e-6, (0.25 * total) / Math.max(1, COLLAPSE_FLOOR_EVENTS_MAX)),
    k: BEAT_GIVE,
  });
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  for (const e of raw) {
    t0 = Math.min(t0, e.t);
    t1 = Math.max(t1, e.t);
  }
  // Equal time bins over the span, one set per kind (a beat's height is
  // that of what it is — a crushed storey is not averaged with a landing).
  const bins = COLLAPSE_FLOOR_EVENTS_MAX;
  const width = Math.max(1, (t1 - t0) / bins);
  type Acc = {
    t: number;
    x: number;
    y: number;
    z: number;
    w: number;
    k: number;
  };
  const acc = new Map<number, Acc>();
  for (const e of raw) {
    const slot = Math.min(bins - 1, Math.floor((e.t - t0) / width));
    const key = slot * 4 + e.k;
    let a = acc.get(key);
    if (!a) {
      a = { t: 0, x: 0, y: 0, z: 0, w: 0, k: e.k };
      acc.set(key, a);
    }
    a.t += e.t * e.w;
    a.x += e.x * e.w;
    a.y += e.y * e.w;
    a.z += e.z * e.w;
    a.w += e.w;
  }
  // The biggest COLLAPSE_FLOOR_EVENTS_MAX, always with the failure floor.
  const all = [...acc.entries()]
    .sort((p, q) => p[0] - q[0])
    .map(([, a]) => a)
    .filter((a) => a.w > 0);
  const keep = all
    .slice()
    .sort(
      (p, q) =>
        (q.k === BEAT_GIVE ? 1 : 0) - (p.k === BEAT_GIVE ? 1 : 0) || q.w - p.w,
    )
    .slice(0, COLLAPSE_FLOOR_EVENTS_MAX);
  let big = 0;
  for (const a of keep) big = Math.max(big, a.w);
  const out: FloorEvent[] = keep.map((a) => ({
    t: a.t / a.w,
    x: a.x / a.w,
    y: a.y / a.w,
    z: a.z / a.w,
    size: a.w / big,
    kind: a.k,
  }));
  out.sort((p, q) => p.t - q.t || p.kind - q.kind);
  floorEventCache.set(c, out);
  return out;
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
        role: ROLE_SLAB,
        rep: 1,
        vol:
          8 *
          (axis === 0 ? seg : hx) *
          (axis === 1 ? seg : hy) *
          (axis === 2 ? seg : hz),
        sub: raw.length,
        face: -1,
        mat: MAT_STEEL,
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
      fail: 0,
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
  /** D10: the blast's scale, CHAIN_ENERGY_MIN..MAX — the striking mass's
   * energy (√(volume · speed²) ÷ CHAIN_ENERGY_REF), clamped. */
  e: number;
  /** P1: the striking piece's velocity there, m/s, and its volume, m³ —
   * what it sweeps on into the building with (city/penetrate.ts). */
  vx: number;
  vy: number;
  vz: number;
  vol: number;
}

/** D10: an impact's blast scale for `vol` m³ arriving at `speed` m/s. */
export const impactScale = (
  vol: number,
  speed: number,
  tuning: Readonly<DestructionTuning> = T,
): number =>
  Math.min(
    tuning.chainEnergyMax,
    Math.max(
      tuning.chainEnergyMin,
      (Math.sqrt(Math.max(0, vol)) * Math.abs(speed)) / tuning.chainEnergyRef,
    ),
  );

/** Trajectory sampling step for collapseImpacts, s. */
const IMPACT_STEP_S = 0.1;

/**
 * D5: where collapse `c`'s falling pieces first drive into ANOTHER
 * building's standing chunks (a crane's debris: any building) — the instant
 * a piece's centre enters a chunk of it that still stands. A per-building
 * AABB reject against the debris' swept bounds, then each probe piece (D10:
 * one per chunk solid — its pieces fall together — and each sheet) sampled
 * every IMPACT_STEP_S until it lands; its energy there scales the blast. Coalesced: per building at most
 * CHAIN_IMPACTS_PER_BUILDING impacts at least CHAIN_COALESCE_M apart, and
 * CHAIN_IMPACTS_MAX in all, earliest first. Pure in (c, buildings' shape
 * and damage); the server lands each one as a D2 blast at its instant.
 */
export function collapseImpacts(
  c: Collapse,
  buildings: readonly Building[],
  tuning: Readonly<DestructionTuning> = DEFAULT_DESTRUCTION_TUNING,
): CollapseImpact[] {
  if (tuning !== T)
    return withTuning(tuning, () => collapseImpacts(c, buildings, tuning));
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
  const ahead = blankPose();
  for (let p = 0; p < c.n; p++) {
    if (!c.rep[p]) continue;
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
        // D10: the footprint reject before the grid lookup (most samples
        // of a long topple are nowhere near most of its neighbours).
        if (
          local.y > b.height ||
          Math.abs(local.x) > b.width / 2 ||
          Math.abs(local.z) > b.depth / 2
        ) {
          continue;
        }
        const at = chunkAt(b, local);
        if (!at || chunkMask(b)[at.tier]?.[at.cell] !== 1) continue;
        if (b.damage?.cells[at.tier]?.[at.cell]) continue;
        hit.add(n.i);
        const w = canonicalize({ x: c.x + pose.x, y: 0, z: c.z + pose.z });
        piecePose(c, p, tMs + 50, ahead);
        const vx = (ahead.x - pose.x) / 0.05;
        const vy = (ahead.y - pose.y) / 0.05;
        const vz = (ahead.z - pose.z) / 0.05;
        // The D10 scale reads exactly the speed it always did (bit-equal).
        const speed =
          Math.hypot(ahead.x - pose.x, ahead.y - pose.y, ahead.z - pose.z) /
          0.05;
        found.push({
          t: tMs,
          building: n.i,
          x: w.x,
          y: pose.y,
          z: w.z,
          e: impactScale(c.vol[p] as number, speed),
          vx,
          vy,
          vz,
          vol: c.vol[p] as number,
        });
      }
    }
  }
  found.sort((a, b) => a.t - b.t || a.building - b.building);
  const out: CollapseImpact[] = [];
  for (const f of found) {
    if (out.length >= T.chainImpactsMax) break;
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
    if (close || same >= T.chainImpactsPerBuilding) continue;
    out.push(f);
  }
  return out;
}

// --- Collision -------------------------------------------------------------

/** What a collapse collision reports. Allocated only on a hit. */
export interface CollapseHit {
  collapse: Collapse;
  /** The piece hit, or (DS1, G9) −1 for the collapse's rubble heap. */
  piece: number;
  /** The piece was still moving (or about to): falling debris, not rubble. */
  falling: boolean;
}

const scratchPose = blankPose();

/** Does a sphere at (dx, dy, dz) from the box centre touch the oriented
 * box? (D9's falling props test exactly this against their own poses.) */
export function sphereHitsPiece(
  p: PiecePose,
  dx: number,
  dy: number,
  dz: number,
  radius: number,
): boolean {
  // Into the piece's frame: rotate by −phi about its axis (DS1: or by the
  // physics pose's conjugate quaternion).
  let lx = dx;
  let ly = dy;
  let lz = dz;
  if (p.quat) {
    // v' = q* v q: t = 2 (−q⃗ × v); v' = v + w t + (−q⃗) × t.
    const qx = -p.qx;
    const qy = -p.qy;
    const qz = -p.qz;
    const qw = p.qw;
    const tx = 2 * (qy * dz - qz * dy);
    const ty = 2 * (qz * dx - qx * dz);
    const tz = 2 * (qx * dy - qy * dx);
    lx = dx + qw * tx + (qy * tz - qz * ty);
    ly = dy + qw * ty + (qz * tx - qx * tz);
    lz = dz + qw * tz + (qx * ty - qy * tx);
  } else if (p.phi !== 0) {
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
    // DS1: a physics collapse — its frames at this clock, and its heap.
    const phys = c.phys;
    if (phys !== null) {
      if (phys.heap !== null && !fallingOnly) {
        const k = phys.heapShare(tMs);
        if (k > 0 && sphereHitsHeap(phys.heap, dx, pos.y, dz, radius, k)) {
          return { collapse: c, piece: -1, falling: false };
        }
      }
      if (outside(phys.bounds, dx, pos.y, dz, radius + phys.reach)) continue;
      poseClock.tMs = tMs;
      for (let i = 0; i < c.n; i++) {
        const p = poseNow(c, i, scratchPose);
        if (fallingOnly && p.rest) continue;
        const bound =
          Math.sqrt(p.hx * p.hx + p.hy * p.hy + p.hz * p.hz) + radius;
        const ox = dx - p.x;
        const oy = pos.y - p.y;
        const oz = dz - p.z;
        if (ox * ox + oy * oy + oz * oz > bound * bound) continue;
        if (sphereHitsPiece(p, ox, oy, oz, radius)) {
          return { collapse: c, piece: i, falling: !p.rest };
        }
      }
      continue;
    }
    // G9: a pancake's heap, at the height it has risen to.
    const heap = c.heap;
    if (heap !== null && !fallingOnly) {
      const k = heapShareAt(c, tMs);
      if (k > 0 && sphereHitsHeap(heap, dx, pos.y, dz, radius, k)) {
        return { collapse: c, piece: -1, falling: false };
      }
    }
    if (tMs >= c.t0 + c.endMs) {
      if (fallingOnly || outside(c.restBounds, dx, pos.y, dz, radius)) continue;
      for (let i = 0; i < c.n; i++) {
        // The rest box's AABB first, then (D10: rubble lies slumped) the
        // oriented box itself.
        const ox = dx - (c.rx[i] as number);
        const oy = pos.y - (c.ry[i] as number);
        const oz = dz - (c.rz[i] as number);
        const ex = Math.max(0, Math.abs(ox) - (c.ax[i] as number));
        const ey = Math.max(0, Math.abs(oy) - (c.ay[i] as number));
        const ez = Math.max(0, Math.abs(oz) - (c.az[i] as number));
        if (ex * ex + ey * ey + ez * ez > radius * radius) continue;
        if (sphereHitsPiece(restPose(c, i, scratchPose), ox, oy, oz, radius)) {
          return { collapse: c, piece: i, falling: false };
        }
      }
      continue;
    }
    if (outside(c.bounds, dx, pos.y, dz, radius)) continue;
    poseClock.tMs = tMs;
    for (let i = 0; i < c.n; i++) {
      const p = poseNow(c, i, scratchPose);
      if (fallingOnly && p.rest) continue;
      const bound = Math.sqrt(p.hx * p.hx + p.hy * p.hy + p.hz * p.hz) + radius;
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
  /** DL1: a Destruction Lab field — the one kind that builds a wire's debris
   * from its stamped tuning (`dt`). Every other field ignores the stamp, so
   * lab tuning can never reach a normal room's debris. */
  lab = false;
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
  /** DS1: the room's physics poses (a physics room only): every building
   * collapse it knows poses from it (Collapse.phys). */
  private physics: PhysRegistry | null = null;

  /** DS1: pose this field's collapses from `registry` as its frames come. */
  attachPhysics(registry: PhysRegistry | null): void {
    this.physics = registry;
    registry?.bind(this.list);
    this.version++;
  }

  /** The physics registry attached, if any. */
  get physicsRegistry(): PhysRegistry | null {
    return this.physics;
  }

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
    if (c) {
      this.list.push(c);
      this.physics?.attach(c);
    }
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
      if (c.kind === kind && c.building === target) {
        this.list.splice(k, 1);
        if (kind === KIND_BUILDING) this.physics?.drop(c.id, c.building);
      }
    }
    if (kind === KIND_CRANE) this.felled.delete(target);
    this.version++;
    return ids;
  }

  private rebuild(): void {
    this.list.length = 0;
    for (const w of this.wires) {
      const c = this.build(w);
      if (c) {
        this.list.push(c);
        this.physics?.attach(c);
      }
    }
    this.version++;
  }

  private build(wire: CollapseWire): Collapse | null {
    if (wireKind(wire) === KIND_CRANE) {
      const site = this.cranes.find((s) => s.id === wire.b);
      return site ? buildCraneCollapse(site, wire) : null;
    }
    return buildCollapse(
      this.buildings as readonly Building[],
      wire,
      this.lab ? tuningFromStamp(wire.dt) : DEFAULT_DESTRUCTION_TUNING,
    );
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
