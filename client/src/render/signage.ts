// Street-level neon signage (S2, client-only dressing) — the "Full Times
// Square" concept the design gate picked: vertical glyph marquees, billboards,
// storefront strips, and sidewalk neon spill, dense near landmarks/plazas and
// quiet on side streets. Layout is the pure seam signageFor(): deterministic
// per building from (world seed, building) via the shared mulberry32 — no
// Math.random, so every client dresses identical streets (same idiom as
// roofClutterFor). Signs mount flush on TIER-1 facades — the plan's sanctioned
// visual-without-collision exception — and every offset that could reach the
// roadway comes from the S1 street contract, never a literal.

import {
  type Building,
  LANDMARK_BLOCKS,
  PLAZA_BLOCKS,
  mulberry32,
} from "@angels-bandits/common/city";
import { ROADWAY_HALF } from "@angels-bandits/common/city/street";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import { canonicalize } from "@angels-bandits/common/world";

// --- Tunables (Concept 4: steep density gradient, everything on) ---
/** Marquee panel: along-facade width, meters. */
const MARQUEE_WIDTH_MIN = 2;
const MARQUEE_WIDTH_MAX = 3;
/** Marquee vertical extent, meters. */
const MARQUEE_HEIGHT_MIN = 8;
const MARQUEE_HEIGHT_MAX = 25;
/** Marquee bottom edge above the sidewalk, meters. */
const MARQUEE_BOTTOM_MIN = 4;
const MARQUEE_BOTTOM_MAX = 8;
/** How proud of the facade a marquee box sits, meters. */
const MARQUEE_DEPTH = 0.6;
/** Mean marquees per facade before the density gradient. */
const MARQUEE_FACE_MEAN = 1.6;
/** Hard cap per facade. */
const MARQUEE_FACE_MAX = 4;

/** Facades need this much sidewalk between face and curb to carry signs —
 * covers the proudest sign plus clearance so no corner touches the roadway. */
const MIN_FACE_CLEARANCE = 1.2;
/** Candidate sign stations per facade (signs get distinct slots, no overlap). */
const FACE_SLOTS = 6;
/** Fraction of the facade length usable for slots (insets keep corners clear). */
const FACE_USABLE = 0.84;

/** Density gradient (Concept 4): quiet side streets → riot at landmarks. */
const DENSITY_BASE = 0.7;
const DENSITY_HOT = 1.1;
/** Blocks of Chebyshev distance over which landmark/plaza heat fades to 0. */
const HEAT_RADIUS = 3;

/** Marquee glyph-texture pool size (atlas tiles; grown from the plan's ~8 —
 * the dense concept repeats textures too visibly with fewer). */
export const MARQUEE_TEXTURE_POOL = 16;

/** Billboard quad: along-facade width, meters (plan: 8×5 to 16×9). */
const BILLBOARD_WIDTH_MIN = 8;
const BILLBOARD_WIDTH_MAX = 16;
const BILLBOARD_HEIGHT_MIN = 5;
const BILLBOARD_HEIGHT_MAX = 9;
/** Billboard bottom edge above the storefront band, meters. */
const BILLBOARD_BOTTOM_MIN = 6;
const BILLBOARD_BOTTOM_MAX = 14;
/** How proud of the facade a billboard sits, meters (flatter than marquees). */
const BILLBOARD_DEPTH = 0.3;
/** Mean billboards per facade before the density gradient (plan caps at 2). */
const BILLBOARD_FACE_MEAN = 1.1;
const BILLBOARD_FACE_MAX = 2;

/** Billboard art-texture pool size (atlas tiles). */
export const BILLBOARD_TEXTURE_POOL = 8;

/** Storefront strip: a thin sign band just above the shop-glass line the
 * buildings shader paints (its shop band tops out at 4 m of world height). */
const STRIP_BOTTOM = 4.1;
const STRIP_HEIGHT = 0.7;
/** How proud of the facade the strip sits, meters. */
const STRIP_DEPTH = 0.4;

/** A facade spills onto the sidewalk once it carries this many signs. */
const SPILL_MIN_CLUSTER = 3;
/** Pool radius bounds, meters (lamp glow pools are 9 m). */
const SPILL_RADIUS_MAX = 8;

// --- Seeded neon palette (linear RGB, weighted like the reference photo) ---
export interface PaletteColor {
  r: number;
  g: number;
  b: number;
}
/** pink, cyan, amber, blue, red — Concept 4's balanced warm+cool mix. */
export const SIGN_PALETTE: readonly PaletteColor[] = [
  { r: 1.0, g: 0.15, b: 0.75 },
  { r: 0.1, g: 0.85, b: 1.0 },
  { r: 1.0, g: 0.55, b: 0.1 },
  { r: 0.2, g: 0.35, b: 1.0 },
  { r: 1.0, g: 0.12, b: 0.1 },
];
const PALETTE_WEIGHTS = [2.5, 2, 2.5, 1.5, 2.5] as const;
const PALETTE_TOTAL = PALETTE_WEIGHTS.reduce((a, w) => a + w, 0);

/** Weighted palette pick from one PRNG draw. */
function paletteIndex(roll: number): number {
  let r = roll * PALETTE_TOTAL;
  for (let i = 0; i < PALETTE_WEIGHTS.length; i++) {
    r -= PALETTE_WEIGHTS[i] as number;
    if (r <= 0) return i;
  }
  return 0;
}

// --- Layout types (the pure seam's output) ---
/** One flush facade-mounted sign panel, canonical coords. */
export interface SignPlacement {
  /** Canonical panel-center ground position (center of the proud box). */
  x: number;
  z: number;
  /** Bottom edge height, meters. */
  y: number;
  /** Along-facade extent, meters. */
  width: number;
  /** Vertical extent, meters. */
  height: number;
  /** Proud-of-facade extent, meters. */
  depth: number;
  /** Facade outward-normal axis and direction. */
  axis: "x" | "z";
  dir: -1 | 1;
  paletteIndex: number;
  /** Atlas tile this sign samples. */
  textureIndex: number;
  /** Pulse phase offset, 0..1 of a period. */
  phase: number;
}

/** One additive ground-glow pool on the sidewalk (lamp-glow idiom). */
export interface SpillPool {
  x: number;
  z: number;
  radius: number;
  paletteIndex: number;
  phase: number;
}

export interface BuildingSignage {
  marquees: SignPlacement[];
  billboards: SignPlacement[];
  strips: SignPlacement[];
  spills: SpillPool[];
}

/** Torus-wrapped block-index distance on the GRID×GRID block grid. */
const GRID = WORLD_SIZE / BLOCK_PITCH;
function blockDist(a: number, b: number): number {
  const d = Math.abs(a - b) % GRID;
  return Math.min(d, GRID - d);
}

/**
 * Landmark/plaza heat for a building: 1 on a hotspot-adjacent block fading
 * linearly to 0 at HEAT_RADIUS blocks (Chebyshev, wrap-aware). This is the
 * "Times Square concentration" — pure function of the block position.
 */
export function landmarkHeat(b: Building): number {
  const bx = Math.floor(b.x / BLOCK_PITCH);
  const bz = Math.floor(b.z / BLOCK_PITCH);
  let nearest = Number.POSITIVE_INFINITY;
  for (const [hx, hz] of [...LANDMARK_BLOCKS, ...PLAZA_BLOCKS]) {
    const d = Math.max(blockDist(bx, hx), blockDist(bz, hz));
    if (d < nearest) nearest = d;
  }
  return Math.max(0, 1 - nearest / HEAT_RADIUS);
}

/** The four tier-1 facades of a building, with the S1-derived clearance
 * between the facade plane and the curb of the street it faces. */
interface Face {
  axis: "x" | "z";
  dir: -1 | 1;
  /** Along-facade length, meters (the other footprint dimension). */
  length: number;
  /** Facade plane's coordinate on `axis`. */
  plane: number;
  /** Sidewalk depth from facade plane to the curb, meters. */
  clearance: number;
}

function tierOneFaces(b: Building): Face[] {
  const t1 = b.tiers[0];
  if (!t1) return [];
  const faces: Face[] = [];
  for (const axis of ["x", "z"] as const) {
    const perp = axis === "x" ? t1.width : t1.depth;
    const length = axis === "x" ? t1.depth : t1.width;
    const clearance = (BLOCK_PITCH - perp) / 2 - ROADWAY_HALF;
    for (const dir of [-1, 1] as const) {
      faces.push({
        axis,
        dir,
        length,
        plane: (axis === "x" ? b.x : b.z) + (dir * perp) / 2,
        clearance,
      });
    }
  }
  return faces;
}

/** Fisher–Yates shuffle of 0..n-1 driven by the face's PRNG. */
function shuffledSlots(rand: () => number, n: number): number[] {
  const slots = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = slots[i] as number;
    slots[i] = slots[j] as number;
    slots[j] = tmp;
  }
  return slots;
}

/**
 * Deterministic signage for one building's tier-1 facades. Faces whose
 * sidewalk clearance can't hold a proud sign (max-footprint buildings sit ON
 * the curb) stay bare. Everything derives from (seed, building) — same city
 * seed, same neon, on every client.
 */
export function signageFor(b: Building, seed: number): BuildingSignage {
  const none: BuildingSignage = {
    marquees: [],
    billboards: [],
    strips: [],
    spills: [],
  };
  const t1 = b.tiers[0];
  if (!t1) return none;

  const bSeed =
    (seed ^
      Math.imul(b.x, 73856093) ^
      Math.imul(b.z, 19349663) ^
      Math.imul(b.height, 83492791)) >>>
    0;
  const density = DENSITY_BASE + DENSITY_HOT * landmarkHeat(b);
  const out: BuildingSignage = {
    marquees: [],
    billboards: [],
    strips: [],
    spills: [],
  };

  tierOneFaces(b).forEach((face, faceIndex) => {
    if (face.clearance < MIN_FACE_CLEARANCE) return;
    const rand = mulberry32((bSeed ^ Math.imul(faceIndex + 1, 0x9e3779b9)) >>> 0);
    const slots = shuffledSlots(rand, FACE_SLOTS);
    const span = face.length * FACE_USABLE;
    const slotWidth = span / FACE_SLOTS;
    const along = (slot: number) =>
      (face.axis === "x" ? b.z : b.x) - span / 2 + (slot + 0.5) * slotWidth;

    // Panel center sits depth/2 outside the facade plane.
    const place = (
      centerAlong: number,
      depth: number,
    ): { x: number; z: number } => {
      const centerPerp = face.plane + (face.dir * depth) / 2;
      const p =
        face.axis === "x"
          ? { x: centerPerp, y: 0, z: centerAlong }
          : { x: centerAlong, y: 0, z: centerPerp };
      const c = canonicalize(p);
      return { x: c.x, z: c.z };
    };

    /** Marquees + billboards mounted on THIS facade (drives the spill). */
    const faceSigns: SignPlacement[] = [];

    // --- Vertical marquees ---
    const marqueeCount = Math.min(
      MARQUEE_FACE_MAX,
      Math.round(MARQUEE_FACE_MEAN * density * (0.6 + 0.8 * rand())),
    );
    const tier1Top = t1.height - 1;
    for (let i = 0; i < marqueeCount; i++) {
      const slot = slots[i % FACE_SLOTS] as number;
      const width =
        MARQUEE_WIDTH_MIN + rand() * (MARQUEE_WIDTH_MAX - MARQUEE_WIDTH_MIN);
      const bottom =
        MARQUEE_BOTTOM_MIN + rand() * (MARQUEE_BOTTOM_MAX - MARQUEE_BOTTOM_MIN);
      const height = Math.min(
        MARQUEE_HEIGHT_MIN + rand() * (MARQUEE_HEIGHT_MAX - MARQUEE_HEIGHT_MIN),
        tier1Top - bottom,
      );
      const jitter =
        (rand() * 2 - 1) * Math.max(0, slotWidth / 2 - width / 2 - 0.5);
      if (height < MARQUEE_HEIGHT_MIN) continue;
      const marquee: SignPlacement = {
        ...place(along(slot) + jitter, MARQUEE_DEPTH),
        y: bottom,
        width,
        height,
        depth: MARQUEE_DEPTH,
        axis: face.axis,
        dir: face.dir,
        paletteIndex: paletteIndex(rand()),
        textureIndex: Math.floor(rand() * MARQUEE_TEXTURE_POOL),
        phase: rand(),
      };
      out.marquees.push(marquee);
      faceSigns.push(marquee);
    }

    // --- Billboards (lower facade, slots after the marquees') ---
    const billboardCount = Math.min(
      BILLBOARD_FACE_MAX,
      Math.floor(BILLBOARD_FACE_MEAN * density * rand() * 2),
    );
    for (let i = 0; i < billboardCount; i++) {
      const slot = slots[(marqueeCount + i) % FACE_SLOTS] as number;
      const width =
        BILLBOARD_WIDTH_MIN +
        rand() * (BILLBOARD_WIDTH_MAX - BILLBOARD_WIDTH_MIN);
      const height =
        BILLBOARD_HEIGHT_MIN +
        rand() * (BILLBOARD_HEIGHT_MAX - BILLBOARD_HEIGHT_MIN);
      const bottom = Math.min(
        BILLBOARD_BOTTOM_MIN +
          rand() * (BILLBOARD_BOTTOM_MAX - BILLBOARD_BOTTOM_MIN),
        t1.height - height,
      );
      const jitter =
        (rand() * 2 - 1) * Math.max(0, slotWidth / 2 - width / 2 - 0.5);
      if (bottom < BILLBOARD_BOTTOM_MIN) continue;
      const billboard: SignPlacement = {
        ...place(along(slot) + jitter, BILLBOARD_DEPTH),
        y: bottom,
        width,
        height,
        depth: BILLBOARD_DEPTH,
        axis: face.axis,
        dir: face.dir,
        paletteIndex: paletteIndex(rand()),
        textureIndex: Math.floor(rand() * BILLBOARD_TEXTURE_POOL),
        phase: rand(),
      };
      out.billboards.push(billboard);
      faceSigns.push(billboard);
    }

    // --- Storefront strip (one continuous band per facade, Concept 4) ---
    out.strips.push({
      ...place(face.axis === "x" ? b.z : b.x, STRIP_DEPTH),
      y: STRIP_BOTTOM,
      width: span,
      height: STRIP_HEIGHT,
      depth: STRIP_DEPTH,
      axis: face.axis,
      dir: face.dir,
      paletteIndex: paletteIndex(rand()),
      textureIndex: 0,
      phase: rand(),
    });

    // --- Neon spill: a dense facade tints its sidewalk (lamp-glow idiom) ---
    if (faceSigns.length >= SPILL_MIN_CLUSTER) {
      const mid = face.plane + (face.dir * face.clearance) / 2;
      const alongMid = face.axis === "x" ? b.z : b.x;
      const c = canonicalize(
        face.axis === "x"
          ? { x: mid, y: 0, z: alongMid }
          : { x: alongMid, y: 0, z: mid },
      );
      out.spills.push({
        x: c.x,
        z: c.z,
        radius: Math.min(
          SPILL_RADIUS_MAX,
          Math.max(2, face.clearance * 0.75),
        ),
        paletteIndex: (faceSigns[0] as SignPlacement).paletteIndex,
        phase: rand(),
      });
    }
  });

  return out;
}
