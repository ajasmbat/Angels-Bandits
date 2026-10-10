// S1 jumbotron sites — where the city's big video screens hang, as a pure
// function of the generated city: each landmark's shaft facing its nearest
// plaza, then one plaza-facing facade per plaza. Moved to common by D9 (the
// screens can be shot loose and fall, so the server places them exactly as
// every client does); client/src/render/jumbotrons.ts re-exports it and
// still draws the screens.

import { BLOCK_PITCH, WORLD_SIZE } from "../constants";
import { type Vec3, canonicalize, wrapDelta } from "../world/index";
import type { Building } from "./index";
import { LANDMARK_BLOCKS, PLAZA_BLOCKS } from "./layout";

/** Hard cap on screens (the ticket asks for 3–6). */
export const JUMBOTRON_MAX = 6;
/** Landmark screens: on the shaft (tier 2), well above the podium. */
const LANDMARK_SCREEN_WIDTH = 48;
const LANDMARK_SCREEN_BOTTOM = 92;
/** Plaza screens: on a tier-1 facade facing the plaza, above every L7 sign
 * (marquees top out at 33 m) — the ticker under it starts at 34 m. */
const PLAZA_SCREEN_WIDTH = 32;
const PLAZA_SCREEN_BOTTOM = 38;
/** A facade must be this much longer than the screen to carry it. */
const FACE_MARGIN = 4;
/** How proud of the facade a screen sits, meters (visual only, like signs). */
export const SCREEN_DEPTH = 0.4;
/** LED ticker band under each screen: height and gap, meters. */
export const TICKER_HEIGHT = 2.6;
export const TICKER_GAP = 1;
/** How far beyond a plaza facade we look for the plaza, meters. */
const PLAZA_PROBE = 30;

/** One screen: canonical panel-center ground position, bottom edge, size,
 * and the facade's outward normal. Its ticker hangs just below it. */
export interface JumbotronSite {
  x: number;
  z: number;
  y: number;
  width: number;
  height: number;
  axis: "x" | "z";
  dir: -1 | 1;
  /** D8: the index of the building it hangs on. */
  building: number;
}

const GRID = WORLD_SIZE / BLOCK_PITCH;
const wrapBlock = (b: number): number => ((b % GRID) + GRID) % GRID;
const blockOf = (v: number): number => wrapBlock(Math.floor(v / BLOCK_PITCH));
const blockCenter = ([bx, bz]: readonly [number, number]): Vec3 => ({
  x: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
  y: 0,
  z: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
});

/** A screen mounted proud of the facade plane at `plane` on `axis`. */
function mount(
  axis: "x" | "z",
  dir: -1 | 1,
  plane: number,
  along: number,
  y: number,
  width: number,
  building: number,
): JumbotronSite {
  const perp = plane + (dir * SCREEN_DEPTH) / 2;
  const c = canonicalize(
    axis === "x" ? { x: perp, y: 0, z: along } : { x: along, y: 0, z: perp },
  );
  return {
    x: c.x,
    z: c.z,
    y,
    width,
    height: (width * 9) / 16,
    axis,
    dir,
    building,
  };
}

/** The landmark's shaft face that looks toward its nearest plaza. */
function landmarkSite(b: Building, index: number): JumbotronSite | null {
  const shaft = b.tiers[1];
  const podium = b.tiers[0];
  if (!shaft || !podium) return null;
  const at = { x: b.x, y: 0, z: b.z };
  let best: Vec3 | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of PLAZA_BLOCKS) {
    const d = wrapDelta(at, blockCenter(p));
    const dist = Math.hypot(d.x, d.z);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  if (!best) return null;
  const axis = Math.abs(best.x) >= Math.abs(best.z) ? "x" : "z";
  const dir = (axis === "x" ? best.x : best.z) >= 0 ? 1 : -1;
  const half = (axis === "x" ? shaft.width : shaft.depth) / 2;
  const length = axis === "x" ? shaft.depth : shaft.width;
  const width = Math.min(LANDMARK_SCREEN_WIDTH, length - FACE_MARGIN);
  const bottom = Math.max(LANDMARK_SCREEN_BOTTOM, podium.height + 20);
  if (bottom + (width * 9) / 16 > podium.height + shaft.height - 4) return null;
  return mount(
    axis,
    dir,
    (axis === "x" ? b.x : b.z) + dir * half,
    axis === "x" ? b.z : b.x,
    bottom,
    width,
    index,
  );
}

/** The tallest tier-1 facade that faces plaza block (px, pz) across the
 * street, skipping hole mouths (a screen would hang across the opening). */
function plazaSite(
  buildings: readonly Building[],
  landmarks: ReadonlySet<Building>,
  px: number,
  pz: number,
): JumbotronSite | null {
  let best: { b: Building; site: JumbotronSite } | null = null;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i] as Building;
    if (landmarks.has(b)) continue;
    const t1 = b.tiers[0];
    if (!t1) continue;
    const mouths = new Set(
      (b.holes ?? []).filter((h) => h.tierIndex === 0).map((h) => h.axis),
    );
    for (const axis of ["x", "z"] as const) {
      if (mouths.has(axis)) continue;
      const half = (axis === "x" ? t1.width : t1.depth) / 2;
      const length = axis === "x" ? t1.depth : t1.width;
      const width = Math.min(PLAZA_SCREEN_WIDTH, length - FACE_MARGIN);
      if (width < PLAZA_SCREEN_WIDTH * 0.6) continue;
      if (t1.height < PLAZA_SCREEN_BOTTOM + (width * 9) / 16 + 2) continue;
      for (const dir of [-1, 1] as const) {
        const plane = (axis === "x" ? b.x : b.z) + dir * half;
        const probe = plane + dir * PLAZA_PROBE;
        const along = axis === "x" ? b.z : b.x;
        const bx = blockOf(axis === "x" ? probe : along);
        const bz = blockOf(axis === "x" ? along : probe);
        if (bx !== px || bz !== pz) continue;
        if (
          best === null ||
          b.height > best.b.height ||
          (b.height === best.b.height &&
            (b.x < best.b.x || (b.x === best.b.x && b.z < best.b.z)))
        ) {
          best = {
            b,
            site: mount(axis, dir, plane, along, PLAZA_SCREEN_BOTTOM, width, i),
          };
        }
      }
    }
  }
  return best?.site ?? null;
}

/**
 * Where the jumbotrons hang: each landmark's shaft, facing its nearest
 * plaza, then one plaza-facing facade per plaza — capped at JUMBOTRON_MAX.
 * Deterministic from the city alone, so every client hangs the same screens.
 */
export function jumbotronSites(
  buildings: readonly Building[],
): JumbotronSite[] {
  const sites: JumbotronSite[] = [];
  const landmarks = new Set<Building>();
  for (const block of LANDMARK_BLOCKS) {
    const c = blockCenter(block);
    const index = buildings.findIndex((o) => o.x === c.x && o.z === c.z);
    const b = buildings[index];
    if (!b) continue;
    landmarks.add(b);
    const site = landmarkSite(b, index);
    if (site) sites.push(site);
  }
  for (const [px, pz] of PLAZA_BLOCKS) {
    const site = plazaSite(buildings, landmarks, px, pz);
    if (site) sites.push(site);
  }
  return sites.slice(0, JUMBOTRON_MAX);
}
