// Gun heat model — pure and shared, like flight.ts: the client's trigger
// (guns.ts) and the server's fire validation (server/src/combat.ts) step the
// SAME model from the same constants, so what the HUD meter shows and what
// the server will accept can only drift by clock jitter (the server absorbs
// that with HEAT_VALIDATION_SLACK, not a second model).
//
// Heat is a 0..1 meter: each shot adds HEAT_PER_SHOT, cooling sheds
// HEAT_COOL_RATE per second always. Reaching the lock threshold locks the
// guns until heat cools below HEAT_LOCK_BELOW (hysteresis — no flickering).

import {
  FIRE_INTERVAL_MS,
  HEAT_COOL_RATE,
  HEAT_LOCK_BELOW,
  HEAT_PER_SHOT,
  OVERHEAT_AT,
} from "./constants";

export interface GunHeat {
  /** Current heat, 0..~1 (can sit slightly above the lock point when locked). */
  heat: number;
  /** True while overheated: no shots until heat cools below HEAT_LOCK_BELOW. */
  locked: boolean;
  /** Timestamp heat was last cooled to, ms. */
  at: number;
  /** Timestamp of the last accepted shot, ms. */
  lastShotAt: number;
}

export function createGunHeat(now = 0): GunHeat {
  return {
    heat: 0,
    locked: false,
    at: now,
    lastShotAt: Number.NEGATIVE_INFINITY,
  };
}

/** Heat after cooling to `now` (unlocks when it falls below HEAT_LOCK_BELOW). */
export function cooledGunHeat(g: GunHeat, now: number): GunHeat {
  const dt = Math.max(0, now - g.at) / 1000;
  const heat = Math.max(0, g.heat - HEAT_COOL_RATE * dt);
  return {
    heat,
    locked: g.locked && heat >= HEAT_LOCK_BELOW,
    at: now,
    lastShotAt: g.lastShotAt,
  };
}

/** May a trigger held right now fire? Cool first — pass cooledGunHeat output. */
export function canFire(g: GunHeat, now: number): boolean {
  return !g.locked && now - g.lastShotAt >= FIRE_INTERVAL_MS;
}

/**
 * Heat after one accepted shot at `now`. `lockAt` is OVERHEAT_AT for the
 * client's own trigger; the server validates with OVERHEAT_AT +
 * HEAT_VALIDATION_SLACK so clock jitter never rejects an honest shot.
 */
export function firedGunHeat(
  g: GunHeat,
  now: number,
  lockAt: number = OVERHEAT_AT,
): GunHeat {
  const heat = g.heat + HEAT_PER_SHOT;
  return { heat, locked: heat >= lockAt, at: g.at, lastShotAt: now };
}
