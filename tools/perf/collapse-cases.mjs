// D11: the collapse time-lapse cases (collapse-timelapse.mjs), shared with
// the destruction-view check (destruction-views.test.mjs). Building indices
// are generateCity(CITY_SEED)'s and `h` guards them (qaDestruction throws if
// the city changed). Each eye has a clear sight line (losClear over every
// other building) to the tower and most of its fall; `fov` is the QA
// camera's pinned vertical field of view (the game's BASE_FOV).

export const CASES = {
  // The planner's pancake: building 166 (305 m at (663, 729)), 460 m off
  // and 200 m up, from the north-west across the river blocks. T1: 166 is
  // one of Downtown's supertalls now (608 m, its crown in the deck): the
  // same tower coming down into its own footprint, from 540 m off and
  // 320 m up, aimed higher for its height.
  pancake: {
    title: "pancake — building 166, 608 m, eye 540 m off, 320 m up",
    eye: [200, 320, 1000],
    at: [663, 380, 729],
    fov: 70,
    fell: [{ b: 166, h: 608, style: "pancake", dir: 0 }],
  },
  // The planner's topple (building 247, 312 m at (948, 1651)) from 600 m:
  // falling east (+x), across the view from the south. T1: 247 is a 620 m
  // supertall that only pancakes; Midtown's 299 m building 243 (at
  // (935.5, 1468)) falls east instead, across the x = 1000 avenue the eye
  // looks up from the south.
  topple: {
    title: "topple — building 243, 299 m, falling east across the avenue",
    eye: [1000, 240, 1330],
    at: [1040, 110, 1468],
    fov: 70,
    fell: [{ b: 243, h: 299, style: "topple", dir: 1 }],
  },
  // Tower-on-tower: building 157 (294 m at (659, 249)) felled west into
  // the 302 m building 110, whose struck floors give way in turn (D10
  // `chain`). T1: 157 is a 577 m supertall now — its 293 m neighbour 159
  // (at (738.5, 270.5)) topples west into IT, from the east down the
  // z = 200 avenue.
  chain: {
    title: "tower-on-tower — 159 (293 m) toppled west into the supertall 157",
    eye: [920, 280, 200],
    at: [690, 150, 270],
    fov: 70,
    fell: [{ b: 159, h: 293, style: "topple", dir: 0, chain: true }],
  },
};
