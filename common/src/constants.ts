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
// Height bounds are the envelope of HEIGHT_BANDS below; the bands are what
// actually shapes the skyline. BUILDING_MAX_HEIGHT stays strictly under
// LANDMARK_HEIGHT because four consumers (minimap, roof beacons, facade
// archetypes, the city's neon tint) identify a landmark by height alone.
export const BUILDING_MIN_HEIGHT = 20;
export const BUILDING_MAX_HEIGHT = 240;
/** Hand-placed landmark supertalls for orientation. */
export const LANDMARK_HEIGHT = 250;
/** Footprint side of the slim landmark towers, meters. */
export const LANDMARK_FOOTPRINT = 90;

// --- Lot subdivision (C1) ---
// Blocks are cut into irregular lots by seeded binary subdivision and every
// lot builds out to the lot line, so a block reads as one continuous
// streetwall. These replace the old BUILDING_MIN/MAX_FOOTPRINT pair: the
// "≤ BLOCK_PITCH − STREET_WIDTH" constraint now binds the block extent, not
// any single building.
/** Buildable lot line, meters behind the street-furniture line. Sized so the
 * deepest thing that hangs off a facade (a 3.2 m canopy) still lands short of
 * the curb; see LOT_LINE in city/street.ts. */
export const LOT_LINE_MARGIN = 4;
/** Smallest lot side a split may leave, meters. */
export const LOT_MIN_WIDTH = 26;
/** Deepest subdivision recursion — 2^n is the per-block lot ceiling. */
export const LOT_MAX_DEPTH = 3;
/** Chance a lot stops subdividing early once past depth 1. This is what puts
 * one wide lot beside three narrow ones instead of a uniform grid. */
export const LOT_STOP_CHANCE = 0.25;
/** Split position along the chosen axis, as a fraction of its length. Clamped
 * per split so neither half falls under LOT_MIN_WIDTH. */
export const LOT_SPLIT_MIN = 0.35;
export const LOT_SPLIT_MAX = 0.65;
/** Chance a split takes the SHORTER axis instead of the longer one — the
 * irregularity that stops lots converging on one modal shape. */
export const LOT_CROSS_SPLIT_CHANCE = 0.25;
/** Interior (non-street-facing) lot edges pull back by up to this, meters,
 * opening mid-block light wells. Street-facing edges always build flush. */
export const LOT_INTERIOR_INSET_MAX = 4;

/**
 * Skyline distribution: [cumulative probability, min height, max height].
 * A continuous low/mid streetwall with a thin tail of towers punching
 * through — a plain power curve over one range gives a lumpy mid-rise mass
 * once there are several buildings per block. Must be sorted ascending by
 * probability, end at exactly 1, and stay inside
 * [BUILDING_MIN_HEIGHT, BUILDING_MAX_HEIGHT].
 */
export const HEIGHT_BANDS: ReadonlyArray<readonly [number, number, number]> = [
  [0.7, 20, 60],
  [0.9, 60, 120],
  [0.98, 120, 190],
  [1.0, 190, 240],
];

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
/** Client → server input/state rate, Hz. Unchanged by ANGE-4KO2W2: one
 * plane's pose is already cheap, and raising it would not shorten the interp
 * buffer (that floor is set by the DOWN rate). */
export const TICK_UP_HZ = 20;
/** Server → client snapshot rate, Hz. Raised 15 → 20 (ANGE-4KO2W2) and paid
 * for by snapshot quantisation (common/src/net.ts): the wire got ~2.6x
 * cheaper per snapshot, so a 33% faster cadence still costs far less than
 * before. This is the number that sets the interpolation floor. */
export const TICK_DOWN_HZ = 20;
/** One snapshot interval, ms — the hard floor on interpolation delay, because
 * below it there is frequently no future sample to lerp toward. */
export const SNAPSHOT_INTERVAL_MS = 1000 / TICK_DOWN_HZ;

// --- Multiplayer presence (T3) ---
/** Shared city seed — every room generates the same city for now. */
export const CITY_SEED = 42;

// --- Interpolation delay (ANGE-4KO2W2) --- the fixed INTERP_DELAY_MS is gone:
// the client now holds the smallest SAFE buffer for its own measured snapshot
// jitter (common/src/net.ts owns the pure math, client/src/net/delay.ts the
// state). A LAN player gets the floor; bad wifi grows its own buffer instead
// of everyone paying for the worst case.
/** Safety margin on top of one snapshot interval, ms — covers the sub-tick
 * phase between a snapshot's arrival and the frame that samples it. */
export const INTERP_MARGIN_MS = 8;
/** Smallest interpolation delay any client may use, ms (58 ms at 20 Hz). */
export const INTERP_FLOOR_MS = SNAPSHOT_INTERVAL_MS + INTERP_MARGIN_MS;
/** Measured jitter is multiplied by this before being added to the floor —
 * ~2 sigma of headroom, so an ordinary wobble never empties the buffer. */
export const INTERP_JITTER_FACTOR = 2;
/** Ceiling on the adaptive delay, ms. Past this the connection is beyond
 * saving and a longer buffer only adds lag. Also the widest hit-claim slack
 * the server will honour. */
export const INTERP_DELAY_MAX_MS = 250;
/** Per-snapshot decay of the jitter estimate. Jitter attacks INSTANTLY (the
 * buffer grows before remotes stutter) and only decays at this rate, which is
 * what makes the controller grow faster than it shrinks — and what stops it
 * oscillating on alternating jitter. ~1.7 s half-life at 20 Hz. */
export const INTERP_JITTER_DECAY = 0.02;
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

// --- Moving obstacles (L2) --- the city's big moving parts. Every pose is a
// pure function of (seed, server snapshot clock) in common/src/city/movers.ts,
// so client and server agree with nothing streamed. The ticket's design rule:
// anything that LOOKS solid in the flight band IS solid, so every dimension
// here is a collision dimension, not just a rendering one.
/** Square tower-crane mast, side in m. Slim enough to read as a lattice. */
export const CRANE_MAST_SIDE = 6;
/** Mast setback from its block's edge, m. The edge is a street centerline and
 * LOT_LINE is 20, so this keeps the mast footprint off the sidewalk while the
 * jib still oversails the roadway — which is the whole point of the hazard. */
export const CRANE_MAST_INSET = 28;
/** Hub altitude band, m — a HARD band, not a preference. The jib sweeping the
 * 60-90 m canyon band is the gameplay item, so when a site's neighbours are
 * tall the JIB gets shorter; the mast never climbs out of the fight to buy
 * itself room. Generation shrinks the jib until the sweep clears everything
 * it can reach with CRANE_HUB_CLEARANCE to spare. */
export const CRANE_MAST_MIN = 62;
export const CRANE_MAST_MAX = 96;
/** Jib (hub to tip) length band, m. A block is BLOCK_PITCH wide and the mast
 * stands CRANE_MAST_INSET inside one edge, so anything past ~28 m oversails
 * the street. Shortened per site until the sweep clears every neighbour. */
export const CRANE_JIB_MIN = 34;
export const CRANE_JIB_MAX = 70;
/** Jib length is searched downward from CRANE_JIB_MAX in steps this big, m. */
export const CRANE_JIB_STEP = 4;
/** Counter-jib length as a fraction of the jib — the short, heavy end. */
export const CRANE_COUNTER_RATIO = 0.36;
/** Boom cross-section, m (square). Also the hook block's side. */
export const CRANE_JIB_SIDE = 2.6;
/** Hoist cable cross-section, m. Thin, but collidable: a cable hanging into
 * the canyon band is solid-looking geometry, so the rule says it is solid. */
export const CRANE_CABLE_SIDE = 0.7;
/** Vertical gap the swept jib keeps above every building it can reach, m.
 * Generation raises the mast (or shortens the jib) until this holds, so a jib
 * can never be buried inside a facade where it would be an invisible killer. */
export const CRANE_HUB_CLEARANCE = 9;
/** Hook drop below the hub, m — the trolley's load line. Clamped per site to
 * whatever headroom is left under the hub after CRANE_HUB_CLEARANCE, so the
 * hook and its cable are as collision-clean as the jib above them. A tight
 * site simply parks its hook up, which is what a real crane does. */
export const CRANE_HOOK_DROP_MIN = 10;
export const CRANE_HOOK_DROP_MAX = 24;
/** Slew rate band, rad/s. 0.02 rad/s is ~5 min per revolution: slow enough to
 * read as a hazard, fast enough that 15 s of slew is ~19 m of tip travel at a
 * 65 m radius — which is what makes "the jib moved" testable. */
export const CRANE_SLEW_MIN = 0.014;
export const CRANE_SLEW_MAX = 0.026;
/** Helicopters on straight torus loops along street axes. */
export const HELI_COUNT = 3;
/** Helicopter cruise altitude band, m — above the canyon, below the blimp. */
export const HELI_ALT_MIN = 120;
export const HELI_ALT_MAX = 260;
/** Helicopter cruise speed band, m/s. */
export const HELI_SPEED_MIN = 30;
export const HELI_SPEED_MAX = 45;
/** Helicopter hull half-extents, m: half-length along travel, half-height, half-width. */
export const HELI_HULL = [6.5, 2.2, 1.9] as const;
/** Blimp cruise altitude, m. Below CLOUD_BASE so it flies under the deck, and
 * far enough under RESPAWN_ALTITUDE's 300 m that a spawn can never land in it. */
export const BLIMP_ALT = 430;
/** Blimp cruise speed, m/s — the slowest thing in the sky. */
export const BLIMP_SPEED = 12;
/** Blimp hull half-extents, m: half-length, half-height, half-width. */
export const BLIMP_HULL = [30, 9, 9] as const;

// --- Fireworks (L2) --- a shared schedule in the strikesInWindow idiom:
// every client computes the same bursts from (seed, synced clock), particles
// only, no collision and no protocol.
/** Consecutive bursts are this far apart (seeded jitter), ms. */
export const FIREWORK_INTERVAL_MIN_MS = 6000;
export const FIREWORK_INTERVAL_MAX_MS = 11000;
/** Burst altitude band, m — well above the streetwall, under the cloud deck. */
export const FIREWORK_ALT_MIN = 150;
export const FIREWORK_ALT_MAX = 300;
/** How long one burst's sparks live, ms. */
export const FIREWORK_LIFETIME_MS = 2200;
/** Sparks per burst, and concurrent bursts the client budgets for. Capped
 * because a burst must never wash out tracers — EMISSIVE_TRACER stays the
 * readable top rung and brightness here comes from count and hue, not a rung. */
export const FIREWORK_SPARKS = 40;
export const FIREWORK_BURSTS = 6;

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

// --- Gun feel (client-only presentation/assist; server validation untouched) ---
/** Bullet magnetism: own bullets bend toward a target within this half-angle
 * of the flight line, degrees. Tight — connection help, not an aimbot. */
export const MAGNETISM_CONE_DEG = 4;
/** Max bend rate toward the target, degrees per second. */
export const MAGNETISM_MAX_DEG_PER_S = 2;
/** A plane strictly below this fraction of MAX_HP trails wounded smoke. */
export const SMOKE_HP_FRAC = 0.3;

// --- Server-side combat validation ---
// Hit-claim range slack is DERIVED, not a constant: see hitRangeSlackFor() in
// common/src/net.ts. It exists to absorb the distance both planes cover during
// the shooter's interpolation delay plus the bullet's flight time, and the
// delay is adaptive now — a hardcoded 200 m beside a variable would drift into
// rejecting legitimate hits (too tight) or widening the shooter-favoured
// window (too loose).
/** A claim's bulletOrigin must be within this of the shooter's on-record pose,
 * meters. Independent of the snapshot cadence: it bounds how stale the
 * SHOOTER's own pose can be, which is a TICK_UP_HZ question (unchanged), not
 * an interpolation one — the shooter's plane is never interpolated. */
export const HIT_ORIGIN_SLACK = 50;
/** Fire-rate token bucket burst: shots that may arrive batched by network
 * jitter. Fire messages are sent the instant the trigger breaks, never batched
 * into the snapshot tick, so this is unaffected by TICK_DOWN_HZ. */
export const FIRE_BURST_SLACK = 5;
/** Server heat tolerance above OVERHEAT_AT before shots are rejected (clock
 * jitter). The heat model is wall-clock driven on both sides — no tick
 * cadence enters it — so this is unaffected by TICK_DOWN_HZ. */
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
/** Bot count a fresh room starts at, before anyone touches the slider. */
export const BOT_TARGET_DEFAULT = 5;
/** Highest bot count the shared slider can ask for. One seat is always kept
 * for a human, so the arena can never be locked to bots only. */
export const BOT_TARGET_MAX = ROOM_CAP - 1;
/** One accepted bot-count change per player per this long, ms — the shared
 * slider's only governance besides last-write-wins (ANGE-6STDNN). */
export const BOT_TARGET_RATE_MS = 3000;
/**
 * Extra clearance a bot's probe demands around an L2 mover, m — on top of the
 * probe radius and the swept-sample padding in blockedAlong.
 *
 * Movers need it and buildings do not, for two reasons the probe profile was
 * never designed for. A crane boom is CRANE_JIB_SIDE = 2.6 m thick against a
 * facade's 40 m, so it fits between two probe samples; and the brain only
 * re-decides every BOT_DECISION_EVERY ticks (200 ms, ~11 m at combat speed),
 * so a jib can slew into a heading that was clear when it was chosen.
 * Measured, not guessed: over a 120 s adversarial sim that parks a decoy in a
 * construction block and makes eight bots orbit through the sweep, 0 m of pad
 * leaves 1 mover death and 6 m leaves none. 8 m is that with margin.
 * Over-avoidance is the safe direction — bots must never die to scenery.
 */
export const BOT_MOVER_CLEAR = 8;
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
/** Brain decision cadence: every Nth sim tick (20 Hz / 4 = 5 Hz). Tracks
 * TICK_DOWN_HZ deliberately — bots fly at snapshot cadence, and ANGE-4KO2W2's
 * faster tick must not silently sharpen their reflexes. */
export const BOT_DECISION_EVERY = 4;
/** HIGH patrol waypoint altitude band, m — above every rooftop (250 m
 * landmarks), below the soft ceiling. */
export const BOT_PATROL_ALT_MIN = 270;
export const BOT_PATROL_ALT_MAX = 460;
/** Share of bots seeded as CANYON pilots (ANGE-SINI5F); the rest patrol high.
 * Drawn once per bot and fixed for its life — disposition steers PATROL only,
 * never ENGAGE, so a chase drags bots through both layers. */
export const BOT_CANYON_SHARE = 0.6;
/** Canyon patrol band, m. The floor sits clear of BOT_MIN_ALT; the ceiling is
 * under the 79 m upper quartile of C1's skyline (median 49 m), so a bot in
 * this band is threading the streets rather than cruising over roofs — though
 * the highest slots do clear the shortest (BUILDING_MIN_HEIGHT) buildings, and
 * a corner hop lifts it further still. The spread staggers bots vertically
 * instead of flying them in a conga line. */
export const BOT_CANYON_ALT_MIN = 25;
export const BOT_CANYON_ALT_MAX = 70;
/** A canyon patrol waypoint counts as reached inside this torus range, m.
 * BOT_WAYPOINT_RADIUS is wider than half a block, so an intersection would
 * read as already-reached the moment it was picked. */
export const BOT_CANYON_WAYPOINT_RADIUS = 60;
/** Chance a canyon bot carries straight on through an intersection rather
 * than turning; the turn's left/right is a second seeded draw. */
export const BOT_CANYON_STRAIGHT_CHANCE = 0.5;
/** Extra altitude a canyon bot carries through an intersection turn, m. A 90°
 * turn sweeps ~52 m at MIN_SPEED — wider than any roadway — so it MUST cross
 * the block corner; the hop buys vertical margin over whatever stands there. */
export const BOT_CANYON_HOP = 30;
/** A canyon bot bleeds throttle while its heading error exceeds this, rad.
 * Turn radius is speed / 0.765 rad/s, so slowing is the only way to tighten
 * it: measured over all 800 city intersections, the same turn crashes 4.5% of
 * the time at 65 m/s and 1.0% at 40 m/s. */
export const BOT_CANYON_TURN_YAW = 0.5;
/** A patrol waypoint counts as reached inside this torus range, m. */
export const BOT_WAYPOINT_RADIUS = 120;
/** How long a bot holds its evade break turn after taking fire, ms. */
export const BOT_EVADE_MS = 2500;
/** An enemy this close AND behind the bot triggers an evade break, m. */
export const BOT_THREAT_RANGE = 150;
/** Collision probe lookahead along the nose, seconds of current speed —
 * the short probe catches corner-cuts mid-turn, the long ones buy turn room.
 * These are the HIGH-altitude values; among the towers the canyon profile
 * below replaces them. */
export const BOT_PROBE_TIMES: readonly number[] = [0.3, 0.8, 1.6, 2.6];
/** Probe sphere radius, m — clearance margin around the plane. */
export const BOT_PROBE_RADIUS = 12;
/** Below this altitude a bot probes with the CANYON profile, m. It sits just
 * over the canyon band ceiling plus a corner hop (BOT_CANYON_ALT_MAX +
 * BOT_CANYON_HOP = 100), so a bot actually threading a street keeps the short
 * profile all the way through a hopped corner — and everything above the
 * streetwall roofline gets the long one. C1's dense city is what pins it
 * here: the short profile's 0.9 s horizon is deliberately blind past the
 * cross-street facade, which is right inside a canyon and wrong among the
 * towers, where 646 buildings now fill the mid-altitude air that 97
 * free-standing ones left empty. Measured over 3 rooms x 11 bots x 200 s,
 * terrain's share of bot deaths: 53.8% at 200 m, 36.6% at 160, 20.7% here. */
export const BOT_CANYON_PROBE_ALT = 110;
/** Canyon probe radius, m. C1's streetwall makes the corridor uniform:
 * buildings stand on LOT_LINE, so a street centerline has exactly 20 m of
 * clearance to the facades on either side, everywhere, at every altitude
 * below the roofline (measured over all 40 street lanes). The wide
 * BOT_PROBE_RADIUS would leave 8 m of tracking slack in that 40 m corridor;
 * this one leaves 15. */
export const BOT_CANYON_PROBE_RADIUS = 5;
/** Canyon probe lookahead, s. The decisive knob: flying a real 90° turn that
 * hits nothing, the high profile reports BLOCKED on 76% of ticks (and still
 * 68% at radius 4) — the long samples reach past the intersection into the
 * cross-street facade. These drop that to ~5%. */
export const BOT_CANYON_PROBE_TIMES: readonly number[] = [0.2, 0.5, 0.9];
/** RECOVER hysteresis: exit only once probes clear at this radius multiple —
 * without it the brain flaps RECOVER→PATROL and re-steers into the wall. */
export const BOT_RECOVER_CLEAR = 2;
/** Below this altitude RECOVER pulls up unconditionally, m. Sits below the
 * canyon band (high patrollers never approach it); the ground still kills at
 * y = 0, this only moves the pull-up trigger. */
export const BOT_MIN_ALT = 15;
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

/** A canyon bot bleeds throttle inside this range of its next intersection, m
 * — the lead-in that lets it arrive slow enough to turn the corner. */
export const BOT_CANYON_SLOW_RADIUS = 110;
/** Steepest descent a canyon bot commands, meters dropped per meter of ground
 * track. Bots spawn at RESPAWN_ALTITUDE, and aiming straight at a waypoint
 * 275 m below is a near-vertical dive that arrives too fast to fly a street —
 * this turns the arrival into a glide down the lattice instead. */
export const BOT_CANYON_GLIDE = 0.5;

/** Steering fan (ANGE-SINI5F): yaw offsets sampled either side of the pursuit
 * vector when terrain blocks the direct line, rad. */
export const BOT_FAN_YAW: readonly number[] = [0.3, 0.6, 1.0, 1.4];
/** ...and the vertical offsets, so a bot can pop over a roof or duck under a
 * setback ledge instead of only going around, rad. */
export const BOT_FAN_PITCH: readonly number[] = [0.35];

/** How long a bot keeps pursuing a target it can no longer see, ms. Sight
 * lines flicker constantly in a canyon; without this the brain would drop and
 * re-acquire several times a second, re-arming BOT_REACTION_MS each time, and
 * the bot would never fire at all. (It is also how a real pilot behaves.) */
export const BOT_LOS_MEMORY_MS = 2000;
/** Worst-case sight tests one bot may spend in a single decision. Contacts are
 * walked nearest-first and the walk stops at the first VISIBLE one, so the
 * common case is a single test; this only bounds the pathological case. It is
 * a work budget, never a candidate cap — capping candidates would let a knot
 * of contacts behind one tower blind a bot to a human in open air. */
export const BOT_LOS_TESTS_MAX = ROOM_CAP;

/** Steering horizon for the fan, seconds of current speed. Deliberately longer
 * than the probe profiles: a 90 deg turn takes ~2.07 s at any speed, so a bot
 * that only looks 0.9 s ahead can SEE a wall it can no longer avoid. The fan
 * uses this to CHOOSE between headings early; the short profile still decides
 * when the chase is hopeless and RECOVER takes over. */
export const BOT_FAN_TIMES: readonly number[] = [0.5, 1.2, 2.2];
