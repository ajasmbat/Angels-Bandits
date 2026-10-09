// The VO gallery's fixed viewpoints, shared by gallery.mjs (PNGs) and
// flicker.mjs --grid (the O5 per-view shimmer grid). A view is a plane pose:
// x, z, y (meters), yaw (0 faces -Z) and pitch (radians, default level);
// `sky` forces an L12 phase, `dyn` / `train` views are placed from the live
// world at capture time (gallery.mjs only); `eye`/`at` views (A1) hold the
// QA camera there, with the plane pinned at x/y/z.
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
];
