// S5 wind litter: paper, leaves and wrappers skittering down the canyons on
// the shared air, kicked up by planes that pass low. Client-only cosmetic
// dressing, non-collidable, gated on altitude like the rest of the micro tier.
//
// Same split as steam.ts: a pure seam (layout + pose) and a one-draw
// renderer.
//  - Every piece belongs to its BLOCK's layout (blockStream, TAG_LITTER), so
//    re-centring the block window never re-deals the field: a piece is the
//    same piece whichever block the camera is in.
//  - A piece's pose is a pure function of (piece, world time, windAt, the
//    low passes). It hops downwind over a seeded cycle from its home, swirls
//    in a canyon eddy and fades in and out at the cycle's ends. A plane
//    passing under KICK_ALT throws the pieces near its track up and out,
//    settling over KICK_LIFE_S.
//  - Time is the latched world clock (renderMs) throughout, kick included, so
//    a pinned world (`__ab.pinWorld`) freezes the litter exactly.
//
// Shimmer: every slow term (eddy, hop, fade) has a period of 2 s or longer,
// so a frozen-camera capture never sees a piece flick back and forth. The
// points are floored (O5's point-floor rule) so a far scrap never pops
// between pixels.

import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import type { Wind } from "@angels-bandits/common/wind";
import type { Vec3 } from "@angels-bandits/common/world";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { applyPointFloor } from "./point-floor";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import type { NearPass } from "./reactions";
import { RENDER_ORDER } from "./render-order";
import {
  BLOCK_WINDOW_RADIUS,
  type BlockIndex,
  GUTTER_LINE,
  PED_BAND_MAX,
  type RingPoint,
  blockStream,
  blockWindowInto,
  pruneBlockCache,
  ringPerimeter,
  ringPointInto,
} from "./streetlife";
import { nearestImageInto, uploadPrefix } from "./wrapPlacement";

/** This subsystem's block-stream tag (streetlife.ts's tags are 1–4). */
export const TAG_LITTER = 21;
/** Pieces in every block's layout. */
export const LITTER_PER_BLOCK = 20;
/** Shortest hop cycle, s — also the shortest period of any term (shimmer). */
export const HOP_PERIOD_MIN_S = 5;
const HOP_PERIOD_MAX_S = 11;
/** Downwind travel over one cycle at full wind, m. */
const TRAVEL_MIN = 6;
const TRAVEL_MAX = 16;
/** Canyon eddy radius, m, and angular rate, rad/s (≤ π: period ≥ 2 s). */
const EDDY_MIN = 0.6;
const EDDY_MAX = 2.4;
export const EDDY_RATE_MAX = Math.PI;
const EDDY_RATE_MIN = 1.2;
/** Highest a gust lifts a piece at full wind, m. */
const HOP_HEIGHT = 2.4;
/** Resting height (a scrap on the asphalt), m. */
const REST_Y = 0.12;
/** Share of the cycle spent fading in, and out. */
const FADE = 0.12;
/** Piece sizes, m. */
const SIZE_MIN = 0.22;
const SIZE_MAX = 0.48;

/** A plane under this altitude kicks the litter it passes over, m. */
export const KICK_ALT = 60;
/** …within this horizontal distance, m. */
export const KICK_RADIUS = 40;
/** The lift settles over this long, s. */
export const KICK_LIFE_S = 3;
/** Peak lift and outward throw at the track at deck height, m. */
const KICK_LIFT = 7;
const KICK_THROW = 4;

export const LitterKind = { PAPER: 0, LEAF: 1, WRAPPER: 2 } as const;
export type LitterKind = (typeof LitterKind)[keyof typeof LitterKind];

/** One scrap of a block's litter (canonical home, seeded motion). */
export interface LitterPiece {
  /** Canonical home on the street, m. */
  x: number;
  z: number;
  kind: LitterKind;
  /** Hop cycle, s, and its phase in [0, 1). */
  period: number;
  phase: number;
  /** Downwind travel per cycle at full wind, m. */
  travel: number;
  /** Eddy radius (m), signed rate (rad/s) and phase (rad). */
  eddy: number;
  rate: number;
  eddyPhase: number;
  /** Sprite size, m. */
  size: number;
}

/**
 * Block (bx, bz)'s litter: LITTER_PER_BLOCK pieces scattered along the
 * block's street ring, from a few metres into the roadway to the facades.
 * Pure: a (seed, block) always deals the same pieces.
 */
export function litterForBlock(
  seed: number,
  bx: number,
  bz: number,
): LitterPiece[] {
  const rand = blockStream(seed, bx, bz, TAG_LITTER);
  const out: LitterPiece[] = [];
  const at: RingPoint = { x: 0, z: 0, dx: 0, dz: 0 };
  // From ~5 m out in the roadway to the facade band: gutters collect most.
  const dMin = GUTTER_LINE - 5;
  for (let i = 0; i < LITTER_PER_BLOCK; i++) {
    const g = rand();
    const d = dMin + (PED_BAND_MAX - dMin) * g * g;
    ringPointInto(bx, bz, d, rand() * ringPerimeter(d), at);
    const k = rand();
    const kind: LitterKind =
      k < 0.5
        ? LitterKind.PAPER
        : k < 0.82
          ? LitterKind.LEAF
          : LitterKind.WRAPPER;
    const rate = EDDY_RATE_MIN + (EDDY_RATE_MAX - EDDY_RATE_MIN) * rand();
    out.push({
      x: at.x,
      z: at.z,
      kind,
      period: HOP_PERIOD_MIN_S + (HOP_PERIOD_MAX_S - HOP_PERIOD_MIN_S) * rand(),
      phase: rand(),
      travel: TRAVEL_MIN + (TRAVEL_MAX - TRAVEL_MIN) * rand(),
      eddy: EDDY_MIN + (EDDY_MAX - EDDY_MIN) * rand(),
      rate: rand() < 0.5 ? -rate : rate,
      eddyPhase: rand() * Math.PI * 2,
      size: SIZE_MIN + (SIZE_MAX - SIZE_MIN) * rand(),
    });
  }
  return out;
}

/** A piece's rendered state: offset from its home (m) and its alpha. */
export interface LitterPose {
  dx: number;
  y: number;
  dz: number;
  alpha: number;
}

/** A low pass reduced to what the kick needs (time in seconds). */
export interface KickSource {
  x: number;
  y: number;
  z: number;
  tSec: number;
}

const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * The lift (m) and outward throw (m) a pass at horizontal distance `dist`
 * and altitude `y`, `age` seconds ago, gives a piece. 0 before the pass,
 * outside KICK_RADIUS, at or above KICK_ALT, and after KICK_LIFE_S; it rises
 * within ~0.2 s and settles smoothly (continuous everywhere).
 */
export function kickAt(
  dist: number,
  y: number,
  age: number,
): { lift: number; throw: number } {
  if (!(age >= 0) || age >= KICK_LIFE_S || dist >= KICK_RADIUS) {
    return { lift: 0, throw: 0 };
  }
  const k = kickWeight(dist, y, age);
  return { lift: KICK_LIFT * k, throw: KICK_THROW * k };
}

/** kickAt's shared envelope, 0..1. */
function kickWeight(dist: number, y: number, age: number): number {
  if (!(age >= 0) || age >= KICK_LIFE_S || dist >= KICK_RADIUS) return 0;
  const near = 1 - smooth01(dist / KICK_RADIUS);
  const low = 1 - smooth01((y - 12) / (KICK_ALT - 12));
  const rise = smooth01(age / 0.2);
  const settle = 1 - smooth01(age / KICK_LIFE_S);
  return near * low * rise * settle;
}

/**
 * Piece `p` at world time `tSec` (seconds) in wind `wind`, kicked by
 * `sources`, written into `out`. Pure.
 */
export function litterPoseInto(
  p: LitterPiece,
  tSec: number,
  wind: Wind,
  sources: readonly KickSource[],
  out: LitterPose,
): LitterPose {
  poseClock.tSec = tSec;
  return litterPoseAt(p, poseClock, wind, sources, out);
}
const poseClock = { tSec: 0 };

/**
 * litterPoseInto with the time in an object (S8): the renderer calls this
 * for every piece every frame, and a double handed to a call V8 does not
 * inline is boxed — one HeapNumber a piece, ~8 KB a frame at street level.
 */
function litterPoseAt(
  p: LitterPiece,
  clock: { tSec: number },
  wind: Wind,
  sources: readonly KickSource[],
  out: LitterPose,
): LitterPose {
  const tSec = clock.tSec;
  let age = (tSec / p.period + p.phase) % 1;
  if (age < 0) age += 1;
  const s = wind.strength;
  // Downwind hop from home, and the eddy it tumbles in.
  const run = p.travel * s * age;
  const a = p.rate * tSec + p.eddyPhase;
  const r = p.eddy * (0.35 + 0.65 * s);
  let dx = wind.x * run + Math.cos(a) * r;
  let dz = wind.z * run + Math.sin(a) * r;
  const lift = Math.sin(Math.PI * age);
  let y =
    REST_Y + HOP_HEIGHT * s * lift * lift * (0.55 + 0.45 * Math.sin(a * 0.5));
  // Low passes: up and out from the track.
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i] as KickSource;
    const ex = wrapDeltaAxis(src.x, p.x + dx);
    const ez = wrapDeltaAxis(src.z, p.z + dz);
    const dist = Math.hypot(ex, ez);
    const k = kickWeight(dist, src.y, tSec - src.tSec);
    if (k <= 0) continue;
    y += KICK_LIFT * k;
    const inv = dist > 1e-3 ? 1 / dist : 0;
    dx += ex * inv * KICK_THROW * k;
    dz += ez * inv * KICK_THROW * k;
  }
  out.dx = dx;
  out.y = y;
  out.dz = dz;
  out.alpha = smooth01(age / FADE) * smooth01((1 - age) / FADE);
  return out;
}

// --- Renderer -------------------------------------------------------------

/** Linear colours: dim — litter is lit by the street, never self-lit. */
const KIND_COLORS: readonly THREE.Color[] = [
  new THREE.Color(0.42, 0.41, 0.37), // newspaper, receipts
  new THREE.Color(0.26, 0.15, 0.06), // dry leaves
  new THREE.Color(0.34, 0.1, 0.24), // a magenta wrapper
];

/** Most recent passes considered per frame (the kick's source pool). */
const MAX_SOURCES = 24;

/** Every drawn scrap in ONE THREE.Points — one draw call. */
export class Litter {
  readonly points: THREE.Points;
  private readonly seed: number;
  private readonly byBlock = new Map<number, LitterPiece[]>();
  private readonly positions: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  private readonly alphas: THREE.BufferAttribute;
  private readonly colors: THREE.BufferAttribute;
  private readonly material: THREE.PointsMaterial;
  private readonly pose: LitterPose = { dx: 0, y: 0, dz: 0, alpha: 0 };
  private readonly home: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly image: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly windowScratch: BlockIndex[] = [];
  private readonly sources: KickSource[] = Array.from(
    { length: MAX_SOURCES },
    () => ({ x: 0, y: 0, z: 0, tSec: 0 }),
  );
  private readonly live: KickSource[] = [];
  /** S8: update()'s clock and upload list, built once (no per-frame array). */
  private readonly clock = { tSec: 0 };
  private readonly uploads: readonly THREE.BufferAttribute[];
  private drawn = 0;
  /** Quality: every Nth piece of a block is drawn (1 = all). */
  private stride = 1;
  private radius = BLOCK_WINDOW_RADIUS;

  constructor(seed: number) {
    this.seed = seed;
    const budget = (2 * BLOCK_WINDOW_RADIUS + 1) ** 2 * LITTER_PER_BLOCK;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(budget), 1);
    this.alphas = new THREE.BufferAttribute(new Float32Array(budget), 1);
    this.colors = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("aSize", this.sizes);
    geometry.setAttribute("aAlpha", this.alphas);
    geometry.setAttribute("color", this.colors);
    this.uploads = [this.positions, this.sizes, this.alphas, this.colors];
    geometry.setDrawRange(0, 0);
    this.material = new THREE.PointsMaterial({
      size: 1, // per-point aSize carries the real size
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // Fog ON and not additive: a scrap is a lit surface that recedes with
      // the street it lies on.
    });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "attribute float aSize;\nattribute float aAlpha;\nvarying float vLitterA;\n#include <common>",
        )
        .replace(
          "gl_PointSize = size;",
          "gl_PointSize = size * aSize;\n\tvLitterA = aAlpha;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "varying float vLitterA;\n#include <common>",
        )
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\n\tdiffuseColor.a *= vLitterA;",
        );
      // O5: floored to 2 px, alpha paying for the floor (after the size).
      applyPointFloor(shader);
    };
    this.material.customProgramCacheKey = () => "ab-litter";
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = RENDER_ORDER.litter;
    this.points.visible = false;
  }

  private piecesFor(bx: number, bz: number): LitterPiece[] {
    const key = bx * 1000 + bz;
    let pieces = this.byBlock.get(key);
    if (!pieces) {
      pieces = litterForBlock(this.seed, bx, bz);
      this.byBlock.set(key, pieces);
    }
    return pieces;
  }

  /**
   * `timeMs` is the latched world clock; `passes` L1's near passes (server
   * time, any plane under NEAR_PASS_ALT); `gate` the micro tier's altitude
   * fraction (0 hides the field and skips all work).
   */
  update(
    cameraPos: Vec3,
    timeMs: number,
    wind: Wind,
    passes: readonly NearPass[],
    gate: number,
  ): void {
    if (gate <= 0) {
      this.points.visible = false;
      this.drawn = 0;
      return;
    }
    this.points.visible = true;
    this.material.opacity = gate;
    const tSec = timeMs / 1000;
    // The kick sources: recent passes low enough, newest first.
    this.live.length = 0;
    const reach = (this.radius + 1) * BLOCK_PITCH;
    for (let i = passes.length - 1; i >= 0; i--) {
      if (this.live.length >= MAX_SOURCES) break;
      const p = passes[i] as NearPass;
      const age = tSec - p.t / 1000;
      if (age >= KICK_LIFE_S) break; // oldest first: the rest are older
      if (age < 0 || p.y >= KICK_ALT) continue;
      if (
        Math.abs(wrapDeltaAxis(cameraPos.x, p.x)) > reach ||
        Math.abs(wrapDeltaAxis(cameraPos.z, p.z)) > reach
      ) {
        continue;
      }
      const s = this.sources[this.live.length] as KickSource;
      s.x = p.x;
      s.y = p.y;
      s.z = p.z;
      s.tSec = p.t / 1000;
      this.live.push(s);
    }
    let i = 0;
    // P3: keep the cache to last frame's window (about to be refilled).
    pruneBlockCache(this.byBlock, this.windowScratch);
    const blocks = blockWindowInto(cameraPos, this.radius, this.windowScratch);
    this.clock.tSec = tSec;
    for (let w = 0; w < blocks.length; w++) {
      const block = blocks[w] as BlockIndex;
      const pieces = this.piecesFor(block.bx, block.bz);
      for (let j = 0; j < pieces.length; j += this.stride) {
        const p = pieces[j] as LitterPiece;
        litterPoseAt(p, this.clock, wind, this.live, this.pose);
        if (this.pose.alpha <= 0) continue;
        this.home.x = p.x;
        this.home.z = p.z;
        const base = nearestImageInto(this.image, cameraPos, this.home);
        this.positions.setXYZ(
          i,
          base.x + this.pose.dx,
          this.pose.y,
          base.z + this.pose.dz,
        );
        this.sizes.setX(i, p.size);
        this.alphas.setX(i, this.pose.alpha);
        const c = KIND_COLORS[p.kind] as THREE.Color;
        this.colors.setXYZ(i, c.r, c.g, c.b);
        i++;
      }
    }
    this.drawn = i;
    this.points.geometry.setDrawRange(0, i);
    uploadPrefix(this.uploads, i);
  }

  /** Quality: the tier's share of each block's pieces, and how far out the
   * field streams. Counts only (O3 rule 1). */
  setQuality(tier: QualityTier): void {
    const p = QUALITY_PROFILES[tier];
    this.stride =
      p.litter <= 0 ? LITTER_PER_BLOCK : Math.max(1, Math.round(1 / p.litter));
    this.radius = Math.min(BLOCK_WINDOW_RADIUS, p.microRadius);
  }

  /** Pieces drawn last frame (QA, perf). */
  get count(): number {
    return this.drawn;
  }
}
