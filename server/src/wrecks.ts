// D4 downed planes, server side: each room's falling wrecks. A shot-down
// plane becomes a wreck whose whole path is decided HERE, once, at the death
// (common/src/wreck.ts wreckImpact against the room's city as it stands);
// clients only replay it. The tick settles each impact exactly once — the
// D2 blast through the room's city — and wreck kills credit the shooter.
// index.ts and the bot-sim harness both use exactly these.

import { chunkBuilding } from "@angels-bandits/common/city";
import { PLAYER_RADIUS } from "@angels-bandits/common/constants";
import {
  WRECKS_MAX,
  WRECK_BLAST_DAMAGE,
  WRECK_BLAST_RADIUS,
  WRECK_CREDIT_LOOKBACK_MS,
  WRECK_CREDIT_SLACK,
  WRECK_RADIUS,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import {
  type WreckParams,
  type WreckWorld,
  wreckImpact,
  wreckNear,
  wreckPosAt,
  wreckTouches,
} from "@angels-bandits/common/wreck";
import type { RoomCity } from "./destruction";

/** One falling wreck and whose it is. */
export interface WreckRecord {
  readonly params: WreckParams;
  readonly victimId: string;
  /** Who shot it down — the credit for anyone it kills. */
  readonly shooterId: string | null;
}

/** Corkscrew direction from the ids (never from where it happened). */
function spinOf(victimId: string, id: number): 1 | -1 {
  let h = 0x811c9dc5 ^ id;
  for (let i = 0; i < victimId.length; i++) {
    h = Math.imul(h ^ victimId.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0) % 2 === 0 ? 1 : -1;
}

/** Where a wreck comes down. */
export const impactPos = (w: WreckParams): Vec3 =>
  wreckPosAt(w, w.t + w.end, { x: 0, y: 0, z: 0 });

/** A wreck hit at `pos`: blow out every chunk near enough (D2 damageAt,
 * WRECK_BLAST_RADIUS, falling off to 0). Returns the chunks destroyed.
 * D3: a collapse it sets off is credited to `by` — the wreck's shooter. */
export function applyWreckImpact(
  city: RoomCity,
  pos: Vec3,
  by: string | null = null,
): number[] {
  const out = city.damage.damageAt(pos, WRECK_BLAST_RADIUS, WRECK_BLAST_DAMAGE);
  for (const id of out) city.breakers.set(chunkBuilding(id), by);
  return out;
}

/** One room's falling wrecks. */
export class RoomWrecks {
  private list: WreckRecord[] = [];
  /** Settled wrecks a late crash report may still name (lookback). */
  private landed: WreckRecord[] = [];
  private nextId = 1;
  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };

  /**
   * A plane was shot down at `p` flying `v`, at server time `t`: sweep its
   * fall against `world` and start it. Null at WRECKS_MAX — the caller
   * blasts in place instead.
   */
  spawn(
    victimId: string,
    shooterId: string | null,
    p: Vec3,
    v: Vec3,
    t: number,
    world: WreckWorld,
  ): WreckParams | null {
    if (this.list.length >= WRECKS_MAX) return null;
    const id = this.nextId++;
    const path = {
      p: { x: p.x, y: p.y, z: p.z },
      v: { x: v.x, y: v.y, z: v.z },
      t,
      spin: spinOf(victimId, id),
    };
    const { end, hit } = wreckImpact(path, world);
    const params: WreckParams = { id, ...path, end, hit };
    this.list.push({ params, victimId, shooterId });
    return params;
  }

  /** Falling wrecks, oldest first (the welcome's replay). */
  active(): WreckParams[] {
    return this.list.map((r) => r.params);
  }

  get count(): number {
    return this.list.length;
  }

  /** Every wreck that has hit by `now`, oldest first — each returned exactly
   * once, and gone from the room after. */
  settle(now: number): WreckRecord[] {
    const due: WreckRecord[] = [];
    const kept: WreckRecord[] = [];
    for (const r of this.list) {
      (now >= r.params.t + r.params.end ? due : kept).push(r);
    }
    this.list = kept;
    this.landed = this.landed.filter(
      (r) => now - (r.params.t + r.params.end) <= WRECK_CREDIT_LOOKBACK_MS,
    );
    this.landed.push(...due);
    return due;
  }

  /**
   * The wreck a crash report names, if the server agrees: it is still
   * falling (or hit within the lookback), is not the crasher's own, and
   * came within reach of the crasher's on-record position over the last
   * WRECK_CREDIT_LOOKBACK_MS. Null → an ordinary crash.
   */
  creditFor(
    crasherId: string,
    wreckId: unknown,
    pos: Vec3,
    now: number,
  ): WreckRecord | null {
    if (typeof wreckId !== "number") return null;
    const r =
      this.list.find((w) => w.params.id === wreckId) ??
      this.landed.find((w) => w.params.id === wreckId);
    if (!r || r.victimId === crasherId) return null;
    const reach = WRECK_RADIUS + PLAYER_RADIUS + WRECK_CREDIT_SLACK;
    return wreckNear(r.params, pos, reach, now - WRECK_CREDIT_LOOKBACK_MS, now)
      ? r
      : null;
  }

  /** The falling wreck a sphere at `pos` touches at `now` (bots), never
   * the one `id` itself became. */
  touching(
    id: string,
    pos: Vec3,
    radius: number,
    now: number,
  ): WreckRecord | null {
    for (const r of this.list) {
      if (r.victimId === id) continue;
      if (wreckTouches(r.params, pos, radius, now, this.scratch)) return r;
    }
    return null;
  }
}
