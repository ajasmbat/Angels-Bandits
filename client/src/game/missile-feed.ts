// X1 missile strikes, the client's pure half: which of the socket's held
// missiles fly, whistle, get announced on the radio, or land THIS frame, on
// the synced render clock — plus the camera shake recent impacts leave.
// No THREE, no audio: main.ts turns each list into effects, and
// render/missiles.ts draws the flying ones.
//
// Every list is rebuilt in place each frame (no per-frame allocation), and
// each missile whistles, is announced and lands at most once.

import {
  MISSILE_TELEGRAPH_MIN_MS,
  type MissileStrike,
  missileImpactAt,
  missileWhistleAt,
} from "@angels-bandits/common/strike";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";

/** An impact this late (hidden tab, resume, slow boot) is dropped silently:
 * no blast, no whistle — it already happened to everyone else. */
export const MISSILE_STALE_MS = 500;
/** The radio calls "incoming" for a target this close to the own plane, m. */
export const MISSILE_ANNOUNCE_M = 300;

/** One frame's work. Arrays are reused frame to frame. */
export interface MissileFrame {
  /** In the air at this render time (launched, not landed). */
  flying: MissileStrike[];
  /** Whistles starting this frame. */
  whistles: MissileStrike[];
  /** Missiles to call "incoming" for, this frame. */
  announces: MissileStrike[];
  /** Landing this frame. */
  impacts: MissileStrike[];
}

export class MissileFeed {
  readonly frame: MissileFrame = {
    flying: [],
    whistles: [],
    announces: [],
    impacts: [],
  };
  private readonly whistled = new Set<number>();
  private readonly announced = new Set<number>();

  /**
   * Advance to render time `renderMs` over `held` (the socket's missiles,
   * by id). Landed and stale missiles are REMOVED from `held`. `self` is
   * the own plane's position, or null while dead (no "incoming" call).
   */
  poll(
    held: Map<number, MissileStrike>,
    renderMs: number,
    self: Vec3 | null,
  ): MissileFrame {
    const f = this.frame;
    f.flying.length = 0;
    f.whistles.length = 0;
    f.announces.length = 0;
    f.impacts.length = 0;
    for (const [id, m] of held) {
      const impactAt = missileImpactAt(m);
      if (renderMs >= impactAt) {
        if (renderMs - impactAt <= MISSILE_STALE_MS) f.impacts.push(m);
        held.delete(id);
        this.whistled.delete(id);
        this.announced.delete(id);
        continue;
      }
      if (renderMs < m.t0) continue; // launched on a clock we're behind
      f.flying.push(m);
      if (renderMs >= missileWhistleAt(m) && !this.whistled.has(id)) {
        this.whistled.add(id);
        f.whistles.push(m);
      }
      if (
        self !== null &&
        !this.announced.has(id) &&
        impactAt - renderMs >= MISSILE_TELEGRAPH_MIN_MS &&
        wrapDistance(self, m.to) <= MISSILE_ANNOUNCE_M
      ) {
        this.announced.add(id);
        f.announces.push(m);
      }
    }
    return f;
  }
}

/** Peak camera shake right at an impact, m, and how it fades. */
const SHAKE_PEAK = 2.4;
const SHAKE_RANGE_M = 450;
const SHAKE_DECAY_MS = 320;
const SHAKE_LIFE_MS = 1400;

/** Shake amplitude an impact `distance` m away leaves `ageMs` later, m. */
export function missileShakeAmp(distance: number, ageMs: number): number {
  if (ageMs < 0 || ageMs > SHAKE_LIFE_MS || distance >= SHAKE_RANGE_M) return 0;
  const near = 1 - distance / SHAKE_RANGE_M;
  return SHAKE_PEAK * near * near * Math.exp(-ageMs / SHAKE_DECAY_MS);
}

/** Recent impacts' shake, added onto the display camera's offset. */
export class MissileShake {
  private readonly hits: { amp: number; at: number }[] = [];

  /** An impact `distance` m from the camera landed at `now` (local ms). */
  add(distance: number, now: number): void {
    if (missileShakeAmp(distance, 0) <= 0) return;
    this.hits.push({ amp: missileShakeAmp(distance, 0) / SHAKE_PEAK, at: now });
    if (this.hits.length > 4) this.hits.shift();
  }

  /** Add this frame's shake into `out` (display offset, m). */
  addInto(out: Vec3, now: number): void {
    let a = 0;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i] as { amp: number; at: number };
      const age = now - h.at;
      if (age > SHAKE_LIFE_MS) {
        this.hits.splice(i, 1);
        continue;
      }
      a += h.amp * SHAKE_PEAK * Math.exp(-age / SHAKE_DECAY_MS);
    }
    if (a <= 0) return;
    const t = now / 1000;
    out.x += (Math.sin(t * 61) + Math.sin(t * 37 + 1.3)) * 0.5 * a;
    out.y += (Math.sin(t * 53 + 0.7) + Math.sin(t * 29)) * 0.5 * a;
    out.z += (Math.sin(t * 47 + 2.1) + Math.sin(t * 31 + 0.4)) * 0.5 * a;
  }
}
