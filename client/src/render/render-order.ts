// O1: an explicit draw order for the blended (non-additive) transparents.
//
// three sorts transparent objects by renderOrder, then by the depth of each
// OBJECT's origin. Every particle system and the cloud deck here is one
// object spanning the whole scene — its origin is the world origin or the
// camera — so that depth says nothing about what is in front, and two
// systems swapped order as the camera moved: a visible pop wherever smoke,
// steam, birds and clouds overlapped. A fixed order cannot swap.
//
// The order is far → near for the usual view (flying under the cloud deck):
// the deck is the backdrop, steam sits on the street, birds over the roofs,
// smoke trails off the planes beside the camera. Everything left at 0 —
// the additive lights, the planes, tracers, name tags and HP bars — draws
// after all of them, so the HUD-like sprites stay on top.
//
// renderOrder sorts BETWEEN draws; particles inside one draw keep their
// buffer order (not changed by O1).

export const RENDER_ORDER = {
  /** Sky dome and its stars: always the backdrop. */
  sky: -1,
  /** Cloud puffs, and the dark ceiling sheet under them. The sheet is in
   * front of the puffs from below and behind them from above, so its rung
   * depends on which side of it the camera is (storm.ts). */
  cloudCeilingAbove: -0.7,
  cloudPuffs: -0.6,
  cloudCeilingBelow: -0.5,
  /** S5 fog banks: mid-air haze between the towers, in front of the deck,
   * behind the street-level steam and everything nearer. */
  fogBanks: -0.4,
  steam: -0.3,
  birds: -0.2,
  /** L1 smoke columns over kill sites: on the ground, beyond the trails. */
  smokeColumns: -0.15,
  smoke: -0.1,
  /** L4 rain streaks (additive): the nearest layer of all — the field lives
   * within 40 m of the camera — so after the smoke, still before the 0 group
   * (tracers, planes, tags), which therefore always paints over the rain. */
  rain: -0.05,
  /** S5 wind litter: street-level scraps — before the 0 group, so tracers,
   * planes and tags always paint over them. */
  litter: -0.04,
  /** Searchlight beams: additive, after the opaque city and the sky. */
  beams: 2,
} as const;
