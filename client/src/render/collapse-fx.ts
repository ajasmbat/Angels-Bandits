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

import type { Building } from "@angels-bandits/common/city";
import {
  BEAT_LAND,
  type Collapse,
  KIND_BUILDING,
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

const GLASS_RGB = [0.72, 0.88, 1.0] as const;
const FRAME_RGB = [0.08, 0.08, 0.09] as const;
const UP: Vec3 = { x: 0, y: 1, z: 0 };

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
    for (let i = 0; i < n; i++) {
      const c = (this.near[i] as Near).c;
      this.trail(c, renderMs, dt, now);
      if (Number.isFinite(prev) && renderMs > prev) {
        this.bursts(c, prev, renderMs, now);
      }
    }
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
    // Gravel and fist-sized chunks, darker than the dust.
    this.impacts.spray(
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
    if (role === ROLE_COLUMN) {
      this.impacts.spray(
        Kind.SPARK,
        this.at,
        UP,
        9,
        1.3,
        3,
        420,
        0.8,
        SPARK_RGB,
        now,
      );
    } else if (role === ROLE_SHEET) {
      // Window frames cascading off the peeling facade — and its glass.
      this.impacts.spray(
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
      if (this.glass(c.building)) {
        this.impacts.spray(
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
      this.impacts.spray(
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
      this.impacts.spray(
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
      if (glass && !landed) {
        this.impacts.spray(
          Kind.GLASS,
          this.at,
          UP,
          8,
          1.5,
          Math.round(BURST.glass * k),
          2600,
          0.4,
          GLASS_RGB,
          now,
        );
      }
    }
  }
}
