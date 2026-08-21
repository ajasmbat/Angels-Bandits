// Street lamps (V1 lighting pass): deterministic emissive lamp heads along
// the street grid, plus a faked warm glow pool under each — NO point lights,
// the night look is emissive + bloom only. Layout is a pure function of the
// block grid (no PRNG): each block owns its west and south street segments,
// so every street centerline is covered exactly once despite the torus wrap.

import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";

/** Lamps per owned street segment, at these fractions along it. */
const LAMP_FRACTIONS = [0.125, 0.5, 0.875] as const;

/** Canonical ground position of one lamp (street centerline, y = 0). */
export interface StreetlampPosition {
  x: number;
  z: number;
}

/**
 * Every street lamp in canonical [0, WORLD_SIZE) coords, deterministic from
 * the block grid. Each block contributes its west edge (x = bx·PITCH) and its
 * south edge (z = bz·PITCH); with the torus wrap that tiles all street lines
 * exactly once, corners excluded (fractions never land on 0 or 1).
 */
export function streetlampPositions(): StreetlampPosition[] {
  const grid = WORLD_SIZE / BLOCK_PITCH;
  const lamps: StreetlampPosition[] = [];
  for (let bx = 0; bx < grid; bx++) {
    for (let bz = 0; bz < grid; bz++) {
      const x0 = bx * BLOCK_PITCH;
      const z0 = bz * BLOCK_PITCH;
      for (const f of LAMP_FRACTIONS) {
        lamps.push({ x: x0, z: z0 + f * BLOCK_PITCH }); // west segment
        lamps.push({ x: x0 + f * BLOCK_PITCH, z: z0 }); // south segment
      }
    }
  }
  return lamps;
}
