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
/** D6: see BUDGETS.chunkInstances — the runner's `ruins` (316 damaged-mesh
 * slots + 667 debris pieces = 983) + 10 % (README D6). */
const CHUNK_INSTANCES_BUDGET = 1082;

export const BUDGETS = {
  gpuP50Ms: 14,
  hitchRatio: 2,
  // P2: the Realism batch's three views get their own ceilings — the
  // runner's measured High draws (station 82, hole 83, sidewalk 82) plus
  // ~10 % — so a later ticket that piles onto a train station, a tunnel or
  // a sidewalk is caught here and not only in `core`.
  // S8: the spectacle views get theirs the same way (the runner's measured
  // High draws, probe included, plus ~10 %; README S8).
  drawCalls: {
    core: 120,
    station: 90,
    hole: 92,
    sidewalk: 90,
    boss: 300,
    rings: 112,
    glass: 110,
  },
  // D6: a collapse segment may cost at most this many draws over the SAME
  // pass's `core` (core itself stays under its 120). A segment not flown
  // beside core in the run reads n/a.
  drawCallsOverCore: { collapse: 15, rubble: 15 },
  // D6: the destruction instances a segment may hold — damaged-mesh slots
  // plus debris pieces — set from the runner's measured maximum + 10 %
  // (README D6). The debris mesh must also never grow past its boot size
  // (city.ts: every chunk COLLAPSE_CAP lets fall, +25 %, +64): growing is a
  // buffer reallocation mid-game, and the boot size is the derived bound.
  chunkInstances: CHUNK_INSTANCES_BUDGET,
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
  // --- D6: the Destruction batch (D1–D5, X1), appended so the ten above
  // keep their index and measured world instants. The server runs quiet
  // (AB_QUIET_CITY: nothing breaks on the wall clock), and each segment
  // STAGES its destruction on the client through `__ab.qaDestruction` — the
  // server's own steps and caps (client/src/game/qa-destruction.ts) — at
  // world times relative to the segment's own instant (`stage`: every `t`
  // is an offset from it) or to the window's (`stageAtWindow`, staged after
  // the settle). Building indices are generateCity(CITY_SEED)'s; each spec
  // states the height / building count it expects, and staging throws if
  // the city changed under it. Each spot was checked offline against the
  // STAGED city — damaged solids, D2 rubble, every collapse piece over the
  // whole fall (collideCollapses) and the wreck — with touchesSolid, every
  // 50 ms from 1 s before the segment's instant to 12 s after: clear.
  {
    name: "collapse",
    what: "D3/D5: a 215 m tower toppling across the street ahead — debris in the air, the dust cloud rising",
    // Building 343 (1240, 464), west face on the x = 1200 street. HELD on
    // that street's centreline 236 m south, 110 m up, nose north. It
    // topples west (−x) across the street: 126 pieces, 8.7 s from the
    // charge to the last landing, its rubble 20–281 m west of its centre —
    // never near the camera.
    x: 1200,
    z: 700,
    y: 110,
    yaw: 0,
    hold: true,
    // Staged after the settle, its charge 1.5 s of WORLD time before the
    // window's first frame: the lead beat (0.6 s) is over and the tower is
    // falling when the window opens — on a 3 fps runner (whose window holds
    // ~0.75 s of world time) and on the M3 (~5 s of it) alike. The harness
    // asserts it has NOT all landed by the window's end.
    stageAtWindow: {
      fell: [{ b: 343, h: 215, style: "topple", dir: 0, t: -1500 }],
    },
    expect: "falling",
  },
  {
    name: "ruins",
    what: "D1–D4: the 12-plane furball in a heavily damaged block — broken towers, collapses still coming, dust, burning facades, a wreck's fire",
    // The furball's own viewpoint, weather and 11 pilots, so `ruins` −
    // `furball` is what the destruction costs that fight. The block around
    // the pilots' corridor (18 buildings within 200 m of (400, 780)) has
    // 30 % of its chunks shot away (seeded); the 21 collapses that leaves
    // owing start every second from 14 s before the segment's instant to
    // 6 s after it, so dust hangs over landed rubble while more comes down.
    // Four death blasts (two land on a facade) set it burning; a downed plane hit a tower
    // 66 ms before the instant and burns there (D4).
    x: 400,
    z: 1000,
    y: 34,
    yaw: 0,
    weather: "downpour",
    hold: true,
    pilots: 11,
    stage: {
      area: {
        x: 400,
        z: 780,
        r: 200,
        share: 0.3,
        seed: 6,
        t: -14_000,
        stepMs: 1000,
        buildings: 18,
      },
      blasts: [
        { x: 382, y: 55, z: 720, t: -2000 },
        { x: 418, y: 70, z: 800, t: -1500 },
        { x: 382, y: 40, z: 870, t: -1000 },
        { x: 418, y: 50, z: 660, t: -500 },
      ],
      wrecks: [
        {
          p: { x: 400, y: 120, z: 900 },
          v: { x: 40, y: -10, z: -30 },
          t: -3000,
          spin: 1,
          hit: "city",
        },
      ],
    },
  },
  {
    name: "rubble",
    what: "D2/D3: a glide down a street both sides of which came down into it — every piece at rest",
    // The x = 1200 street, from z = 1880 north at 20 m (the x = 800 street
    // has a viaduct over it). Buildings 332 and 325 (west) and 375 and 374
    // (east) toppled across it 56–62 s before the segment's instant, after
    // 25 % of the chunks of the five buildings within 120 m of (1200, 1700)
    // were shot away: 6 collapses, 386 chunks down, the last landed 44 s
    // before the instant — no dust, nothing moving; the harness asserts
    // every collapse is at rest. A glide in WALL time, like `hole`.
    x: 1200,
    z: 1880,
    y: 20,
    yaw: 0,
    glide: { speed: 42, maxM: 330 },
    stage: {
      area: {
        x: 1200,
        z: 1700,
        r: 120,
        share: 0.25,
        seed: 9,
        t: -75_000,
        stepMs: 500,
        buildings: 5,
      },
      fell: [
        { b: 332, h: 117, style: "topple", dir: 1, t: -62_000 },
        { b: 375, h: 168, style: "topple", dir: 0, t: -60_000 },
        { b: 374, h: 135, style: "topple", dir: 0, t: -58_000 },
        { b: 325, h: 107, style: "topple", dir: 1, t: -56_000 },
      ],
    },
    expect: "settled",
  },
  // --- S8: the Spectacle batch (S1–S7), appended after D6's so the
  // thirteen above still line up with every older report by index. Every spot was checked offline
  // against the shared collision (`touchesSolid`: ground, buildings, trees,
  // viaducts and every mover sampled every 100–250 ms over 15 min of world
  // time around WORLD_EPOCH_MS), and the boss's against the staged hull too
  // (`collideBoss`, over warm-up, settle and window): clear.
  {
    name: "boss",
    what: "S4: a full 12-plane room weaving under the war zeppelin and its flak, at altitude",
    // HELD at 285 m (over every roof, under the hull's 268–337 m band only
    // where the hull is 380+ m away) while 11 fake pilots weave 70–230 m
    // ahead at 262–317 m — inside the plane LOD's near band (300 m) from
    // the camera, so every plane is the full airframe all window — and hold
    // their fire (a tracer is a draw call, timed on the pilots' wall clock).
    // The zeppelin is STAGED on the client (`__ab.qaBoss`,
    // client/src/game/qa-spectacle.ts): a raid on station, crossing the view
    // `boss.ahead` m out at mid-window, its flak a fixed schedule on the
    // pinned world clock aimed into the pilots' corridor, from 3 s before
    // the segment's instant so shells are always in the air.
    x: 1000,
    z: 1000,
    y: 285,
    yaw: 0,
    hold: true,
    pilots: 11,
    pilotFlight: { near: 70, far: 230, yLo: 262, yHi: 317 },
    pilotFire: false,
    boss: {
      ahead: 520,
      corridor: { near: 70, far: 230, lateral: 25, yLo: 262, yHi: 317 },
    },
  },
  {
    name: "rings",
    what: "S3: a glide down Canyon Run's street canyon through its rings, the record ghost racing ahead",
    // S3's Canyon Run for the city seed: 13 rings (r 9 m) down the x = 1400
    // street from z = 500 heading −Z (wrapping) — a weave ±6 m and 24/34 m
    // high, so the centreline at 29 m passes inside every ring. Re-teleported
    // every frame at `glide.speed` m/s of WALL time from 25 m before the
    // start ring — crossed ~0.4 s in, inside the settle even at 3 fps — so
    // the client's own run starts there, plays the staged ghost
    // (`__ab.qaCourseGhost`: `ghostSpeed` m/s through the ring centres, on
    // the wall clock like the glide) from the window's first frame, and the
    // rings go to race colours. The glide stops at `glide.maxM`, six rings
    // in and some 700 m short of the finish, so no run ever finishes and the
    // server never records a time or a ghost a later pass would see (each
    // pass is a new page, and the server drops the old page's run when it
    // leaves). Clear from 60 m before the start to 460 m past it.
    x: 1400,
    z: 525,
    y: 29,
    yaw: 0,
    glide: { speed: 60, maxM: 480 },
    course: { theme: "canyon", ghostSpeed: 72 },
  },
  {
    name: "glass",
    what: "S6: a close-up on the glass landmark — the probe's neon skyline in its curtain wall",
    // Building 127, the 250 m glass landmark at (500, 700) the gallery's
    // glass-landmark view frames. HELD 85 m off its north-west corner at
    // 120 m, nose toward (500, 700): the frame is curtain wall at a grazing
    // angle, where the Fresnel term makes the reflection strongest. A held
    // view moves the probe 0 m a frame, so it never refills mid-window.
    x: 420,
    z: 800,
    y: 120,
    yaw: yawToward(80, -100),
    hold: true,
    weather: "clear",
  },
];
