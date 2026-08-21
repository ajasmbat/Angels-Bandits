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
/** Smallest building footprint side, meters. */
export const BUILDING_MIN_FOOTPRINT = 100;
/** Largest footprint side, meters. Must stay ≤ BLOCK_PITCH − STREET_WIDTH. */
export const BUILDING_MAX_FOOTPRINT = 170;
/** Hand-placed landmark supertalls for orientation. */
export const LANDMARK_HEIGHT = 250;
/** Footprint side of the slim landmark towers, meters. */
export const LANDMARK_FOOTPRINT = 90;

// --- Flight (tuned by T2) ---
/** Minimum airspeed, m/s. At MIN_SPEED you mush, never stall. */
export const MIN_SPEED = 40;
/** Maximum airspeed, m/s. */
export const MAX_SPEED = 90;
/** Soft altitude ceiling, meters — engine power fades above this. */
export const SOFT_CEILING = 600;
/** Band above SOFT_CEILING over which engine power fades to nothing, meters. */
export const CEILING_FADE = 150;
/** Sink rate at full ceiling fade, m/s — the "mush back down", never a wall. */
export const MUSH_SINK = 25;
/** Throttle response: target-speed change per second at full W/S, m/s². */
export const THROTTLE_RATE = 30;
/** Proportional pull of airspeed toward the commanded speed, 1/s. */
export const SPEED_RESPONSE = 0.6;
/** Energy rule strength: speed gain at a straight-down dive, m/s² (loss when climbing). */
export const ENERGY_GAIN = 8;
/** Speed bleed at full turn/pitch deflection, m/s². */
export const TURN_BLEED = 8;
/** Max pitch rate at full mouse deflection, rad/s. */
export const PITCH_RATE = 1.0;
/** Max yaw (turn) rate at full mouse deflection, rad/s. */
export const TURN_RATE = 0.9;
/** Bank angle the plane leans into at full turn deflection, rad (~57°). */
export const BANK_ANGLE = 1.0;
/** Exponential response of roll toward its target, 1/s. */
export const BANK_RESPONSE = 4;
/** Pitch is clamped to ±this, rad (~85° — arcade mouse-aim never goes vertical). */
export const PITCH_LIMIT = 1.48;
/** Player collision-sphere radius, meters. */
export const PLAYER_RADIUS = 2;
/** Respawn altitude, meters — above every rooftop (tallest landmark is 250 m). */
export const RESPAWN_ALTITUDE = 300;
/** Respawn airspeed, m/s — combat speed, mid-throttle. */
export const RESPAWN_SPEED = 65;

// --- Chase camera (client-only feel, kept here with the rest of the tuning) ---
/** Camera distance behind the plane, meters. */
export const CHASE_DISTANCE = 22;
/** Camera height above the plane, meters. */
export const CHASE_HEIGHT = 6;
/** Exponential response of the camera toward its chase position, 1/s — the lag. */
export const CAMERA_RESPONSE = 3.5;

// --- Networking rates ---
/** Client → server input/state rate, Hz. */
export const TICK_UP_HZ = 20;
/** Server → client snapshot rate, Hz. */
export const TICK_DOWN_HZ = 15;

// --- Multiplayer presence (T3) ---
/** Shared city seed — every room generates the same city for now. */
export const CITY_SEED = 42;
/** Remote planes render this far behind estimated server time, ms. */
export const INTERP_DELAY_MS = 100;
/** Server accepts claimed speeds up to MAX_SPEED × this factor. */
export const SPEED_TOLERANCE = 1.1;
/** Slack added to the per-update displacement bound, meters (network jitter). */
export const POSE_DISTANCE_SLACK = 15;
/** Claimed altitude is clamped to this, meters (legal flight can't sustain more). */
export const MAX_ALTITUDE = 800;
/** Max player-name length on the wire; longer names are truncated. */
export const NAME_MAX_LENGTH = 16;
/** Server drops a joined connection silent for this long, ms (clients stream at TICK_UP_HZ). */
export const LIVENESS_TIMEOUT_MS = 4000;

// --- Combat (placeholders — T4 tunes them) ---
export const MAX_HP = 100;
export const BULLET_SPEED = 400;
export const BULLET_DAMAGE = 7;
/** Effective bullet range, meters (server also range-validates hits with this). */
export const BULLET_RANGE = 350;

// --- Rooms ---
/** Players per FFA room; rooms auto-spawn when full. */
export const ROOM_CAP = 12;
