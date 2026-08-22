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

// --- Street cross-section (S1) — consumed via common/src/city/street.ts ---
/** Offset of each lane center from the street centerline, meters (right-hand traffic). */
export const LANE_CENTER_OFFSET = 5;
/** Street-furniture line (lamp posts): this far behind the curb, meters. */
export const FURNITURE_MARGIN = 1;
/** Depth of a crosswalk zebra band along the roadway, meters. */
export const CROSSWALK_DEPTH = 4;

// --- Emissive ladder (S1) ---
// Peak linear-luminance target per emissive class, strictly increasing so
// combat readability outranks scenery. Every rung sits above the client's
// bloom threshold (0.72); client materials derive their HDR boosts from
// these targets (plain numbers here — common/ stays THREE-free).
export const EMISSIVE_WINDOW = 0.88;
/** Wingtip ribbon trails at full turn hardness — streaks, not neon. */
export const EMISSIVE_TRAIL = 0.9;
/** Reserved for S2 neon signage — between windows and lamp heads. */
export const EMISSIVE_SIGN = 0.93;
/** Engine exhaust flicker at full throttle — a warm ember, below the lamps. */
export const EMISSIVE_EXHAUST = 0.95;
export const EMISSIVE_LAMP = 0.98;
/** Steady red/green/white aviation lights on every plane's wingtips/tail. */
export const EMISSIVE_NAVLIGHT = 1.0;
/** Landmark beacons at pulse PEAK; the trough dips under the bloom threshold. */
export const EMISSIVE_BEACON = 1.05;
/** Anti-collision strobe at flash peak — brightest plane light, under tracers. */
export const EMISSIVE_STROBE = 1.1;
export const EMISSIVE_TRACER = 1.5;

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

// --- Tiered setbacks (V2) ---
// Buildings are 1–3 stacked, centered tiers; tier 1 keeps the full footprint
// so streets/canyons/minimap are untouched. All ratios feed the seeded PRNG
// draws in generateCity — tune here, never downstream.
/** Below this total height a building stays a single slab, meters. */
export const TIER_TWO_MIN_HEIGHT = 80;
/** Minimum total height for a 3-tier wedding-cake profile, meters. */
export const TIER_THREE_MIN_HEIGHT = 130;
/** Upper-tier footprint ratio vs the tier below, min..max (setback range). */
export const TIER_SETBACK_MIN = 0.55;
export const TIER_SETBACK_MAX = 0.8;
/** Fraction of the remaining height a lower tier keeps, min..max. */
export const TIER_SPLIT_MIN = 0.5;
export const TIER_SPLIT_MAX = 0.7;

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

// --- Storm (ST1) --- schedule shared client/server; the ceiling is a hidden
// server rule — no constant here feeds a warning UI, by design.
/** Cloud deck base altitude, m (ST2 renders the deck; bots stay under it). */
export const CLOUD_BASE = 500;
/** Above this altitude the hidden death ceiling arms, m. */
export const STORM_KILL_ALT = 600;
/** Continuous time above STORM_KILL_ALT before the kill bolt, ms — dipping
 * below resets it. Never announced to clients: discovery is the design. */
export const STORM_GRACE_MS = 3000;
/** Radius a strike reveals planes within (ST2's global ping), m. */
export const STORM_REVEAL_RADIUS = 300;
/** How long a strike's reveal ping lasts (ST2), ms. */
export const STORM_REVEAL_MS = 2000;
/** Consecutive scheduled strikes are this far apart (seeded jitter), ms. */
export const STRIKE_INTERVAL_MIN_MS = 8000;
export const STRIKE_INTERVAL_MAX_MS = 15000;
/** Strike coverage cell, m — every cell is struck once per 16-strike epoch. */
export const STORM_CELL_SIZE = 500;
/** A strike whose cell holds a landmark supertall lands within this of the
 * tower's center — the 250 m towers are the city's lightning rods, m. */
export const STORM_ROD_RADIUS = 60;

// --- Combat (tuned by T4) ---
export const MAX_HP = 100;
export const BULLET_SPEED = 400;
/** Damage per bullet. 15 hits to kill → ~1.5 s of sustained on-target fire at FIRE_INTERVAL_MS. */
export const BULLET_DAMAGE = 7;
/** Effective bullet range, meters (server also range-validates hits with this). */
export const BULLET_RANGE = 350;
/** How long a client-simulated bullet lives, seconds (≈ range / speed). */
export const BULLET_LIFETIME_S = BULLET_RANGE / BULLET_SPEED;
/** Plane hit-sphere radius, meters — generous (wingspan 9 m) because hits favor the shooter. */
export const HIT_RADIUS = 6;

// --- Guns / heat model (heat is a 0..1 meter; overheating locks the guns) ---
/** Minimum time between shots, ms (10 rounds/s, alternating wingtips). */
export const FIRE_INTERVAL_MS = 100;
/** Heat added per shot. With cooling, continuous fire overheats in ~4 s. */
export const HEAT_PER_SHOT = 0.055;
/** Heat shed per second, always (firing or not). */
export const HEAT_COOL_RATE = 0.3;
/** Heat at or above this locks the guns (the meter's full scale). */
export const OVERHEAT_AT = 1.0;
/** Locked guns stay locked until heat cools below this (hysteresis, ~2.2 s). */
export const HEAT_LOCK_BELOW = 0.35;

// --- Server-side combat validation ---
/** Meters of slack on top of BULLET_RANGE for hit claims: interpolation delay
 * plus bullet flight time let both planes move before the claim arrives. */
export const HIT_RANGE_SLACK = 200;
/** A claim's bulletOrigin must be within this of the shooter's on-record pose, meters. */
export const HIT_ORIGIN_SLACK = 50;
/** Fire-rate token bucket burst: shots that may arrive batched by network jitter. */
export const FIRE_BURST_SLACK = 5;
/** Server heat tolerance above OVERHEAT_AT before shots are rejected (clock jitter). */
export const HEAT_VALIDATION_SLACK = 0.1;

// --- Death, respawn, regen (all server-owned) ---
/** Invulnerability after (re)spawn, ms — canceled the instant that player fires. */
export const SPAWN_PROTECTION_MS = 4000;
/** Kill-cam beat between death and the server-issued respawn, ms. */
export const KILL_CAM_MS = 2500;
/** Crash within this of last taking damage credits the damager, ms. */
export const DAMAGE_MEMORY_MS = 8000;
/** No damage for this long starts health regen, ms. */
export const REGEN_DELAY_MS = 8000;
/** Regen rate once it starts, HP per second (MAX_HP / 10). */
export const REGEN_RATE = MAX_HP / 10;
/** Random points sampled when picking a farthest-from-enemies respawn. */
export const RESPAWN_SAMPLES = 24;

// --- Rooms ---
/** Players per FFA room; rooms auto-spawn when full. */
export const ROOM_CAP = 12;

// --- Bots (B1) — every knob for the server-side backfill pilots ---
/** Minimum combatants (humans + bots) a room is kept backfilled to. */
export const BOT_FLOOR = 6;
/** A bot notices targets (human or bot) within this torus range, m. */
export const BOT_DETECT_RANGE = 500;
/** A bot pulls the trigger only inside this range, m (< BULLET_RANGE). */
export const BOT_FIRE_RANGE = 300;
/** …and only while its nose is within this half-angle of the target, rad. */
export const BOT_FIRE_CONE = 0.14;
/** Seeded aim error: the pursuit aim point wanders by up to this half-angle
 * each brain decision, rad — the "beatable, not aimbot" miss source. */
export const BOT_AIM_JITTER = 0.05;
/** Reaction delay before the first shot at a freshly acquired target, ms. */
export const BOT_REACTION_MS = 400;
/** Bot steering-input cap (players reach 1.0): bots turn slightly worse. */
export const BOT_INPUT_CAP = 0.85;
/** Brain decision cadence: every Nth sim tick (15 Hz / 3 ≈ 5 Hz). */
export const BOT_DECISION_EVERY = 3;
/** Patrol waypoint altitude band, m — above every rooftop (250 m landmarks),
 * below the soft ceiling. */
export const BOT_PATROL_ALT_MIN = 270;
export const BOT_PATROL_ALT_MAX = 460;
/** A patrol waypoint counts as reached inside this torus range, m. */
export const BOT_WAYPOINT_RADIUS = 120;
/** How long a bot holds its evade break turn after taking fire, ms. */
export const BOT_EVADE_MS = 2500;
/** An enemy this close AND behind the bot triggers an evade break, m. */
export const BOT_THREAT_RANGE = 150;
/** Collision probe lookahead along the nose, seconds of current speed —
 * the short probe catches corner-cuts mid-turn, the long ones buy turn room. */
export const BOT_PROBE_TIMES: readonly number[] = [0.3, 0.8, 1.6, 2.6];
/** Probe sphere radius, m — clearance margin around the plane. */
export const BOT_PROBE_RADIUS = 12;
/** RECOVER hysteresis: exit only once probes clear at this radius multiple —
 * without it the brain flaps RECOVER→PATROL and re-steers into the wall. */
export const BOT_RECOVER_CLEAR = 2;
/** Below this altitude RECOVER pulls up unconditionally, m. */
export const BOT_MIN_ALT = 40;
/** Bots never enter the clouds (ST1): RECOVER pitches DOWN above this, m —
 * a margin under CLOUD_BASE so the hidden storm rule can't kill a bot. */
export const BOT_CEILING_ALT = 480;
/** Ceiling anticipation: danger when the current climb would reach
 * BOT_CEILING_ALT within this lookahead, s (the pitch-down turnaround). */
export const BOT_CEILING_LOOKAHEAD_S = 1.2;
/** RECOVER's ceiling hysteresis: exit only this far back below, m. */
export const BOT_CEILING_HYST = 40;
/** Steering gain: input per radian of yaw/pitch error (capped at BOT_INPUT_CAP). */
export const BOT_STEER_GAIN = 3;
