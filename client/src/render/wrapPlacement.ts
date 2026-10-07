// Nearest-image torus placement (PLAN.md → "The torus"): the world is stored
// once in canonical [0, WORLD_SIZE) coords, and every frame each thing is
// DRAWN at its torus image nearest the viewer. Built on wrapDelta — the only
// legal way to compare two world positions.

import { WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  type Vec3,
  wrapDelta,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import type * as THREE from "three";

/**
 * The render-space position of `canonical` in the torus image nearest
 * `viewer` (usually the camera): per axis at most WORLD_SIZE/2 away.
 */
export function nearestImage(viewer: Vec3, canonical: Vec3): Vec3 {
  const d = wrapDelta(viewer, canonical);
  return { x: viewer.x + d.x, y: canonical.y, z: viewer.z + d.z };
}

/** nearestImage written into `out` — for per-frame loops, which must not
 * allocate (O2). Same arithmetic, so the same answer to the last bit. */
export function nearestImageInto(
  out: Vec3,
  viewer: Vec3,
  canonical: Vec3,
): Vec3 {
  out.x = viewer.x + wrapDeltaAxis(viewer.x, canonical.x);
  out.y = canonical.y;
  out.z = viewer.z + wrapDeltaAxis(viewer.z, canonical.z);
  return out;
}

/** Which whole-world shift nearestImage applies to coordinate `c` along one
 * axis for a viewer at `v`: the image is c + k·WORLD_SIZE. */
const imageIndex = (v: number, c: number): number =>
  Math.round((v + wrapDeltaAxis(v, c) - c) / WORLD_SIZE);

/** No image yet — forces every instance's first write. */
const UNSET = 0x7fff;

/**
 * Per-instance torus-image cache for STATIC instanced scenery (O2).
 *
 * A static instance's image only changes when the camera crosses the
 * half-world line relative to it, yet every renderer used to recompose and
 * re-upload every matrix every frame. This keeps each instance's image index
 * and reports only the ones that flipped. The index comes from nearestImage's
 * own arithmetic, so an image flips on exactly the frame nearestImage's
 * would; the position written is c + k·WORLD_SIZE (within float rounding of
 * nearestImage's, and stable while the camera moves).
 */
export class ImageCache {
  private readonly kx: Int16Array;
  private readonly kz: Int16Array;
  /**
   * O3: each instance's half-world line per axis — the viewer coordinate
   * (mod WORLD_SIZE) at which its image along that axis flips — sorted,
   * with the instance index alongside. A frame only has to re-check the
   * instances whose line the viewer crossed since the last frame: two
   * binary searches and a handful of candidates instead of a pass over
   * every instance (the O3 profile's costliest JS path in the city).
   */
  private readonly linesX: Float64Array;
  private readonly orderX: Int32Array;
  private readonly linesZ: Float64Array;
  private readonly orderZ: Int32Array;
  /** Per-frame scratch: candidate indices, and a "seen" flag to dedupe. */
  private readonly cand: Int32Array;
  private readonly seen: Uint8Array;
  /** Viewer at the last update; NaN forces the next one to scan everything. */
  private lastX = Number.NaN;
  private lastZ = Number.NaN;

  /** `xs` / `zs`: each instance's canonical anchor (fixed for its life). */
  constructor(
    private readonly xs: ArrayLike<number>,
    private readonly zs: ArrayLike<number>,
  ) {
    this.kx = new Int16Array(xs.length).fill(UNSET);
    this.kz = new Int16Array(xs.length).fill(UNSET);
    [this.linesX, this.orderX] = halfWorldLines(xs);
    [this.linesZ, this.orderZ] = halfWorldLines(zs);
    this.cand = new Int32Array(xs.length);
    this.seen = new Uint8Array(xs.length);
  }

  get length(): number {
    return this.xs.length;
  }

  /**
   * Call `write(i, imageX, imageZ)` for every instance whose image differs
   * from the last update (all of them on the first), in increasing `i`
   * (InstanceUploads merges adjacent marks on that). Returns how many.
   */
  update(
    viewer: Vec3,
    write: (i: number, x: number, z: number) => void,
  ): number {
    const dx = viewer.x - this.lastX;
    const dz = viewer.z - this.lastZ;
    // First update, after invalidate(), or a jump (the camera re-canonicalised
    // across the seam, a teleport): scan everything, exactly as before.
    if (!(Math.abs(dx) < SCAN_JUMP && Math.abs(dz) < SCAN_JUMP)) {
      this.lastX = viewer.x;
      this.lastZ = viewer.z;
      let changed = 0;
      for (let i = 0; i < this.xs.length; i++) {
        if (this.refresh(i, viewer, write)) changed++;
      }
      return changed;
    }
    let n = 0;
    n = this.crossed(this.linesX, this.orderX, this.lastX, viewer.x, n);
    n = this.crossed(this.linesZ, this.orderZ, this.lastZ, viewer.z, n);
    this.lastX = viewer.x;
    this.lastZ = viewer.z;
    // Increasing index order; candidate sets are a few per frame.
    const c = this.cand;
    for (let a = 1; a < n; a++) {
      const v = c[a] as number;
      let b = a - 1;
      while (b >= 0 && (c[b] as number) > v) {
        c[b + 1] = c[b] as number;
        b--;
      }
      c[b + 1] = v;
    }
    let changed = 0;
    for (let a = 0; a < n; a++) {
      const i = c[a] as number;
      this.seen[i] = 0;
      if (this.refresh(i, viewer, write)) changed++;
    }
    return changed;
  }

  /** Forget every image; the next update rewrites all instances. */
  invalidate(): void {
    this.kx.fill(UNSET);
    this.kz.fill(UNSET);
    this.lastX = Number.NaN;
    this.lastZ = Number.NaN;
  }

  /** Re-derive instance `i`'s image; write and report it if it changed. */
  private refresh(
    i: number,
    viewer: Vec3,
    write: (i: number, x: number, z: number) => void,
  ): boolean {
    const cx = this.xs[i] as number;
    const cz = this.zs[i] as number;
    const kx = imageIndex(viewer.x, cx);
    const kz = imageIndex(viewer.z, cz);
    if (kx === this.kx[i] && kz === this.kz[i]) return false;
    this.kx[i] = kx;
    this.kz[i] = kz;
    write(i, cx + kx * WORLD_SIZE, cz + kz * WORLD_SIZE);
    return true;
  }

  /**
   * Append (deduped) every instance whose line lies between `from` and `to`
   * (widened by LINE_EPS, so a tie that rounds either way is still checked)
   * to the candidates; returns the new count. The span is < WORLD_SIZE / 4,
   * so on the circle it is one interval or two (when it wraps past 0).
   */
  private crossed(
    lines: Float64Array,
    order: Int32Array,
    from: number,
    to: number,
    n: number,
  ): number {
    const lo = mod(Math.min(from, to) - LINE_EPS, WORLD_SIZE);
    const span = Math.abs(to - from) + 2 * LINE_EPS;
    const hi = lo + span;
    let count = this.collect(lines, order, lo, Math.min(hi, WORLD_SIZE), n);
    if (hi > WORLD_SIZE) {
      count = this.collect(lines, order, 0, hi - WORLD_SIZE, count);
    }
    return count;
  }

  private collect(
    lines: Float64Array,
    order: Int32Array,
    lo: number,
    hi: number,
    start: number,
  ): number {
    let n = start;
    // First line >= lo.
    let a = 0;
    let b = lines.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if ((lines[m] as number) < lo) a = m + 1;
      else b = m;
    }
    for (let j = a; j < lines.length && (lines[j] as number) <= hi; j++) {
      const i = order[j] as number;
      if (this.seen[i]) continue;
      this.seen[i] = 1;
      this.cand[n++] = i;
    }
    return n;
  }
}

/** Past this much viewer travel in one update, scan every instance. */
const SCAN_JUMP = WORLD_SIZE / 4;
/** Lines this close to the travelled span are re-checked anyway (metres). */
const LINE_EPS = 1e-3;
const mod = (v: number, m: number): number => ((v % m) + m) % m;

/** Each anchor's half-world line (mod WORLD_SIZE), sorted, with its index. */
function halfWorldLines(cs: ArrayLike<number>): [Float64Array, Int32Array] {
  const order = Array.from({ length: cs.length }, (_, i) => i);
  const line = (i: number) =>
    mod((cs[i] as number) + WORLD_SIZE / 2, WORLD_SIZE);
  order.sort((p, q) => line(p) - line(q));
  return [Float64Array.from(order, line), Int32Array.from(order)];
}

/** Past this many separate runs a frame uploads the whole buffer once
 * instead — one big bufferSubData beats dozens of small ones. */
const MAX_RANGES = 32;

/**
 * Collects the instance slots written this frame and uploads only those
 * (O2). Marks must arrive in increasing index order (ImageCache.update's
 * order), so adjacent slots merge into one run as they are marked.
 */
export class InstanceUploads {
  private runStart = -1;
  private runEnd = -1;
  /** Closed runs as flat [start, end) pairs — reused, never reallocated. */
  private readonly runs: number[] = [];
  private full = false;
  private marked = false;

  /** `attrs` share one slot layout (e.g. a lamp's pole, head and glow). */
  constructor(private readonly attrs: THREE.BufferAttribute[]) {}

  mark(i: number): void {
    this.marked = true;
    if (this.full) return;
    if (i === this.runEnd) {
      this.runEnd++;
      return;
    }
    this.closeRun();
    this.runStart = i;
    this.runEnd = i + 1;
  }

  /** Mark every slot (first frame, or a non-image change). */
  markAll(): void {
    this.marked = true;
    this.full = true;
  }

  /** Hand this frame's marks to three.js. A frame with none uploads none. */
  flush(): void {
    this.closeRun();
    if (this.marked) {
      for (const attr of this.attrs) {
        attr.clearUpdateRanges();
        if (!this.full && this.runs.length <= MAX_RANGES * 2) {
          for (let r = 0; r < this.runs.length; r += 2) {
            const start = this.runs[r] as number;
            const end = this.runs[r + 1] as number;
            attr.addUpdateRange(
              start * attr.itemSize,
              (end - start) * attr.itemSize,
            );
          }
        }
        attr.needsUpdate = true;
      }
    }
    this.runs.length = 0;
    this.full = false;
    this.marked = false;
  }

  private closeRun(): void {
    if (this.runStart >= 0) this.runs.push(this.runStart, this.runEnd);
    this.runStart = -1;
    this.runEnd = -1;
  }
}

/**
 * Upload only slots `[0, count)` of attributes a system re-packs from the
 * front every frame (O3) — walkers, headlights, trails, puffs. Each of them
 * sizes its buffer for the worst case and draws a prefix of it, and a bare
 * `needsUpdate` re-uploads the WHOLE capacity: the profile found ~600 KB a
 * frame going up that way, a quarter of a MB of it for pedestrians alone
 * at a few hundred walkers out of a 3 250-slot buffer. A frame that draws
 * nothing uploads nothing.
 */
export function uploadPrefix(
  attrs: readonly (THREE.BufferAttribute | null | undefined)[],
  count: number,
): void {
  for (const attr of attrs) {
    if (!attr) continue;
    attr.clearUpdateRanges();
    if (count <= 0) continue;
    attr.addUpdateRange(0, count * attr.itemSize);
    attr.needsUpdate = true;
  }
}
