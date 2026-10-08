// D2 breakable buildings, server side: each room's own breakable copy of the
// city, and the two ways a fight breaks it — a bullet's ray and a death's
// blast. index.ts and the bot-sim harness both call exactly these, so the sim
// measures the damage the live server deals.
//
// The server is the only authority on what breaks (PLAN.md authority split:
// combat is server-side). Movement and crash DETECTION stay with each client,
// which subtracts the same destroyed set from the same city.

import {
  type Building,
  CityDamage,
  makeBuilding,
  raycastChunk,
} from "@angels-bandits/common/city";
import {
  BULLET_DAMAGE,
  BULLET_RANGE,
  DEATH_BLAST_DAMAGE,
  DEATH_BLAST_RADIUS,
} from "@angels-bandits/common/constants";
import type { Quat } from "@angels-bandits/common/protocol";
import type { Vec3 } from "@angels-bandits/common/world";

/**
 * A breakable copy of `buildings`: new Building objects in the same order
 * (chunk ids are building indices, so the order IS the protocol), sharing
 * the immutable tiers, holes and roofs, built through makeBuilding so they
 * keep the seed city's one object shape.
 */
export function cloneCity(buildings: readonly Building[]): Building[] {
  return buildings.map((b) => makeBuilding({ ...b, damage: undefined }));
}

/** One room's city and what has been broken in it. */
export interface RoomCity {
  readonly buildings: Building[];
  readonly damage: CityDamage;
}

export function createRoomCity(buildings: readonly Building[]): RoomCity {
  const copy = cloneCity(buildings);
  const damage = new CityDamage();
  damage.bind(copy);
  return { buildings: copy, damage };
}

/** Unit nose vector of a wire attitude (the same math as bots.poseVelocity
 * at speed 1: the plane flies along its local −Z). */
export function noseOf(quat: Quat): Vec3 {
  const { x, y, z, w } = quat;
  const v = {
    x: -2 * w * y - 2 * x * z,
    y: 2 * w * x - 2 * y * z,
    z: -1 + 2 * x * x + 2 * y * y,
  };
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * One accepted round: ray it from `origin` along `dir` (unit) through the
 * room's city for BULLET_RANGE and take BULLET_DAMAGE off the first chunk it
 * meets. The ray only knows the city — a round that hit a plane may chip the
 * wall behind it too. Returns the chunk hit, or -1.
 */
export function applyShotDamage(
  city: RoomCity,
  origin: Vec3,
  dir: Vec3,
): number {
  const hit = raycastChunk(city.buildings, origin, dir, BULLET_RANGE);
  if (!hit || hit.chunk < 0) return -1;
  city.damage.damageChunk(hit.chunk, BULLET_DAMAGE);
  return hit.chunk;
}

/** A plane died at `pos`: blow out every chunk near enough (point-to-box,
 * DEATH_BLAST_RADIUS, falling off to 0). Returns the chunks destroyed. */
export function applyDeathBlast(city: RoomCity, pos: Vec3): number[] {
  return city.damage.damageAt(pos, DEATH_BLAST_RADIUS, DEATH_BLAST_DAMAGE);
}
