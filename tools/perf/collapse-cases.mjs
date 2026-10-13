// D11: the collapse time-lapse cases (collapse-timelapse.mjs), shared with
// the destruction-view check (destruction-views.test.mjs). Building indices
// are generateCity(CITY_SEED)'s and `h` guards them (qaDestruction throws if
// the city changed). Each eye has a clear sight line (losClear over every
// other building) to the tower and most of its fall; `fov` is the QA
// camera's pinned vertical field of view (the game's BASE_FOV).

export const CASES = {
  // The planner's pancake: building 166 (305 m at (663, 729)), 460 m off
  // and 200 m up, from the north-west across the river blocks.
  pancake: {
    title: "pancake — building 166, 305 m, eye 460 m off, 200 m up",
    eye: [264, 200, 959],
    at: [663, 140, 729],
    fov: 70,
    fell: [{ b: 166, h: 305, style: "pancake", dir: 0 }],
  },
  // The planner's topple (building 247, 312 m at (948, 1651)) from 600 m:
  // falling east (+x), across the view from the south.
  topple: {
    title: "topple — building 247, 312 m, falling east, eye 600 m off",
    eye: [968, 230, 2242],
    at: [1072, 110, 1651],
    fov: 70,
    fell: [{ b: 247, h: 312, style: "topple", dir: 1 }],
  },
  // Tower-on-tower: building 157 (294 m at (659, 249)) felled west into
  // the 302 m building 110, whose struck floors give way in turn (D10
  // `chain`), from the north.
  chain: {
    title: "tower-on-tower — 157 (294 m) toppled west into 110 (302 m)",
    eye: [682, 200, -170],
    at: [600, 120, 293],
    fov: 70,
    fell: [{ b: 157, h: 294, style: "topple", dir: 0, chain: true }],
  },
};
