// D10 collapse detail: the small stuff a real building sheds as it comes
// down, which the physical pieces (collapse.ts — boxes that collide) are
// too big to be. Cosmetic only — nothing here collides — and through the D1
// particle pool (impacts.ts), so no new draw:
//
//   - a trail of gravel and fist-sized chunks off every falling piece;
//   - a cascade of window frames and, off a curtain-wall tower, a shower of
//     glass from the facade sheets peeling away;
//   - sparks off the steel (column / I-beam segments);
//   - a burst of gravel, dust and glass at each floor event (collapse.ts
//     collapseFloorEvents): a storey giving way, a section breaking up, the
//     mass hitting the ground.
//
// Only the COLLAPSES_NEAR nearest active collapses within DETAIL_RANGE_M
// shed; the trail rate is a budget per second shared by their pieces
// (round-robin), scaled by the tier's chaosFx share on top of the pool's
// own. Particle origins are canonical, like every pool particle.
//
// D11 made it read from 600 m:
//   - everything scales with the building (k = height / SCALE_H_M, 1..3:
//     size × k, count × √k) and grows with the viewer's distance (up to
//     RANGE_GROW× at 600 m — the inferno's far-flame idiom; dressing, never
//     collided), so a 300 m tower's debris is not a 40 m one's;
//   - a pancake's CRUSH FRONT: as each storey is reached (its crushed
//     piece starts down) the front bursts out of the facade at that height
//     — chunks thrown out that stream down the faces and settle on the
//     street (the pool's chunk ring → settled ring), sparks, blue-white
//     electrical flashes, fire bursting from the failing floor, glass;
//   - glass glitter off every tower's falling sheets (a masonry tower's
//     fewer panes: GLASS_MASONRY of the shower);
//   - a budget: the collapses never spray more than RATE_MAX particles a
//     second into the busy pool, so gunfire impacts are never starved.

import type { Building } from "@angels-bandits/common/city";
import {
  BEAT_LAND,
  type Collapse,
  KIND_BUILDING,
  MODE_HINGE,
  PANCAKE,
  ROLE_COLUMN,
  ROLE_SHEET,
  blankPose,
  collapseFloorEvents,
  piecePose,
} from "@angels-bandits/common/city/collapse";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import { DUST_RGB, type Impacts, Kind, SPARK_RGB } from "./impacts";

/** Collapses further than this shed nothing, m; at most this many at once. */
export const DETAIL_RANGE_M = 650;
export const COLLAPSES_NEAR = 3;
/** Trail emissions per second per collapse at full share (each one a few
 * particles off one piece). */
export const TRAIL_RATE = 40;
/** A floor event's burst at full share, particles (× its size). */
export const BURST = { gravel: 26, dust: 10, glass: 34 } as const;
/** D11: the building scale's reference height, m, and its clamp. */
export const SCALE_H_M = 120;
const SCALE_MAX = 3;
/** D11: particles grow with the viewer's distance — 1× inside RANGE_NEAR_M,
 * RANGE_GROW× from RANGE_FAR_M. */
const RANGE_NEAR_M = 150;
const RANGE_FAR_M = 600;
export const RANGE_GROW = 3;
/** D11: crush-front bursts per second at most (per collapse, full share);
 * the busy pool's budget for all collapses, particles per second. */
export const FRONT_RATE = 36;
export const RATE_MAX = 600;
/** D11: a masonry / office tower's share of a curtain wall's glass. */
const GLASS_MASONRY = 0.4;
/** D11: a crush-front burst's chance of an electrical flash and of fire. */
const FLASH_CHANCE = 0.16;
const FIRE_CHANCE = 0.55;

const GLASS_RGB = [0.72, 0.88, 1.0] as const;
const FRAME_RGB = [0.08, 0.08, 0.09] as const;
/** D11: a severed cable's arc — blue-white, the pool's brightest colour
 * (≈ 1.2 linear: over the bloom threshold, under the tracer rung 1.5). */
export const FLASH_RGB = [0.72, 0.88, 1.2] as const;
const FIRE_RGB = [1.0, 0.46, 0.12] as const;
const UP: Vec3 = { x: 0, y: 1, z: 0 };

/** smoothstep(0, 1, x). */
const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** D11: the particle growth at `d` m from the viewer. */
export const rangeGrow = (d: number): number =>
  1 +
  (RANGE_GROW - 1) *
    smooth01((d - RANGE_NEAR_M) / (RANGE_FAR_M - RANGE_NEAR_M));

/** D11: where the falling mass hits, in time order — each piece's landing
 * (a pancake's on the face of its footprint nearest it: the foot it sinks
 * into; a topple's where it lands) and, for a topple, each hinged piece's
 * break-up in the air. Centre-relative, with the outward direction a
 * burst throws along (a face normal; a topple's: seeded). */
interface Front {
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  nx: Float64Array;
  nz: Float64Array;
  /** 1 = a break-up in the air, 0 = a landing. */
  air: Uint8Array;
}
const fronts = new WeakMap<Collapse, Front>();
const frontPose = blankPose();

/** `c`'s hits (cached). Pure in the collapse. */
function frontOf(c: Collapse): Front {
  let f = fronts.get(c);
  if (f) return f;
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let z0 = Number.POSITIVE_INFINITY;
  let z1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < c.n; i++) {
    x0 = Math.min(x0, (c.ox[i] as number) - (c.hx[i] as number));
    x1 = Math.max(x1, (c.ox[i] as number) + (c.hx[i] as number));
    z0 = Math.min(z0, (c.oz[i] as number) - (c.hz[i] as number));
    z1 = Math.max(z1, (c.oz[i] as number) + (c.hz[i] as number));
  }
  const raw: [number, number, number, number, number, number, number][] = [];
  for (let i = 0; i < c.n; i++) {
    const start = (c.start[i] as number) * 1000;
    const a = ((i * 2654435761) >>> 0) / 4294967296;
    const dx = Math.cos(a * Math.PI * 2);
    const dz = Math.sin(a * Math.PI * 2);
    if (c.style !== PANCAKE && c.mode[i] === MODE_HINGE) {
      const tb = c.hbreak[i] as number;
      if (tb < (c.land[i] as number)) {
        piecePose(c, i, c.t0 + start + tb * 1000, frontPose);
        raw.push([
          start + tb * 1000,
          frontPose.x,
          frontPose.y,
          frontPose.z,
          dx,
          dz,
          1,
        ]);
      }
    }
    piecePose(c, i, Number.POSITIVE_INFINITY, frontPose);
    const t = start + (c.land[i] as number) * 1000;
    if (c.style === PANCAKE) {
      const px = frontPose.x;
      const pz = frontPose.z;
      const near = Math.min(px - x0, x1 - px, pz - z0, z1 - pz);
      const alongX = near === px - x0 || near === x1 - px;
      const sign = alongX
        ? near === x1 - px
          ? 1
          : -1
        : near === z1 - pz
          ? 1
          : -1;
      raw.push([
        t,
        alongX ? (sign > 0 ? x1 : x0) : px,
        frontPose.y + frontPose.hy,
        alongX ? pz : sign > 0 ? z1 : z0,
        alongX ? sign : 0,
        alongX ? 0 : sign,
        0,
      ]);
    } else {
      raw.push([
        t,
        frontPose.x,
        frontPose.y + frontPose.hy,
        frontPose.z,
        dx,
        dz,
        0,
      ]);
    }
  }
  raw.sort((p, q) => p[0] - q[0]);
  const col = (j: number) => Float64Array.from(raw, (r) => r[j] as number);
  f = {
    t: col(0),
    x: col(1),
    y: col(2),
    z: col(3),
    nx: col(4),
    nz: col(5),
    air: Uint8Array.from(raw, (r) => r[6] as number),
  };
  fronts.set(c, f);
  return f;
}

/**
 * D10 audio: the beats of collapse `c` still to come at server time
 * `serverMs` — its `max` biggest floor events, seconds from then, in time
 * order (sound.ts collapseBeats plays one roar each). Pure.
 */
export function beatSchedule(
  c: Collapse,
  serverMs: number,
  max: number,
): { t: number; size: number }[] {
  const ahead = collapseFloorEvents(c).filter(
    (e) => c.t0 + e.t >= serverMs - 1e-6,
  );
  return ahead
    .slice()
    .sort((a, b) => b.size - a.size || a.t - b.t)
    .slice(0, Math.max(0, max))
    .sort((a, b) => a.t - b.t)
    .map((e) => ({ t: (c.t0 + e.t - serverMs) / 1000, size: e.size }));
}

/** D10 audio: seconds from `serverMs` until `c`'s first piece moves (the
 * lead beat and, for a pancake, the creep: when the cracking runs). */
export function creepSeconds(c: Collapse, serverMs: number): number {
  let first = Number.POSITIVE_INFINITY;
  for (let i = 0; i < c.n; i++) first = Math.min(first, c.start[i] as number);
  if (!Number.isFinite(first)) return 0;
  return Math.max(0, (c.t0 + first * 1000 - serverMs) / 1000);
}

interface Near {
  c: Collapse;
  d: number;
}

/** What one emission scales by: the building (k), and k × the range
 * growth for sizes (`size`), √k for counts (`count`). */
interface Scale {
  size: number;
  count: number;
}

export class CollapseDetail {
  private share = 1;
  private lastRender = Number.NaN;
  private lastNow = Number.NaN;
  /** Fractional emissions owed and the round-robin piece, per collapse. */
  private readonly owed = new Map<number, number>();
  private readonly cursor = new Map<number, number>();
  private readonly near: Near[] = [];
  private readonly a = blankPose();
  private readonly b = blankPose();
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly glassy = new Map<number, boolean>();
  /** D11: the building's scale (k), cached. */
  private readonly kOf = new Map<number, number>();
  /** D11: crush-front bursts owed per collapse (FRONT_RATE throttle). */
  private readonly frontOwed = new Map<number, number>();
  private readonly scale: Scale = { size: 1, count: 1 };
  /** D11: the busy pool's budget, particles, refilled at RATE_MAX/s. */
  private tokens = RATE_MAX;
  private readonly out: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tint = new Map<number, readonly [number, number, number]>();
  private readonly dark = new Map<number, readonly [number, number, number]>();

  constructor(
    private readonly impacts: Impacts,
    private readonly buildings: readonly Building[],
  ) {}

  /** Quality row (chaosFx): share of the detail. */
  setQuality(share: number): void {
    this.share = Math.max(0, Math.min(1, share));
  }

  /** QA/tests: emissions owed per collapse id. */
  get pending(): ReadonlyMap<number, number> {
    return this.owed;
  }

  /** Per frame. `renderMs` is the clock debris poses on (null: none yet);
   * `now` the wall clock the particle pool ages on. */
  update(
    list: readonly Collapse[],
    viewer: Vec3,
    renderMs: number | null,
    now: number,
  ): void {
    const prev = this.lastRender;
    const dt = Number.isFinite(this.lastNow)
      ? Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000))
      : 0;
    this.lastNow = now;
    this.lastRender = renderMs ?? Number.NaN;
    if (renderMs === null || this.share <= 0 || list.length === 0) {
      if (this.owed.size > 0) this.owed.clear();
      return;
    }
    let count = 0;
    for (let e = 0; e < list.length; e++) {
      const c = list[e] as Collapse;
      if (c.kind !== KIND_BUILDING) continue;
      if (renderMs < c.t0 || renderMs > c.t0 + c.endMs + 500) {
        this.owed.delete(c.id);
        this.cursor.delete(c.id);
        continue;
      }
      const dx = wrapDeltaAxis(viewer.x, c.x);
      const dz = wrapDeltaAxis(viewer.z, c.z);
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > DETAIL_RANGE_M) continue;
      const slot = this.near[count] ?? { c, d };
      slot.c = c;
      slot.d = d;
      this.near[count++] = slot;
    }
    // Partial selection of the nearest COLLAPSES_NEAR.
    const n = Math.min(count, COLLAPSES_NEAR);
    for (let i = 0; i < n; i++) {
      let best = i;
      for (let j = i + 1; j < count; j++) {
        if ((this.near[j] as Near).d < (this.near[best] as Near).d) best = j;
      }
      const t = this.near[i] as Near;
      this.near[i] = this.near[best] as Near;
      this.near[best] = t;
    }
    this.tokens = Math.min(
      RATE_MAX * this.share,
      this.tokens + RATE_MAX * this.share * dt,
    );
    for (let i = 0; i < n; i++) {
      const near = this.near[i] as Near;
      const c = near.c;
      const k = this.buildingScale(c.building);
      this.scale.size = k * rangeGrow(near.d);
      this.scale.count = Math.sqrt(k);
      this.trail(c, renderMs, dt, now);
      if (Number.isFinite(prev) && renderMs > prev) {
        this.bursts(c, prev, renderMs, now);
        this.front(c, prev, renderMs, dt, now);
      }
    }
  }

  /** D11: building `b`'s scale, 1..SCALE_MAX by its height. Cached. */
  private buildingScale(b: number): number {
    let k = this.kOf.get(b);
    if (k === undefined) {
      const bld = this.buildings[b];
      k = Math.min(SCALE_MAX, Math.max(1, (bld?.height ?? 0) / SCALE_H_M));
      this.kOf.set(b, k);
    }
    return k;
  }

  /** D11: spray through the busy pool's budget — `n` × √k particles at
   * `size` × k × range growth; fewer (or none) once the second's budget
   * is spent. Chunks that settle fly in their own ring, outside it. */
  private emit(
    kind: Kind,
    at: Vec3,
    dir: Vec3,
    speed: number,
    spread: number,
    n: number,
    lifeMs: number,
    size: number,
    rgb: readonly [number, number, number],
    now: number,
    settle = false,
  ): void {
    let count = Math.max(1, Math.round(n * this.scale.count));
    if (!settle) {
      count = Math.min(count, Math.floor(this.tokens));
      if (count <= 0) return;
      this.tokens -= count;
    }
    this.impacts.spray(
      kind,
      at,
      dir,
      speed,
      spread,
      count,
      lifeMs,
      size * this.scale.size,
      rgb,
      now,
      settle,
    );
  }

  /** D11: the mass hitting — a burst at each piece's landing (and a
   * topple's break-ups in the air), at most FRONT_RATE a second (the hits
   * in between share them). */
  private front(
    c: Collapse,
    from: number,
    to: number,
    dt: number,
    now: number,
  ): void {
    const f = frontOf(c);
    const n = f.t.length;
    if (n === 0) return;
    let owed = (this.frontOwed.get(c.id) ?? 0) + FRONT_RATE * this.share * dt;
    owed = Math.min(owed, FRONT_RATE);
    // The hits this frame (binary search for the first).
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c.t0 + (f.t[mid] as number) <= from) lo = mid + 1;
      else hi = mid;
    }
    let reached = 0;
    for (let j = lo; j < n && c.t0 + (f.t[j] as number) <= to; j++) reached++;
    if (reached > 0) {
      const bursts = Math.min(reached, Math.floor(owed));
      const step = reached / Math.max(1, bursts);
      for (let b = 0; b < bursts; b++) {
        this.frontBurst(c, f, lo + Math.floor(b * step), now);
        owed -= 1;
      }
    }
    this.frontOwed.set(c.id, owed);
  }

  /** One hit's burst: chunks thrown out along its direction (they stream
   * down and settle on the street), sparks, now and then a blue-white
   * flash, fire out of the failing floor, glass. */
  private frontBurst(c: Collapse, f: Front, j: number, now: number): void {
    this.at.x = wrapCoord(c.x + (f.x[j] as number));
    this.at.y = Math.max(1, (f.y[j] as number) - 1);
    this.at.z = wrapCoord(c.z + (f.z[j] as number));
    const air = f.air[j] === 1;
    // Out and up off a landing, out and down off a break-up.
    this.out.x = f.nx[j] as number;
    this.out.y = air ? -0.3 : 0.45;
    this.out.z = f.nz[j] as number;
    const chips = this.chips(c.building);
    this.emit(
      Kind.CHIP,
      this.at,
      this.out,
      9,
      0.7,
      2,
      9000,
      0.75,
      chips,
      now,
      true,
    );
    this.emit(Kind.CHIP, this.at, this.out, 12, 0.9, 3, 1800, 0.45, chips, now);
    this.emit(
      Kind.SPARK,
      this.at,
      this.out,
      14,
      1.1,
      3,
      600,
      0.7,
      SPARK_RGB,
      now,
    );
    if (Math.random() < FIRE_CHANCE) {
      this.emit(Kind.FIRE, this.at, UP, 4, 0.8, 2, 1100, 2.2, FIRE_RGB, now);
    }
    if (Math.random() < FLASH_CHANCE) {
      this.emit(Kind.FLASH, this.at, UP, 0.5, 1, 1, 200, 5, FLASH_RGB, now);
      this.emit(Kind.SPARK, this.at, UP, 18, 1.4, 4, 500, 0.6, FLASH_RGB, now);
    }
    if (Math.random() < this.glassShare(c.building)) {
      this.emit(
        Kind.GLASS,
        this.at,
        this.out,
        7,
        1.2,
        3,
        2600,
        0.45,
        GLASS_RGB,
        now,
      );
    }
  }

  /** D11: the share of a full glass shower building `b` sheds. */
  private glassShare(b: number): number {
    return this.glass(b) ? 1 : GLASS_MASONRY;
  }

  /** Is building `b` a curtain-wall tower (glass showers)? Cached. */
  private glass(b: number): boolean {
    let g = this.glassy.get(b);
    if (g === undefined) {
      const bld = this.buildings[b];
      g = !!bld && archetypeFor(bld) === FacadeArchetype.GLASS;
      this.glassy.set(b, g);
    }
    return g;
  }

  /** The concrete dust / chip tint of building `b`. Cached. */
  private dust(b: number): readonly [number, number, number] {
    let t = this.tint.get(b);
    if (!t) {
      const bld = this.buildings[b];
      t = DUST_RGB[bld ? archetypeFor(bld) : FacadeArchetype.OFFICE];
      this.tint.set(b, t);
    }
    return t;
  }

  /** The tint of building `b`'s gravel (its dust, darker). Cached. */
  private chips(b: number): readonly [number, number, number] {
    let t = this.dark.get(b);
    if (!t) {
      const d = this.dust(b);
      t = [d[0] * 0.55, d[1] * 0.55, d[2] * 0.55];
      this.dark.set(b, t);
    }
    return t;
  }

  /** The trail: this frame's share of TRAIL_RATE, each off the next
   * falling piece round the collapse. */
  private trail(c: Collapse, renderMs: number, dt: number, now: number): void {
    let owed = (this.owed.get(c.id) ?? 0) + TRAIL_RATE * this.share * dt;
    let k = this.cursor.get(c.id) ?? 0;
    // At most a full lap of pieces per frame looking for falling ones.
    let tries = 0;
    while (owed >= 1 && tries < c.n) {
      k = (k + 1) % c.n;
      tries++;
      piecePose(c, k, renderMs, this.a);
      if (this.a.rest) continue;
      piecePose(c, k, renderMs + 40, this.b);
      const vx = (this.b.x - this.a.x) / 0.04;
      const vy = (this.b.y - this.a.y) / 0.04;
      const vz = (this.b.z - this.a.z) / 0.04;
      // Standing still (the lead and the creep): only the odd crumb.
      const moving = vx * vx + vy * vy + vz * vz > 4;
      owed -= 1;
      if (!moving && k % 3 !== 0) continue;
      this.shed(c, k, vx, vy, vz, now);
    }
    this.owed.set(c.id, Math.min(owed, TRAIL_RATE));
    this.cursor.set(c.id, k);
  }

  /** A few particles off piece `k` (posed in `this.a`), moving with it. */
  private shed(
    c: Collapse,
    k: number,
    vx: number,
    vy: number,
    vz: number,
    now: number,
  ): void {
    const p = this.a;
    const role = c.role[k] as number;
    this.at.x = wrapCoord(c.x + p.x + (Math.random() * 2 - 1) * p.hx);
    this.at.y = p.y + (Math.random() * 2 - 1) * p.hy;
    this.at.z = wrapCoord(c.z + p.z + (Math.random() * 2 - 1) * p.hz);
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    this.dir.x = speed > 1e-3 ? vx / speed : 0;
    this.dir.y = speed > 1e-3 ? vy / speed : -1;
    this.dir.z = speed > 1e-3 ? vz / speed : 0;
    // Gravel and fist-sized chunks, darker than the dust — D11: one in
    // three a chunk that falls all the way and settles on the street.
    this.emit(
      Kind.CHIP,
      this.at,
      this.dir,
      Math.min(40, speed * 0.8 + 2),
      0.9,
      2,
      1600,
      0.5,
      this.chips(c.building),
      now,
    );
    if (k % 3 === 0) {
      this.emit(
        Kind.CHIP,
        this.at,
        this.dir,
        Math.min(30, speed * 0.6 + 2),
        0.6,
        1,
        9000,
        0.8,
        this.chips(c.building),
        now,
        true,
      );
    }
    if (role === ROLE_COLUMN) {
      this.emit(Kind.SPARK, this.at, UP, 9, 1.3, 3, 420, 0.8, SPARK_RGB, now);
    } else if (role === ROLE_SHEET) {
      // Window frames cascading off the peeling facade — and its glass
      // (D11: off every tower, a curtain wall's the most).
      this.emit(
        Kind.CHIP,
        this.at,
        this.dir,
        Math.min(30, speed * 0.6 + 3),
        1.0,
        1,
        2200,
        1.3,
        FRAME_RGB,
        now,
      );
      if (Math.random() < this.glassShare(c.building)) {
        this.emit(
          Kind.GLASS,
          this.at,
          this.dir,
          Math.min(30, speed * 0.6 + 4),
          1.2,
          4,
          2400,
          0.4,
          GLASS_RGB,
          now,
        );
      }
    }
  }

  /** Every floor event in (`from`, `to`]: a burst where it happens. */
  private bursts(c: Collapse, from: number, to: number, now: number): void {
    const events = collapseFloorEvents(c);
    const tint = this.dust(c.building);
    const glass = this.glass(c.building);
    for (let e = 0; e < events.length; e++) {
      const ev = events[e] as (typeof events)[number];
      const t = c.t0 + ev.t;
      if (t <= from || t > to) continue;
      const k = 0.35 + 0.65 * ev.size;
      this.at.x = wrapCoord(c.x + ev.x);
      this.at.y = Math.max(1, ev.y);
      this.at.z = wrapCoord(c.z + ev.z);
      const landed = ev.kind === BEAT_LAND;
      this.emit(
        Kind.CHIP,
        this.at,
        UP,
        landed ? 14 : 9,
        1.4,
        Math.round(BURST.gravel * k),
        1800,
        0.6,
        this.chips(c.building),
        now,
      );
      this.emit(
        Kind.DUST,
        this.at,
        UP,
        5,
        1.5,
        Math.round(BURST.dust * k),
        3200,
        6,
        tint,
        now,
      );
      if (!landed) {
        this.emit(
          Kind.GLASS,
          this.at,
          UP,
          8,
          1.5,
          Math.round(BURST.glass * k * (glass ? 1 : GLASS_MASONRY)),
          2600,
          0.4,
          GLASS_RGB,
          now,
        );
        // D11: the floor giving way flashes and bursts into flame.
        this.emit(Kind.FLASH, this.at, UP, 0.5, 1, 1, 220, 6, FLASH_RGB, now);
        this.emit(
          Kind.FIRE,
          this.at,
          UP,
          5,
          1.2,
          Math.round(6 * k),
          1200,
          2.4,
          FIRE_RGB,
          now,
        );
      }
    }
  }
}

/** D11 QA: what the camera sees of the collapses (`__ab.destruction()`). */
export interface CollapseView {
  /** Pieces in the frustum: still falling, at rest. */
  falling: number;
  rest: number;
  /** The largest falling piece's projected size, px (drawing buffer). */
  maxFallingPx: number;
  /** Impact-pool particles in the frustum. */
  particles: number;
}

const viewPose = blankPose();
const viewP = new THREE.Vector3();

/**
 * D11 QA: count every building collapse's pieces (posed at `renderMs`, at
 * their torus image nearest the camera) and the drawn pool particles
 * (`positions`, `live` of them) that fall inside `camera`'s frustum; and the
 * projected size of the largest falling piece, for a `heightPx` tall view.
 */
export function collapseView(
  list: readonly Collapse[],
  camera: THREE.PerspectiveCamera,
  renderMs: number,
  heightPx: number,
  positions: ArrayLike<number>,
  live: number,
): CollapseView {
  const out: CollapseView = {
    falling: 0,
    rest: 0,
    maxFallingPx: 0,
    particles: 0,
  };
  const cam = camera.position;
  const inView = (): boolean =>
    viewP.z < 1 && Math.abs(viewP.x) <= 1 && Math.abs(viewP.y) <= 1;
  const pxPerM = heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
  for (const c of list) {
    if (c.kind !== KIND_BUILDING) continue;
    const ox = cam.x + wrapDeltaAxis(cam.x, c.x);
    const oz = cam.z + wrapDeltaAxis(cam.z, c.z);
    for (let i = 0; i < c.n; i++) {
      piecePose(c, i, renderMs, viewPose);
      viewP.set(ox + viewPose.x, viewPose.y, oz + viewPose.z);
      const d = viewP.distanceTo(cam);
      viewP.project(camera);
      if (!inView()) continue;
      if (viewPose.rest) {
        out.rest++;
        continue;
      }
      out.falling++;
      const size = 2 * Math.max(viewPose.hx, viewPose.hy, viewPose.hz);
      out.maxFallingPx = Math.max(out.maxFallingPx, (size * pxPerM) / d);
    }
  }
  for (let i = 0; i < live; i++) {
    viewP.set(
      positions[i * 3] as number,
      positions[i * 3 + 1] as number,
      positions[i * 3 + 2] as number,
    );
    viewP.project(camera);
    if (inView()) out.particles++;
  }
  return out;
}
