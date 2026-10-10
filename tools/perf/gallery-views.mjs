// The VO gallery's fixed viewpoints, shared by gallery.mjs (PNGs) and
// flicker.mjs --grid (the O5 per-view shimmer grid). A view is a plane pose:
// x, z, y (meters), yaw (0 faces -Z) and pitch (radians, default level);
// `sky` forces an L12 phase, `dyn` / `train` views are placed from the live
// world at capture time (gallery.mjs only); `eye`/`at` views (A1) hold the
// QA camera there, with the plane pinned at x/y/z. DT1 `showcase` views pose
// planes in the sky through __ab.planeShowcase (turntable, damage, dogfight).

/** DT1: the turntable sheet — a row of each airframe at four headings, the
 * QA camera `dist` m off (near ≈ 40 m, mid ≈ 250 m, far ≈ 600 m: the three
 * LOD levels). Clear sky high over the city; the own plane parked behind
 * the camera, out of shot. */
const turntable = (name, dist) => {
  const yaws = [Math.PI / 2, Math.PI * 0.75, Math.PI, Math.PI * 1.3];
  const row = (kind, y) =>
    yaws.map((yaw, i) => ({
      kind,
      x: 982 + i * 12,
      y,
      z: 1000,
      yaw,
      pitch: 0.12,
      speed: 70,
    }));
  return {
    name,
    x: 1000,
    z: 1000 + dist + 140,
    y: 600,
    yaw: Math.PI,
    eye: [1000, 460, 1000 + dist],
    at: [1000, 460, 1000],
    weather: "clear",
    sky: "dusk",
    showcase: [...row("biplane", 465), ...row("fighter", 455)],
  };
};

/** DT1: one airframe from 11 m, three-quarter front and a little above —
 * the paintwork, the pilot, the racks and the rigging. */
const closeup = (name, kind, hp = 100) => ({
  name,
  x: 1000,
  z: 1150,
  y: 600,
  yaw: Math.PI,
  eye: [1008, 464, 1008],
  at: [1000, 460, 1000],
  weather: "clear",
  sky: "dusk",
  showcase: [
    {
      kind,
      x: 1000,
      y: 460,
      z: 1000,
      yaw: Math.PI * 0.62,
      pitch: 0.04,
      roll: -0.12,
      speed: 70,
      aileron: 0.5,
      elevator: 0.5,
      hp,
    },
  ],
});

/** DT1: the three LOD levels side by side at one distance (held by the
 * showcase's QA-only `lod`): near, mid, far, each from the side and from
 * three-quarter front. */
const lodSheet = () => {
  const cols = [0, 0, 1, 1, 2, 2].map((lod, i) => ({
    lod,
    yaw: i % 2 === 0 ? Math.PI / 2 : Math.PI * 0.75,
  }));
  const row = (kind, y) =>
    cols.map((c, i) => ({
      kind,
      x: 970 + i * 12,
      y,
      z: 1000,
      yaw: c.yaw,
      pitch: 0.1,
      speed: 70,
      lod: c.lod,
    }));
  return {
    name: "planes-lod-levels",
    x: 1000,
    z: 1180,
    y: 600,
    yaw: Math.PI,
    eye: [1000, 460, 1036],
    at: [1000, 460, 1000],
    weather: "clear",
    sky: "dusk",
    showcase: [...row("biplane", 465), ...row("fighter", 455)],
  };
};

/** DT1: both airframes at 2 HP from 16 m — scorch, holes, missing panels,
 * the engine fire and the smoke. */
const wreckedPair = () => ({
  name: "planes-closeup-wrecked",
  x: 1000,
  z: 1150,
  y: 600,
  yaw: Math.PI,
  eye: [1000, 464, 1016],
  at: [1000, 460, 1000],
  weather: "clear",
  sky: "dusk",
  showcase: ["biplane", "fighter"].map((kind, i) => ({
    kind,
    x: 994 + i * 12,
    y: 460,
    z: 1000,
    yaw: Math.PI * (i === 0 ? 0.62 : 0.38),
    pitch: 0.25,
    roll: i === 0 ? -0.3 : 0.3,
    speed: 70,
    hp: 2,
  })),
});

/** DT1: a full room — 12 enemy fighters and 8 human biplanes spread over
 * the three LOD bands (near, mid, far), every one in the frame: the fleet's
 * draw count for the ticket's "rises ≤ 4" check (`fleet` log line). */
const fullRoom = () => {
  const at = (kind, i, dist, spread) => ({
    kind,
    x: 1000 + (i - 1.5) * spread,
    y: 460 + (i % 2) * spread * 0.3,
    z: 1000 - dist,
    yaw: Math.PI / 2 + i * 0.4,
    pitch: 0.1,
    speed: 70,
  });
  const list = [];
  for (let i = 0; i < 4; i++) {
    list.push(at("fighter", i, 40, 12), at("fighter", i, 260, 60));
    list.push(at("fighter", i, 650, 140));
  }
  for (let i = 0; i < 4; i++) {
    list.push(at("biplane", i, 70, 14), at("biplane", i, 500, 110));
  }
  return {
    name: "planes-full-room",
    x: 1000,
    z: 1200,
    y: 600,
    yaw: Math.PI,
    eye: [1000, 462, 1010],
    at: [1000, 460, 900],
    weather: "clear",
    sky: "dusk",
    showcase: list,
  };
};

/** DT1: the shimmer check (flicker.mjs --grid): one airframe, nothing
 * animated (no airspeed: the prop stands, no blur), four at ~30 m and four
 * at ~120 m — the procedural paintwork's lines, rivets and decals are what
 * could crawl. Compare the fighter's score with the biplane's. */
const shimmer = (name, kind) => ({
  name,
  x: 1000,
  z: 1180,
  y: 600,
  yaw: Math.PI,
  eye: [1000, 462, 1030],
  at: [1000, 460, 990],
  weather: "clear",
  sky: "dusk",
  showcase: [0, 1, 2, 3].flatMap((i) => [
    {
      kind,
      x: 982 + i * 12,
      y: 458 + (i % 2) * 4,
      z: 1000,
      yaw: Math.PI / 2 + i * 0.6,
      pitch: 0.15,
      speed: 0,
    },
    {
      kind,
      x: 940 + i * 40,
      y: 470,
      z: 910,
      yaw: Math.PI / 2 + i * 0.6,
      pitch: 0.15,
      speed: 0,
    },
  ]),
});

/** DT1: the damage stages side by side, near — full HP, smoke (< 30),
 * fire (< 18), missing panels (> 86 % damage). */
const damageSheet = () => {
  const hps = [100, 23, 16, 7];
  const row = (kind, y) =>
    hps.map((hp, i) => ({
      kind,
      x: 982 + i * 12,
      y,
      z: 1000,
      yaw: Math.PI / 2,
      pitch: 0.05,
      hp,
      speed: 70,
    }));
  return {
    name: "planes-damage",
    x: 1000,
    z: 1180,
    y: 600,
    yaw: Math.PI,
    eye: [1000, 460, 1026],
    at: [1000, 460, 1000],
    weather: "clear",
    sky: "dusk",
    showcase: [...row("biplane", 465), ...row("fighter", 455)],
  };
};

export const VIEWS = [
  // name, x, z, y, yaw, extra
  { name: "chase-rooftops", x: 300, z: 900, y: 175, yaw: 0.6 },
  { name: "chase-canyon", x: 400, z: 1100, y: 70, yaw: 0 },
  { name: "high-overview", x: 100, z: 1500, y: 380, yaw: 0.9, pitch: -0.35 },
  { name: "plane-side", x: 600, z: 700, y: 200, yaw: 1.2, orbit: 260 },
  { name: "plane-front", x: 800, z: 300, y: 160, yaw: -0.4, orbit: 620 },
  { name: "street-low", x: 1000, z: 1300, y: 35, yaw: 0 },
  // A1 city life: a crossing seen from a corner (crossers waiting for WALK,
  // riders in the bike lanes, groups and carts) and a balcony stack across a
  // street (people on balconies, laundry, pigeons). Both hold the QA camera
  // at `eye` looking at `at` while the plane is pinned behind it (it keeps
  // the micro tier streaming around the spot), in clear weather.
  {
    name: "intersection",
    x: 600,
    z: 1520,
    y: 22,
    yaw: 0,
    eye: [572, 26, 1452],
    at: [600, 0, 1400],
    weather: "clear",
  },
  {
    name: "balcony",
    x: 1995,
    z: 560,
    y: 14,
    yaw: Math.PI,
    eye: [1990, 16, 500],
    at: [19.4, 12, 472],
    weather: "clear",
  },
  // G1: skimming the curb at 8 m, a lane in from the parked cars, looking
  // down the sidewalk — furniture, parked cars, road wear, lit shopfronts.
  // At 8 m the plane sinks into the street within one stalled frame, so this
  // view is pinned every frame in the page (`raf`), not by round trips.
  { name: "sidewalk-closeup", x: 810, z: 1380, y: 8, yaw: 0.08, raf: true },
  { name: "rooftop-skim", x: 1210, z: 500, y: 140, yaw: 1.57, pitch: -0.15 },
  // S6 glass reflections: glass-heavy views (the GLASS archetype clusters of
  // the seed-42 city), a puddled street and the river — the probe's three
  // readers. Each holds the QA camera at `eye` (the plane pinned behind it),
  // in clear weather; `AB_GALLERY_QUERY=refl=0` shoots the before.
  {
    name: "glass-landmark",
    x: 400,
    z: 520,
    y: 70,
    yaw: 0,
    eye: [400, 70, 560],
    at: [500, 130, 700],
    weather: "clear",
  },
  {
    name: "glass-canyon",
    x: 1200,
    z: 260,
    y: 45,
    yaw: 0,
    eye: [1200, 45, 300],
    at: [1200, 70, 600],
    weather: "clear",
  },
  {
    name: "glass-cluster",
    x: 1000,
    z: 260,
    y: 170,
    yaw: 0,
    eye: [1000, 170, 300],
    at: [1160, 110, 500],
    weather: "clear",
  },
  {
    name: "puddle-street",
    x: 1000,
    z: 1240,
    y: 25,
    yaw: 0,
    eye: [1000, 7, 1300],
    at: [1000, 0, 1450],
    weather: "clear",
  },
  {
    name: "river-glass",
    x: 650,
    z: 1100,
    y: 260,
    yaw: -Math.PI / 2,
    eye: [700, 10, 1100],
    at: [1000, -10, 1100],
    weather: "clear",
  },
  // N1: plaza (4,4) as a night park — pond, paths, lamps, tree clusters.
  { name: "plaza-park", x: 900, z: 1030, y: 120, yaw: 0, pitch: -0.6 },
  { name: "moon", x: 700, z: 1000, y: 260, yaw: -0.61, pitch: 0.2 }, // faces MOON_DIR
  // L12 sky cycle: each phase toward its own horizon (dusk glow in the west,
  // the night moon, the dawn glow in the east) and over the same rooftops.
  {
    name: "sky-dusk",
    x: 700,
    z: 1000,
    y: 230,
    yaw: 2.5,
    pitch: 0.12,
    sky: "dusk",
  },
  {
    name: "sky-night",
    x: 700,
    z: 1000,
    y: 230,
    yaw: -0.61,
    pitch: 0.12,
    sky: "night",
  },
  {
    name: "sky-predawn",
    x: 700,
    z: 1000,
    y: 230,
    yaw: -0.66,
    pitch: 0.12,
    sky: "predawn",
  },
  { name: "sky-dusk-city", x: 300, z: 900, y: 175, yaw: 0.6, sky: "dusk" },
  { name: "sky-night-city", x: 300, z: 900, y: 175, yaw: 0.6, sky: "night" },
  {
    name: "sky-predawn-city",
    x: 300,
    z: 900,
    y: 175,
    yaw: 0.6,
    sky: "predawn",
  },
  // L10 sky traffic: placed at capture time from the live __ab read-backs,
  // since all three move on the synced clock.
  { name: "sky-airliner", dyn: "airliner" },
  { name: "news-heli", dyn: "newsHeli" },
  { name: "drone-show", dyn: "drones" },
  // L5: the elevated train running down its canyon. x/z/yaw are recomputed
  // from the live train pose at every pin (it moves 22 m/s): the plane sits
  // `behind` m back from the last car and `side` m off its track, `y` m up,
  // nose `dyaw` off the train's heading so the plane does not hide it.
  // `leadMs` poses the train that far ahead of now (a slow software renderer
  // shows a frame seconds after it was pinned).
  {
    name: "train-canyon",
    train: true,
    behind: 38,
    side: -5,
    dyaw: 0.4,
    y: 40,
    pitch: -0.32,
    leadMs: 0,
  },
  // T2: a train standing at a station with its doors open, a train rounding
  // a curve, and two trains passing on the double track. Each is found on the
  // pure schedule (__ab.train / __ab.trainMeeting at future times), then the
  // world clock is pinned to that moment and a fixed QA camera frames it.
  { name: "train-station", dyn: "trainStation" },
  { name: "train-curve", dyn: "trainCurve" },
  { name: "trains-passing", dyn: "trainsPassing" },
  { name: "train-cab", dyn: "trainCab" },
  // H2: the street-level row tunnel (the lowest multi-lot tunnel, else the
  // lowest tunnel) from 110 m out on its approach — runway chevrons, the
  // lit mouth frame — and from just inside its mouth looking down the run
  // (strips, lane lines, fans, signs, murals). Found through __ab.holes();
  // a fixed QA camera, the plane pinned every frame out of shot above.
  { name: "hole-approach", dyn: "holeApproach", raf: true },
  { name: "hole-inside", dyn: "holeInside", raf: true },
  // D2: sustained fire on a setback tower's west facade (seed building 176,
  // facade on the lot line at x = 620) from a gunner in the street —
  // __ab.chew fires `rounds` through the shared ray + CityDamage, aimed
  // round `at` with `spread` (0 = every round at the point, 1 = anywhere on
  // the building) — then a fixed QA camera frames the result: broken
  // floors, exposed slabs and rebar, rubble on the sidewalk. The close-up
  // looks straight into one shot-through row of a plain mid-rise.
  {
    name: "destruction-chewed",
    x: 585,
    z: 300,
    y: 300,
    yaw: 0,
    eye: [588, 34, 382],
    at: [626, 58, 452],
    weather: "clear",
    chew: {
      eye: [598, 34, 440],
      at: [620, 58, 445.5],
      rounds: 700,
      spread: 0.45,
    },
  },
  {
    name: "destruction-closeup",
    x: 1990,
    z: 100,
    y: 300,
    yaw: 0,
    eye: [1992, 20, 118],
    at: [40, 17, 135],
    weather: "clear",
    chew: {
      eye: [1995, 17.7, 133],
      at: [21, 17.7, 133],
      rounds: 27,
      spread: 0,
    },
  },
  // U4 tunnels: diving into the plaza (4,4) portal from the west, mid-bore
  // on the Crosstown S-bend, and climbing out of plaza (8,2)'s cut; plus a
  // river mouth seen from the channel. Pinned every frame (raf).
  {
    name: "tunnel-portal",
    // The plane level over the lawn (a slow software-GL frame integrates a
    // whole second between pins: a dive pose would meet the lip first).
    x: 850,
    z: 850,
    y: 30,
    yaw: -Math.PI / 2,
    raf: true,
    eye: [800, 42, 838],
    at: [935, -18, 850],
    weather: "clear",
  },
  {
    name: "tunnel-mid",
    x: 1176,
    z: 787.2,
    y: -52,
    yaw: -0.912,
    raf: true,
    weather: "clear",
  },
  {
    name: "tunnel-exit",
    x: 1625,
    z: 450,
    y: -24,
    yaw: -Math.PI / 2,
    pitch: 0.3,
    raf: true,
    weather: "clear",
  },
  {
    name: "tunnel-river-mouth",
    x: 1208.4,
    z: 1084.1,
    y: -12,
    yaw: 2.182,
    raf: true,
    weather: "clear",
  },
  // U5 underground life: the metro hall seen through its glass from
  // Crosstown's middle straight (the world pinned 24 s into a metro cycle:
  // the train stands at the platform, doors open), the Seam Line garden
  // looking down the bore to its lake, and the Riverside grotto low over
  // its glowing mushrooms. Poses from tunnelPointInto (s 448 lat -4 turned
  // 35° to the hall; s 770; s 300 lat -3).
  {
    name: "tunnel-station",
    x: 1273,
    z: 676,
    y: -54,
    yaw: -1.309,
    raf: true,
    timeMs: 60_024_000,
    weather: "clear",
  },
  {
    name: "tunnel-garden",
    x: 720,
    z: 384.9,
    y: -53,
    yaw: 0,
    raf: true,
    weather: "clear",
  },
  {
    name: "tunnel-grotto",
    x: 898.8,
    z: 1304.5,
    y: -57,
    yaw: 2.356,
    raf: true,
    weather: "clear",
  },
  // U6 cave-ins: Riverside's grotto straight, the ceiling coming down at
  // s 380, the right-wall lane left open — the QA camera in that lane 42 m
  // short of it (the plane parked behind it at s 300) — staged on this client
  // through `__ab.qaCaveIn` at a pinned world time (`caveIn.ago` ms into
  // its life): the warning (dust streaming from the cracks over the
  // blocked lanes, lamps stuttering), the fall, and the rubble after.
  {
    name: "tunnel-cavein-warning",
    x: 897.1,
    z: 1302.1,
    y: -52,
    yaw: 2.182,
    raf: true,
    eye: [872.9, -55, 1333.7],
    at: [829.8, -54, 1345.5],
    timeMs: 60_000_000,
    caveIn: { tunnel: 1, s: 380, gap: 1, ago: 1300 },
    weather: "clear",
  },
  {
    name: "tunnel-cavein-fall",
    x: 897.1,
    z: 1302.1,
    y: -52,
    yaw: 2.182,
    raf: true,
    eye: [872.9, -55, 1333.7],
    at: [829.8, -54, 1345.5],
    timeMs: 60_000_000,
    caveIn: { tunnel: 1, s: 380, gap: 1, ago: 3100 },
    weather: "clear",
  },
  {
    name: "tunnel-cavein-rubble",
    x: 897.1,
    z: 1302.1,
    y: -52,
    yaw: 2.182,
    raf: true,
    eye: [872.9, -55, 1333.7],
    at: [829.8, -54, 1345.5],
    timeMs: 60_000_000,
    caveIn: { tunnel: 1, s: 380, gap: 1, ago: 9000 },
    weather: "clear",
  },
  // U6 tunnel life, a view per section's character: the Crosstown mine
  // (timber sets, the rail line and its cart, workers, machinery, signs),
  // the Seam Line works (pipe runs leaking steam, a grate's light shaft),
  // the Riverside grotto (dripstone, crystals, roots, bats stirring off
  // the ceiling), the garden's lake (fish, deer and foxes at the
  // channels) and the metro platform (passengers waiting at its edge).
  // Poses from tunnelPointInto (Crosstown s 196, Seam Line s 1290,
  // Riverside s 240; the lake from a camera low over its shore at s 826).
  {
    name: "tunnel-life-mine",
    x: 1084.5,
    z: 835.5,
    y: -56,
    yaw: -1.258,
    raf: true,
    timeMs: 60_010_000,
    weather: "clear",
  },
  {
    name: "tunnel-life-works",
    x: 720,
    z: 1864.9,
    y: -54,
    yaw: 0,
    raf: true,
    timeMs: 60_010_000,
    weather: "clear",
  },
  {
    name: "tunnel-life-grotto",
    x: 946.2,
    z: 1267.7,
    y: -55,
    yaw: 2.182,
    raf: true,
    timeMs: 60_010_000,
    weather: "clear",
  },
  {
    name: "tunnel-life-lake",
    x: 720,
    z: 364.9,
    y: -52,
    yaw: 0,
    raf: true,
    eye: [715, -60.5, 328.9],
    at: [724, -63.6, 304.9],
    timeMs: 60_013_000,
    weather: "clear",
  },
  {
    name: "tunnel-life-platform",
    x: 1273,
    z: 676,
    y: -56,
    yaw: -1.1,
    raf: true,
    timeMs: 60_024_000,
    weather: "clear",
  },
  // D8 ruins: what a felled lot looks like once the debris is down — the
  // jagged stump, rubble across the street, smoke and soot, and NOTHING left
  // in the air where the tower was (no scaffold cage, crane mast, signs or
  // roof structures). Staged through __ab.qaDestruction (`stage`, times
  // relative to the render clock at staging): building 343 (215 m, at
  // (1240, 464)) felled 15 s before the shot — toppled west across the
  // x = 1200 street, or pancaked — and the seeded 30 % chew of the `ruins`
  // segment's block (18 buildings within 200 m of (400, 780)), its
  // collapses landed. The plane is parked at 240 m over the lot, out of shot
  // (the scaffold dresses the damaged buildings nearest the plane) and under
  // the zeppelin's band.
  {
    name: "ruin-felled",
    sky: "dusk",
    x: 1215,
    z: 560,
    y: 240,
    yaw: 0,
    eye: [1192, 64, 590],
    at: [1232, 12, 462],
    weather: "clear",
    stage: { fell: [{ b: 343, h: 215, style: "topple", dir: 0, t: -15_000 }] },
  },
  {
    name: "ruin-pancake",
    sky: "dusk",
    x: 1215,
    z: 560,
    y: 240,
    yaw: 0,
    eye: [1186, 42, 552],
    at: [1240, 8, 464],
    weather: "clear",
    stage: { fell: [{ b: 343, h: 215, style: "pancake", dir: 0, t: -15_000 }] },
  },
  {
    name: "ruin-chewed",
    sky: "dusk",
    x: 330,
    z: 900,
    y: 240,
    yaw: 0,
    eye: [300, 95, 960],
    at: [400, 35, 780],
    weather: "clear",
    stage: {
      area: {
        x: 400,
        z: 780,
        r: 200,
        share: 0.3,
        seed: 6,
        t: -60_000,
        stepMs: 1000,
        buildings: 18,
      },
    },
  },
  // D9 more destruction, staged through __ab.qaDestruction's `props` (the
  // seed-42 prop layout: each `down` takes the nearest standing prop of
  // that kind, and throws if none is near — the layout changed). Times are
  // relative to the render clock at staging.
  //
  // destruction-glass: tower 343's glass curtain wall chewed open at the
  // street (__ab.chew) and its cascade of shards re-thrown every pin
  // (`glass`), from the glass-canyon street.
  {
    name: "destruction-glass",
    x: 1200,
    z: 340,
    y: 40,
    yaw: 0,
    raf: true,
    eye: [1204, 12, 404],
    at: [1222, 30, 452],
    weather: "clear",
    chew: {
      eye: [1205, 22, 436],
      at: [1222, 26, 452],
      rounds: 700,
      spread: 0.3,
    },
    glass: 343,
  },
  // destruction-chain: the riverside gas station at (1300, 1030) blown up
  // with the poles beside it down (live wires sparking), a parked car on
  // the bank street gone up with it, craters (one a burst water main) and
  // the bank towers across the street burning, soot rising up their faces.
  {
    name: "destruction-chain",
    sky: "dusk",
    x: 1214,
    z: 1104,
    y: 30,
    yaw: 0,
    raf: true,
    eye: [1268, 11, 1058],
    at: [1298, 6, 1000],
    weather: "clear",
    stage: {
      props: {
        down: [
          { kind: "station", near: { x: 1300, z: 1030 }, t: -2500, blast: 600 },
          { kind: "pole", near: { x: 1287, z: 1038 }, t: -2000 },
          { kind: "pole", near: { x: 1313, z: 1038 }, t: -2000 },
          { kind: "car", near: { x: 1240, z: 986 }, t: -2200, blast: 500 },
          { kind: "lamp", near: { x: 1270, z: 1016 }, t: -2000 },
        ],
        craters: [
          { x: 1262, z: 994, r: 4.5, t: -1700, water: true },
          { x: 1300, z: 1004, r: 5, t: -1900, water: false },
        ],
        burn: [
          { b: 360, h: 71, chunks: 6, face: "+z" },
          { b: 359, h: 42, chunks: 4, face: "+z" },
        ],
      },
    },
  },
  // destruction-bridge: the x = 1400 bridge's middle span down in the river
  // (its lamps with it), the gap in the deck, from the south promenade.
  {
    name: "destruction-bridge",
    sky: "dusk",
    x: 1322,
    z: 1032,
    y: 22,
    yaw: 0,
    raf: true,
    eye: [1342, 9, 1046],
    at: [1400, -8, 1100],
    weather: "clear",
    stage: {
      props: {
        down: [{ kind: "bridge", near: { x: 1400, z: 1100 }, t: -30_000 }],
      },
    },
  },
  // destruction-street: the x = 1000 street at z ≈ 365, a lane in from
  // two parked cars facing across it — both blown and flipped, lamps and a
  // signal mast snapped into the street, craters and a burst water main.
  {
    name: "destruction-street",
    x: 1000,
    z: 280,
    y: 30,
    yaw: 0,
    raf: true,
    eye: [997, 6, 334],
    at: [1000, 1, 372],
    weather: "clear",
    stage: {
      props: {
        down: [
          { kind: "car", near: { x: 986, z: 362 }, t: -2600, blast: 400 },
          { kind: "car", near: { x: 1014, z: 368 }, t: -2400, blast: 700 },
          { kind: "lamp", near: { x: 1016, z: 375 }, t: -2500 },
          { kind: "lamp", near: { x: 984, z: 337 }, t: -2500 },
          { kind: "signal", near: { x: 984, z: 384 }, t: -2300 },
          { kind: "signal", near: { x: 1016, z: 384 }, t: -2300 },
        ],
        craters: [
          { x: 996, z: 352, r: 4.5, t: -2000, water: true },
          { x: 1006, z: 388, r: 3.5, t: -2000, water: false },
          { x: 990, z: 330, r: 3, t: -2000, water: false },
        ],
      },
    },
  },
  // S9: the war-zeppelin carrier, STAGED on the client (`__ab.qaBoss`): a
  // raid whose hull crosses `boss.ahead` m in front of the pinned plane at
  // the pinned world instant `timeMs`, flying the view's +X (so the hull
  // frame is the world frame, centred at x 1000, y 305, z 820). A view may
  // stage a launch `phaseMs` into its sequence (`__ab.qaBossLaunch`) or the
  // break-up `downAfterMs` ago (`__ab.qaBossDown`). The QA camera frames it.
  {
    name: "boss-closeup",
    x: 1000,
    z: 1000,
    y: 285,
    yaw: 0,
    timeMs: 1_790_000_000_000,
    eye: [1112, 292, 925],
    at: [1020, 303, 820],
    weather: "clear",
    boss: { ahead: 180 },
  },
  {
    name: "boss-belly-launch",
    x: 1000,
    z: 1000,
    y: 285,
    yaw: 0,
    timeMs: 1_790_000_000_000,
    eye: [1046, 268, 880],
    at: [998, 284, 820],
    weather: "clear",
    boss: { ahead: 180, launch: { kind: 0, phaseMs: 2050 } },
  },
  {
    name: "boss-catapult-launch",
    x: 1000,
    z: 1000,
    y: 285,
    yaw: 0,
    timeMs: 1_790_000_000_000,
    eye: [1072, 342, 866],
    at: [1028, 328, 820],
    weather: "clear",
    boss: { ahead: 180, launch: { kind: 1, phaseMs: 1500 } },
  },
  {
    name: "boss-breakup",
    x: 1000,
    z: 1000,
    y: 285,
    yaw: 0,
    timeMs: 1_790_000_000_000,
    eye: [1060, 300, 1110],
    at: [1000, 268, 820],
    weather: "clear",
    boss: { ahead: 180, downAfterMs: 3500 },
  },
  turntable("planes-turntable-near", 26),
  closeup("planes-closeup-fighter", "fighter"),
  lodSheet(),
  closeup("planes-closeup-biplane", "biplane"),
  wreckedPair(),
  turntable("planes-turntable-mid", 250),
  turntable("planes-turntable-far", 600),
  damageSheet(),
  fullRoom(),
  shimmer("planes-shimmer-fighter", "fighter"),
  shimmer("planes-shimmer-biplane", "biplane"),
  // DT1: a dogfight — over a biplane's shoulder, three fighter-bombers
  // banking through a turn ahead, one of them burning, a wingman high left.
  {
    name: "planes-dogfight",
    x: 1000,
    z: 1300,
    y: 600,
    yaw: Math.PI,
    eye: [1004, 451.5, 1031],
    at: [998, 453, 975],
    weather: "clear",
    sky: "dusk",
    showcase: [
      {
        kind: "biplane",
        x: 995,
        y: 447.5,
        z: 1020,
        yaw: 0.25,
        roll: -0.6,
        pitch: 0.05,
        aileron: 0.6,
        elevator: 0.4,
      },
      {
        kind: "fighter",
        x: 989,
        y: 457,
        z: 1003,
        yaw: -1.35,
        roll: -0.8,
        pitch: 0.08,
        elevator: 0.8,
        aileron: -0.4,
      },
      {
        kind: "fighter",
        x: 1013,
        y: 451,
        z: 998,
        yaw: 1.3,
        roll: 0.7,
        pitch: -0.05,
        hp: 9,
        elevator: 0.5,
      },
      {
        kind: "fighter",
        x: 1000,
        y: 463,
        z: 988,
        yaw: -1.0,
        roll: -1.1,
        pitch: 0.15,
        bombs: 0b00110,
      },
      {
        kind: "biplane",
        x: 1022,
        y: 462,
        z: 1008,
        yaw: 1.2,
        roll: 0.5,
        pitch: 0.1,
      },
    ],
  },
];
