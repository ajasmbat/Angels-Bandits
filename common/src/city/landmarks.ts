// L3 Stormlit landmarks: what each hand-placed landmark block IS. Kept out
// of layout.ts (pure orientation lists, which tests swap wholesale) so the
// silhouettes stay put when a test moves the blocks around.
//
// Fictional towers *inspired by* Art Deco icons — never copies, never named
// or signed after a real building. Their names live with the client
// (headlines.ts LANDMARK_NAMES, same order as LANDMARK_BLOCKS).

import { BLOCK_PITCH } from "../constants";
import { LANDMARK_BLOCKS } from "./layout";

export type LandmarkStyle =
  /** THE NEEDLE: a slender modern glass supertall, lit crown, spire. */
  | "glass"
  /** MERIDIAN TOWER: an Art Deco ziggurat of floodlit setbacks. */
  | "ziggurat"
  /** THE SPIRE: stepped massing, a mooring mast and a red beacon. */
  | "spire"
  /** HALCYON TOWER: a crown of stacked lit arches and a needle. */
  | "arches";

/** One landmark's style and its exact (rendered AND collided) silhouette. */
export interface LandmarkProfile {
  style: LandmarkStyle;
  /** Bottom-up tiers, each centred on the block like any building's. */
  tiers: ReadonlyArray<{ width: number; depth: number; height: number }>;
}

/**
 * The landmark silhouettes, one per LANDMARK_BLOCKS slot (a longer block
 * list cycles through them). H1 scaled L3's four designs up into the
 * city's supertalls — same styles, same tier rhythm, shafts ~2× taller and
 * ~15 % wider. Every profile:
 *  - sums to between LANDMARK_HEIGHT (400 m) and CITY_TOP (480 m), the
 *    tallest summing to exactly CITY_TOP — `height >= LANDMARK_HEIGHT` is
 *    how the whole codebase recognises a landmark, and nothing generated
 *    reaches it;
 *  - keeps the 90 × 90 × 60 m podium (the H1 arch, the forecourt lawn);
 *  - has at most 4 tiers (destruction.ts MAX_TIERS: 2 tier bits per chunk);
 *  - sets every tier strictly back from the one below;
 *  - gives tiers[1] at least 63 m of height and 52 m of width, so the
 *    landmark jumbotron (jumbotron-sites.ts landmarkSite) still fits;
 *  - keeps the glass, spire and arches tops 10 m wide — more than two
 *    window bays at the widest pitch, and room for the leader searchlight's
 *    lamp.
 */
export const LANDMARK_PROFILES: readonly LandmarkProfile[] = [
  {
    style: "glass",
    tiers: [
      { width: 90, depth: 90, height: 60 },
      { width: 60, depth: 60, height: 332 },
      { width: 34, depth: 34, height: 57 },
      { width: 10, depth: 10, height: 31 },
    ],
  },
  {
    style: "ziggurat",
    tiers: [
      { width: 90, depth: 90, height: 60 },
      { width: 72, depth: 72, height: 197 },
      { width: 52, depth: 52, height: 72 },
      { width: 34, depth: 34, height: 71 },
    ],
  },
  {
    style: "spire",
    tiers: [
      { width: 90, depth: 90, height: 60 },
      { width: 72, depth: 72, height: 287 },
      { width: 40, depth: 40, height: 62 },
      { width: 10, depth: 10, height: 41 },
    ],
  },
  {
    style: "arches",
    tiers: [
      { width: 90, depth: 90, height: 60 },
      { width: 64, depth: 64, height: 265 },
      { width: 40, depth: 40, height: 66 },
      { width: 10, depth: 10, height: 39 },
    ],
  },
];

/** The profile for LANDMARK_BLOCKS slot `slot`. */
export const landmarkProfile = (slot: number): LandmarkProfile =>
  LANDMARK_PROFILES[slot % LANDMARK_PROFILES.length] as LandmarkProfile;

/**
 * The style of the landmark whose block holds (x, z), canonical world
 * coordinates — or null off the landmark blocks. Pass the building's own
 * (x, z): landmarks share one podium footprint, so their dimensions are not
 * how to tell them apart.
 */
export function landmarkStyleAt(x: number, z: number): LandmarkStyle | null {
  const bx = Math.floor(x / BLOCK_PITCH);
  const bz = Math.floor(z / BLOCK_PITCH);
  const i = LANDMARK_BLOCKS.findIndex(([lx, lz]) => lx === bx && lz === bz);
  return i < 0 ? null : landmarkProfile(i).style;
}
