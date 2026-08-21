// Every tunable in one place (PLAN.md is the source of truth for these values).
// Nothing downstream hardcodes a gameplay number — client, server, and tests
// all import from here so both sides of the wire agree exactly.

// --- Map / torus ---
/** Side length of the square torus world, meters. X and Z wrap modulo this. */
export const WORLD_SIZE = 2000;
/** Fog / view distance, meters. Must stay < WORLD_SIZE / 2 (torus hard rule). */
export const FOG_DISTANCE = 800;
/** City block pitch, meters. Must divide WORLD_SIZE evenly so streets tile across the seam. */
export const BLOCK_PITCH = 200;
/** Width of the street gap between adjacent building footprints, meters. */
export const STREET_WIDTH = 30;

// --- Buildings ---
export const BUILDING_MIN_HEIGHT = 40;
export const BUILDING_MAX_HEIGHT = 180;
/** Hand-placed landmark supertalls for orientation. */
export const LANDMARK_HEIGHT = 250;

// --- Flight (placeholders — T2 tunes them) ---
/** Minimum airspeed, m/s. At MIN_SPEED you mush, never stall. */
export const MIN_SPEED = 40;
/** Maximum airspeed, m/s. */
export const MAX_SPEED = 90;
/** Soft altitude ceiling, meters — engine power fades above this. */
export const SOFT_CEILING = 600;

// --- Networking rates ---
/** Client → server input/state rate, Hz. */
export const TICK_UP_HZ = 20;
/** Server → client snapshot rate, Hz. */
export const TICK_DOWN_HZ = 15;

// --- Combat (placeholders — T4 tunes them) ---
export const MAX_HP = 100;
export const BULLET_SPEED = 400;
export const BULLET_DAMAGE = 7;
/** Effective bullet range, meters (server also range-validates hits with this). */
export const BULLET_RANGE = 350;

// --- Rooms ---
/** Players per FFA room; rooms auto-spawn when full. */
export const ROOM_CAP = 12;
