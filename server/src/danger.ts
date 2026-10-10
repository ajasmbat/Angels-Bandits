// C2 fairness: the per-player danger budget. Constant chaos must stay
// survivable, so every LETHAL event a director stages near a plane is
// charged to that plane, and a plane that has had its share in the last
// window is left alone for a while. One DangerBudget per room, shared by the
// X1 missile director, the C2 chaos director (meteors) and the
// D5 destruction director; index.ts and the bot-sim harness drive exactly
// this.
//
// The rules:
//  - "near" a plane: the event's impact point(s) within nearM of the plane's
//    current position OR its straight-line position at the impact instant;
//  - at most `total` events near one plane per window, and at most
//    perLayer[layer] of them from one layer, so missiles every few seconds
//    can never use up the allowance meteors and the director need;
//  - nothing at all near a plane that is spawn-protected or (re)spawned
//    less than freshMs ago;
//  - a multi-impact event is charged ONCE per plane.
//
// Exempt on purpose (each has its own floor): S4 flak (reaction delay and
// a per-second damage cap), fire (it never hurts planes), wreck and boss
// sections and chain reactions (consequences of budgeted events).

import { type Vec3, wrapDistance } from "@angels-bandits/common/world";

export type DangerLayer =
  | "missile"
  | "meteor"
  | "director"
  // U6: a cave-in ahead of a plane in a bore (server/src/caveins.ts) —
  // charged by id (allowsIds / chargeIds): `near()` flies straight and
  // clamps to street level, so it never sees an underground event.
  | "cavein";

export interface DangerTuning {
  windowMs: number;
  total: number;
  perLayer: Readonly<Record<DangerLayer, number>>;
  /** Plan-view-and-height distance that makes an impact "near", m: the
   * largest blast radius (a meteor's 55 m) plus 25 m of prediction error. */
  nearM: number;
  /** A plane (re)spawned this recently is off limits, ms. */
  freshMs: number;
}

export const DANGER_TUNING: DangerTuning = {
  windowMs: 30_000,
  total: 4,
  perLayer: { missile: 2, meteor: 1, director: 1, cavein: 2 },
  nearM: 80,
  freshMs: 5000,
};

/** A plane as the budget sees it: where it is, how it is moving (m/s), and
 * whether it is spawn-protected right now. */
export interface DangerPlane {
  id: string;
  pos: Vec3;
  vel?: Vec3;
  prot?: boolean;
}

interface Charge {
  t: number;
  layer: DangerLayer;
}

export class DangerBudget {
  private readonly charges = new Map<string, Charge[]>();
  private readonly spawns = new Map<string, number>();
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(readonly tuning: DangerTuning = DANGER_TUNING) {}

  /** A plane (re)spawned or came back at `now`. */
  noteSpawn(id: string, now: number): void {
    this.spawns.set(id, now);
  }

  /** A plane left the room. */
  forget(id: string): void {
    this.spawns.delete(id);
    this.charges.delete(id);
  }

  /** The room's last human left: start over. */
  reset(): void {
    this.charges.clear();
    this.spawns.clear();
  }

  /** Spawn-protected, or (re)spawned less than freshMs ago. */
  fresh(p: DangerPlane, now: number): boolean {
    if (p.prot) return true;
    const at = this.spawns.get(p.id);
    return at !== undefined && now - at < this.tuning.freshMs;
  }

  /** Events charged to `id` in the window ending at `now` (one layer, or
   * all of them). */
  count(id: string, now: number, layer?: DangerLayer): number {
    const list = this.charges.get(id);
    if (!list) return 0;
    let n = 0;
    for (const c of list) {
      if (now - c.t >= this.tuning.windowMs) continue;
      if (layer === undefined || c.layer === layer) n++;
    }
    return n;
  }

  /** Is any of `points` near `p` — at its position now, or where it will be
   * `leadMs` from now flying straight? */
  near(p: DangerPlane, points: readonly Vec3[], leadMs: number): boolean {
    const r = this.tuning.nearM;
    const s = leadMs / 1000;
    const v = p.vel;
    this.at.x = p.pos.x + (v ? v.x * s : 0);
    this.at.y = Math.max(0, p.pos.y + (v ? v.y * s : 0));
    this.at.z = p.pos.z + (v ? v.z * s : 0);
    for (const q of points) {
      if (wrapDistance(q, p.pos) <= r || wrapDistance(q, this.at) <= r) {
        return true;
      }
    }
    return false;
  }

  /** May `layer` stage a lethal event at `points`, landing `leadMs` from
   * `now`? False when it would be near a fresh plane or one whose budget
   * (total, or this layer's share) is spent. */
  allows(
    layer: DangerLayer,
    points: readonly Vec3[],
    leadMs: number,
    now: number,
    planes: readonly DangerPlane[],
  ): boolean {
    const t = this.tuning;
    for (const p of planes) {
      if (!this.near(p, points, leadMs)) continue;
      if (this.fresh(p, now)) return false;
      if (this.count(p.id, now) >= t.total) return false;
      if (this.count(p.id, now, layer) >= t.perLayer[layer]) return false;
    }
    return true;
  }

  /** The event was staged: charge every plane it is near, once. Returns
   * the ids charged. */
  charge(
    layer: DangerLayer,
    points: readonly Vec3[],
    leadMs: number,
    now: number,
    planes: readonly DangerPlane[],
  ): string[] {
    const out: string[] = [];
    for (const p of planes) {
      if (!this.near(p, points, leadMs)) continue;
      let list = this.charges.get(p.id);
      if (!list) {
        list = [];
        this.charges.set(p.id, list);
      }
      // Drop what has left the window, so the list stays a few long.
      while (
        list.length > 0 &&
        now - (list[0] as Charge).t >= this.tuning.windowMs
      ) {
        list.shift();
      }
      list.push({ t: now, layer });
      out.push(p.id);
    }
    return out;
  }

  /** U6: allows() for an event whose planes the caller has already named
   * (`ids`, a subset of `planes`): each must be neither fresh nor over its
   * total or this layer's share. */
  allowsIds(
    layer: DangerLayer,
    ids: readonly string[],
    now: number,
    planes: readonly DangerPlane[],
  ): boolean {
    const t = this.tuning;
    for (const p of planes) {
      if (!ids.includes(p.id)) continue;
      if (this.fresh(p, now)) return false;
      if (this.count(p.id, now) >= t.total) return false;
      if (this.count(p.id, now, layer) >= t.perLayer[layer]) return false;
    }
    return true;
  }

  /** U6: charge() to the planes the caller named, once each. */
  chargeIds(layer: DangerLayer, ids: readonly string[], now: number): void {
    for (const id of ids) {
      let list = this.charges.get(id);
      if (!list) {
        list = [];
        this.charges.set(id, list);
      }
      while (
        list.length > 0 &&
        now - (list[0] as Charge).t >= this.tuning.windowMs
      ) {
        list.shift();
      }
      list.push({ t: now, layer });
    }
  }

  /** allows() then charge() in one step; true when staged. */
  take(
    layer: DangerLayer,
    points: readonly Vec3[],
    leadMs: number,
    now: number,
    planes: readonly DangerPlane[],
  ): boolean {
    if (!this.allows(layer, points, leadMs, now, planes)) return false;
    this.charge(layer, points, leadMs, now, planes);
    return true;
  }
}
