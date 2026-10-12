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
 * list cycles through them). Every profile:
 *  - sums to exactly LANDMARK_HEIGHT (250 m) — `height >= LANDMARK_HEIGHT`
 *    is how the whole codebase recognises a landmark;
 *  - keeps the 90 × 90 × 60 m podium (the H1 arch, the forecourt lawn);
 *  - has at most 4 tiers (destruction.ts MAX_TIERS: 2 tier bits per chunk);
 *  - sets every tier strictly back from the one below;
 *  - gives tiers[1] at least 63 m of height and 52 m of width, so the
 *    landmark jumbotron (jumbotron-sites.ts landmarkSite) still fits;
 *  - keeps the top tier 10 m wide — more than two window bays at the widest
 *    pitch, and room for the leader searchlight's lamp;
 *  - stays inside the old slim-shaft silhouette (90 m to 60 m, 62 m to
 *    210 m, 34 m to 250 m) at every height, so nothing that cleared the old
 *    landmark (courses, AA arcs, the news heli, birds) can hit a new one.
 */
export const LANDMARK_PROFILES: readonly LandmarkProfile[] = [
  {
    style: "glass",
    tiers: [
      { width: 90, depth: 90, height: 60 },
      { width: 52, depth: 52, height: 150 },
      { width: 30, depth: 30, height: 26 },
      { width: 10, depth: 10, height: 14 },
    ],
  },
  {
    style: "ziggurat",
    tiers: [
      { width: 90, depth: 90, height: 60 },
      { width: 62, depth: 62, height: 110 },
      { width: 46, depth: 46, height: 40 },
      { width: 30, depth: 30, height: 40 },
    ],
  },
  {
    style: "spire",
    tiers: [
      { width: 90, depth: 90, height: 60 },
      { width: 62, depth: 62, height: 140 },
      { width: 34, depth: 34, height: 30 },
      { width: 10, depth: 10, height: 20 },
    ],
  },
  {
    style: "arches",
    tiers: [
      { width: 90, depth: 90, height: 60 },
      { width: 56, depth: 56, height: 136 },
      { width: 34, depth: 34, height: 34 },
      { width: 10, depth: 10, height: 20 },
    ],
  },
];

/** The profile for LANDMARK_BLOCKS slot `slot`. */
export const landmarkProfile = (slot: number): LandmarkProfile =>
  LANDMARK_PROFILES[slot % LANDMARK_PROFILES.length] as LandmarkProfile;

/**
 * The style of the landmark whose block holds (x, z), canonical world
 * coordinates — or null off the landmark blocks. Pass the building's own
 * (x, z): landmarks share one footprint and height, so their dimensions
 * cannot tell them apart.
 */
export function landmarkStyleAt(x: number, z: number): LandmarkStyle | null {
  const bx = Math.floor(x / BLOCK_PITCH);
  const bz = Math.floor(z / BLOCK_PITCH);
  const i = LANDMARK_BLOCKS.findIndex(([lx, lz]) => lx === bx && lz === bz);
  return i < 0 ? null : landmarkProfile(i).style;
}
