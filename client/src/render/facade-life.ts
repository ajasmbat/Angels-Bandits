// A1 facade life (client-only dressing): laundry lines strung along masonry
// walls, flags on angled poles and blade banners on some facades, and
// pigeons on parapet lips and entrance canopies that burst off a ledge when
// a plane passes and settle back.
//
// Layout is pure and per building (facadeLifeFor): deterministic from the
// building's own position and dimensions via salted mulberry32 streams —
// never Math.random, never a torus image — so every client dresses the same
// walls. Everything is placed on the DRAWN window grid's bays and steps
// around the L13 boxes and the S2 signs of the same face.
//
// NON-COLLIDABLE by the plan's facade-garnish rule: every laundry line, pole,
// banner and garment stays within MAX_PROTRUSION (1.5 m) of its own facade
// plane and above DETAIL_MIN_Y, and nothing spans a street — each item hangs
// off ONE face, inside that face's length (tested).
//
// The renderer is ONE draw call: a baked whole-city mesh whose vertices carry
// their item's canonical pivot, placed at the torus image nearest the camera
// in the vertex shader (the rooftop-life idiom), animated on the synced clock
// (cloth sways in the shared wind) and, for pigeons, by the shared pass
// uniforms (lookup.ts) — so nothing is uploaded per frame but uniforms.

import {
  type Building,
  type LocalBox,
  STAND_OUT,
  mulberry32,
} from "@angels-bandits/common/city";
import { facadeClearances } from "@angels-bandits/common/city/street";
import {
  wrapCoord,
  wrapDelta,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import {
  DETAIL_MIN_Y,
  type DetailBox,
  MAX_PROTRUSION,
  facadeDetailFor,
} from "./facade-detail";
import {
  CANOPY_THICKNESS,
  CANOPY_Y,
  PARAPET_HEIGHT,
  facadeGarnishFor,
} from "./facade-garnish";
import { FLUTTER_SETTLE_S, LOOK_GLSL_PARS, W_GLSL, lookPasses } from "./lookup";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { CYCLES_PER_LOOP, loopPhase } from "./rooftop-life";
import { signageFor } from "./signage";
import { BakedHider, type StandingLayer, StandingMask } from "./standing-watch";
import { pitchSeed, windowPitch } from "./window-pattern";

// --- Layout rules ----------------------------------------------------------

/** Faces with less sidewalk than this are party walls (L13's rule). */
const MIN_FACE_CLEARANCE = 1.2;
/** Laundry: share of masonry street faces with a line, lines per face. */
export const LAUNDRY_FACE_CHANCE = 0.45;
const LAUNDRY_LINES_MAX = 2;
/** How far the line runs off the wall, meters (well inside 1.5). */
export const LAUNDRY_OUT = 0.85;
/** Garments hang at most this far below the line, meters. */
const GARMENT_MAX_DROP = 0.95;
/** Highest a laundry line goes, meters. */
const LAUNDRY_MAX_Y = 34;
/** Flag poles: share of non-glass street faces, pole reach and angle. */
export const FLAG_FACE_CHANCE = 0.1;
export const FLAG_REACH = 1.4;
const FLAG_ELEVATION = Math.PI / 6;
/** Blade banners: share of tall-enough faces, blade span off the wall. */
export const BANNER_FACE_CHANCE = 0.08;
const BANNER_MIN_HEIGHT = 24;
const BANNER_IN = 0.35;
const BANNER_OUT = 1.3;
/** Pigeons: share of buildings with a flock on a parapet / on the canopy. */
export const PIGEON_PARAPET_CHANCE = 0.25;
export const PIGEON_CANOPY_CHANCE = 0.2;
/** Clearance kept from L13 boxes and signs on the same face, meters. */
const MARGIN = 0.35;

const GARMENT_COLORS = [
  0xe8e4da, 0xd9cfb8, 0x8fb3d9, 0x3f5f8f, 0xb5524a, 0xe0c060, 0xd99aa5,
  0x6f9a6a, 0x9a9a9a,
] as const;
const FLAG_COLORS = [
  0xc8102e, 0xffffff, 0x0033a0, 0xffcd00, 0x009a44, 0x00a3e0, 0xff6a13,
] as const;
const BANNER_COLORS = [0x7a1f2b, 0x135e63, 0x1f2f5c, 0xb08a2a, 0x4d2a6b];
const IRON = 0x2f2c2b;
const PIGEON = 0x6b7280;
const PIGEON_WING = 0x58606c;

/** A facade of one tier: outward axis/direction, plane, centre and extent. */
interface Face {
  axis: "x" | "z";
  dir: -1 | 1;
  plane: number;
  center: number;
  length: number;
  base: number;
  top: number;
  px: number;
  py: number;
  /** Occupied rects on the face (along a0..a1, height y0..y1). */
  taken: { a0: number; a1: number; y0: number; y1: number }[];
}

export interface LaundryLine {
  axis: "x" | "z";
  dir: -1 | 1;
  plane: number;
  a0: number;
  a1: number;
  y: number;
  garments: { a: number; w: number; h: number; color: number }[];
}

export interface FacadeFlag {
  axis: "x" | "z";
  dir: -1 | 1;
  plane: number;
  along: number;
  y: number;
  /** Three vertical stripes. */
  stripes: [number, number, number];
}

export interface Banner {
  axis: "x" | "z";
  dir: -1 | 1;
  plane: number;
  along: number;
  y0: number;
  y1: number;
  color: number;
  trim: number;
}

export interface Pigeon {
  x: number;
  y: number;
  z: number;
  yaw: number;
  phase: number;
}

export interface FacadeLife {
  laundry: LaundryLine[];
  flags: FacadeFlag[];
  banners: Banner[];
  pigeons: Pigeon[];
}

/** Per-building PRNG stream, salted per feature (facade-detail's idiom with
 * its own salts, so these never correlate with an L13 roll). */
function stream(b: Building, seed: number, salt: number): () => number {
  return mulberry32(
    (seed ^
      Math.imul(b.x | 0, 0x2f6b9a5d) ^
      Math.imul(b.z | 0, 0x58e2b3c1) ^
      Math.imul(Math.round(b.height * 16), 0x1b873593) ^
      Math.imul(salt + 40, 0x9e3779b9)) >>>
      0,
  );
}

/** Ground-tier street faces (never a party wall, never a holed axis), with
 * the L13 boxes and S2 signs on them pre-marked as taken. */
function streetFaces(b: Building, seed: number): Face[] {
  const t0 = b.tiers[0];
  if (!t0) return [];
  const arch = archetypeFor(b);
  const clearance = facadeClearances(b.x, b.z, t0.width, t0.depth);
  const [px, py] = windowPitch(arch, pitchSeed(t0.width, t0.height, t0.depth));
  const holed = new Set(
    (b.holes ?? []).filter((h) => h.tierIndex === 0).map((h) => h.axis),
  );
  const detail = facadeDetailFor(b, seed);
  const sign = signageFor(b, seed);
  const signs = [...sign.marquees, ...sign.billboards, ...sign.strips];
  const faces: Face[] = [];
  for (const axis of ["x", "z"] as const) {
    if (holed.has(axis)) continue;
    const length = axis === "x" ? t0.depth : t0.width;
    for (const dir of [-1, 1] as const) {
      if (clearance[`${axis}${dir < 0 ? 0 : 1}`] < MIN_FACE_CLEARANCE) continue;
      const plane =
        (axis === "x" ? b.x : b.z) +
        (dir * (axis === "x" ? t0.width : t0.depth)) / 2;
      const center = axis === "x" ? b.z : b.x;
      const taken: Face["taken"] = [];
      for (const box of [...detail.boxes, ...detail.lights]) {
        if (box.axis !== axis || box.dir !== dir) continue;
        if (Math.abs(box.plane - plane) > 0.01) continue;
        taken.push(boxRect(box));
      }
      for (const s of signs) {
        if (s.axis !== axis || s.dir !== dir) continue;
        const d = wrapDelta({ x: b.x, y: 0, z: b.z }, { x: s.x, y: 0, z: s.z });
        const along = center + (axis === "x" ? d.z : d.x);
        taken.push({
          a0: along - s.width / 2,
          a1: along + s.width / 2,
          y0: s.y,
          y1: s.y + s.height,
        });
      }
      faces.push({
        axis,
        dir,
        plane,
        center,
        length,
        base: 0,
        top: t0.height,
        px,
        py,
        taken,
      });
    }
  }
  return faces;
}

const boxRect = (box: DetailBox) => {
  const along = box.axis === "x" ? box.z : box.x;
  const size = box.axis === "x" ? box.sz : box.sx;
  // A rolled box (a stair flight) grows vertically; take its diagonal.
  const half = Math.max(size, Math.hypot(size, box.sy)) / 2;
  return {
    a0: along - half,
    a1: along + half,
    y0: box.y - Math.hypot(size, box.sy) / 2,
    y1: box.y + Math.hypot(size, box.sy) / 2,
  };
};

const free = (
  f: Face,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
): boolean =>
  a0 >= f.center - f.length / 2 + 0.3 &&
  a1 <= f.center + f.length / 2 - 0.3 &&
  f.taken.every(
    (t) =>
      a1 + MARGIN <= t.a0 ||
      a0 - MARGIN >= t.a1 ||
      y1 + MARGIN <= t.y0 ||
      y0 - MARGIN >= t.y1,
  );

function laundryOn(f: Face, rand: () => number, out: LaundryLine[]): void {
  const lines = 1 + Math.floor(rand() * LAUNDRY_LINES_MAX);
  for (let l = 0; l < lines; l++) {
    // Fixed draws per attempt, whatever happens.
    const kRoll = rand();
    const bayRoll = rand();
    const spanRoll = rand();
    const gRand = mulberry32((rand() * 4294967296) >>> 0);
    const bays = 2 + Math.floor(spanRoll * 3);
    const nMin = Math.ceil(-f.length / 2 / f.px);
    const nMax = Math.floor(f.length / 2 / f.px) - bays;
    if (nMax < nMin) continue;
    const kLo = Math.ceil((DETAIL_MIN_Y + GARMENT_MAX_DROP + 0.4) / f.py);
    const kHi = Math.floor(
      (Math.min(f.top - 1.5, LAUNDRY_MAX_Y) + 0.15) / f.py,
    );
    if (kHi < kLo) continue;
    const k = kLo + Math.floor(kRoll * (kHi - kLo + 1));
    const y = k * f.py - 0.15;
    const n = nMin + Math.floor(bayRoll * (nMax - nMin + 1));
    const a0 = f.center + n * f.px;
    const a1 = a0 + bays * f.px;
    if (!free(f, a0, a1, y - GARMENT_MAX_DROP, y + 0.1)) continue;
    f.taken.push({ a0, a1, y0: y - GARMENT_MAX_DROP, y1: y + 0.1 });
    const garments: LaundryLine["garments"] = [];
    let a = a0 + 0.35;
    for (let g = 0; g < 16; g++) {
      const w = 0.3 + gRand() * 0.55;
      const h = 0.35 + gRand() * (GARMENT_MAX_DROP - 0.35);
      const gap = 0.1 + gRand() * 0.3;
      const color = GARMENT_COLORS[
        Math.floor(gRand() * GARMENT_COLORS.length)
      ] as number;
      const skip = gRand() < 0.15;
      if (a + w > a1 - 0.35) break;
      if (!skip) garments.push({ a: a + w / 2, w, h, color });
      a += w + gap;
    }
    out.push({ axis: f.axis, dir: f.dir, plane: f.plane, a0, a1, y, garments });
  }
}

/**
 * Laundry, facade flags, banners and pigeons for one building. Pure.
 */
export function facadeLifeFor(b: Building, seed: number): FacadeLife {
  const life: FacadeLife = { laundry: [], flags: [], banners: [], pigeons: [] };
  const arch = archetypeFor(b);
  const faces = arch === FacadeArchetype.GLASS ? [] : streetFaces(b, seed);

  if (arch === FacadeArchetype.MASONRY) {
    const rand = stream(b, seed, 1);
    for (const f of faces) {
      const roll = rand();
      const sub = mulberry32((rand() * 4294967296) >>> 0);
      if (roll < LAUNDRY_FACE_CHANCE) laundryOn(f, sub, life.laundry);
    }
  }

  const flagRand = stream(b, seed, 2);
  for (const f of faces) {
    const roll = flagRand();
    const bay = flagRand();
    const s0 = flagRand();
    const s1 = flagRand();
    const s2 = flagRand();
    if (roll >= FLAG_FACE_CHANCE) continue;
    const y = Math.max(DETAIL_MIN_Y + 0.6, 6.4);
    if (y + 1.6 > f.top - 0.5) continue;
    const nMin = Math.ceil(-f.length / 2 / f.px);
    const nMax = Math.floor(f.length / 2 / f.px) - 1;
    const n = nMin + Math.floor(bay * (nMax - nMin + 1));
    const along = f.center + (n + 0.5) * f.px;
    if (!free(f, along - 0.9, along + 0.9, y - 0.8, y + 1.0)) continue;
    f.taken.push({ a0: along - 0.9, a1: along + 0.9, y0: y - 0.8, y1: y + 1 });
    const pick = (r: number) =>
      FLAG_COLORS[Math.floor(r * FLAG_COLORS.length)] as number;
    life.flags.push({
      axis: f.axis,
      dir: f.dir,
      plane: f.plane,
      along,
      y,
      stripes: [pick(s0), pick(s1), pick(s2)],
    });
  }

  const bannerRand = stream(b, seed, 3);
  for (const f of faces) {
    const roll = bannerRand();
    const hRoll = bannerRand();
    const cRoll = bannerRand();
    if (roll >= BANNER_FACE_CHANCE || f.top < BANNER_MIN_HEIGHT) continue;
    const y0 = 8;
    const y1 = Math.min(y0 + 3.5 + hRoll * 1.5, f.top - 1);
    const color = BANNER_COLORS[
      Math.floor(cRoll * BANNER_COLORS.length)
    ] as number;
    for (const end of [-1, 1]) {
      const along = f.center + end * (f.length / 2 - 1.6);
      if (!free(f, along - 0.3, along + 0.3, y0 - 0.2, y1 + 0.2)) continue;
      f.taken.push({
        a0: along - 0.3,
        a1: along + 0.3,
        y0: y0 - 0.2,
        y1: y1 + 0.2,
      });
      life.banners.push({
        axis: f.axis,
        dir: f.dir,
        plane: f.plane,
        along,
        y0,
        y1,
        color,
        trim: 0xd9cfb8,
      });
    }
  }

  pigeonsOn(b, life.pigeons);
  return life;
}

/** A flock along one parapet lip, and a few on the entrance canopy. */
function pigeonsOn(b: Building, out: Pigeon[]): void {
  const rand = mulberry32(
    (Math.imul(b.x | 0, 0x7feb352d) ^
      Math.imul(b.z | 0, 0x846ca68b) ^
      Math.imul(Math.round(b.height), 0x5bd1e995) ^
      0x9161) >>>
      0,
  );
  const g = facadeGarnishFor(b);
  const rLip = rand();
  const which = rand();
  const size = rand();
  const along = rand();
  const rCanopy = rand();
  const cSize = rand();
  const flock = mulberry32((rand() * 4294967296) >>> 0);
  const perch = (
    x: number,
    y: number,
    z: number,
    longX: boolean,
    span: number,
    n: number,
    at: number,
  ) => {
    let s = at;
    for (let i = 0; i < n; i++) {
      const gap = 0.3 + flock() * 0.3;
      const face = flock() < 0.5 ? 1 : -1;
      const jitter = (flock() - 0.5) * 0.5;
      const phase = flock();
      if (Math.abs(s) > span / 2 - 0.2) break;
      out.push({
        x: wrapCoord(longX ? x + s : x),
        y,
        z: wrapCoord(longX ? z : z + s),
        yaw: (longX ? 0 : Math.PI / 2) + (face > 0 ? 0 : Math.PI) + jitter,
        phase,
      });
      s += gap;
    }
  };
  if (rLip < PIGEON_PARAPET_CHANCE && g.parapets.length > 0) {
    const lip = g.parapets[
      Math.floor(which * g.parapets.length)
    ] as (typeof g.parapets)[number];
    const longX = lip.width >= lip.depth;
    const span = longX ? lip.width : lip.depth;
    perch(
      lip.x,
      lip.y + PARAPET_HEIGHT,
      lip.z,
      longX,
      span,
      3 + Math.floor(size * 5),
      (along - 0.5) * (span - 4),
    );
  }
  if (rCanopy < PIGEON_CANOPY_CHANCE && g.canopy) {
    const c = g.canopy;
    const longX = c.sizeX >= c.sizeZ;
    const span = longX ? c.sizeX : c.sizeZ;
    perch(
      c.x,
      CANOPY_Y + CANOPY_THICKNESS,
      c.z,
      longX,
      span,
      2 + Math.floor(cSize * 4),
      -span / 4,
    );
  }
}

// --- Geometry bounds (the tests' contract) -----------------------------------

/** How far an item stands off its facade plane at most, and its lowest point. */
export function itemExtent(item: LaundryLine | FacadeFlag | Banner): {
  out: number;
  low: number;
  a0: number;
  a1: number;
} {
  if ("garments" in item) {
    return {
      out: LAUNDRY_OUT + CLOTH_SWAY,
      low: item.y - Math.max(0, ...item.garments.map((g) => g.h)),
      a0: item.a0,
      a1: item.a1,
    };
  }
  if ("stripes" in item) {
    return {
      out: FLAG_REACH,
      low: item.y - 0.05,
      a0: item.along - 0.1,
      a1: item.along + 0.1,
    };
  }
  return {
    out: BANNER_OUT + 0.02,
    low: item.y0,
    a0: item.along - 0.05,
    a1: item.along + 0.05,
  };
}

// --- D8: what still stands --------------------------------------------------

/** How many items a building's life bakes (laundry, flags, banners,
 * pigeons — the bake's and the standing layer's item order). */
const itemCount = (life: FacadeLife): number =>
  life.laundry.length +
  life.flags.length +
  life.banners.length +
  life.pigeons.length;

/**
 * Building `b`'s facade life as building-local boxes, in bake order. A
 * pigeon on an entrance canopy can sit further out than STAND_OUT; it is
 * judged by its anchor, pulled back to STAND_OUT off the tier-1 wall.
 */
export function facadeLifeBoxes(b: Building, life: FacadeLife): LocalBox[] {
  const out: LocalBox[] = [];
  // A facade item: `out0..out1` off plane `plane`, along `a0..a1`.
  const onFace = (
    axis: "x" | "z",
    dir: -1 | 1,
    plane: number,
    a0: number,
    a1: number,
    y0: number,
    y1: number,
    reach: number,
  ) => {
    const n0 = wrapDeltaAxis(axis === "x" ? b.x : b.z, plane);
    const n1 = n0 + dir * reach;
    const l0 = wrapDeltaAxis(axis === "x" ? b.z : b.x, a0);
    const l1 = l0 + (a1 - a0);
    const lo = Math.min(n0, n1);
    const hi = Math.max(n0, n1);
    out.push(
      axis === "x"
        ? { x0: lo, x1: hi, y0, y1, z0: l0, z1: l1 }
        : { x0: l0, x1: l1, y0, y1, z0: lo, z1: hi },
    );
  };
  for (const l of life.laundry) {
    const e = itemExtent(l);
    onFace(l.axis, l.dir, l.plane, l.a0, l.a1, e.low, l.y + 0.1, e.out);
  }
  const rise = FLAG_REACH * Math.tan(FLAG_ELEVATION);
  for (const f of life.flags) {
    const e = itemExtent(f);
    onFace(f.axis, f.dir, f.plane, e.a0, e.a1, f.y - 0.8, f.y + rise, e.out);
  }
  for (const bn of life.banners) {
    const e = itemExtent(bn);
    onFace(bn.axis, bn.dir, bn.plane, e.a0, e.a1, bn.y0, bn.y1, e.out);
  }
  const hw = b.width / 2 + STAND_OUT;
  const hd = b.depth / 2 + STAND_OUT;
  for (const pg of life.pigeons) {
    const x = Math.max(-hw, Math.min(hw, wrapDeltaAxis(b.x, pg.x)));
    const z = Math.max(-hd, Math.min(hd, wrapDeltaAxis(b.z, pg.z)));
    out.push({
      x0: x - 0.2,
      x1: x + 0.2,
      y0: pg.y,
      y1: pg.y + 0.2,
      z0: z - 0.2,
      z1: z + 0.2,
    });
  }
  return out;
}

/** The standing layer over every building's facade life. */
export function facadeLifeStandingLayer(
  buildings: readonly Building[],
  seed: number,
): StandingLayer {
  const cache = new Map<number, LocalBox[]>();
  return {
    boxes(index) {
      let out = cache.get(index);
      if (!out) {
        const b = buildings[index] as Building;
        out = facadeLifeBoxes(b, facadeLifeFor(b, seed));
        cache.set(index, out);
      }
      return out;
    },
  };
}

// --- Baking --------------------------------------------------------------------

/** Animation tags (aAnim.x). */
const Part = { STATIC: 0, LAUNDRY: 1, FLAG: 2, PIGEON: 3, WING: 4 } as const;
/** Fold distances: an item this far from the camera collapses to its pivot. */
const FOLD_CLOTH = 420;
const FOLD_PIGEON = 150;
/** Laundry sways at most this far off its line, meters. */
const CLOTH_SWAY = 0.12;

export interface BakedFacadeLife {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  pivots: Float32Array;
  anims: Float32Array;
  vertexCount: number;
  /** D8: item i's vertices are starts[i]..starts[i + 1] (items in
   * facadeLifeBoxes order, building after building). */
  starts: Int32Array;
}

class Baker {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly c: number[] = [];
  readonly pv: number[] = [];
  readonly an: number[] = [];
  pivot = { x: 0, y: 0, z: 0, fold: FOLD_CLOTH };
  private readonly color = new THREE.Color();

  private vert(
    x: number,
    y: number,
    z: number,
    n: readonly number[],
    hex: number,
    anim: readonly number[],
  ) {
    this.p.push(x, y, z);
    this.n.push(n[0] ?? 0, n[1] ?? 1, n[2] ?? 0);
    this.color.setHex(hex);
    this.c.push(this.color.r, this.color.g, this.color.b);
    const { x: px, y: py, z: pz, fold } = this.pivot;
    this.pv.push(px, py, pz, fold);
    this.an.push(anim[0] ?? 0, anim[1] ?? 0, anim[2] ?? 0, anim[3] ?? 0);
  }

  /** One vertex, pivot-local. */
  vertex(
    v: readonly number[],
    n: readonly number[],
    hex: number,
    anim: readonly number[],
  ): void {
    this.vert(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, n, hex, anim);
  }

  /** Any geometry, already pivot-local (disposed here). */
  geom(
    g: THREE.BufferGeometry,
    hex: number,
    anim: readonly number[] = [Part.STATIC, 0, 0, 0],
  ): void {
    const flat = g.index ? g.toNonIndexed() : g;
    const pos = flat.getAttribute("position");
    const nor = flat.getAttribute("normal");
    for (let i = 0; i < pos.count; i++) {
      this.vert(
        pos.getX(i),
        pos.getY(i),
        pos.getZ(i),
        [nor.getX(i), nor.getY(i), nor.getZ(i)],
        hex,
        anim,
      );
    }
    if (flat !== g) flat.dispose();
    g.dispose();
  }

  /** A quad (two triangles), corners in pivot-local meters, CCW. */
  quad(
    corners: readonly (readonly [number, number, number])[],
    normal: readonly number[],
    hex: number,
    anims: readonly (readonly number[])[],
  ): void {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const c = corners[i] as readonly [number, number, number];
      this.vert(c[0], c[1], c[2], normal, hex, anims[i] ?? [0, 0, 0, 0]);
    }
  }

  /** An axis-aligned box, pivot-local centre and size. */
  box(
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    hex: number,
    anim: readonly number[] = [Part.STATIC, 0, 0, 0],
  ): void {
    const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    for (let i = 0; i < pos.count; i++) {
      this.vert(
        pos.getX(i) + cx,
        pos.getY(i) + cy,
        pos.getZ(i) + cz,
        [nor.getX(i), nor.getY(i), nor.getZ(i)],
        hex,
        anim,
      );
    }
    g.dispose();
  }
}

/** Facade frame → pivot-local offset: `out` meters off the wall, `along`
 * meters along it (relative to the pivot's along), `y` up. */
const local = (
  axis: "x" | "z",
  dir: -1 | 1,
  out: number,
  along: number,
  y: number,
): [number, number, number] =>
  axis === "x" ? [dir * out, y, along] : [along, y, dir * out];

export function bakeFacadeLife(lives: readonly FacadeLife[]): BakedFacadeLife {
  const k = new Baker();
  const starts: number[] = [];
  const mark = () => starts.push(k.p.length / 3);
  for (const life of lives) {
    for (const line of life.laundry) {
      mark();
      const mid = (line.a0 + line.a1) / 2;
      const half = (line.a1 - line.a0) / 2;
      const [px, , pz] = local(line.axis, line.dir, 0, mid, 0);
      const onX = line.axis === "x";
      k.pivot = {
        x: wrapCoord(onX ? line.plane + px : mid),
        y: line.y,
        z: wrapCoord(onX ? mid : line.plane + pz),
        fold: FOLD_CLOTH,
      };
      const outAngle = onX ? Math.atan2(0, line.dir) : Math.atan2(line.dir, 0);
      const outN = local(line.axis, line.dir, 1, 0, 0);
      // The line itself and its two wall brackets.
      const c = local(line.axis, line.dir, LAUNDRY_OUT, 0, 0);
      k.box(
        c[0],
        c[1],
        c[2],
        onX ? 0.025 : half * 2,
        0.025,
        onX ? half * 2 : 0.025,
        IRON,
      );
      for (const end of [-1, 1]) {
        const b = local(line.axis, line.dir, LAUNDRY_OUT / 2, end * half, 0);
        k.box(
          b[0],
          b[1],
          b[2],
          onX ? LAUNDRY_OUT : 0.04,
          0.04,
          onX ? 0.04 : LAUNDRY_OUT,
          IRON,
        );
      }
      for (const g of line.garments) {
        const a = g.a - mid;
        const tl = local(line.axis, line.dir, LAUNDRY_OUT, a - g.w / 2, 0);
        const tr = local(line.axis, line.dir, LAUNDRY_OUT, a + g.w / 2, 0);
        const br = local(line.axis, line.dir, LAUNDRY_OUT, a + g.w / 2, -g.h);
        const bl = local(line.axis, line.dir, LAUNDRY_OUT, a - g.w / 2, -g.h);
        const phase = (g.a * 0.37) % 1;
        const top = [Part.LAUNDRY, phase, 0, outAngle];
        const hem = [Part.LAUNDRY, phase, 1, outAngle];
        k.quad([tl, bl, br, tr], outN, g.color, [top, hem, hem, top]);
      }
    }
    for (const f of life.flags) {
      mark();
      const onX = f.axis === "x";
      k.pivot = {
        x: wrapCoord(onX ? f.plane : f.along),
        y: f.y,
        z: wrapCoord(onX ? f.along : f.plane),
        fold: FOLD_CLOTH,
      };
      // The pole: from the wall, out and up at FLAG_ELEVATION.
      const len = FLAG_REACH / Math.cos(FLAG_ELEVATION);
      const ps = (s: number) =>
        local(
          f.axis,
          f.dir,
          s * Math.cos(FLAG_ELEVATION),
          0,
          s * Math.sin(FLAG_ELEVATION),
        );
      const tip = ps(len);
      const pole = new THREE.BoxGeometry(0.05, 0.05, len);
      pole.applyQuaternion(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(tip[0], tip[1], tip[2]).normalize(),
        ),
      );
      pole.translate(tip[0] / 2, tip[1] / 2, tip[2] / 2);
      k.geom(pole, IRON);
      // The cloth hangs from the pole's outer two thirds, in three stripes.
      const clothN = onX ? [0, 0, 1] : [1, 0, 0];
      const clothAngle = onX ? Math.atan2(1, 0) : Math.atan2(0, 1);
      const s0 = len * 0.3;
      const s1 = len;
      const drop = 0.75;
      for (let i = 0; i < 3; i++) {
        const a = s0 + ((s1 - s0) * i) / 3;
        const b = s0 + ((s1 - s0) * (i + 1)) / 3;
        const ua = (a - s0) / (s1 - s0);
        const ub = (b - s0) / (s1 - s0);
        const ta = ps(a);
        const tb = ps(b);
        const ba: [number, number, number] = [ta[0], ta[1] - drop, ta[2]];
        const bb: [number, number, number] = [tb[0], tb[1] - drop, tb[2]];
        const phase = (f.along * 0.21) % 1;
        k.quad([ta, ba, bb, tb], clothN, f.stripes[i] as number, [
          [Part.FLAG, phase, ua, clothAngle],
          [Part.FLAG, phase, ua, clothAngle],
          [Part.FLAG, phase, ub, clothAngle],
          [Part.FLAG, phase, ub, clothAngle],
        ]);
      }
    }
    for (const bn of life.banners) {
      mark();
      const onX = bn.axis === "x";
      k.pivot = {
        x: wrapCoord(onX ? bn.plane : bn.along),
        y: bn.y0,
        z: wrapCoord(onX ? bn.along : bn.plane),
        fold: FOLD_CLOTH,
      };
      const h = bn.y1 - bn.y0;
      for (const y of [0, h]) {
        const c = local(bn.axis, bn.dir, (BANNER_OUT + 0.02) / 2, 0, y);
        k.box(
          c[0],
          c[1],
          c[2],
          onX ? BANNER_OUT + 0.02 : 0.04,
          0.04,
          onX ? 0.04 : BANNER_OUT + 0.02,
          IRON,
        );
      }
      const clothN = onX ? [0, 0, 1] : [1, 0, 0];
      const clothAngle = onX ? Math.atan2(1, 0) : Math.atan2(0, 1);
      const phase = (bn.along * 0.13) % 1;
      const seg = (y0: number, y1: number, color: number) => {
        const a = local(bn.axis, bn.dir, BANNER_IN, 0, y1);
        const b = local(bn.axis, bn.dir, BANNER_IN, 0, y0);
        const c = local(bn.axis, bn.dir, BANNER_OUT, 0, y0);
        const d = local(bn.axis, bn.dir, BANNER_OUT, 0, y1);
        const an = [Part.FLAG, phase, 0.25, clothAngle];
        const ao = [Part.FLAG, phase, 0.6, clothAngle];
        k.quad([a, b, c, d], clothN, color, [an, an, ao, ao]);
      };
      seg(0.04, h * 0.12, bn.trim);
      seg(h * 0.12, h * 0.96, bn.color);
    }
    for (const pg of life.pigeons) {
      mark();
      k.pivot = { x: pg.x, y: pg.y, z: pg.z, fold: FOLD_PIGEON };
      const c = Math.cos(pg.yaw);
      const s = Math.sin(pg.yaw);
      // Body + head as one box along the bird's heading; two flat wings.
      const rot = (
        x: number,
        y: number,
        z: number,
      ): [number, number, number] => [x * c + z * s, y, -x * s + z * c];
      const g = new THREE.BoxGeometry(0.13, 0.12, 0.3).toNonIndexed();
      g.translate(0, 0.08, 0.02);
      const pos = g.getAttribute("position");
      const nor = g.getAttribute("normal");
      for (let i = 0; i < pos.count; i++) {
        const v = rot(pos.getX(i), pos.getY(i), pos.getZ(i));
        const nn = rot(nor.getX(i), nor.getY(i), nor.getZ(i));
        k.vertex(v, nn, PIGEON, [Part.PIGEON, pg.phase, 0, 0]);
      }
      g.dispose();
      for (const side of [-1, 1]) {
        const a = rot(side * 0.06, 0.11, 0.08);
        const b = rot(side * 0.3, 0.11, 0.04);
        const cc = rot(side * 0.3, 0.11, -0.08);
        const d = rot(side * 0.06, 0.11, -0.1);
        const an = [Part.WING, pg.phase, 0, side];
        const tip = [Part.WING, pg.phase, 1, side];
        k.quad([a, b, cc, d], [0, 1, 0], PIGEON_WING, [an, tip, tip, an]);
      }
    }
  }
  mark();
  return {
    positions: new Float32Array(k.p),
    normals: new Float32Array(k.n),
    colors: new Float32Array(k.c),
    pivots: new Float32Array(k.pv),
    anims: new Float32Array(k.an),
    vertexCount: k.p.length / 3,
    starts: Int32Array.from(starts),
  };
}

// --- Shader --------------------------------------------------------------------

const TAU = "6.28318530718";
const glsl = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

const VERTEX_PARS = /* glsl */ `
uniform float uLoop;
attribute vec4 aPivot;
attribute vec4 aAnim;
${LOOK_GLSL_PARS}
`;

const BEGIN_VERTEX = /* glsl */ `
float abPart = aAnim.x;
vec3 abPivot = aPivot.xyz;
abPivot.xz += floor((cameraPosition.xz - abPivot.xz) / ${W_GLSL} + 0.5) * ${W_GLSL};
float abGust = 0.75 + 0.25 * sin(${TAU} * uLoop * 7.0 + abPivot.x * 0.013 + abPivot.z * 0.017);
if (abPart > 0.5 && abPart < 1.5) {
  // Laundry: swings off the wall, more at the hem.
  float u = aAnim.z;
  float ph = ${TAU} * (uLoop * ${CYCLES_PER_LOOP.sway}.0 * 0.5 + aAnim.y);
  float sw = ${glsl(CLOTH_SWAY)} * u * abGust * (0.55 + 0.45 * sin(ph));
  transformed.xz += vec2(cos(aAnim.w), sin(aAnim.w)) * sw;
} else if (abPart > 1.5 && abPart < 2.5) {
  // Flags and banners: a travelling wave across the cloth.
  float u = aAnim.z;
  float ph = ${TAU} * (uLoop * ${CYCLES_PER_LOOP.flag}.0 + aAnim.y) - u * 3.2;
  transformed.xz += vec2(cos(aAnim.w), sin(aAnim.w)) * 0.09 * u * abGust * sin(ph);
} else if (abPart > 2.5) {
  // Pigeons: perched wings fold away; a pass within reach sends the flock
  // up and away, wheeling, back on the ledge by FLUTTER_SETTLE_S.
  vec4 fl = abFlutter(abPivot);
  float fly = 0.0;
  vec3 off = vec3(0.0);
  if (fl.w > 0.5) {
    float s = fl.z;
    float h = aAnim.y;
    float rise = 1.0 - exp(-s / 0.35);
    float home = smoothstep(4.5, ${glsl(FLUTTER_SETTLE_S)}, s);
    fly = rise * (1.0 - home);
    float wheel = s * (1.1 + 0.6 * h) + h * 6.28;
    off = vec3(
      fl.x * (8.0 + 8.0 * h) + cos(wheel) * 3.0,
      5.0 + 7.0 * h,
      fl.y * (8.0 + 8.0 * h) + sin(wheel) * 3.0) * fly;
  }
  if (abPart > 3.5) {
    // Wings: folded (collapsed) at rest; flapping in flight.
    transformed.xz *= fly;
    transformed.y += aAnim.z * 0.14 * sin(${TAU} * (uLoop * 840.0 + aAnim.y)) * fly;
  } else {
    // A perched bird bobs its head now and then.
    transformed.y += 0.012 * step(0.9, fract(uLoop * 40.0 + aAnim.y)) * (1.0 - fly);
  }
  transformed += off;
}
if (distance(abPivot, cameraPosition) > aPivot.w) transformed = vec3(0.0);
transformed += abPivot;
`;

const FRAGMENT_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += diffuseColor.rgb * 0.24;
`;

export const FACADE_LIFE_CACHE_KEY = "ab-a1-facade-life";

/** The baked laundry / flags / pigeons mesh: one draw call. */
export class FacadeLifeRenderer {
  readonly mesh: THREE.Mesh;
  readonly counts: {
    laundry: number;
    flags: number;
    banners: number;
    pigeons: number;
    vertices: number;
  };
  private readonly loop = { value: 0 };
  private tierOn = true;
  /** D8: items on what no longer stands drop out of the bake. */
  private readonly standing: StandingMask;
  private readonly hider: BakedHider;
  /** Each building's first item in the bake (one past the last at the end). */
  private readonly firstItem: Int32Array;

  constructor(buildings: readonly Building[], seed: number) {
    const lives = buildings.map((b) => facadeLifeFor(b, seed));
    const baked = bakeFacadeLife(lives);
    this.firstItem = new Int32Array(lives.length + 1);
    lives.forEach((life, i) => {
      this.firstItem[i + 1] = (this.firstItem[i] as number) + itemCount(life);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(baked.positions, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(baked.normals, 3),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(baked.colors, 3));
    geometry.setAttribute("aPivot", new THREE.BufferAttribute(baked.pivots, 4));
    geometry.setAttribute("aAnim", new THREE.BufferAttribute(baked.anims, 4));
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    material.customProgramCacheKey = () => FACADE_LIFE_CACHE_KEY;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uLoop = this.loop;
      lookPasses.attach(shader);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${BEGIN_VERTEX}`,
        );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${FRAGMENT_EMISSIVE}`,
      );
    };
    // Identity model matrix: positions leave the vertex shader in world
    // space at the camera's torus image (the rooftop-life idiom).
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    position.setUsage(THREE.DynamicDrawUsage);
    this.hider = new BakedHider(position, baked.starts);
    this.standing = new StandingMask(
      buildings,
      facadeLifeStandingLayer(buildings, seed),
      (b) => {
        const first = this.firstItem[b] as number;
        const n = (this.firstItem[b + 1] as number) - first;
        for (let k = 0; k < n; k++) {
          this.hider.setHidden(first + k, this.standing.isHidden(b, k));
        }
        this.hider.flush();
      },
    );
    this.counts = {
      laundry: lives.reduce((n, l) => n + l.laundry.length, 0),
      flags: lives.reduce((n, l) => n + l.flags.length, 0),
      banners: lives.reduce((n, l) => n + l.banners.length, 0),
      pigeons: lives.reduce((n, l) => n + l.pigeons.length, 0),
      vertices: baked.vertexCount,
    };
  }

  /** O3: Low and Mobile hide it (dressing, not solid). */
  setQuality(tier: QualityTier): void {
    this.tierOn = QUALITY_PROFILES[tier].facadeLife;
  }

  /** Per frame: the synced clock (or local time before the first snapshot). */
  update(timeMs: number, on = true): void {
    this.standing.update(); // D8
    this.mesh.visible = this.tierOn && on;
    this.loop.value = loopPhase(timeMs);
  }
}
