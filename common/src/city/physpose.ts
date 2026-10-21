// DS1 the pose seam between the debris physics and everything that draws or
// collides with a collapse — shared verbatim by the host and the page.
//
// A physics room (the solo sim worker) simulates a collapse's pieces as
// Rapier bodies (server/src/debris-physics.ts). Their poses are no longer a
// pure function of time, so they travel: once per host tick the physics
// writes ONE frame — every piece of every active collapse, as centre (from
// the building's centre, like a PiecePose) + rotation quaternion + state +
// squash (a crushed slab's share of its height) — into one Float32Array
// (DebrisPhysics.takeFrame), which the worker transfers to the
// page. Both sides ingest the SAME bytes into a PhysRegistry: the host for
// its bots, the page for the plane and the renderer. Each Collapse the
// registry knows gets `phys` (a PhysPoses), and collapse.ts's poseNow /
// collideCollapses read the interpolated frame from it at whatever clock
// they are given — so what is drawn is still exactly what collides.
//
// Frames are interpolated (position lerp, quaternion nlerp) between the two
// that bracket the clock: the page renders ~100 ms behind the host, so a
// short ring of frames is enough. A Destruction Lab keeps the whole history
// instead, so its scrub replays what happened.
//
// When a collapse has settled the physics sends its final frame (every piece
// frozen) and its RUBBLE HEAP: a heightfield of fine rubble over the lot
// (`RubbleHeap`; G9: slumped to the angle of repose, city/repose.ts), drawn
// as a mesh and collided as the same triangles. G9: it rises over
// HEAP_RISE_MS from the frame that brought it (`heapShare`), so the mound
// slumps up round the pile instead of appearing.
//
// Not re-exported from city/index.ts; import "@angels-bandits/common/city/physpose".

import type { LocalBox } from "./destruction";

/** Floats per piece in a frame: x, y, z, qx, qy, qz, qw, state, and its
 * squash — the share of its height a crushed slab keeps (1 uncrushed). */
export const PIECE_STRIDE = 9;
/** Floats in a record's head: collapse id, building, piece count, flags. */
export const RECORD_HEAD = 4;
/** Record flag: this is the collapse's final frame (everything frozen). */
export const REC_SETTLED = 1;

/** Piece states: still in place (held by its columns, or not started),
 * moving, frozen into static rubble. */
export const PIECE_HELD = 0;
export const PIECE_MOVING = 1;
export const PIECE_FROZEN = 2;
/** Moving, but still part of a whole section or floor (not yet broken up
 * or crushed): drawn whole, the closed form's CUT_INTACT. */
export const PIECE_WHOLE = 3;

/** Is a piece in `state` moving (broken off, or riding a whole section)? */
export const pieceMoving = (state: number): boolean =>
  state === PIECE_MOVING || state === PIECE_WHOLE;

/** The clock the hot pose reads run at (collapse.ts's poseClock is this
 * object): a double handed to a call V8 declines to inline is boxed — one
 * HeapNumber per piece per frame (O5's rule) — so the time rides in here. */
export const PHYS_CLOCK = { tMs: 0 };
/** The frame being ingested's host time (PhysPoses.take reads it). */
const INGEST = { t: 0 };

/** Frames each collapse keeps outside a lab: 0.6 s at 20 Hz — the page's
 * render clock trails the host by ~100–200 ms. */
const RING = 12;

/** A collapse's fine-rubble heap: heights over a grid of `cell`-metre
 * squares from (x0, z0), relative to the building's centre; the drawn and
 * collided surface is two triangles per square, split on the (0,0)–(1,1)
 * diagonal. */
export interface RubbleHeap {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  /** (nx + 1) × (nz + 1) vertex heights, row-major in z then x. */
  h: Float32Array;
  /** Its highest vertex, m (the collision reject). */
  top: number;
}

/** G9: how long a physics heap takes to rise to full height, ms. */
export const HEAP_RISE_MS = 2500;

/** Height of `heap`'s surface at (x, z) (centre-relative), or −1 outside
 * it — exactly the drawn triangles. */
export function heapHeight(heap: RubbleHeap, x: number, z: number): number {
  const u = (x - heap.x0) / heap.cell;
  const v = (z - heap.z0) / heap.cell;
  if (!(u >= 0 && v >= 0 && u <= heap.nx && v <= heap.nz)) return -1;
  const i = Math.min(heap.nx - 1, Math.floor(u));
  const j = Math.min(heap.nz - 1, Math.floor(v));
  const fu = u - i;
  const fv = v - j;
  const row = heap.nx + 1;
  const h00 = heap.h[j * row + i] as number;
  const h10 = heap.h[j * row + i + 1] as number;
  const h01 = heap.h[(j + 1) * row + i] as number;
  const h11 = heap.h[(j + 1) * row + i + 1] as number;
  // Lower triangle (00, 10, 11) when fu ≥ fv, else (00, 11, 01).
  return fu >= fv
    ? h00 + (h10 - h00) * fu + (h11 - h10) * fv
    : h00 + (h11 - h01) * fu + (h01 - h00) * fv;
}

/** Does a sphere at (x, y, z) (centre-relative) of `radius` touch the heap
 * risen to `rise` of its height (G9: the drawn mound is scaled the same)?
 * Tested at its centre and four points around it on the plan (the mound's
 * slopes are no steeper than the angle of repose: a flyable pile). */
export function sphereHitsHeap(
  heap: RubbleHeap,
  x: number,
  y: number,
  z: number,
  radius: number,
  rise = 1,
): boolean {
  if (y - radius > heap.top * rise) return false;
  const h = heapHeight(heap, x, z) * rise;
  if (h > 0 && y - radius < h) return true;
  const r = radius * 0.7;
  for (let k = 0; k < 4; k++) {
    const sx = k === 0 ? r : k === 1 ? -r : 0;
    const sz = k === 2 ? r : k === 3 ? -r : 0;
    const hk = heapHeight(heap, x + sx, z + sz) * rise;
    if (hk > 0 && y - radius * 0.7 < hk) return true;
  }
  return false;
}

/** What a pose read writes: PiecePose's shape (collapse.ts), structurally. */
interface PoseOut {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  axis: number;
  phi: number;
  rest: boolean;
  quat: boolean;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** What a pose read needs of its Collapse (the standing half extents). */
interface PieceSizes {
  readonly hx: Float64Array;
  readonly hy: Float64Array;
  readonly hz: Float64Array;
}

/**
 * One physics collapse's poses: a ring of frames (or, `history`, every
 * frame), the union of everything its pieces have covered, its final frame
 * once settled, and its rubble heap.
 */
export class PhysPoses {
  readonly id: number;
  readonly building: number;
  readonly n: number;
  /** Keeps every frame (the Destruction Lab's scrub). */
  readonly history: boolean;
  private cap: number;
  private times: Float64Array;
  private data: Float32Array;
  /** Frames held; the newest is at (head − 1) mod cap. */
  private count = 0;
  private head = 0;
  /** Host ms of its final frame (+∞ until it settles). */
  settledAt = Number.POSITIVE_INFINITY;
  /** Everything its pieces' centres have covered so far (centre-
   * relative); grow it by `reach` for the pieces themselves — the
   * collision reject. */
  readonly bounds: LocalBox = {
    x0: Number.POSITIVE_INFINITY,
    x1: Number.NEGATIVE_INFINITY,
    y0: Number.POSITIVE_INFINITY,
    y1: Number.NEGATIVE_INFINITY,
    z0: Number.POSITIVE_INFINITY,
    z1: Number.NEGATIVE_INFINITY,
  };
  /** The largest piece's bounding radius, m (0 until `measure`). */
  reach = 0;
  heap: RubbleHeap | null = null;
  /** G9: host ms of the frame that brought the heap (+∞ before). */
  heapAt = Number.POSITIVE_INFINITY;
  /** Bumped on every frame (a renderer redraws when it moves). */
  version = 0;

  constructor(id: number, building: number, n: number, history = false) {
    this.id = id;
    this.building = building;
    this.n = n;
    this.history = history;
    this.cap = history ? 64 : RING;
    this.times = new Float64Array(this.cap);
    this.data = new Float32Array(this.cap * this.n * PIECE_STRIDE);
  }

  /** Take the pieces' sizes (once the collapse is known). */
  measure(sizes: PieceSizes): void {
    let r = 0;
    for (let i = 0; i < this.n; i++) {
      r = Math.max(
        r,
        Math.hypot(
          sizes.hx[i] as number,
          sizes.hy[i] as number,
          sizes.hz[i] as number,
        ),
      );
    }
    this.reach = r;
  }

  get settled(): boolean {
    return this.settledAt !== Number.POSITIVE_INFINITY;
  }

  /** G9: the share of its full height the heap stands at host ms `tMs`
   * (0 before it came, rising over HEAP_RISE_MS, eased). */
  heapShare(tMs: number): number {
    const u = (tMs - this.heapAt) / HEAP_RISE_MS;
    if (!(u > 0)) return 0;
    if (u >= 1) return 1;
    return u * u * (3 - 2 * u);
  }

  /** Frames held (the lab's scrub range is first…last). */
  get frames(): number {
    return this.count;
  }

  /** Host ms of the oldest and the newest frame (NaN with none). */
  get first(): number {
    return this.count > 0 ? (this.times[this.slot(0)] as number) : Number.NaN;
  }
  get last(): number {
    return this.count > 0
      ? (this.times[this.slot(this.count - 1)] as number)
      : Number.NaN;
  }

  /** Ring slot of the k-th frame held, oldest first. */
  private slot(k: number): number {
    return this.history
      ? k
      : (this.head - this.count + k + this.cap) % this.cap;
  }

  /** Add a frame at host time `t` from `src` (the record's piece block at
   * `at`). A frame older than the newest is dropped. */
  push(t: number, src: Float32Array, at: number, settled: boolean): void {
    INGEST.t = t;
    this.take(src, at, settled);
  }

  /** push() at INGEST.t (the registry's per-record form: no double handed
   * on, O5). */
  take(src: Float32Array, at: number, settled: boolean): void {
    const t = INGEST.t;
    if (this.count > 0 && t < this.last) return;
    if (this.settled) return;
    const len = this.n * PIECE_STRIDE;
    if (this.history && this.count === this.cap) {
      const cap = this.cap * 2;
      const times = new Float64Array(cap);
      times.set(this.times);
      const data = new Float32Array(cap * len);
      data.set(this.data);
      this.cap = cap;
      this.times = times;
      this.data = data;
    }
    let s: number;
    if (this.history) {
      s = this.count++;
    } else {
      s = this.head;
      this.head = (this.head + 1) % this.cap;
      this.count = Math.min(this.count + 1, this.cap);
    }
    this.times[s] = t;
    // A loop, not set(subarray()): no view object per record per tick.
    const d = this.data;
    const o = s * len;
    for (let k = 0; k < len; k++) d[o + k] = src[at + k] as number;
    const b = this.bounds;
    for (let i = 0; i < this.n; i++) {
      const o = at + i * PIECE_STRIDE;
      const x = src[o] as number;
      const y = src[o + 1] as number;
      const z = src[o + 2] as number;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      if (z < b.z0) b.z0 = z;
      if (z > b.z1) b.z1 = z;
    }
    if (settled) {
      this.settledAt = t;
      // Settled outside a lab: only the final frame is ever read again.
      if (!this.history) this.compact();
    }
    this.version++;
  }

  /** Keep only the newest frame (a settled collapse's memory). */
  private compact(): void {
    const len = this.n * PIECE_STRIDE;
    const last = this.slot(this.count - 1);
    const t = this.times[last] as number;
    const data = this.data.slice(last * len, last * len + len);
    this.cap = 1;
    this.times = Float64Array.of(t);
    this.data = data;
    this.head = 0;
    this.count = 1;
  }

  /**
   * Piece `i` at host time PHYS_CLOCK.tMs into `out` (sizes from `c`): the
   * frames either side, interpolated; the first frame before it (a piece
   * held in place stands where it stood), the newest after.
   * Allocation-free.
   */
  pose(c: PieceSizes, i: number, out: PoseOut): PoseOut {
    const tMs = PHYS_CLOCK.tMs;
    out.hx = c.hx[i] as number;
    out.hy = c.hy[i] as number;
    out.hz = c.hz[i] as number;
    out.axis = 0;
    out.phi = 0;
    out.quat = true;
    const len = this.n * PIECE_STRIDE;
    const d = this.data;
    const n = this.count;
    // Newest frame at or before tMs (frames come in time order).
    let k = n - 1;
    while (k > 0 && (this.times[this.slot(k)] as number) > tMs) k--;
    const a = this.slot(k);
    const ta = this.times[a] as number;
    const oa = a * len + i * PIECE_STRIDE;
    if (k === n - 1 || !(tMs > ta)) {
      out.hy *= d[oa + 8] as number;
      out.x = d[oa] as number;
      out.y = d[oa + 1] as number;
      out.z = d[oa + 2] as number;
      out.qx = d[oa + 3] as number;
      out.qy = d[oa + 4] as number;
      out.qz = d[oa + 5] as number;
      out.qw = d[oa + 6] as number;
      out.rest = d[oa + 7] === PIECE_FROZEN;
      return out;
    }
    const b = this.slot(k + 1);
    const tb = this.times[b] as number;
    const ob = b * len + i * PIECE_STRIDE;
    const u = tb > ta ? (tMs - ta) / (tb - ta) : 1;
    out.hy *=
      (d[oa + 8] as number) +
      ((d[ob + 8] as number) - (d[oa + 8] as number)) * u;
    out.x = (d[oa] as number) + ((d[ob] as number) - (d[oa] as number)) * u;
    out.y =
      (d[oa + 1] as number) +
      ((d[ob + 1] as number) - (d[oa + 1] as number)) * u;
    out.z =
      (d[oa + 2] as number) +
      ((d[ob + 2] as number) - (d[oa + 2] as number)) * u;
    // nlerp, the short way round.
    let bx = d[ob + 3] as number;
    let by = d[ob + 4] as number;
    let bz = d[ob + 5] as number;
    let bw = d[ob + 6] as number;
    const ax = d[oa + 3] as number;
    const ay = d[oa + 4] as number;
    const az = d[oa + 5] as number;
    const aw = d[oa + 6] as number;
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    let qx = ax + (bx - ax) * u;
    let qy = ay + (by - ay) * u;
    let qz = az + (bz - az) * u;
    let qw = aw + (bw - aw) * u;
    const m = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
    qx /= m;
    qy /= m;
    qz /= m;
    qw /= m;
    out.qx = qx;
    out.qy = qy;
    out.qz = qz;
    out.qw = qw;
    out.rest = d[oa + 7] === PIECE_FROZEN && d[ob + 7] === PIECE_FROZEN;
    return out;
  }

  /** Piece `i`'s state in the frame at or before `tMs`. */
  state(i: number, tMs: number): number {
    PHYS_CLOCK.tMs = tMs;
    return this.stateNow(i);
  }

  /** Piece `i`'s state at PHYS_CLOCK.tMs (the per-frame loops' form). */
  stateNow(i: number): number {
    const tMs = PHYS_CLOCK.tMs;
    const n = this.count;
    if (n === 0) return PIECE_HELD;
    let k = n - 1;
    while (k > 0 && (this.times[this.slot(k)] as number) > tMs) k--;
    return this.data[
      this.slot(k) * this.n * PIECE_STRIDE + i * PIECE_STRIDE + 7
    ] as number;
  }
}

/** A collapse the registry can attach poses to (collapse.ts Collapse,
 * structurally). */
export interface PhysTarget extends PieceSizes {
  readonly id: number;
  readonly kind: number;
  readonly building: number;
  readonly n: number;
  phys: PhysPoses | null;
}

const keyOf = (id: number, building: number): number => id * 65536 + building;

/**
 * Every physics collapse of one room, as frames arrive — on the host fed by
 * its own physics, on the page by the worker's `poses` messages: the same
 * bytes either way. A bound list (a CollapseField's) gets `phys` attached to
 * each matching collapse (same id AND building — kind 0 only), whichever
 * arrives first.
 */
export class PhysRegistry {
  /** Keep every frame (a Destruction Lab's scrub). */
  history = false;
  /** The physics' epoch the registry holds (a room reset bumps it). */
  epoch = -1;
  private readonly poses = new Map<number, PhysPoses>();
  /** The last frame's collapses, in its order (ingest's fast path). */
  private readonly order: PhysPoses[] = [];
  private list: readonly PhysTarget[] | null = null;
  /** Bumped on every frame ingested. */
  version = 0;

  /** The collapses `phys` is attached to (a CollapseField's list). */
  bind(list: readonly PhysTarget[]): void {
    this.list = list;
    for (const c of list) this.attach(c);
  }

  get size(): number {
    return this.poses.size;
  }

  get(id: number, building: number): PhysPoses | null {
    return this.poses.get(keyOf(id, building)) ?? null;
  }

  /** Give `c` its poses, if the registry has them. */
  attach(c: PhysTarget): void {
    if (c.kind !== 0) return;
    const p = this.poses.get(keyOf(c.id, c.building));
    if (p && p.n === c.n) {
      if (p.reach === 0) p.measure(c);
      c.phys = p;
    }
  }

  /** Forget collapse `id` of `building` (a rebuild dropped it). */
  drop(id: number, building: number): void {
    this.poses.delete(keyOf(id, building));
    this.order.length = 0;
  }

  clear(): void {
    this.poses.clear();
    this.order.length = 0;
    if (this.list) for (const c of this.list) c.phys = null;
    this.version++;
  }

  /**
   * One frame at host time `t`: `data` holds records (RECORD_HEAD floats,
   * then PIECE_STRIDE per piece), `heaps` the heaps of collapses settled in
   * it (heapRecords). A new `epoch` (a room reset) clears what was held.
   */
  ingest(
    t: number,
    epoch: number,
    data: Float32Array,
    heaps: Float32Array | null,
    /** Where the records end in `data` (a reused buffer), floats. */
    end = data.length,
  ): void {
    if (epoch !== this.epoch) {
      this.clear();
      this.epoch = epoch;
    }
    INGEST.t = t;
    let o = 0;
    let r = 0;
    while (o + RECORD_HEAD <= end) {
      const id = data[o] as number;
      const building = data[o + 1] as number;
      const n = data[o + 2] as number;
      const flags = data[o + 3] as number;
      const at = o + RECORD_HEAD;
      o = at + n * PIECE_STRIDE;
      if (o > end) break;
      // Frames list their collapses in the same order tick after tick:
      // the last frame's r-th is checked first, by comparison — a map
      // lookup boxes a key past the small-integer range (O5).
      let p = this.order[r] ?? null;
      if (p === null || p.id !== id || p.building !== building) {
        p = this.poses.get(keyOf(id, building)) ?? null;
      }
      if (!p) {
        p = new PhysPoses(id, building, n, this.history);
        this.poses.set(keyOf(id, building), p);
        if (this.list) {
          for (let k = this.list.length - 1; k >= 0; k--) {
            const c = this.list[k] as PhysTarget;
            if (c.id === id && c.building === building) {
              this.attach(c);
              break;
            }
          }
        }
      }
      p.take(data, at, (flags & REC_SETTLED) !== 0);
      this.order[r++] = p;
    }
    this.order.length = r;
    if (heaps) {
      let h = 0;
      while (h + 7 <= heaps.length) {
        const id = heaps[h] as number;
        const building = heaps[h + 1] as number;
        const nx = heaps[h + 5] as number;
        const nz = heaps[h + 6] as number;
        const cells = (nx + 1) * (nz + 1);
        const p = this.poses.get(keyOf(id, building));
        if (p && h + 7 + cells <= heaps.length) {
          const hh = heaps.slice(h + 7, h + 7 + cells);
          let top = 0;
          for (let k = 0; k < hh.length; k++)
            top = Math.max(top, hh[k] as number);
          p.heapAt = t;
          p.heap = {
            x0: heaps[h + 2] as number,
            z0: heaps[h + 3] as number,
            cell: heaps[h + 4] as number,
            nx,
            nz,
            h: hh,
            top,
          };
          p.version++;
        }
        h += 7 + cells;
      }
    }
    this.version++;
  }
}

/** Heaps as their records, one after another: id, building, x0, z0,
 * cell, nx, nz, then the heights. */
export function heapRecords(
  list: readonly { id: number; building: number; heap: RubbleHeap }[],
): Float32Array {
  let size = 0;
  for (const e of list) size += 7 + e.heap.h.length;
  const out = new Float32Array(size);
  let o = 0;
  for (const { id, building, heap } of list) {
    out[o] = id;
    out[o + 1] = building;
    out[o + 2] = heap.x0;
    out[o + 3] = heap.z0;
    out[o + 4] = heap.cell;
    out[o + 5] = heap.nx;
    out[o + 6] = heap.nz;
    out.set(heap.h, o + 7);
    o += 7 + heap.h.length;
  }
  return out;
}
