// Client-simulated bullets (PLAN.md: projectiles live on the shooter's
// client). Positions are canonical and step through canonicalize, so a
// bullet crosses the seam exactly like a plane does; each bullet keeps its
// previous position so hit detection can sweep the frame's segment.
// Cosmetic bullets are other players' tracers — rendered, never claimed.

import { hitsGround } from "@angels-bandits/common/collision";
import { BULLET_LIFETIME_S } from "@angels-bandits/common/constants";
import {
  type Vec3,
  canonicalize,
  wrapCoord,
} from "@angels-bandits/common/world";

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
  /**
   * D1: this round already struck a building (one impact per round). Its
   * tracer stops drawing at the wall; hit detection is untouched — a spent
   * own round can still score exactly as it could before (cosmetic only).
   */
  spent: boolean;
}

export class Bullets {
  private list: Bullet[] = [];
  /** D9: the room's fallen bridge spans (a round flies through the gap). */
  gaps = 0;

  get all(): readonly Bullet[] {
    return this.list;
  }

  spawn(seq: number, origin: Vec3, vel: Vec3, cosmetic = false): void {
    const pos = canonicalize(origin);
    // Three distinct objects: step() reuses pos/prev in place (O4), and the
    // muzzle position a hit claim carries must never move with them.
    this.list.push({
      seq,
      pos,
      prev: { ...pos },
      vel,
      origin: { ...pos },
      age: 0,
      cosmetic,
      spent: false,
    });
  }

  /**
   * Advance every bullet one frame; expired ones drop out. In place (O4): a
   * 12-plane furball keeps a couple of hundred tracers alive, and two fresh
   * objects per bullet per frame plus a filtered copy of the list was garbage
   * the collector had to stop for mid-fight. `prev` and `pos` swap objects,
   * so `prev` is still exactly last frame's position.
   */
  step(dt: number): void {
    let kept = 0;
    for (const b of this.list) {
      // U4: a round that went into the ground last step stops there — the
      // rock over a tunnel is cover (its last segment was still swept).
      if (b.pos.y < 0 && hitsGround(b.pos, 0, this.gaps)) continue;
      const next = b.prev;
      next.x = wrapCoord(b.pos.x + b.vel.x * dt);
      next.y = b.pos.y + b.vel.y * dt;
      next.z = wrapCoord(b.pos.z + b.vel.z * dt);
      b.prev = b.pos;
      b.pos = next;
      b.age += dt;
      if (b.age <= BULLET_LIFETIME_S) this.list[kept++] = b;
    }
    this.list.length = kept;
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
