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
  drawCalls: { core: 120 },
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
    x: 200,
    z: 1200,
    y: 45,
    yaw: 0,
  },
  {
    name: "storm",
    what: "a lightning strike inside the window — bolt, flash, fog stain, reveals",
    // Fixed viewpoint, high enough to be crash-proof; the harness times the
    // window so a scheduled strike lands ~1.2 s in. The strike's POSITION
    // moves with the wall clock (it is a function of absolute time), so this
    // is the one segment whose scene is not byte-identical between runs —
    // see the tolerance note in README.md.
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
];
