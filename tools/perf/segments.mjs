// The scripted flight path. This file is the harness's contract: change a
// number here and every committed baseline stops being comparable, so treat
// it the way you'd treat a wire format.
//
// Why a fixed path measures anything at all: this game generates its city
// from a seeded PRNG with no Math.random anywhere, the server hands every
// client the same CITY_SEED, and the storm is a pure function of (seed,
// time). Same seed + same viewpoint therefore means the same scene, down to
// the instance counts — so a difference between two runs is a real
// difference, not a different level.
//
// CRASH SAFETY IS PART OF THE CONTRACT. A segment that flies into a tower
// dies, and a dead plane renders a kill-cam instead of the scene we meant to
// measure. Two ways to be safe, and every segment below uses one of them:
//   1. y > 260 — above LANDMARK_HEIGHT (250), the tallest thing in the city.
//   2. Travel along a street: with yaw 0 the plane flies down -Z at constant
//      x, so an x on a BLOCK_PITCH (200 m) boundary stays inside the 30 m
//      street band for the whole segment, whatever the buildings do.

/** yaw 0 faces -Z (common/src/flight.ts) — a heading toward (dx, dz). */
export const yawToward = (dx, dz) => Math.atan2(-dx, -dz);

/** Milliseconds of frames captured per segment, after it has settled. */
export const SAMPLE_MS = 5000;
/** Flown but not measured after each teleport: instance streaming, LOD, GC. */
export const SETTLE_MS = 900;
/** One unmeasured lap of the whole path first — shader compiles, uploads. */
export const WARMUP_MS = 700;
/** How far into the storm window the scheduled strike is lined up to land. */
export const STRIKE_LEAD_MS = 1200;
/**
 * After a segment's fake pilots join, before its settle starts: long enough
 * for the server to re-sync each pilot from its spawn to the weave (10
 * rejected poses at 30 Hz) and for the page to fill its interpolation buffer.
 */
export const PILOT_SETTLE_MS = 1500;

/**
 * O4: the WORLD clock every segment is pinned to (`__ab.pinWorld`). Traffic,
 * signage, living windows, the news heli, the train, drones, airliners,
 * birds, fireworks and the storm are pure functions of (seed, server time),
 * so pinning the time pins the scene — on every pass, in every arm that has
 * the hook. Segment i starts at WORLD_EPOCH_MS + i * WORLD_STEP_MS (the
 * storm segment then slides to its next strike), and the warm-up lap flies
 * the same spots earlier still, so the world clock only ever moves FORWARD
 * through a page: nothing in the client assumes a clock that runs back.
 * A fixed instant in the FUTURE (2033), so even the first pin — from the
 * live clock the page booted on — is a forward jump. The sky is pinned to
 * deep night separately (`?sky=night`), the weather per segment below.
 */
export const WORLD_EPOCH_MS = 2_000_000_000_000;
/** World time between segment starts: a segment (settle + window) plus the
 * storm's longest slide to its next strike (15 s) fit inside it. */
export const WORLD_STEP_MS = 30_000;
/** Weather for a segment that does not name one. */
export const DEFAULT_WEATHER = "clear";

/** Where segment `i` of the measured pass starts on the world clock. */
export const segmentWorldMs = (i) => WORLD_EPOCH_MS + i * WORLD_STEP_MS;
/** Where segment `i` of the warm-up lap starts — before the whole pass. */
export const warmupWorldMs = (i) =>
  WORLD_EPOCH_MS - (SEGMENTS.length - i + 1) * WORLD_STEP_MS;

/** P2: how far a `trainsAt` segment may slide its world clock to find its
 * moment — the slide plus the segment must stay inside its own WORLD_STEP_MS
 * slot, or it would overlap the next segment's world instant. */
export const TRAINS_SLIDE_MAX_MS = WORLD_STEP_MS - SETTLE_MS - SAMPLE_MS;

/**
 * O3's contract, judged per segment (run.mjs `segmentVerdicts`).
 *
 *  - `gpuP50Ms` — 60 fps at the measured ratio: a 16.7 ms frame minus ~2.7 ms
 *    for the compositor and the CPU's share. GPU, because with vsync off the
 *    wall clock is the CPU's pace, not the frame's cost.
 *  - `hitchRatio` — no hitches: wall p99 within 2x wall p50.
 *  - `drawCalls` — per-segment budgets. Only `core` has one: it is the
 *    densest everyday view and the one the ticket names. Over budget, cut in
 *    this order: sign spill pools, rooftop string lights, fountains,
 *    headlight pools (each is one draw, all are dressing).
 */
export const BUDGETS = {
  gpuP50Ms: 14,
  hitchRatio: 2,
  // P2: the Realism batch's three views get their own ceilings (the runner's
  // measured High draws + ~10 %), so a later ticket that piles onto a train
  // station, a tunnel or a sidewalk is caught here and not only in `core`.
  drawCalls: { core: 120, station: 999, hole: 999, sidewalk: 999 },
};

export const SEGMENTS = [
  {
    name: "core",
    what: "dense midtown at facade height, down a canyon (signage, lamps, traffic)",
    // x = 1000 is a street centerline, so 90 m is safe for the whole run.
    x: 1000,
    z: 1600,
    y: 90,
    yaw: 0,
  },
  {
    name: "plaza",
    what: "over the open plaza block (4,4) — sparse geometry, wide ground",
    x: 900,
    z: 1060,
    y: 300,
    yaw: 0,
  },
  {
    name: "sky",
    what: "high and level — the whole skyline inside FOG_DISTANCE at once",
    x: 700,
    z: 1400,
    y: 560, // under the 600 m storm ceiling: this segment must not die
    yaw: yawToward(-1, 1),
  },
  {
    name: "canyon",
    what: "low between the towers, down the x=200 street",
    // The most GPU-expensive viewpoint on the path, and also the LEAST
    // repeatable one — read its absolute number as indicative and its paired
    // `--ab` delta as the real result.
    //
    // Why: at y=45 the camera sits at street level, so instanced traffic and
    // its headlights fill more of the frame here than anywhere else on the
    // path, and traffic pose is a pure function of the synced SERVER clock —
    // the one scene input the harness does not pin. (Pinning it would mean
    // overriding render time, i.e. a server change, which this ticket
    // forbids.) The signature is unmistakable and shows up in every multi-
    // pass run: canyon's GPU p50 swings (10.2 → 14.0 → 9.9 ms) while its
    // WALL p50 falls monotonically (7.6 → 7.4 → 7.2) and its draw calls stay
    // pinned at 107. CPU contention would push wall and GPU up together;
    // more GPU work at constant draw calls is a fuller frame, not a busier
    // machine.
    //
    // O4: the client now renders the world at a pinned time
    // (`__ab.pinWorld`, WORLD_EPOCH_MS above), traffic included, so on a
    // build with the hook this segment's scene is pinned like the others.
    // The note above stands for an older build (an --ab-ref before O4).
    x: 200,
    z: 1200,
    y: 45,
    yaw: 0,
  },
  {
    name: "storm",
    what: "a lightning strike inside the window — bolt, flash, fog stain, reveals",
    // Fixed viewpoint, high enough to be crash-proof. O4: the harness pins
    // the world clock so the next scheduled strike lands STRIKE_LEAD_MS of
    // world time into the window — the same strike, the same cell, every
    // pass, and no unpiloted wait for the live clock to reach one. A build
    // without `__ab.pinWorld` falls back to waiting on the live clock, and
    // its strike position then moves between runs (README.md).
    x: 1000,
    z: 1000,
    y: 380,
    yaw: 0,
    storm: true,
  },
  // --- O3: appended, so the five above still line up with every older
  // report by index. Both are street level in a downpour: rain streaks,
  // wet streets and the crowd only exist down here.
  {
    name: "street",
    what: "street level in a downpour — rain, traffic, the crowd (L1/L4/L6)",
    // x = 600 is a street centerline. Checked offline against the shared
    // collision (buildings, trees, the viaduct, bridges, every mover at any
    // server time) for 1000 m of travel at 25–45 m: clear. 32 m keeps the
    // camera under the micro tier's full-gate height (100 m), so every
    // pedestrian is drawn.
    x: 600,
    z: 1400,
    y: 32,
    yaw: 0,
    weather: "downpour",
  },
  {
    name: "furball",
    what: "a full 12-plane room weaving and firing down a street, in a downpour",
    // HELD, not flown: the page re-teleports here every frame while 11 fake
    // pilots (tools/perf/pilots.mjs) weave 80–380 m ahead of it — the page
    // plus 11 is ROOM_CAP. Same offline collision check as `street`.
    x: 400,
    z: 1000,
    y: 34,
    yaw: 0,
    weather: "downpour",
    hold: true,
    pilots: 11,
  },
  // --- P2: the Realism batch (T2, H2, G1/A1), appended so the seven above
  // still line up with every older report by index. Appending moves the
  // warm-up lap's world instants (warmupWorldMs counts SEGMENTS.length);
  // each segment's MEASURED instant (segmentWorldMs) is unchanged.
  //
  // Each spot was checked offline against the shared collision
  // (client/src/game/collision.ts touchesSolid: ground, buildings and their
  // holes, trees, the viaducts and stations, and every mover sampled every
  // 100 ms from 5 min before WORLD_EPOCH_MS to 10 min after it): clear.
  {
    name: "station",
    what: "T2: a station with two trains in it, one per track — platforms, canopy, people, doors",
    // Line 0's station at (1300, 1000), on the z = 1000 street centreline.
    // HELD 80 m east of its centre, 44 m up (13.6 m above the canopy's top
    // at 30.4 m), nose west down the platforms. The trains pass beneath the
    // plane, never through it.
    x: 1380,
    z: 1000,
    y: 44,
    yaw: yawToward(-1, 0),
    hold: true,
    // The world clock slides forward from this segment's own instant to the
    // first moment two trains on opposite tracks are both inside `withinM`
    // of the station's centre — a pure function of the schedule, so the
    // same moment on every pass (run.mjs refuses a slide past
    // TRAINS_SLIDE_MAX_MS). Two trains share a platform pair every ~20 s.
    trainsAt: { line: 0, station: 2, withinM: 8 },
  },
  {
    name: "hole",
    what: "H2: a glide through the street-level row tunnel — chevrons, mouth frame, LED strips, decor",
    // The tunnel the gallery's hole views use (the lowest multi-lot row
    // tunnel): x = 303.5, floor 8 m, 20 m tall, 26 m wide, mouths at
    // z = 1220 and 1380. The plane is re-teleported every frame along its
    // axis at the clear volume's middle height, `glide.speed` m/s of WALL
    // time from 63 m before the entry, so the 5 s window runs from ~25 m
    // before the entry to ~25 m past the exit (three quarters of it inside).
    // Clear from 120 m before the entry to 150 m past the exit; the glide
    // stops at `glide.maxM` (107 m past the exit) however long a slow frame
    // stretches the window. Wall time, not the pinned world clock, so the
    // path is the same length on a slow software renderer as on a GPU.
    x: 303.5,
    z: 1157,
    y: 18,
    yaw: yawToward(0, 1),
    glide: { speed: 42, maxM: 330 },
  },
  {
    name: "sidewalk",
    what: "G1/A1: skimming the curb at 8 m — street furniture, parked cars, road paint, lit lobbies, the crowd",
    // G1's gallery close-up: a lane in from the parked cars at x ~810, 8 m
    // up, nose a touch toward the sidewalk. HELD (re-teleported every frame;
    // at 8 m an unpiloted plane would sink into the street). Under the micro
    // tier's full gate, so every pedestrian, rider and street object in the
    // tier's radius is drawn. Lamps, benches and parked cars are street-level
    // dressing (not solid); street trees are solid and none is in reach.
    x: 810,
    z: 1380,
    y: 8,
    yaw: 0.08,
    hold: true,
  },
];
