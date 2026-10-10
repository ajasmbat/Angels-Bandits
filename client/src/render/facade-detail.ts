// L13 facade detail (ANGE-G6JR64, client-only dressing): the real-world
// clutter that gives a canyon wall relief — zig-zag fire escapes down masonry
// mid-rises, balcony stacks on residential-looking office towers, AC units
// under windows, and scaffolding with work lights on the buildings across
// the street from a crane.
//
// Layout is the pure seam facadeDetailFor() — deterministic per building via
// the shared mulberry32 (facadeGarnishFor idiom, no Math.random), so every
// client sees the same balconies. Everything sits on the DRAWN window grid:
// windowPitch(arch, pitchSeed(tier dims)) is bit-exact with the building
// shader, cells measured from the tier's horizontal centre and floors from
// the tier base (the shader's vMeters frame).
//
// Visual-only, no collision: every box stays within MAX_PROTRUSION (1.5 m) of
// its facade plane — the plan's tiny-garnish exception, the same one parapets
// and canopies use — so the flight envelope and the bot probes are untouched.
// Faces are street frontage only (never a party wall), a tier with an H1 hole
// along an axis keeps BOTH faces on that axis bare (the signage rule), and
// features step around the S2 signs.

import {
  type Building,
  CITY_GRID,
  CONSTRUCTION_BLOCKS,
  type LocalBox,
  mulberry32,
} from "@angels-bandits/common/city";
import { facadeClearances } from "@angels-bandits/common/city/street";
import { BLOCK_PITCH, EMISSIVE_SIGN } from "@angels-bandits/common/constants";
import {
  type Vec3,
  wrapDelta,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import { emissiveBoost } from "./emissive";
import { GLYPH_H, wordCells, wordRuns } from "./pixel-font";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { type SignPlacement, signageFor } from "./signage";
import { type StandingLayer, StandingMask } from "./standing-watch";
import { blockOf, blockWindow } from "./streetlife";
import { facadeFor, pitchSeed, windowPitch } from "./window-pattern";
import { nearestImage } from "./wrapPlacement";

/** Nothing stands further than this off its facade plane, meters. */
export const MAX_PROTRUSION = 1.5;
/** Nothing hangs lower than this, meters: above the S2 neon strip that runs
 * the whole street face (4.1–4.8 m, + the sign margin), and so above the
 * canopies (top at 4.2 m), the shop band and every head on the pavement.
 * Drop ladders stop exactly here. */
export const DETAIL_MIN_Y = 5.6;
/** Headroom kept under each tier top — the parapet lip overhangs the facade. */
const TOP_CLEAR = 0.5;
/** A side needs this much tier-1 sidewalk to count as street frontage. */
const MIN_FACE_CLEARANCE = 1.2;
/** Gap kept around every sign panel, meters. */
const SIGN_MARGIN = 0.75;
/** Placement retries for a column feature that hits a sign. */
const PLACE_TRIES = 5;

// --- Fire escapes (MASONRY) ---
const ESCAPE_BAYS = 2;
const LANDING_DEPTH = 1.2;
const LANDING_THICKNESS = 0.12;
const RAIL_HEIGHT = 0.95;
const PANEL_THICKNESS = 0.05;
const FLIGHT_DEPTH = 0.55;
const FLIGHT_THICKNESS = 0.1;
/** Share of the landing width a flight's run covers. */
const FLIGHT_RUN = 0.55;
const LADDER_WIDTH = 0.5;
const LADDER_MAX = 2.5;
/** Chance a masonry building gets a second fire escape on another face. */
const SECOND_ESCAPE = 0.4;

// --- Balconies (residential-looking OFFICE towers) ---
const RESIDENTIAL_CHANCE = 0.4;
const RESIDENTIAL_MIN_HEIGHT = 30;
const BALCONY_DEPTH = 1.3;
const BALCONY_SLAB = 0.18;
const BALCONY_RAIL = 1.0;
/** Balcony width as a share of the window bay. */
const BALCONY_WIDTH = 0.8;
const BALCONY_COLUMNS_MAX = 3;
/** Lowest balcony floor line, meters (above shops, signs' lower band). */
const BALCONY_MIN_Y = 7;

// --- AC units ---
const AC_CHANCE = { masonry: 0.06, office: 0.035, residential: 0.07 };
const AC_WIDTH = 0.75;
const AC_HEIGHT = 0.5;
const AC_DEPTH = 0.6;
/** Gap between the unit's top and the window sill, meters. */
const AC_SILL_GAP = 0.08;

// --- Scaffolding (beside CONSTRUCTION_BLOCKS) ---
const SCAFFOLD_CHANCE = 0.35;
const LIFT = 2;
const POLE = 0.12;
const STANDARD_SPACING = 2.4;
const SCAFFOLD_IN = 0.2;
const SCAFFOLD_OUT = 1.32;
const LIGHT_SPACING = 8;

// --- Palette (non-emissive; the night key and the windows behind light them) ---
const IRON = [0x3a3532, 0x2c2a2b, 0x433730] as const;
const BALCONY_PANEL = [0x5d636b, 0x4f5660, 0x6a6560] as const;
const SLAB = 0x5a5856;
const AC_TONES = [0x8d8a82, 0x77736b, 0x9a958b] as const;
const SCAFFOLD_POLE = 0x6d7177;
const SCAFFOLD_DECK = 0x5a4632;
/** Halogen work light — warm white, on the SIGN rung (never above it). */
export const WORK_LIGHT_COLOR = 0xffe2b0;
export const WORK_LIGHT_RUNG = EMISSIVE_SIGN;

// --- DT2: balcony gardens and lights, ivy, graffiti ---
/** Balcony planter, foliage and the occasional bloom on top. */
const PLANTER_TONES = [0x9a5a3c, 0x6f6a66, 0x8a4a34] as const;
const FOLIAGE_TONES = [0x2f5a2a, 0x3d6b2f, 0x24502a, 0x4a7a34] as const;
const BLOOM_TONES = [0xd9467a, 0xe8c13a, 0xf2f2f2, 0xb05ad9] as const;
/** Share of balconies with plants at both ends / at least one end. */
const PLANTS_BOTH = 0.35;
const PLANTS_ANY = 0.75;
/** Share of balconies with a lit wall sconce beside the door. */
export const SCONCE_CHANCE = 0.33;
export const SCONCE_COLOR = 0xffc98a;
/** Sconces glow under the bloom threshold (0.72): a warm dot, never a
 * blooming speck that twinkles at range. */
export const SCONCE_LUMINANCE = 0.5;
/** Ivy curtains hang from a masonry tier's top (roof planters spilling
 * over), down to no lower than DETAIL_MIN_Y. */
export const IVY_CHANCE = 0.3;
const IVY_ROW = 0.55;
const IVY_TONES = [0x2c4a26, 0x355a2c, 0x23401f, 0x3e6332, 0x2a4f2f] as const;
/** Graffiti throw-ups on a masonry street face's lowest dressable band. */
export const GRAFFITI_CHANCE = 0.3;
export const GRAFFITI_CELL = 0.3;
/** Paint glows like hole-decor's murals do, well under DECOR_PAINT_GLOW. */
export const GRAFFITI_GLOW = 0.2;
/** Outline from the wall to 5 cm, fill 5–9 cm: ≥ 4 cm between the two
 * front faces — depth-safe at the 380 m fade (near plane 1 m). */
export const GRAFFITI_OUTLINE_OUT = 0.05;
export const GRAFFITI_FILL_OUT = 0.09;
const GRAFFITI_OUTLINE = 0.09;
const GRAFFITI_OUTLINE_TONE = 0x111216;
const GRAFFITI_TONES = [
  0xff3d7f, 0x35d0ff, 0xffd23c, 0x7dff6a, 0xb46bff, 0xff7a2d, 0xf2f2f2,
] as const;
export const GRAFFITI_WORDS = [
  "ACE",
  "ZAP",
  "BOOM",
  "WILD",
  "KAOS",
  "RAD",
  "FLY",
  "DOPE",
  "KING",
  "ZOOM",
  "MAD",
  "GLOW",
  "WOW",
  "YES",
] as const;

export type DetailKind =
  | "fireEscape"
  | "balcony"
  | "ac"
  | "scaffold"
  | "plant"
  | "lamp"
  | "ivy"
  | "graffiti";

/** DT2: the emissive rung each lit kind glows at (work lights: the SIGN
 * rung, as they always have). */
export const lightLuminance = (kind: DetailKind): number =>
  kind === "lamp"
    ? SCONCE_LUMINANCE
    : kind === "graffiti"
      ? GRAFFITI_GLOW
      : WORK_LIGHT_RUNG;

/** One instanced box, in its building's frame (b.x/b.z ± offsets — the
 * renderer moves the whole building to its torus image). */
export interface DetailBox {
  kind: DetailKind;
  /** Box centre. */
  x: number;
  y: number;
  z: number;
  /** World-axis sizes before `roll`. */
  sx: number;
  sy: number;
  sz: number;
  /** Rotation about the facade normal, radians (+ raises the +along end):
   * stair flights and braces. Never changes the normal-axis extent. */
  roll: number;
  /** Facade outward normal axis/direction and plane coordinate. */
  axis: "x" | "z";
  dir: -1 | 1;
  plane: number;
  tierIndex: number;
  color: number;
}

export interface FacadeDetail {
  boxes: DetailBox[];
  /** Emissive work lights (same box shape). */
  lights: DetailBox[];
}

/** A rect on a facade: along-face coordinate span and height span. */
interface Rect {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

/** One eligible street-facing face of one tier. */
interface Face {
  tierIndex: number;
  axis: "x" | "z";
  dir: -1 | 1;
  plane: number;
  /** Along-face coordinate of the tier centre (b.z on an x face). */
  center: number;
  length: number;
  base: number;
  top: number;
  px: number;
  py: number;
  /** Window sill height inside its floor, fraction of py. */
  sill: number;
  /** First/last whole bay index (cells measured from `center`). */
  nMin: number;
  nMax: number;
  /** Sign panels on this face (+ margin) — never covered. */
  signs: Rect[];
  /** Rects already taken by a feature (AC units step around them). */
  taken: Rect[];
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.a0 < b.a1 && b.a0 < a.a1 && a.y0 < b.y1 && b.y0 < a.y1;

const blocked = (f: Face, r: Rect, taken = false): boolean =>
  f.signs.some((s) => overlaps(s, r)) ||
  (taken && f.taken.some((t) => overlaps(t, r)));

/** Bay n's centre along the face. */
const bayCenter = (f: Face, n: number): number => f.center + (n + 0.5) * f.px;

/** Per-building PRNG stream, salted per feature so kinds never correlate. */
function stream(b: Building, seed: number, salt: number): () => number {
  return mulberry32(
    (seed ^
      Math.imul(b.x | 0, 73856093) ^
      Math.imul(b.z | 0, 19349663) ^
      Math.imul(Math.round(b.height * 16), 83492791) ^
      Math.imul(salt, 0x9e3779b9)) >>>
      0,
  );
}

/** A box on face `f`: along-centre, height-centre, along size, height,
 * and its normal span [out0, out1] measured outward from the plane. */
function boxOn(
  f: Face,
  kind: DetailKind,
  along: number,
  y: number,
  alongSize: number,
  height: number,
  out0: number,
  out1: number,
  color: number,
  roll = 0,
): DetailBox {
  const n = f.plane + (f.dir * (out0 + out1)) / 2;
  const depth = out1 - out0;
  const onX = f.axis === "x";
  return {
    kind,
    x: onX ? n : along,
    y,
    z: onX ? along : n,
    sx: onX ? depth : alongSize,
    sy: height,
    sz: onX ? alongSize : depth,
    roll,
    axis: f.axis,
    dir: f.dir,
    plane: f.plane,
    tierIndex: f.tierIndex,
    color,
  };
}

/** World AABB of a box (roll included) — tests and QA. */
export function detailBounds(b: DetailBox): {
  min: Vec3;
  max: Vec3;
} {
  const c = Math.abs(Math.cos(b.roll));
  const s = Math.abs(Math.sin(b.roll));
  const along = b.axis === "x" ? b.sz : b.sx;
  const hAlong = (c * along + s * b.sy) / 2;
  const hy = (s * along + c * b.sy) / 2;
  const hx = b.axis === "x" ? b.sx / 2 : hAlong;
  const hz = b.axis === "x" ? hAlong : b.sz / 2;
  return {
    min: { x: b.x - hx, y: b.y - hy, z: b.z - hz },
    max: { x: b.x + hx, y: b.y + hy, z: b.z + hz },
  };
}

/** True when block (bx, bz) shares a street with a crane site. */
function besideConstruction(bx: number, bz: number): boolean {
  const wrap = (v: number) => ((v % CITY_GRID) + CITY_GRID) % CITY_GRID;
  return CONSTRUCTION_BLOCKS.some(
    ([cx, cz]) =>
      (wrap(bx - cx) === 0 && (wrap(bz - cz) === 1 || wrap(cz - bz) === 1)) ||
      (wrap(bz - cz) === 0 && (wrap(bx - cx) === 1 || wrap(cx - bx) === 1)),
  );
}

/** Sign rects on the tier-1 face (axis, dir), in the face's along frame. */
function signRects(
  b: Building,
  signs: SignPlacement[],
  axis: "x" | "z",
  dir: -1 | 1,
): Rect[] {
  const center = axis === "x" ? b.z : b.x;
  return signs
    .filter((s) => s.axis === axis && s.dir === dir)
    .map((s) => {
      const d = wrapDelta({ x: b.x, y: 0, z: b.z }, { x: s.x, y: 0, z: s.z });
      const along = center + (axis === "x" ? d.z : d.x);
      return {
        a0: along - s.width / 2 - SIGN_MARGIN,
        a1: along + s.width / 2 + SIGN_MARGIN,
        y0: s.y - SIGN_MARGIN,
        y1: s.y + s.height + SIGN_MARGIN,
      };
    });
}

/** Street-facing faces of every tier (party walls and holed axes skipped). */
function facesOf(
  b: Building,
  arch: FacadeArchetype,
  signs: SignPlacement[],
): Face[] {
  const t0 = b.tiers[0];
  if (!t0) return [];
  const clearance = facadeClearances(b.x, b.z, t0.width, t0.depth);
  const sill = (1 - facadeFor(arch).pane[1]) / 2;
  const faces: Face[] = [];
  let base = 0;
  b.tiers.forEach((t, tierIndex) => {
    const [px, py] = windowPitch(arch, pitchSeed(t.width, t.height, t.depth));
    const holed = new Set(
      (b.holes ?? [])
        .filter((h) => h.tierIndex === tierIndex)
        .map((h) => h.axis),
    );
    for (const axis of ["x", "z"] as const) {
      if (holed.has(axis)) continue;
      const length = axis === "x" ? t.depth : t.width;
      for (const dir of [-1, 1] as const) {
        if (clearance[`${axis}${dir < 0 ? 0 : 1}`] < MIN_FACE_CLEARANCE)
          continue;
        faces.push({
          tierIndex,
          axis,
          dir,
          plane:
            (axis === "x" ? b.x : b.z) +
            (dir * (axis === "x" ? t.width : t.depth)) / 2,
          center: axis === "x" ? b.z : b.x,
          length,
          base,
          top: base + t.height,
          px,
          py,
          sill,
          nMin: Math.ceil(-length / 2 / px),
          nMax: Math.floor(length / 2 / px) - 1,
          signs: tierIndex === 0 ? signRects(b, signs, axis, dir) : [],
          taken: [],
        });
      }
    }
    base += t.height;
  });
  return faces;
}

/** Zig-zag fire escape two bays wide; returns false when nothing fits. */
function fireEscape(f: Face, rand: () => number, out: DetailBox[]): boolean {
  const bays = f.nMax - f.nMin + 1;
  if (bays < ESCAPE_BAYS + 2) return false;
  // Landings on floor lines: the lowest leaves room for the drop ladder, the
  // highest keeps its railing under the parapet.
  const kStart = Math.max(1, Math.ceil((DETAIL_MIN_Y + 1 - f.base) / f.py));
  const kEnd = Math.floor((f.top - TOP_CLEAR - RAIL_HEIGHT - f.base) / f.py);
  if (kEnd - kStart < 1) return false;
  const yOf = (k: number) => f.base + k * f.py;
  const width = ESCAPE_BAYS * f.px;

  for (let tryIndex = 0; tryIndex < PLACE_TRIES; tryIndex++) {
    const n = f.nMin + 1 + Math.floor(rand() * (bays - ESCAPE_BAYS - 1));
    const a0 = f.center + n * f.px;
    const rect = {
      a0: a0 - 0.2,
      a1: a0 + width + 0.2,
      y0: DETAIL_MIN_Y,
      y1: yOf(kEnd) + RAIL_HEIGHT,
    };
    if (blocked(f, rect)) continue;
    f.taken.push(rect);
    const mid = a0 + width / 2;
    const iron = IRON[Math.floor(rand() * IRON.length)] as number;
    const run = width * FLIGHT_RUN;
    for (let k = kStart; k <= kEnd; k++) {
      const y = yOf(k);
      out.push(
        boxOn(
          f,
          "fireEscape",
          mid,
          y - LANDING_THICKNESS / 2,
          width,
          LANDING_THICKNESS,
          0.05,
          LANDING_DEPTH,
          iron,
        ),
        boxOn(
          f,
          "fireEscape",
          mid,
          y + RAIL_HEIGHT / 2,
          width,
          RAIL_HEIGHT,
          LANDING_DEPTH - PANEL_THICKNESS,
          LANDING_DEPTH,
          iron,
        ),
        boxOn(
          f,
          "fireEscape",
          a0 + PANEL_THICKNESS / 2,
          y + RAIL_HEIGHT / 2,
          PANEL_THICKNESS,
          RAIL_HEIGHT,
          0.05,
          LANDING_DEPTH,
          iron,
        ),
        boxOn(
          f,
          "fireEscape",
          a0 + width - PANEL_THICKNESS / 2,
          y + RAIL_HEIGHT / 2,
          PANEL_THICKNESS,
          RAIL_HEIGHT,
          0.05,
          LANDING_DEPTH,
          iron,
        ),
      );
      if (k < kEnd) {
        // One flight per storey, alternating direction — the zig-zag.
        const s = (k - kStart) % 2 === 0 ? 1 : -1;
        out.push(
          boxOn(
            f,
            "fireEscape",
            mid + s * width * 0.1,
            y + f.py / 2,
            Math.hypot(run, f.py),
            FLIGHT_THICKNESS,
            LANDING_DEPTH - FLIGHT_DEPTH - PANEL_THICKNESS,
            LANDING_DEPTH - PANEL_THICKNESS,
            iron,
            s * Math.atan2(f.py, run),
          ),
        );
      }
    }
    // Counterweighted drop ladder under the lowest landing, down to DETAIL_MIN_Y.
    const low = yOf(kStart) - LANDING_THICKNESS;
    const ladder = Math.min(LADDER_MAX, low - DETAIL_MIN_Y);
    if (ladder >= 0.8) {
      out.push(
        boxOn(
          f,
          "fireEscape",
          a0 + width - 0.6,
          low - ladder / 2,
          LADDER_WIDTH,
          ladder,
          0.95,
          1.1,
          iron,
        ),
      );
    }
    return true;
  }
  return false;
}

/** A deterministic 0..1 from a position on a face — DT2 decisions that
 * must not draw from (and so shift) a layout stream. */
function hashAt(a: number, y: number, n: number, salt: number): number {
  let h =
    Math.imul(Math.round(a * 8), 0x27d4eb2d) ^
    Math.imul(Math.round(y * 8), 0x165667b1) ^
    Math.imul(Math.round(n * 8), 0x61c88647) ^
    Math.imul(salt, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const pickTone = <T>(list: readonly T[], r: number): T =>
  list[Math.min(list.length - 1, Math.floor(r * list.length))] as T;

/** DT2: potted plants at a balcony's ends (clear of the spot citylife
 * stands its balcony people on, ±0.36 m round the middle) and a warm
 * sconce on the wall beside the door. Position-hashed, so the balcony
 * layout itself never moves. */
function balconyLife(
  f: Face,
  along: number,
  y: number,
  width: number,
  out: DetailBox[],
  lights: DetailBox[],
): void {
  const h = hashAt(along, y, f.plane, 1);
  const ends =
    h < PLANTS_BOTH
      ? [-1, 1]
      : h < PLANTS_ANY
        ? [hashAt(along, y, f.plane, 2) < 0.5 ? -1 : 1]
        : [];
  for (const side of ends) {
    const at = along + side * (width / 2 - PANEL_THICKNESS - 0.28);
    const r = hashAt(at, y, f.plane, 3);
    const leafH = 0.3 + r * 0.45;
    out.push(
      boxOn(
        f,
        "plant",
        at,
        y + 0.17,
        0.45,
        0.34,
        0.12,
        0.55,
        pickTone(PLANTER_TONES, r),
      ),
      boxOn(
        f,
        "plant",
        at,
        y + 0.34 + leafH / 2,
        0.5,
        leafH,
        0.1,
        0.6,
        pickTone(FOLIAGE_TONES, (r * 7.3) % 1),
      ),
    );
    if (r < 0.4) {
      out.push(
        boxOn(
          f,
          "plant",
          at,
          y + 0.34 + leafH + 0.05,
          0.34,
          0.1,
          0.2,
          0.5,
          pickTone(BLOOM_TONES, r / 0.4),
        ),
      );
    }
  }
  const lampY = y + 1.8;
  if (
    hashAt(along, y, f.plane, 4) < SCONCE_CHANCE &&
    lampY + 0.2 <= f.top - TOP_CLEAR
  ) {
    const side = hashAt(along, y, f.plane, 5) < 0.5 ? -1 : 1;
    const at = along + side * (width / 2 - 0.25);
    const rect = {
      a0: at - 0.1,
      a1: at + 0.1,
      y0: lampY - 0.12,
      y1: lampY + 0.12,
    };
    if (!blocked(f, rect, true)) {
      lights.push(
        boxOn(f, "lamp", at, lampY, 0.16, 0.22, 0, 0.12, SCONCE_COLOR),
      );
    }
  }
}

/** Balcony stacks on one face: a few bay columns, one balcony per floor. */
function balconies(
  f: Face,
  rand: () => number,
  out: DetailBox[],
  lights: DetailBox[],
): void {
  const bays = f.nMax - f.nMin + 1;
  if (bays < 3) return;
  const columns =
    1 +
    Math.floor(rand() * Math.min(BALCONY_COLUMNS_MAX, Math.floor(bays / 3)));
  const panel = BALCONY_PANEL[
    Math.floor(rand() * BALCONY_PANEL.length)
  ] as number;
  const width = f.px * BALCONY_WIDTH;
  const used = new Set<number>();
  for (let c = 0; c < columns; c++) {
    const n = f.nMin + 1 + Math.floor(rand() * (bays - 2));
    if (used.has(n) || used.has(n - 1) || used.has(n + 1)) continue;
    used.add(n);
    const along = bayCenter(f, n);
    for (let k = 1; ; k++) {
      const y = f.base + k * f.py;
      if (y + BALCONY_RAIL > f.top - TOP_CLEAR) break;
      if (y < BALCONY_MIN_Y) continue;
      const rect = {
        a0: along - width / 2,
        a1: along + width / 2,
        y0: y - BALCONY_SLAB,
        y1: y + BALCONY_RAIL,
      };
      if (blocked(f, rect)) continue;
      f.taken.push(rect);
      out.push(
        boxOn(
          f,
          "balcony",
          along,
          y - BALCONY_SLAB / 2,
          width,
          BALCONY_SLAB,
          0,
          BALCONY_DEPTH,
          SLAB,
        ),
        boxOn(
          f,
          "balcony",
          along,
          y + BALCONY_RAIL / 2,
          width,
          BALCONY_RAIL,
          BALCONY_DEPTH - PANEL_THICKNESS,
          BALCONY_DEPTH,
          panel,
        ),
        boxOn(
          f,
          "balcony",
          along - width / 2 + PANEL_THICKNESS / 2,
          y + BALCONY_RAIL / 2,
          PANEL_THICKNESS,
          BALCONY_RAIL,
          0,
          BALCONY_DEPTH,
          panel,
        ),
        boxOn(
          f,
          "balcony",
          along + width / 2 - PANEL_THICKNESS / 2,
          y + BALCONY_RAIL / 2,
          PANEL_THICKNESS,
          BALCONY_RAIL,
          0,
          BALCONY_DEPTH,
          panel,
        ),
      );
      balconyLife(f, along, y, width, out, lights);
    }
  }
}

/** Wall-mounted AC units, each tucked under its window's sill. */
function acUnits(
  f: Face,
  chance: number,
  rand: () => number,
  out: DetailBox[],
): void {
  for (let k = 0; ; k++) {
    const sill = f.base + (k + f.sill) * f.py;
    const top = sill - AC_SILL_GAP;
    if (top > f.top - TOP_CLEAR) break;
    if (top - AC_HEIGHT < DETAIL_MIN_Y) continue;
    for (let n = f.nMin; n <= f.nMax; n++) {
      if (rand() >= chance) continue;
      const along = bayCenter(f, n);
      const rect = {
        a0: along - AC_WIDTH / 2,
        a1: along + AC_WIDTH / 2,
        y0: top - AC_HEIGHT,
        y1: top,
      };
      if (blocked(f, rect, true)) continue;
      const tone = AC_TONES[Math.floor(rand() * AC_TONES.length)] as number;
      out.push(
        boxOn(
          f,
          "ac",
          along,
          top - AC_HEIGHT / 2,
          AC_WIDTH,
          AC_HEIGHT,
          0,
          AC_DEPTH,
          tone,
        ),
      );
    }
  }
}

/** Bracket scaffold on one face with halogen work lights; false if no fit. */
function scaffold(
  f: Face,
  rand: () => number,
  out: DetailBox[],
  lights: DetailBox[],
): boolean {
  const bays = f.nMax - f.nMin + 1;
  const spanBays = Math.min(bays - 2, 4 + Math.floor(rand() * 4));
  if (spanBays < 3) return false;
  const lifts = Math.min(
    3 + Math.floor(rand() * 5),
    Math.floor((f.top - TOP_CLEAR - 1 - DETAIL_MIN_Y) / LIFT),
  );
  if (lifts < 2) return false;
  const span = spanBays * f.px;
  const yTop = DETAIL_MIN_Y + lifts * LIFT;
  for (let tryIndex = 0; tryIndex < PLACE_TRIES; tryIndex++) {
    const n = f.nMin + 1 + Math.floor(rand() * (bays - spanBays - 1));
    const a0 = f.center + n * f.px;
    const rect = { a0, a1: a0 + span, y0: DETAIL_MIN_Y, y1: yTop + 1 };
    if (blocked(f, rect)) continue;
    f.taken.push(rect);
    const mid = a0 + span / 2;
    const height = yTop + 1 - DETAIL_MIN_Y;
    const yMid = DETAIL_MIN_Y + height / 2;
    const intervals = Math.max(1, Math.round(span / STANDARD_SPACING));
    const step = span / intervals;
    // Standards: inner and outer line.
    for (let i = 0; i <= intervals; i++) {
      const a = Math.min(
        a0 + span - POLE / 2,
        Math.max(a0 + POLE / 2, a0 + i * step),
      );
      out.push(
        boxOn(
          f,
          "scaffold",
          a,
          yMid,
          POLE,
          height,
          SCAFFOLD_IN,
          SCAFFOLD_IN + POLE,
          SCAFFOLD_POLE,
        ),
        boxOn(
          f,
          "scaffold",
          a,
          yMid,
          POLE,
          height,
          SCAFFOLD_OUT - POLE,
          SCAFFOLD_OUT,
          SCAFFOLD_POLE,
        ),
      );
    }
    // Per lift: a deck, the outer ledger and a guard rail a meter up.
    for (let l = 1; l <= lifts; l++) {
      const y = DETAIL_MIN_Y + l * LIFT;
      out.push(
        boxOn(
          f,
          "scaffold",
          mid,
          y - 0.03,
          span,
          0.06,
          SCAFFOLD_IN,
          SCAFFOLD_OUT,
          SCAFFOLD_DECK,
        ),
        boxOn(
          f,
          "scaffold",
          mid,
          y,
          span,
          POLE,
          SCAFFOLD_OUT - POLE,
          SCAFFOLD_OUT,
          SCAFFOLD_POLE,
        ),
        boxOn(
          f,
          "scaffold",
          mid,
          y + 1,
          span,
          POLE * 0.8,
          SCAFFOLD_OUT - POLE,
          SCAFFOLD_OUT,
          SCAFFOLD_POLE,
        ),
      );
    }
    // Facade bracing in the two end bays, zig-zagging every two lifts.
    const rise = 2 * LIFT;
    const brace = Math.hypot(step, rise);
    for (const [end, s] of [
      [a0 + step / 2, 1],
      [a0 + span - step / 2, -1],
    ] as const) {
      for (let l = 0; l + 2 <= lifts; l += 2) {
        const flip = (l / 2) % 2 === 0 ? s : -s;
        out.push(
          boxOn(
            f,
            "scaffold",
            end,
            DETAIL_MIN_Y + (l + 1) * LIFT + 0.05, // tilt reach stays above DETAIL_MIN_Y
            brace,
            0.08,
            SCAFFOLD_OUT,
            SCAFFOLD_OUT + 0.08,
            SCAFFOLD_POLE,
            flip * Math.atan2(rise, step),
          ),
        );
      }
    }
    // Work lights clamped to the outer ledgers, every other lift.
    const count = Math.max(1, Math.round(span / LIGHT_SPACING));
    for (let i = 0; i < count; i++) {
      const l = 1 + ((i * 2) % lifts);
      lights.push(
        boxOn(
          f,
          "scaffold",
          a0 + ((i + 0.5) * span) / count,
          DETAIL_MIN_Y + l * LIFT + 0.3,
          0.35,
          0.25,
          SCAFFOLD_OUT,
          SCAFFOLD_OUT + 0.16,
          WORK_LIGHT_COLOR,
        ),
      );
    }
    return true;
  }
  return false;
}

/** Rects of the boxes already on face `f` (AC units are never marked
 * taken, so DT2 steps around every drawn box instead). */
function occupied(f: Face, boxes: readonly DetailBox[]): Rect[] {
  const out: Rect[] = [];
  for (const box of boxes) {
    if (box.axis !== f.axis || box.dir !== f.dir) continue;
    if (Math.abs(box.plane - f.plane) > 0.01) continue;
    const { min, max } = detailBounds(box);
    out.push({
      a0: f.axis === "x" ? min.z : min.x,
      a1: f.axis === "x" ? max.z : max.x,
      y0: min.y,
      y1: max.y,
    });
  }
  return out;
}

const clearOf = (f: Face, used: readonly Rect[], r: Rect): boolean =>
  !blocked(f, r, true) && used.every((u) => !overlaps(u, r));

/** DT2: an ivy curtain spilling down from the tier top — ragged rows of
 * leaf clumps that narrow towards the bottom, a few strands trailing
 * lower. Flat to the wall (≤ 0.16 m out): it grows round the AC units
 * (they stand proud of it) but never over a sign, a fire escape, a
 * balcony or a scaffold. */
function ivy(
  f: Face,
  rand: () => number,
  used: Rect[],
  out: DetailBox[],
): void {
  const bays = f.nMax - f.nMin + 1;
  const spanBays = 1 + Math.floor(rand() * 2);
  const dropRoll = rand();
  if (bays < spanBays) return;
  const width = spanBays * f.px * 0.9;
  const top = f.top - TOP_CLEAR - 0.05;
  const bottom = Math.max(DETAIL_MIN_Y + 0.6, top - (4 + dropRoll * 10));
  if (top - bottom < 2) return;
  for (let tryIndex = 0; tryIndex < PLACE_TRIES; tryIndex++) {
    const n = f.nMin + Math.floor(rand() * (bays - spanBays + 1));
    const mid = f.center + (n + spanBays / 2) * f.px;
    const rect = {
      a0: mid - width / 2 - 0.2,
      a1: mid + width / 2 + 0.2,
      y0: bottom - 2,
      y1: top,
    };
    if (
      rect.a0 < f.center - f.length / 2 ||
      rect.a1 > f.center + f.length / 2 ||
      blocked(f, rect, true)
    ) {
      continue;
    }
    f.taken.push(rect);
    used.push(rect);
    const rows = Math.floor((top - bottom) / IVY_ROW);
    for (let i = 0; i < rows; i++) {
      const t = i / Math.max(1, rows - 1);
      const w = width * (1 - 0.45 * t * t) * (0.8 + rand() * 0.2);
      const jitter = (rand() - 0.5) * 0.3 * (1 - t * 0.5);
      const depth = 0.06 + rand() * 0.1;
      const y = top - (i + 0.5) * IVY_ROW;
      const a = Math.min(
        Math.max(mid + jitter, rect.a0 + w / 2),
        rect.a1 - w / 2,
      );
      out.push(
        boxOn(
          f,
          "ivy",
          a,
          y,
          w,
          IVY_ROW * 1.15,
          0,
          depth,
          pickTone(IVY_TONES, rand()),
        ),
      );
    }
    // Strands trailing past the curtain's ragged hem.
    const strands = 2 + Math.floor(rand() * 3);
    const hem = top - rows * IVY_ROW;
    for (let s = 0; s < strands; s++) {
      const a = mid + (rand() - 0.5) * width * 0.6;
      const len = Math.min(0.5 + rand() * 1.4, hem - DETAIL_MIN_Y);
      const tone = pickTone(IVY_TONES, rand());
      if (len < 0.3) continue;
      out.push(
        boxOn(f, "ivy", a, hem - len / 2 + 0.2, 0.22, len + 0.4, 0, 0.08, tone),
      );
    }
    return;
  }
}

/** DT2: a graffiti throw-up on the lowest dressable band of a street face
 * — a word in chunky pixel letters, two-tone paint over a dark outline. */
function graffiti(
  f: Face,
  rand: () => number,
  used: Rect[],
  out: DetailBox[],
  lights: DetailBox[],
): void {
  const word = pickTone(GRAFFITI_WORDS, rand());
  const toneA = pickTone(GRAFFITI_TONES, rand());
  const toneB = pickTone(GRAFFITI_TONES, rand());
  const cell = GRAFFITI_CELL;
  const wordW = wordCells(word) * cell;
  const base = DETAIL_MIN_Y + 0.25;
  const top = base + GLYPH_H * cell;
  if (top + GRAFFITI_OUTLINE > f.top - TOP_CLEAR) return;
  const half = wordW / 2 + GRAFFITI_OUTLINE;
  const room = f.length / 2 - half - 0.3;
  if (room <= 0) return;
  for (let tryIndex = 0; tryIndex < PLACE_TRIES; tryIndex++) {
    const mid = f.center + (rand() * 2 - 1) * room;
    const rect = {
      a0: mid - half - 0.2,
      a1: mid + half + 0.2,
      y0: DETAIL_MIN_Y,
      y1: top + GRAFFITI_OUTLINE + 0.2,
    };
    if (!clearOf(f, used, rect)) continue;
    f.taken.push(rect);
    used.push(rect);
    // The reader's right runs along −z on an x face facing +x, etc.
    const right = f.axis === "x" ? -f.dir : f.dir;
    for (const run of wordRuns(word)) {
      const a = mid + right * (-wordW / 2 + (run.col + run.len / 2) * cell);
      const y = base + (GLYPH_H - 1 - run.row + 0.5) * cell;
      const len = run.len * cell;
      out.push(
        boxOn(
          f,
          "graffiti",
          a,
          y,
          len + 2 * GRAFFITI_OUTLINE,
          cell + 2 * GRAFFITI_OUTLINE,
          0,
          GRAFFITI_OUTLINE_OUT,
          GRAFFITI_OUTLINE_TONE,
        ),
      );
      lights.push(
        boxOn(
          f,
          "graffiti",
          a,
          y,
          len,
          cell,
          GRAFFITI_OUTLINE_OUT,
          GRAFFITI_FILL_OUT,
          run.row < 2 ? toneA : toneB,
        ),
      );
    }
    return;
  }
}

/**
 * Deterministic facade detail for one building, from (world seed, building)
 * alone. GLASS curtain walls and landmarks stay clean; MASONRY gets fire
 * escapes, OFFICE towers rolled "residential" get balconies, both get AC
 * units, and buildings across a street from a crane get scaffolding.
 */
export function facadeDetailFor(b: Building, seed: number): FacadeDetail {
  const boxes: DetailBox[] = [];
  const lights: DetailBox[] = [];
  const arch = archetypeFor(b);
  if (arch === FacadeArchetype.GLASS) return { boxes, lights };
  const sign = signageFor(b, seed);
  const faces = facesOf(b, arch, [
    ...sign.marquees,
    ...sign.billboards,
    ...sign.strips,
  ]);
  if (faces.length === 0) return { boxes, lights };
  const ground = faces.filter((f) => f.tierIndex === 0);

  // Scaffolding first: it claims its stretch before anything else does.
  const { bx, bz } = blockOf({ x: b.x, y: 0, z: b.z });
  const scaffoldRand = stream(b, seed, 4);
  if (besideConstruction(bx, bz) && scaffoldRand() < SCAFFOLD_CHANCE) {
    const start = Math.floor(scaffoldRand() * ground.length);
    for (let i = 0; i < ground.length; i++) {
      const f = ground[(start + i) % ground.length] as Face;
      if (scaffold(f, scaffoldRand, boxes, lights)) break;
    }
  }

  let acChance = AC_CHANCE.office;
  if (arch === FacadeArchetype.MASONRY) {
    acChance = AC_CHANCE.masonry;
    const rand = stream(b, seed, 1);
    const wanted = rand() < SECOND_ESCAPE ? 2 : 1;
    const start = Math.floor(rand() * ground.length);
    let placed = 0;
    for (let i = 0; i < ground.length && placed < wanted; i++) {
      const f = ground[(start + i) % ground.length] as Face;
      if (f.taken.length > 0) continue;
      if (fireEscape(f, rand, boxes)) placed++;
    }
  } else {
    const rand = stream(b, seed, 2);
    if (b.height >= RESIDENTIAL_MIN_HEIGHT && rand() < RESIDENTIAL_CHANCE) {
      acChance = AC_CHANCE.residential;
      for (const f of faces) {
        if (f.taken.length === 0) balconies(f, rand, boxes, lights);
      }
    }
  }

  const acRand = stream(b, seed, 3);
  for (const f of faces) acUnits(f, acChance, acRand, boxes);

  // DT2, last and on their own streams, stepping around everything above:
  // ivy curtains down masonry tiers, graffiti on masonry street faces.
  if (arch === FacadeArchetype.MASONRY) {
    const ivyRand = stream(b, seed, 5);
    const paintRand = stream(b, seed, 6);
    for (const f of faces) {
      const used = occupied(f, [...boxes, ...lights]);
      const rIvy = ivyRand();
      const rPaint = paintRand();
      if (rIvy < IVY_CHANCE) ivy(f, ivyRand, used, boxes);
      if (f.tierIndex === 0 && rPaint < GRAFFITI_CHANCE) {
        graffiti(f, paintRand, used, boxes, lights);
      }
    }
  }
  return { boxes, lights };
}

// --- D8: what still stands ------------------------------------------------

/**
 * Building `index`'s facade detail as building-local boxes for the standing
 * filter: its boxes in facadeDetailFor order, then its work lights. Nothing
 * stands more than MAX_PROTRUSION off its facade, so every box is judged
 * whole (a scaffold pole the height of the street tier goes with the first
 * floor above it that falls).
 */
export function facadeDetailStandingLayer(
  buildings: readonly Building[],
  seed: number,
): StandingLayer {
  const cache = new Map<number, LocalBox[]>();
  return {
    boxes(index) {
      let out = cache.get(index);
      if (out) return out;
      const b = buildings[index] as Building;
      const d = facadeDetailFor(b, seed);
      out = [...d.boxes, ...d.lights].map((box) => {
        const { min, max } = detailBounds(box);
        const x = wrapDeltaAxis(b.x, box.x);
        const z = wrapDeltaAxis(b.z, box.z);
        return {
          x0: x + (min.x - box.x),
          x1: x + (max.x - box.x),
          y0: min.y,
          y1: max.y,
          z0: z + (min.z - box.z),
          z1: z + (max.z - box.z),
        };
      });
      cache.set(index, out);
      return out;
    },
  };
}

// --- Renderer: streamed per block, faded on the GPU ---

/** Distance fade (vertex shader, per instance): full size inside FADE_NEAR,
 * shrunk to nothing at FADE_FAR. The r = 2 block window always reaches at
 * least 2 · BLOCK_PITCH = 400 m from the camera, past FADE_FAR, so nothing
 * pops at the window's edge. */
const FADE_NEAR = 260;
const FADE_FAR = 380;
/** Highest a detail can sit (tallest OFFICE tower), plus slack — above
 * FADE_FAR + this the whole tier is past the fade and is not drawn. */
const DETAIL_TOP = 140;

const FADE_GLSL = /* glsl */ `#include <begin_vertex>
// L13: shrink each box into its own centre with distance (anchor = the
// instance translation, so a box fades as one piece).
float fdDist = distance((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz, cameraPosition);
transformed *= 1.0 - smoothstep(${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, fdDist);
`;

function withFade<M extends THREE.Material>(m: M): M {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      FADE_GLSL,
    );
  };
  m.customProgramCacheKey = () => "l13-facade-detail-fade";
  return m;
}

/** One block's precomputed instances (building frame, unshifted). */
interface BlockData {
  /** Block centre — the anchor its torus shift is computed from. */
  ax: number;
  az: number;
  boxCount: number;
  boxMatrices: Float32Array;
  boxColors: Float32Array;
  lightCount: number;
  lightMatrices: Float32Array;
  /** DT2: each light's linear colour, already lifted to its kind's rung. */
  lightColors: Float32Array;
  /** D8: the block's buildings, and where each one's boxes / lights start
   * in it (one past the last at the end) — a building's items are
   * contiguous, boxes then lights, in its StandingLayer order. */
  buildings: Int32Array;
  boxStart: Int32Array;
  lightStart: Int32Array;
}

/** Instanced facade detail: one lit box mesh + one work-light mesh. */
export class FacadeDetailRenderer {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly lightMesh: THREE.InstancedMesh;
  private readonly blocks = new Map<number, BlockData>();
  private lastBlock = -1;
  /** O3 quality tier: whether the detail is drawn at all. */
  private tierOn = true;
  /** D8: hides re-patch the streamed buffers in place. */
  private readonly standing: StandingMask;
  /** D8: each streamed building's first box / light slot and its block. */
  private readonly streamedBox = new Map<number, number>();
  private readonly streamedLight = new Map<number, number>();
  private readonly streamedBlock = new Map<number, BlockData>();
  private readonly blockOfBuilding: Int32Array;
  private readonly shiftOf = new Map<BlockData, { dx: number; dz: number }>();

  constructor(buildings: readonly Building[], seed: number) {
    this.standing = new StandingMask(
      buildings,
      facadeDetailStandingLayer(buildings, seed),
      (b) => this.patch(b),
    );
    this.blockOfBuilding = new Int32Array(buildings.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const color = new THREE.Color();
    const write = (box: DetailBox, out: Float32Array, i: number) => {
      e.set(
        box.axis === "x" ? -box.roll : 0,
        0,
        box.axis === "z" ? box.roll : 0,
      );
      q.setFromEuler(e);
      m.compose(p.set(box.x, box.y, box.z), q, s.set(box.sx, box.sy, box.sz));
      m.toArray(out, i * 16);
    };

    const perBlock = new Map<
      number,
      {
        boxes: DetailBox[];
        lights: DetailBox[];
        ids: number[];
        boxStart: number[];
        lightStart: number[];
      }
    >();
    buildings.forEach((b, i) => {
      const { bx, bz } = blockOf({ x: b.x, y: 0, z: b.z });
      const key = bx * CITY_GRID + bz;
      this.blockOfBuilding[i] = key;
      const entry = perBlock.get(key) ?? {
        boxes: [],
        lights: [],
        ids: [],
        boxStart: [],
        lightStart: [],
      };
      const detail = facadeDetailFor(b, seed);
      entry.ids.push(i);
      entry.boxStart.push(entry.boxes.length);
      entry.lightStart.push(entry.lights.length);
      entry.boxes.push(...detail.boxes);
      entry.lights.push(...detail.lights);
      perBlock.set(key, entry);
    });
    for (const [key, entry] of perBlock) {
      const { boxes, lights } = entry;
      const boxMatrices = new Float32Array(boxes.length * 16);
      const boxColors = new Float32Array(boxes.length * 3);
      boxes.forEach((box, i) => {
        write(box, boxMatrices, i);
        color.setHex(box.color).toArray(boxColors, i * 3);
      });
      const lightMatrices = new Float32Array(lights.length * 16);
      const lightColors = new Float32Array(lights.length * 3);
      lights.forEach((box, i) => {
        write(box, lightMatrices, i);
        color.setHex(box.color);
        color
          .multiplyScalar(emissiveBoost(color, lightLuminance(box.kind)))
          .toArray(lightColors, i * 3);
      });
      this.blocks.set(key, {
        ax: (Math.floor(key / CITY_GRID) + 0.5) * BLOCK_PITCH,
        az: ((key % CITY_GRID) + 0.5) * BLOCK_PITCH,
        boxCount: boxes.length,
        boxMatrices,
        boxColors,
        lightCount: lights.length,
        lightMatrices,
        lightColors,
        buildings: Int32Array.from(entry.ids),
        boxStart: Int32Array.from([...entry.boxStart, boxes.length]),
        lightStart: Int32Array.from([...entry.lightStart, lights.length]),
      });
    }

    // Exact capacity: the fullest (2r+1)² window over every camera block.
    let boxCap = 1;
    let lightCap = 1;
    for (let bx = 0; bx < CITY_GRID; bx++) {
      for (let bz = 0; bz < CITY_GRID; bz++) {
        const center = {
          x: (bx + 0.5) * BLOCK_PITCH,
          y: 0,
          z: (bz + 0.5) * BLOCK_PITCH,
        };
        let nb = 0;
        let nl = 0;
        for (const w of blockWindow(center)) {
          const d = this.blocks.get(w.bx * CITY_GRID + w.bz);
          nb += d?.boxCount ?? 0;
          nl += d?.lightCount ?? 0;
        }
        boxCap = Math.max(boxCap, nb);
        lightCap = Math.max(lightCap, nl);
      }
    }

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.InstancedMesh(
      geometry,
      withFade(
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
      ),
      boxCap,
    );
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(boxCap * 3),
      3,
    );
    // DT2: white × a per-instance colour lifted to each kind's rung (work
    // lights: WORK_LIGHT_COLOR at the SIGN rung, exactly as before).
    const lightMaterial = withFade(
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    this.lightMesh = new THREE.InstancedMesh(geometry, lightMaterial, lightCap);
    this.lightMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(lightCap * 3),
      3,
    );
    for (const mesh of [this.mesh, this.lightMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // instances move relative to the camera
      mesh.count = 0;
      this.group.add(mesh);
    }
  }

  /** Instances drawn right now — perf reporting/QA. */
  get instanceCount(): number {
    return this.mesh.count + this.lightMesh.count;
  }

  /** O3: Low drops the facade detail (dressing only — none of it is solid). */
  setQuality(tier: QualityTier): void {
    this.tierOn = QUALITY_PROFILES[tier].facadeDetail;
  }

  /**
   * Re-stream on block change only: the window's buildings are copied in
   * (precomputed matrices) and shifted to their torus image nearest the
   * window's centre block. Within one camera block every window block stays
   * well under WORLD_SIZE / 2 away, so its image cannot flip — nothing to do
   * per frame; the fade runs on the GPU.
   */
  update(cameraPos: Vec3, enabled = true): void {
    this.standing.update(); // D8: patches streamed buildings in place
    const visible =
      enabled && this.tierOn && cameraPos.y < FADE_FAR + DETAIL_TOP;
    this.mesh.visible = visible;
    this.lightMesh.visible = visible;
    if (!visible) return;
    const { bx, bz } = blockOf(cameraPos);
    const key = bx * CITY_GRID + bz;
    if (key === this.lastBlock) return;
    this.lastBlock = key;

    const center = {
      x: (bx + 0.5) * BLOCK_PITCH,
      y: 0,
      z: (bz + 0.5) * BLOCK_PITCH,
    };
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    const colors = this.mesh.instanceColor?.array as Float32Array;
    const lightMatrices = this.lightMesh.instanceMatrix.array as Float32Array;
    const lightColors = this.lightMesh.instanceColor?.array as Float32Array;
    let nb = 0;
    let nl = 0;
    this.streamedBox.clear();
    this.streamedLight.clear();
    this.streamedBlock.clear();
    for (const w of blockWindow(cameraPos)) {
      const d = this.blocks.get(w.bx * CITY_GRID + w.bz);
      if (!d) continue;
      const img = nearestImage(center, { x: d.ax, y: 0, z: d.az });
      const dx = img.x - d.ax;
      const dz = img.z - d.az;
      let shift = this.shiftOf.get(d);
      if (!shift) {
        shift = { dx, dz };
        this.shiftOf.set(d, shift);
      }
      shift.dx = dx;
      shift.dz = dz;
      for (let j = 0; j < d.buildings.length; j++) {
        const b = d.buildings[j] as number;
        this.streamedBox.set(b, nb + (d.boxStart[j] as number));
        this.streamedLight.set(b, nl + (d.lightStart[j] as number));
        this.streamedBlock.set(b, d);
      }
      matrices.set(d.boxMatrices, nb * 16);
      colors.set(d.boxColors, nb * 3);
      for (let i = nb; i < nb + d.boxCount; i++) {
        matrices[i * 16 + 12] = (matrices[i * 16 + 12] as number) + dx;
        matrices[i * 16 + 14] = (matrices[i * 16 + 14] as number) + dz;
      }
      lightMatrices.set(d.lightMatrices, nl * 16);
      lightColors.set(d.lightColors, nl * 3);
      for (let i = nl; i < nl + d.lightCount; i++) {
        lightMatrices[i * 16 + 12] =
          (lightMatrices[i * 16 + 12] as number) + dx;
        lightMatrices[i * 16 + 14] =
          (lightMatrices[i * 16 + 14] as number) + dz;
      }
      // D8: what no longer stands streams in hidden.
      for (let j = 0; j < d.buildings.length; j++) {
        if (this.standing.hiddenOf(d.buildings[j] as number)) {
          this.writeBuilding(d.buildings[j] as number, false);
        }
      }
      nb += d.boxCount;
      nl += d.lightCount;
    }
    this.mesh.count = nb;
    this.lightMesh.count = nl;
    for (const [attr, n, size] of [
      [this.mesh.instanceMatrix, nb, 16],
      [this.mesh.instanceColor, nb, 3],
      [this.lightMesh.instanceMatrix, nl, 16],
      [this.lightMesh.instanceColor, nl, 3],
    ] as const) {
      if (!attr) continue;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, n) * size);
      attr.needsUpdate = true;
    }
  }

  /** D8: building `b`'s standing flags changed — re-write its streamed
   * instances in place (nothing when it is outside the streamed window). */
  private patch(b: number): void {
    if (!this.streamedBlock.has(b)) return;
    this.writeBuilding(b, true);
  }

  /** Write building `b`'s streamed instances from its block's precomputed
   * matrices: shown ones as streamed, hidden ones as zero-scale. */
  private writeBuilding(b: number, upload: boolean): void {
    const d = this.streamedBlock.get(b);
    const at = this.streamedBox.get(b);
    const lightAt = this.streamedLight.get(b);
    const shift = d && this.shiftOf.get(d);
    if (!d || at === undefined || lightAt === undefined || !shift) return;
    const j = d.buildings.indexOf(b);
    const b0 = d.boxStart[j] as number;
    const b1 = d.boxStart[j + 1] as number;
    const l0 = d.lightStart[j] as number;
    const l1 = d.lightStart[j + 1] as number;
    const hidden = this.standing.hiddenOf(b);
    const put = (
      src: Float32Array,
      dst: Float32Array,
      from: number,
      to: number,
      slot: number,
      k0: number,
    ) => {
      for (let i = from; i < to; i++) {
        const o = (slot + i - from) * 16;
        if (hidden?.[k0 + i - from]) {
          dst.fill(0, o, o + 16);
          continue;
        }
        for (let e = 0; e < 16; e++) dst[o + e] = src[i * 16 + e] as number;
        dst[o + 12] = (dst[o + 12] as number) + shift.dx;
        dst[o + 14] = (dst[o + 14] as number) + shift.dz;
      }
    };
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    const lightMatrices = this.lightMesh.instanceMatrix.array as Float32Array;
    put(d.boxMatrices, matrices, b0, b1, at, 0);
    put(d.lightMatrices, lightMatrices, l0, l1, lightAt, b1 - b0);
    if (!upload) return;
    for (const [attr, from, n] of [
      [this.mesh.instanceMatrix, at, b1 - b0],
      [this.lightMesh.instanceMatrix, lightAt, l1 - l0],
    ] as const) {
      if (n <= 0) continue;
      attr.addUpdateRange(from * 16, n * 16);
      attr.needsUpdate = true;
    }
  }
}
