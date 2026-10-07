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

  /** `xs` / `zs`: each instance's canonical anchor (fixed for its life). */
  constructor(
    private readonly xs: ArrayLike<number>,
    private readonly zs: ArrayLike<number>,
  ) {
    this.kx = new Int16Array(xs.length).fill(UNSET);
    this.kz = new Int16Array(xs.length).fill(UNSET);
  }

  get length(): number {
    return this.xs.length;
  }

  /**
   * Call `write(i, imageX, imageZ)` for every instance whose image differs
   * from the last update (all of them on the first). Returns how many.
   */
  update(
    viewer: Vec3,
    write: (i: number, x: number, z: number) => void,
  ): number {
    let changed = 0;
    for (let i = 0; i < this.xs.length; i++) {
      const cx = this.xs[i] as number;
      const cz = this.zs[i] as number;
      const kx = imageIndex(viewer.x, cx);
      const kz = imageIndex(viewer.z, cz);
      if (kx === this.kx[i] && kz === this.kz[i]) continue;
      this.kx[i] = kx;
      this.kz[i] = kz;
      write(i, cx + kx * WORLD_SIZE, cz + kz * WORLD_SIZE);
      changed++;
    }
    return changed;
  }

  /** Forget every image; the next update rewrites all instances. */
  invalidate(): void {
    this.kx.fill(UNSET);
    this.kz.fill(UNSET);
  }
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
