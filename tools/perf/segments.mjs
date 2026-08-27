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
];
