// D8 the client half of "what still stands" (common/src/city/standing.ts):
// how a per-building decoration layer learns that a building it dresses
// lost (or got back) the floors its items hang on, and hides exactly those
// items — without a per-frame pass over the city.
//
//   StandingWatch  which buildings' damage moved. Gated on the CityDamage
//                  version (one integer compare a frame while nothing
//                  breaks); a building whose collapse has not started yet on
//                  the render clock is held back, so a sign does not vanish
//                  while the tower it hangs on is still standing for
//                  COLLAPSE_LEAD_MS + the interpolation delay; each building
//                  re-filters at most every STANDING_MIN_MS and at most
//                  STANDING_PER_FRAME a frame (a welcome's reset of the whole
//                  city spreads over frames). A rebuild (back to intact) goes
//                  first and is never held back.
//   StandingMask   one layer's per-item hidden flags, per building: the
//                  layer says which boxes each building carries
//                  (StandingLayer, in the building's frame) and the mask
//                  keeps `decorStands` of each. The layer reads `hiddenOf`
//                  wherever it writes an instance (its place / stream path),
//                  so a hide survives a torus flip, a re-stream or a quality
//                  change, and re-places a building's instances when told.
//   BakedHider     for layers baked into one merged geometry: drops an
//                  item's vertex range far below the far plane and restores
//                  it from a kept copy of the original positions.
//
// `attachStanding` is called once by main.ts with the GameSocket's
// CityDamage and CollapseField; `setStandingClock` once a frame with the
// render clock (the one debris poses on). Tests attach their own.

import {
  type Building,
  type LocalBox,
  decorStands,
} from "@angels-bandits/common/city";
import {
  type CollapseField,
  KIND_BUILDING,
  wireKind,
} from "@angels-bandits/common/city/collapse";
import { COLLAPSE_LEAD_MS } from "@angels-bandits/common/constants";
import type * as THREE from "three";
import { pushUpdateRange } from "./update-range";

/** A building re-filters at most this often, ms (≈ 4 Hz under gunfire). */
export const STANDING_MIN_MS = 250;
/** At most this many buildings re-filter per layer per frame. */
export const STANDING_PER_FRAME = 8;

/** What the watch reads: anything whose version moves when damage does. */
export interface StandingSource {
  readonly version: number;
}

let source: StandingSource | null = null;
let field: CollapseField | null = null;
let clockMs: number | null = null;
/** Each building's latest collapse start (record time + lead), ms, from the
 * field at `fieldVersion`. */
const starts = new Map<number, number>();
let fieldVersion = -1;

/** Attach the city's damage (and collapse records, for the hold-back). */
export function attachStanding(
  damage: StandingSource | null,
  collapses: CollapseField | null = null,
): void {
  source = damage;
  field = collapses;
  fieldVersion = -1;
  starts.clear();
}

/** The render clock (server ms, the one debris poses on); null = unknown,
 * nothing is held back. */
export function setStandingClock(renderMs: number | null): void {
  clockMs = renderMs;
  // D8 QA: close the frame's cost (every watch's work since the last call).
  frameCost[frameAt++ % frameCost.length] = costNow;
  costNow = 0;
}

/** D8 QA: the standing updates' cost per frame (ms, summed over every
 * layer) over the last COST_FRAMES frames, and the most buildings any one
 * poll handed out. */
const COST_FRAMES = 1200;
const frameCost = new Float64Array(COST_FRAMES);
let frameAt = 0;
let costNow = 0;
let maxPerPoll = 0;

export function standingCost(): {
  frames: number;
  p50: number;
  p99: number;
  max: number;
  maxBuildingsPerPoll: number;
} {
  const n = Math.min(frameAt, COST_FRAMES);
  const sorted = Array.from(frameCost.subarray(0, n)).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))] ?? 0;
  return {
    frames: n,
    p50: at(0.5),
    p99: at(0.99),
    max: sorted[n - 1] ?? 0,
    maxBuildingsPerPoll: maxPerPoll,
  };
}

/** True while building `b`'s latest collapse has not started on the render
 * clock — its pieces still stand in for the chunks that left solids(). */
function heldBack(b: number): boolean {
  if (!field || clockMs === null) return false;
  if (field.version !== fieldVersion) {
    fieldVersion = field.version;
    starts.clear();
    for (const w of field.records) {
      if (wireKind(w) !== KIND_BUILDING || !Number.isFinite(w.t)) continue;
      const at = w.t + COLLAPSE_LEAD_MS;
      if (at > (starts.get(w.b) ?? Number.NEGATIVE_INFINITY))
        starts.set(w.b, at);
    }
  }
  const at = starts.get(b);
  return at !== undefined && clockMs < at;
}

const versionOf = (b: Building): number => b.damage?.version ?? 0;

/**
 * Which buildings' damage moved since this watch last looked — one watch
 * per layer (each keeps its own "applied" versions).
 */
export class StandingWatch {
  /** The damage version each building was last handed out at. */
  private readonly seen: Float64Array;
  private readonly lastAt: Float64Array;
  private readonly queued: Uint8Array;
  private readonly queue: number[] = [];
  private lastSource = Number.NaN;

  constructor(private readonly buildings: readonly Building[]) {
    this.seen = new Float64Array(buildings.length);
    this.lastAt = new Float64Array(buildings.length).fill(
      Number.NEGATIVE_INFINITY,
    );
    this.queued = new Uint8Array(buildings.length);
  }

  /**
   * Hand `fn` the buildings to re-evaluate this frame. `now` is a wall
   * clock in ms (performance.now() by default) for the rate limit. Returns
   * how many it handed out.
   */
  poll(fn: (b: number) => void, now = performance.now()): number {
    const v = source ? source.version : Number.NaN;
    if (source && v === this.lastSource && this.queue.length === 0) return 0;
    const t0 = performance.now();
    const n = this.handOut(fn, v, now);
    costNow += performance.now() - t0;
    if (n > maxPerPoll) maxPerPoll = n;
    return n;
  }

  private handOut(fn: (b: number) => void, v: number, now: number): number {
    // No source attached (tests, tools): look every call.
    if (!source || v !== this.lastSource) {
      this.lastSource = v;
      for (let i = 0; i < this.buildings.length; i++) {
        if (this.queued[i]) continue;
        if (versionOf(this.buildings[i] as Building) === this.seen[i]) continue;
        this.queued[i] = 1;
        this.queue.push(i);
      }
    }
    if (this.queue.length === 0) return 0;
    let n = 0;
    // Rebuilds first: a tower that is back is never held back or throttled.
    for (let pass = 0; pass < 2 && n < STANDING_PER_FRAME; pass++) {
      for (let q = 0; q < this.queue.length && n < STANDING_PER_FRAME; q++) {
        const i = this.queue[q] as number;
        const ver = versionOf(this.buildings[i] as Building);
        const restore = ver === 0;
        if (pass === 0 && !restore) continue;
        if (pass === 1 && restore) continue;
        if (!restore) {
          if (now - (this.lastAt[i] as number) < STANDING_MIN_MS) continue;
          if (heldBack(i)) continue;
        }
        this.queue.splice(q, 1);
        q--;
        this.queued[i] = 0;
        this.seen[i] = ver;
        this.lastAt[i] = now;
        n++;
        fn(i);
      }
    }
    return n;
  }

  /** Forget what was applied (a layer rebuilt its instances from scratch):
   * every damaged building is handed out again. */
  reset(): void {
    this.seen.fill(0);
    this.lastSource = Number.NaN;
  }
}

/** One layer's items, per building, in the building's frame. */
export interface StandingLayer {
  /** The boxes building `index` carries, in the layer's own item order
   * (the k-th box is the layer's k-th item on that building). */
  boxes(index: number): readonly LocalBox[];
}

/**
 * One layer's hidden flags. `update()` once a frame; the layer reads
 * `hiddenOf(b)` (null = everything on b shown) wherever it writes b's items,
 * and `onChange(b)` tells it to re-write them now.
 */
export class StandingMask {
  private readonly watch: StandingWatch;
  private readonly hidden = new Map<number, Uint8Array>();

  constructor(
    private readonly buildings: readonly Building[],
    private readonly layer: StandingLayer,
    private readonly onChange: (b: number) => void = () => {},
  ) {
    this.watch = new StandingWatch(buildings);
  }

  /** Re-evaluate the buildings whose damage moved; returns how many. */
  update(now?: number): number {
    return this.watch.poll(this.apply, now);
  }

  /** Building `b`'s hidden flags (index = the layer's item order on b), or
   * null when all of its items show. */
  hiddenOf(b: number): Uint8Array | null {
    return this.hidden.get(b) ?? null;
  }

  /** Is item `k` of building `b` hidden? */
  isHidden(b: number, k: number): boolean {
    return this.hidden.get(b)?.[k] === 1;
  }

  /** Evaluate building `b` right now (tests; the watch's callback). */
  evaluate(b: number): Uint8Array | null {
    const building = this.buildings[b];
    let flags: Uint8Array | null = null;
    if (building?.damage) {
      const boxes = this.layer.boxes(b);
      for (let k = 0; k < boxes.length; k++) {
        if (decorStands(building, boxes[k] as LocalBox)) continue;
        if (!flags) flags = new Uint8Array(boxes.length);
        flags[k] = 1;
      }
    }
    if (flags) this.hidden.set(b, flags);
    else this.hidden.delete(b);
    return flags;
  }

  /** Every damaged building again (the layer rebuilt its instances). */
  reset(): void {
    this.hidden.clear();
    this.watch.reset();
  }

  private readonly apply = (b: number): void => {
    const before = this.hidden.get(b) ?? null;
    const after = this.evaluate(b);
    if (before === null && after === null) return;
    this.onChange(b);
  };
}

/** The boxes of building `index` that `mask`'s layer keeps — what the layer
 * draws there (the D8 layer-sweep test reads every layer through this). */
export function keptBoxes(
  mask: StandingMask,
  layer: StandingLayer,
  index: number,
): LocalBox[] {
  const flags = mask.evaluate(index);
  const boxes = layer.boxes(index);
  return boxes.filter((_, k) => !flags?.[k]);
}

/** How far a hidden baked item drops, m — far past any far plane. */
export const HIDE_DROP = 1e5;

/**
 * Hide / show items of a baked (merged) geometry by vertex range: a hidden
 * item's vertices drop HIDE_DROP below where they were (moved, not
 * collapsed — a vertex shader's own offsets cannot open a collapsed item
 * back up), and come back from a copy of the original positions taken on
 * the first hide.
 */
export class BakedHider {
  private original: Float32Array | null = null;
  private lo = Number.POSITIVE_INFINITY;
  private hi = Number.NEGATIVE_INFINITY;

  /** `starts[i]..starts[i + 1]` are item i's vertices. */
  constructor(
    private readonly position: THREE.BufferAttribute,
    private readonly starts: ArrayLike<number>,
  ) {}

  setHidden(item: number, hidden: boolean): void {
    const a = this.starts[item] as number;
    const b = this.starts[item + 1] as number;
    if (!(b > a)) return;
    const arr = this.position.array as Float32Array;
    if (!this.original) {
      if (!hidden) return;
      this.original = arr.slice();
    }
    const src = this.original;
    const s = this.position.itemSize;
    for (let v = a; v < b; v++) {
      const y = v * s + 1;
      arr[y] = hidden ? (src[y] as number) - HIDE_DROP : (src[y] as number);
    }
    this.lo = Math.min(this.lo, a * s);
    this.hi = Math.max(this.hi, b * s);
  }

  /** Upload what changed since the last flush (one range). */
  flush(): void {
    if (this.hi <= this.lo) return;
    this.position.clearUpdateRanges();
    pushUpdateRange(this.position, this.lo, this.hi - this.lo);
    this.position.needsUpdate = true;
    this.lo = Number.POSITIVE_INFINITY;
    this.hi = Number.NEGATIVE_INFINITY;
  }
}
