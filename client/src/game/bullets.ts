// Client-simulated bullets (PLAN.md: projectiles live on the shooter's
// client). Positions are canonical and step through canonicalize, so a
// bullet crosses the seam exactly like a plane does; each bullet keeps its
// previous position so hit detection can sweep the frame's segment.
// Cosmetic bullets are other players' tracers — rendered, never claimed.

import { BULLET_LIFETIME_S } from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";

export interface Bullet {
  /** Client-issued bullet id — the seq of FireMsg and hit claims. */
  seq: number;
  /** Canonical position now / one step ago (the hit-test segment). */
  pos: Vec3;
  prev: Vec3;
  /** World-frame velocity, m/s (muzzle direction × speed + plane velocity). */
  vel: Vec3;
  /** Canonical muzzle position, sent with a hit claim. */
  origin: Vec3;
  age: number;
  /** True for another player's tracer: render only, never hit-test. */
  cosmetic: boolean;
}

export class Bullets {
  private list: Bullet[] = [];

  get all(): readonly Bullet[] {
    return this.list;
  }

  spawn(seq: number, origin: Vec3, vel: Vec3, cosmetic = false): void {
    const pos = canonicalize(origin);
    this.list.push({
      seq,
      pos,
      prev: pos,
      vel,
      origin: pos,
      age: 0,
      cosmetic,
    });
  }

  /** Advance every bullet one frame; expired ones drop out. */
  step(dt: number): void {
    for (const b of this.list) {
      b.prev = b.pos;
      b.pos = canonicalize({
        x: b.pos.x + b.vel.x * dt,
        y: b.pos.y + b.vel.y * dt,
        z: b.pos.z + b.vel.z * dt,
      });
      b.age += dt;
    }
    this.list = this.list.filter((b) => b.age <= BULLET_LIFETIME_S);
  }

  /** Remove a bullet that just hit (one bullet, one claim). */
  remove(bullet: Bullet): void {
    const i = this.list.indexOf(bullet);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** Drop the local player's live bullets (death — claims would be stale). */
  clearOwn(): void {
    this.list = this.list.filter((b) => b.cosmetic);
  }
}
