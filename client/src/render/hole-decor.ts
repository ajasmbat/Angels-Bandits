// H2 hole decor (client-only dressing): what makes a hole a place, and what
// leads a pilot into it.
//
//  - Inside every hole: LED light strips and recessed lights, painted lane
//    lines, a cable tray and pipes under the ceiling, spinning ventilation
//    fans set flush in it, EXIT and arrow signs, neon murals and graffiti
//    (procedural, no brands), and — in the landmark arches, which run
//    through lobbies — glass walls onto lit lobbies with people in them.
//  - Outside every OUTER mouth: runway-style approach chevrons on the street
//    or roofs under the approach, sweeping toward the mouth, and lead-in
//    chevrons on the facade under a raised mouth.
//
// Layout is pure (holeDecorFor: one hole span in, quads out) and seeded from
// the span's own position — never Math.random — so every client dresses
// every hole the same. Decor goes only where the hole is lined: a row tunnel
// is decorated host by host, never across an open-sky slot.
//
// NON-COLLIDABLE and FLUSH: every interior piece sits on the lining and
// stands at most DECOR_DEPTH (0.5 m) proud of it into the clear volume —
// well under PLAYER_RADIUS, so a plane that does not crash never visibly
// clips decor. The hole's collision volume (common/holes.ts solids) is
// unchanged. Chevrons lie on the surface below the approach, under the floor.
//
// Emissive ladder: guidance lights (strips, chevrons) sit at
// EMISSIVE_HOLE_LED, signs and neon at EMISSIVE_SIGN, lobby light at
// EMISSIVE_WINDOW; paint (murals' body, graffiti, lane lines) glows at most
// DECOR_PAINT_GLOW, under the 0.72 bloom threshold. Each vertex carries its
// peak radiance (aGlow); the shader only ever scales it down.
//
// The renderer is ONE draw call: a baked whole-city mesh whose vertices carry
// their item's canonical pivot, placed at the torus image nearest the camera
// in the vertex shader (the facade-life idiom), folded away past each item's
// fold distance. Fans spin and chevrons sweep on the synced clock's loop
// (rooftop-life's LOOP_MS), so only uniforms change per frame.

import {
  type Building,
  type HoleSpan,
  cityHoles,
} from "@angels-bandits/common/city";
import {
  BLOCK_PITCH,
  EMISSIVE_HOLE_LED,
  EMISSIVE_SIGN,
  EMISSIVE_WINDOW,
  HOLE_RUN_OUT,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { wrapCoord, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { AB_AA_GLSL } from "./aa-glsl";
import { emissiveBoost } from "./emissive";
import { W_GLSL } from "./lookup";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { loopPhase } from "./rooftop-life";

// --- Layout rules ------------------------------------------------------------

/** The most any interior piece stands proud of the lining, m. */
export const DECOR_DEPTH = 0.5;
/** Decals (paint, signs, glass) float this far off their surface, m. */
const DECAL = 0.04;
/** Paint's own glow, peak luminance — under the bloom threshold. */
export const DECOR_PAINT_GLOW = 0.3;
/** Fold distances, m: interiors are only worth drawing close; the approach
 * guidance must read from well back (fog is at 800 m). */
const FOLD_INTERIOR = 380;
const FOLD_GUIDE = 700;
/** Approach chevrons: first one this far out, then every CHEVRON_PITCH, out
 * to the clear run-out (arches: their hand-placed 55 m run-in). */
const CHEVRON_FIRST = 10;
const CHEVRON_PITCH = 12;
const ARCH_RUN_IN = 55;
/** Fans: one per this much lined length, at most FAN_MAX per host. */
const FAN_EVERY = 26;
const FAN_MAX = 3;
const FAN_RADIUS = 1.25;
/** Vertex budget for the whole city (the perf ceiling the test pins). */
export const DECOR_VERTEX_BUDGET = 150_000;

/** What a vertex is, for the shader. Guidance kinds are the last two. */
export enum DecorKind {
  PLAIN = 0,
  FAN = 1,
  MURAL = 2,
  GRAFFITI = 3,
  EXIT = 4,
  ARROW = 5,
  LOBBY = 6,
  CHEVRON = 7,
  LIGHT = 8,
}

/** One quad: four corners (world, canonical-ish — offsets from `pivot`). */
export interface DecorQuad {
  kind: DecorKind;
  /** Item pivot: canonical world position the corners hang off. */
  pivot: { x: number; y: number; z: number };
  /** Fold distance, m. */
  fold: number;
  /** Corners as offsets from the pivot, counter-clockwise seen from `normal`. */
  corners: [number, number, number][];
  normal: [number, number, number];
  /** Albedo (linear). */
  color: [number, number, number];
  /** Peak emissive radiance (linear, HDR) — the shader scales it ≤ 1. */
  glow: [number, number, number];
  /** Per-corner pattern coordinates, meters (u along, v up the panel). */
  uv: [number, number][];
  /** 0..1 per-item seed (pattern variety, fan phase). */
  seed: number;
}

/** A linear colour scaled to a peak luminance. */
function rung(rgb: [number, number, number], target: number) {
  const c = new THREE.Color(rgb[0], rgb[1], rgb[2]);
  const k = emissiveBoost(c, target);
  return [c.r * k, c.g * k, c.b * k] as [number, number, number];
}

const LED_WHITE = rung([0.72, 0.9, 1.0], EMISSIVE_HOLE_LED);
const LED_WARM = rung([1.0, 0.82, 0.55], EMISSIVE_HOLE_LED);
const CHEVRON_AMBER = rung([1.0, 0.72, 0.32], EMISSIVE_HOLE_LED);
const SIGN_GREEN = rung([0.2, 1.0, 0.45], EMISSIVE_SIGN);
const SIGN_WHITE = rung([1.0, 1.0, 1.0], EMISSIVE_SIGN);
const NEON = rung([1.0, 1.0, 1.0], EMISSIVE_SIGN);
const LOBBY_WARM = rung([1.0, 0.78, 0.5], EMISSIVE_WINDOW);
const PAINT_WHITE = rung([1.0, 1.0, 1.0], DECOR_PAINT_GLOW);
const PAINT_YELLOW = rung([1.0, 0.8, 0.25], DECOR_PAINT_GLOW);
const NONE: [number, number, number] = [0, 0, 0];

/** mulberry32 on a span's own position: the same stream on every client. */
function streamFor(span: HoleSpan): () => number {
  let a =
    (Math.imul(Math.round(span.center.x * 8) + 1, 73856093) ^
      Math.imul(Math.round(span.center.z * 8) + 1, 19349663) ^
      0x6d1e5a11) >>>
    0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The hole's own frame: `a` along the axis from the span centre, `c` across
 * it (world +z for an x hole, +x for a z hole), `y` world height.
 */
interface Frame {
  span: HoleSpan;
  x: boolean;
}
const toWorld = (f: Frame, a: number, c: number, y: number) => ({
  x: f.span.center.x + (f.x ? a : c),
  y,
  z: f.span.center.z + (f.x ? c : a),
});
/** A frame-space vector as world [x, y, z]. */
const vec = (f: Frame, a: number, c: number, y: number) =>
  (f.x ? [a, y, c] : [c, y, a]) as [number, number, number];

/** A frame-space triple (along, across, up). */
type F3 = [number, number, number];

/** Quads for one item, all sharing its pivot. Every coordinate and normal
 * handed in is in the hole's frame (along, across, up). */
class Item {
  readonly quads: DecorQuad[] = [];
  private readonly pivot: { x: number; y: number; z: number };
  constructor(
    private readonly f: Frame,
    private readonly pa: number,
    private readonly pc: number,
    private readonly py: number,
    private readonly fold: number,
    private readonly seed: number,
  ) {
    const p = toWorld(f, pa, pc, py);
    this.pivot = { x: wrapCoord(p.x), y: p.y, z: wrapCoord(p.z) };
  }

  /** A quad from frame-space corners (a, c, y) and normal. */
  quad(
    kind: DecorKind,
    corners: F3[],
    normal: F3,
    color: F3,
    glow: F3,
    uv: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  ): void {
    this.quads.push({
      kind,
      pivot: this.pivot,
      fold: this.fold,
      corners: corners.map(([a, c, y]) =>
        vec(this.f, a - this.pa, c - this.pc, y - this.py),
      ),
      normal: vec(this.f, normal[0], normal[1], normal[2]),
      color,
      glow,
      uv,
      seed: this.seed,
    });
  }

  /**
   * A panel on the wall plane c = `c`, facing into the hole, a0..a1 along
   * and y0..y1 up. u (meters) runs to the right as seen from inside, or —
   * with `toward` — along that direction of `a` (arrow signs).
   */
  wall(
    kind: DecorKind,
    c: number,
    a0: number,
    a1: number,
    y0: number,
    y1: number,
    color: F3,
    glow: F3,
    toward?: 1 | -1,
  ): void {
    const s = Math.sign(c);
    // Facing +s across, the viewer's right is world (−f.z, f.x): along −a
    // on an x hole (across = +z), along +a on a z hole (across = +x).
    const right = toward ?? ((this.f.x ? -s : s) as 1 | -1);
    const u = (a: number) => (right > 0 ? a - a0 : a1 - a);
    const h = y1 - y0;
    this.quad(
      kind,
      [
        [a0, c, y0],
        [a1, c, y0],
        [a1, c, y1],
        [a0, c, y1],
      ],
      [0, -s, 0],
      color,
      glow,
      [
        [u(a0), 0],
        [u(a1), 0],
        [u(a1), h],
        [u(a0), h],
      ],
    );
  }

  /** A horizontal rectangle at height y, facing up (+1) or down (−1). */
  flat(
    kind: DecorKind,
    a0: number,
    a1: number,
    c0: number,
    c1: number,
    y: number,
    up: 1 | -1,
    color: F3,
    glow: F3,
  ): void {
    this.quad(
      kind,
      [
        [a0, c0, y],
        [a1, c0, y],
        [a1, c1, y],
        [a0, c1, y],
      ],
      [0, 0, up],
      color,
      glow,
    );
  }

  /** A box along the hole: its four long faces (the ends are never seen). */
  box(
    a0: number,
    a1: number,
    c0: number,
    c1: number,
    y0: number,
    y1: number,
    color: F3,
  ): void {
    this.flat(DecorKind.PLAIN, a0, a1, c0, c1, y0, -1, color, NONE);
    this.flat(DecorKind.PLAIN, a0, a1, c0, c1, y1, 1, color, NONE);
    for (const [c, n] of [
      [c0, -1],
      [c1, 1],
    ] as const) {
      this.quad(
        DecorKind.PLAIN,
        [
          [a0, c, y0],
          [a1, c, y0],
          [a1, c, y1],
          [a0, c, y1],
        ],
        [0, n, 0],
        color,
        NONE,
      );
    }
  }

  /** A hexagonal pipe along the hole, centre (c, y), radius r. */
  pipe(a0: number, a1: number, c: number, y: number, r: number, color: F3) {
    for (let k = 0; k < 6; k++) {
      const t0 = (k / 6) * Math.PI * 2;
      const t1 = ((k + 1) / 6) * Math.PI * 2;
      const tm = (t0 + t1) / 2;
      this.quad(
        DecorKind.PLAIN,
        [
          [a0, c + r * Math.cos(t0), y + r * Math.sin(t0)],
          [a1, c + r * Math.cos(t0), y + r * Math.sin(t0)],
          [a1, c + r * Math.cos(t1), y + r * Math.sin(t1)],
          [a0, c + r * Math.cos(t1), y + r * Math.sin(t1)],
        ],
        [0, Math.cos(tm), Math.sin(tm)],
        color,
        NONE,
      );
    }
  }
}

/** The ground or roof height under (x, z): the top of the highest tier
 * whose footprint holds it, 0 on a street. */
export function surfaceAt(
  x: number,
  z: number,
  byBlock: ReadonlyMap<number, readonly Building[]>,
): number {
  const grid = WORLD_SIZE / BLOCK_PITCH;
  const bx = Math.floor(wrapCoord(x) / BLOCK_PITCH);
  const bz = Math.floor(wrapCoord(z) / BLOCK_PITCH);
  let top = 0;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const key =
        ((((bx + i) % grid) + grid) % grid) * grid +
        ((((bz + j) % grid) + grid) % grid);
      for (const b of byBlock.get(key) ?? []) {
        const dx = Math.abs(wrapDeltaAxis(b.x, x));
        const dz = Math.abs(wrapDeltaAxis(b.z, z));
        let h = 0;
        for (const t of b.tiers) {
          h += t.height;
          if (dx <= t.width / 2 && dz <= t.depth / 2 && h > top) top = h;
        }
      }
    }
  }
  return top;
}

/** Buildings bucketed by block, for surfaceAt. */
export function bucketByBlock(
  buildings: readonly Building[],
): Map<number, Building[]> {
  const grid = WORLD_SIZE / BLOCK_PITCH;
  const out = new Map<number, Building[]>();
  for (const b of buildings) {
    const key =
      Math.floor(wrapCoord(b.x) / BLOCK_PITCH) * grid +
      Math.floor(wrapCoord(b.z) / BLOCK_PITCH);
    const list = out.get(key);
    if (list) list.push(b);
    else out.set(key, [b]);
  }
  return out;
}

/** Each host's lined along-extent [lo, hi] in the span frame, sorted. */
export function linedSegments(span: HoleSpan): [number, number][] {
  const x = span.hole.axis === "x";
  const out: [number, number][] = [];
  for (const b of span.hosts) {
    const hole = b.holes?.[0];
    const tier = hole ? b.tiers[hole.tierIndex] : undefined;
    if (!tier) continue;
    const half = (x ? tier.width : tier.depth) / 2;
    const mid = wrapDeltaAxis(x ? span.center.x : span.center.z, x ? b.x : b.z);
    out.push([mid - half, mid + half]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/**
 * Every decor quad for one hole: the interior, host by host, and the
 * approach guidance at each outer mouth. `byBlock` (bucketByBlock) is what
 * the chevrons lie on.
 */
export function holeDecorFor(
  span: HoleSpan,
  byBlock: ReadonlyMap<number, readonly Building[]>,
): DecorQuad[] {
  const { kind, axis, width: W, height: H, y0 } = span.hole;
  if (kind === "bridge") return [];
  const f: Frame = { span, x: axis === "x" };
  const rand = streamFor(span);
  const yC = y0 + H;
  const out: DecorQuad[] = [];
  const segs = linedSegments(span);
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (!first || !last) return out;
  const runLo = first[0];
  const runHi = last[1];
  const wallC = W / 2 - DECAL;

  segs.forEach(([lo, hi], si) => {
    const L = hi - lo;
    const mid = (lo + hi) / 2;
    const it = new Item(f, mid, 0, y0 + H / 2, FOLD_INTERIOR, rand());
    const guide = new Item(f, mid, 0, y0 + H / 2, FOLD_GUIDE, 0);
    // LED strips high on both walls, a warm kick strip low — guidance.
    for (const s of [-1, 1]) {
      guide.wall(
        DecorKind.LIGHT,
        s * wallC,
        lo + 0.4,
        hi - 0.4,
        yC - 0.95,
        yC - 0.7,
        NONE,
        LED_WHITE,
      );
      guide.wall(
        DecorKind.LIGHT,
        s * wallC,
        lo + 0.4,
        hi - 0.4,
        y0 + 0.9,
        y0 + 1.05,
        NONE,
        LED_WARM,
      );
    }
    // Recessed ceiling lights, two rows.
    for (let a = lo + 3.5; a <= hi - 3; a += 7) {
      for (const s of [-1, 1]) {
        const c = s * W * 0.25;
        it.flat(
          DecorKind.LIGHT,
          a - 0.4,
          a + 0.4,
          c - 0.2,
          c + 0.2,
          yC - DECAL,
          -1,
          NONE,
          LED_WARM,
        );
      }
    }
    // Lane lines: solid edge lines, dashed dividers — paint, a faint glow.
    const fy = y0 + DECAL;
    for (const s of [-1, 1]) {
      const e = s * (W / 2 - 1.3);
      it.flat(
        DecorKind.PLAIN,
        lo + 0.3,
        hi - 0.3,
        e - 0.1,
        e + 0.1,
        fy,
        1,
        [0.6, 0.6, 0.58],
        PAINT_WHITE,
      );
      const d = s * (W / 6);
      for (let a = lo + 1.5; a + 3 <= hi - 0.5; a += 9) {
        it.flat(
          DecorKind.PLAIN,
          a,
          a + 3,
          d - 0.08,
          d + 0.08,
          fy,
          1,
          [0.62, 0.5, 0.18],
          PAINT_YELLOW,
        );
      }
    }
    // A cable tray on one side and two pipes on the other, under the ceiling.
    const t = rand() < 0.5 ? 1 : -1;
    it.box(
      lo + 0.3,
      hi - 0.3,
      t * (W / 2 - 2.3),
      t * (W / 2 - 1.4),
      yC - 0.42,
      yC - 0.27,
      [0.25, 0.26, 0.27],
    );
    it.pipe(
      lo + 0.3,
      hi - 0.3,
      -t * (W / 2 - 1.0),
      yC - 0.24,
      0.16,
      [0.42, 0.08, 0.06],
    );
    it.pipe(
      lo + 0.3,
      hi - 0.3,
      -t * (W / 2 - 1.55),
      yC - 0.26,
      0.12,
      [0.45, 0.38, 0.1],
    );
    // Fans flush in the ceiling on the centreline: a dark well, a short
    // housing and four blades the shader turns about +y.
    const fans = Math.min(FAN_MAX, Math.floor(L / FAN_EVERY));
    for (let k = 0; k < fans; k++) {
      const a = lo + (L * (k + 0.5)) / fans;
      const ring = new Item(f, a, 0, yC - 0.3, FOLD_INTERIOR, 0);
      const fan = new Item(f, a, 0, yC - 0.3, FOLD_INTERIOR, rand());
      const n = 8;
      for (let j = 0; j < n; j++) {
        const t0 = (j / n) * Math.PI * 2;
        const t1 = ((j + 1) / n) * Math.PI * 2;
        const tm = (t0 + t1) / 2;
        const p0: [number, number] = [
          a + FAN_RADIUS * Math.cos(t0),
          FAN_RADIUS * Math.sin(t0),
        ];
        const p1: [number, number] = [
          a + FAN_RADIUS * Math.cos(t1),
          FAN_RADIUS * Math.sin(t1),
        ];
        ring.quad(
          DecorKind.PLAIN,
          [
            [p0[0], p0[1], yC - 0.45],
            [p1[0], p1[1], yC - 0.45],
            [p1[0], p1[1], yC],
            [p0[0], p0[1], yC],
          ],
          [-Math.cos(tm), -Math.sin(tm), 0],
          [0.2, 0.21, 0.22],
          NONE,
        );
        ring.quad(
          DecorKind.PLAIN,
          [
            [a, 0, yC - DECAL],
            [p0[0], p0[1], yC - DECAL],
            [p1[0], p1[1], yC - DECAL],
            [a, 0, yC - DECAL],
          ],
          [0, 0, -1],
          [0.03, 0.03, 0.035],
          NONE,
        );
      }
      for (let b = 0; b < 4; b++) {
        const tb = (b / 4) * Math.PI * 2;
        const ca = Math.cos(tb);
        const sa = Math.sin(tb);
        const r0 = 0.18;
        const r1 = FAN_RADIUS - 0.12;
        const hw = 0.16;
        fan.quad(
          DecorKind.FAN,
          [
            [a + ca * r0 - sa * hw, sa * r0 + ca * hw, yC - 0.3],
            [a + ca * r1 - sa * hw, sa * r1 + ca * hw, yC - 0.3],
            [a + ca * r1 + sa * hw, sa * r1 - ca * hw, yC - 0.3],
            [a + ca * r0 + sa * hw, sa * r0 - ca * hw, yC - 0.3],
          ],
          [0, 0, -1],
          [0.5, 0.5, 0.52],
          NONE,
        );
      }
      out.push(...ring.quads, ...fan.quads);
    }
    // EXIT signs near each OUTER mouth, both walls; arrow signs between,
    // pointing to the nearer outer mouth.
    const signY0 = yC - 2.7;
    const signY1 = yC - 2.0;
    const exits: number[] = [];
    if (si === 0) exits.push(lo + 5);
    if (si === segs.length - 1) exits.push(hi - 5);
    for (const a of exits) {
      if (a - 1 < lo || a + 1 > hi) continue;
      for (const s of [-1, 1]) {
        it.wall(
          DecorKind.EXIT,
          s * wallC,
          a - 1,
          a + 1,
          signY0,
          signY1,
          [0.02, 0.1, 0.04],
          SIGN_GREEN,
        );
      }
    }
    for (let a = lo + 20; a <= hi - 20; a += 40) {
      const toward = a - runLo < runHi - a ? -1 : 1;
      for (const s of [-1, 1]) {
        it.wall(
          DecorKind.ARROW,
          s * wallC,
          a - 1.2,
          a + 1.2,
          signY0,
          signY1,
          [0.03, 0.03, 0.03],
          SIGN_WHITE,
          toward,
        );
      }
    }
    if (kind === "arch") {
      // The arch runs through the landmark's lobby: glass on both sides.
      for (const s of [-1, 1]) {
        it.wall(
          DecorKind.LOBBY,
          s * wallC,
          lo + 4,
          hi - 4,
          y0 + 0.3,
          y0 + Math.min(H - 5, 9),
          [0.03, 0.035, 0.04],
          LOBBY_WARM,
        );
      }
    } else if (L >= 12) {
      // A neon mural on one wall, graffiti tags low on the other.
      const ms = rand() < 0.5 ? 1 : -1;
      const ml = Math.min(L - 6, 18);
      const mc = mid + (rand() - 0.5) * (L - 6 - ml);
      it.wall(
        DecorKind.MURAL,
        ms * wallC,
        mc - ml / 2,
        mc + ml / 2,
        y0 + 2.2,
        y0 + Math.min(H - 4.5, 9.5),
        [0.2, 0.2, 0.2],
        NEON,
      );
      const tags = Math.min(3, Math.floor(L / 9));
      for (let k = 0; k < tags; k++) {
        const ta = lo + (L * (k + 0.5)) / tags + (rand() - 0.5) * 2;
        it.wall(
          DecorKind.GRAFFITI,
          -ms * wallC,
          ta - 1.8,
          ta + 1.8,
          y0 + 1.3,
          y0 + 2.9,
          [0.11, 0.105, 0.1],
          PAINT_WHITE,
        );
      }
    }
    out.push(...it.quads, ...guide.quads);
  });

  // --- Approach guidance at each OUTER mouth ----------------------------------
  const runIn = kind === "arch" ? ARCH_RUN_IN : HOLE_RUN_OUT - 10;
  const len = 4.5;
  const spread = W * 0.32;
  const hw = 0.5;
  for (const o of [-1, 1] as const) {
    const mouth = o === -1 ? runLo : runHi;
    // Chevrons (a V, tip toward the mouth) on whatever surface is under the
    // approach — street or roof — sweeping in; never above the floor.
    const g = new Item(f, mouth + o * 60, 0, y0, FOLD_GUIDE, 0);
    for (let d = CHEVRON_FIRST; d <= runIn; d += CHEVRON_PITCH) {
      const tip = mouth + o * d;
      const p = toWorld(f, tip, 0, 0);
      const ground = surfaceAt(p.x, p.z, byBlock);
      if (ground > y0 - 1) break; // blocked: stop the lead-in here
      const y = ground + 0.06;
      for (const s of [-1, 1]) {
        g.quad(
          DecorKind.CHEVRON,
          [
            [tip, -s * hw, y],
            [tip + o * len, s * spread - s * hw, y],
            [tip + o * len, s * spread + s * hw, y],
            [tip, s * hw, y],
          ],
          [0, 0, 1],
          NONE,
          CHEVRON_AMBER,
          [
            [d, 0],
            [d + len, 0],
            [d + len, 1],
            [d, 1],
          ],
        );
      }
    }
    out.push(...g.quads);
    // Lead-in chevrons on the facade under a raised mouth, pointing up.
    const host = o === -1 ? hostAt(span, runLo) : hostAt(span, runHi);
    const hole = host?.holes?.[0];
    if (!host || !hole) continue;
    let base = 0;
    for (let i = 0; i < hole.tierIndex; i++) base += host.tiers[i]?.height ?? 0;
    const face = mouth + o * DECAL;
    const lead = new Item(f, face, 0, y0, FOLD_GUIDE, 0);
    for (let k = 0; k < 3; k++) {
      const tipY = y0 - 1.6 - 2.6 * k;
      if (tipY - 2.1 < base + 0.5) break;
      for (const s of [-1, 1]) {
        lead.quad(
          DecorKind.CHEVRON,
          [
            [face, 0, tipY],
            [face, s * W * 0.28, tipY - 1.5],
            [face, s * W * 0.28, tipY - 2.1],
            [face, 0, tipY - 0.6],
          ],
          [o, 0, 0],
          NONE,
          CHEVRON_AMBER,
          [
            [-2 - 3 * k, 0],
            [-2 - 3 * k, 0],
            [-2 - 3 * k, 1],
            [-2 - 3 * k, 1],
          ],
        );
      }
    }
    out.push(...lead.quads);
  }
  return out;
}

/** The host whose lined extent ends at `a` (an outer mouth). */
function hostAt(span: HoleSpan, a: number): Building | undefined {
  const x = span.hole.axis === "x";
  return span.hosts.find((b) => {
    const hole = b.holes?.[0];
    const tier = hole ? b.tiers[hole.tierIndex] : undefined;
    if (!tier) return false;
    const half = (x ? tier.width : tier.depth) / 2;
    const mid = wrapDeltaAxis(x ? span.center.x : span.center.z, x ? b.x : b.z);
    return Math.abs(mid - half - a) < 0.01 || Math.abs(mid + half - a) < 0.01;
  });
}

// --- Bake ---------------------------------------------------------------------

export interface BakedDecor {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  glows: Float32Array;
  pivots: Float32Array;
  decor: Float32Array;
  vertexCount: number;
}

/** Two triangles per quad, non-indexed. */
export function bakeDecor(quads: readonly DecorQuad[]): BakedDecor {
  const n = quads.length * 6;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const glows = new Float32Array(n * 3);
  const pivots = new Float32Array(n * 4);
  const decor = new Float32Array(n * 4);
  let v = 0;
  for (const q of quads) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const c = q.corners[i] as [number, number, number];
      const uv = q.uv[i] as [number, number];
      positions.set(c, v * 3);
      normals.set(q.normal, v * 3);
      colors.set(q.color, v * 3);
      glows.set(q.glow, v * 3);
      pivots.set([q.pivot.x, q.pivot.y, q.pivot.z, q.fold], v * 4);
      // kind + seed packed in .x (seed < 1), pattern meters in .zw.
      decor.set([q.kind + q.seed * 0.9, 0, uv[0], uv[1]], v * 4);
      v++;
    }
  }
  return { positions, normals, colors, glows, pivots, decor, vertexCount: n };
}

// --- Shader ---------------------------------------------------------------------

const TAU = "6.28318530718";

const VERTEX_PARS = /* glsl */ `
uniform float uDecorLoop;
uniform float uDecorFull;
attribute vec4 aPivot;
attribute vec4 aDecor;
attribute vec3 aGlow;
varying vec4 vDecor;
varying vec3 vGlow;
`;

const BEGIN_VERTEX = /* glsl */ `
vDecor = aDecor;
vGlow = aGlow;
float abKind = floor(aDecor.x + 1e-3);
vec3 abPivot = aPivot.xyz;
abPivot.xz += floor((cameraPosition.xz - abPivot.xz) / ${W_GLSL} + 0.5) * ${W_GLSL};
if (abKind > 0.5 && abKind < 1.5) {
  // Fan blades turn about +y (their plane is horizontal): 240 turns a loop.
  float a = ${TAU} * (uDecorLoop * 240.0 + fract(aDecor.x) * 1.1);
  float c = cos(a);
  float s = sin(a);
  transformed.xz = vec2(c * transformed.x - s * transformed.z, s * transformed.x + c * transformed.z);
}
bool abGuide = abKind > 6.5;
if ((!abGuide && uDecorFull < 0.5) || distance(abPivot, cameraPosition) > aPivot.w) {
  transformed = vec3(0.0);
}
transformed += abPivot;
`;

const glslVec = (c: F3) => `vec3(${c.map((v) => v.toFixed(4)).join(", ")})`;

const FRAGMENT_PARS = /* glsl */ `
uniform float uDecorLoop;
varying vec4 vDecor;
varying vec3 vGlow;
${AB_AA_GLSL}
float abH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 abPal(float t) { return 0.5 + 0.5 * cos(${TAU} * (vec3(0.0, 0.33, 0.67) + t)); }
// 3×5 glyphs E, X, I, T: rows top to bottom, bit 14 = top-left.
float abGlyph(int g, vec2 cell) {
  int bits = g == 0 ? 31207 : g == 1 ? 23213 : g == 2 ? 29847 : 29842;
  int cx = int(cell.x);
  int cy = 4 - int(cell.y);
  if (cx < 0 || cx > 2 || cy < 0 || cy > 4) return 0.0;
  return float((bits >> (14 - (cy * 3 + cx))) & 1);
}
`;

/** Per-kind pattern. Every emissive term is a convex mix (or a scale ≤ 1)
 * of the vertex's own peak radiance, so nothing outshines its rung. */
const FRAGMENT_EMISSIVE = /* glsl */ `
{
  float k = floor(vDecor.x + 1e-3);
  float seed = fract(vDecor.x) / 0.9;
  vec2 uv = vDecor.zw;
  // Meters per pixel on the panel: the AA width every line filters by.
  float aa = max(length(fwidth(uv)), 1e-4);
  if (k > 1.5 && k < 2.5) {
    // Neon mural: soft colour fields, outlined in neon contour lines.
    vec2 q = uv / 3.2;
    float field = sin(q.x * 1.3 + q.y * 1.9 + seed * 17.0)
      + sin(length(q - vec2(1.5 + seed * 2.0, 1.2)) * 2.4 - seed * 9.0);
    vec3 paint = abPal(field * 0.18 + seed);
    diffuseColor.rgb = paint * 0.3;
    float c = field * 1.4;
    float perM = max(length(fwidth(vec2(c))) / aa, 1e-3);
    float line = abLine(abs(fract(c) - 0.5) / perM, 0.06, aa) * abDetail(0.8, aa);
    totalEmissiveRadiance += mix(
      paint * ${DECOR_PAINT_GLOW.toFixed(2)},
      vGlow * abPal(field * 0.18 + seed + 0.5),
      line);
  } else if (k > 2.5 && k < 3.5) {
    // Graffiti: a row of bubble letters, fill and outline, on the lining.
    float best = 9.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec2 c = vec2(0.55 + fi * 0.85, 0.8 + 0.12 * sin(fi * 2.3 + seed * 31.0));
      float r = 0.42 + 0.08 * abH(vec2(fi, seed));
      best = min(best, length((uv - c) * vec2(1.0, 1.25)) - r);
    }
    float fill = 1.0 - smoothstep(-aa, aa, best);
    float rim = abLine(abs(best + 0.06), 0.05, aa);
    vec3 a = abPal(seed);
    vec3 b = abPal(seed + 0.45);
    diffuseColor.rgb = mix(mix(diffuseColor.rgb, a * 0.5, fill), b * 0.6, rim);
    totalEmissiveRadiance += vGlow * mix(a * 0.5 * fill, b * 0.6, rim);
  } else if (k > 3.5 && k < 4.5) {
    // EXIT: white glyphs on a lit green panel.
    vec2 cell = floor(vec2(uv.x / 0.11 - 1.0, uv.y / 0.1 - 1.0));
    float letter = floor(cell.x / 4.0);
    float on = 0.0;
    if (letter >= 0.0 && letter < 4.0) {
      on = abGlyph(int(letter), vec2(mod(cell.x, 4.0), cell.y));
    }
    on *= abDetail(0.22, aa);
    totalEmissiveRadiance += mix(vGlow * 0.55, ${glslVec(SIGN_WHITE)}, on);
  } else if (k > 4.5 && k < 5.5) {
    // Arrow sign: two chevrons pointing along +u, sweeping slowly.
    vec2 p = vec2(uv.x / 2.4 - 0.5, uv.y / 0.7 - 0.5);
    float f = fract(p.x * 3.0 - abs(p.y) * 2.2 - uDecorLoop * 60.0);
    float on = smoothstep(0.55, 0.62, f) * (1.0 - smoothstep(0.92, 0.99, f))
      * step(abs(p.y), 0.38) * step(abs(p.x), 0.44);
    totalEmissiveRadiance += vGlow * on * abDetail(0.4, aa);
  } else if (k > 5.5 && k < 6.5) {
    // Lobby glass: a lit room, mullions every 3 m, people in silhouette.
    float mull = abLine(abs(uv.x - floor(uv.x / 3.0 + 0.5) * 3.0), 0.06, aa);
    float cell = floor(uv.x / 2.2);
    float who = abH(vec2(cell, seed * 7.0));
    float cx = (cell + 0.3 + 0.4 * abH(vec2(cell, 3.0))) * 2.2;
    float body = (1.0 - smoothstep(0.22 - aa, 0.22 + aa, abs(uv.x - cx)))
      * (1.0 - smoothstep(1.55 - aa, 1.55 + aa, uv.y));
    float head = 1.0 - smoothstep(0.15 - aa, 0.15 + aa, length(uv - vec2(cx, 1.72)));
    float person = step(0.45, who) * max(body, head);
    float light = 0.55 + 0.45 * smoothstep(0.0, 6.0, uv.y);
    totalEmissiveRadiance += vGlow * light * (1.0 - person) * (1.0 - mull);
  } else if (k > 6.5 && k < 7.5) {
    // Approach chevrons: a steady glow, a runway "rabbit" sweeping in.
    float sweep = fract(uDecorLoop * 120.0 + uv.x / 60.0);
    float rabbit = smoothstep(0.8, 0.95, sweep) * (1.0 - smoothstep(0.95, 1.0, sweep));
    totalEmissiveRadiance += vGlow * (0.45 + 0.55 * rabbit);
  } else {
    // Lights, fans, trays, pipes, paint: the vertex's own glow as is.
    totalEmissiveRadiance += vGlow;
  }
}
`;

export const HOLE_DECOR_CACHE_KEY = "ab-h2-hole-decor";

/** The baked hole decor: one draw call for every hole in the city. */
export class HoleDecorRenderer {
  readonly mesh: THREE.Mesh;
  readonly counts: { holes: number; quads: number; vertices: number };
  private readonly loop = { value: 0 };
  private readonly full = { value: 1 };

  constructor(buildings: readonly Building[]) {
    const byBlock = bucketByBlock(buildings);
    const spans = cityHoles(buildings);
    const quads = spans.flatMap((s) => holeDecorFor(s, byBlock));
    const baked = bakeDecor(quads);
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
    geometry.setAttribute("aGlow", new THREE.BufferAttribute(baked.glows, 3));
    geometry.setAttribute("aPivot", new THREE.BufferAttribute(baked.pivots, 4));
    geometry.setAttribute("aDecor", new THREE.BufferAttribute(baked.decor, 4));
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      // Decals sit DECAL off the lining: pull them forward a touch more in
      // depth so they never fight it at a distance.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    material.customProgramCacheKey = () => HOLE_DECOR_CACHE_KEY;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uDecorLoop = this.loop;
      shader.uniforms.uDecorFull = this.full;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${BEGIN_VERTEX}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>\n${FRAGMENT_EMISSIVE}`,
        );
    };
    // Identity model matrix: positions leave the vertex shader in world
    // space at the camera's torus image (the facade-life idiom).
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.counts = {
      holes: spans.length,
      quads: quads.length,
      vertices: baked.vertexCount,
    };
  }

  /** O3: interiors on High/Medium/Low; Mobile keeps only the guidance
   * (strips and chevrons) — a uniform, never a recompile. */
  setQuality(tier: QualityTier): void {
    this.full.value = QUALITY_PROFILES[tier].holeDecor;
  }

  /** Per frame: the synced clock (or local time before the first snapshot). */
  update(timeMs: number): void {
    this.loop.value = loopPhase(timeMs);
  }
}
