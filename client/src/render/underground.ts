// U5 underground life & light, drawn: the dressing that turns U4's bores
// into a bright, living world under the night city. The placement is the
// pure seam underground-layout.ts; this file only builds buffers from it.
//
// DRAW-CALL BUDGET: four draws for the whole network, whatever the view.
//   1. decor    — opaque, unlit: light panels, vines, moss, glowing
//                 mushrooms and ferns, hanging gardens, waterfall vents,
//                 channels, the lake, and the metro hall (floor, walls,
//                 platform, rails, stalls, mullions). Water flow, glow
//                 pulse run in its shader. Vines and fronds hang still:
//                 thin leaves creeping across pixels read as shimmer (O5).
//   2. veil     — transparent: the hall's glass, the waterfall sheets.
//   3. motes    — Points: fireflies and pollen drifting in the shader.
//   4. critters — birds looping under the ceiling and people walking the
//                 platform, posed in the shader from static attributes.
// The metro itself is three more cars in T2's train InstancedMesh (no draw).
//
// UNLIT, like the shell (tunnels.ts): a bore is under 40 m of rock, so the
// moon, the hemisphere fill and the storm's lightning never reach this.
// Vertex colours carry baked light. Every surface stays under the bloom
// threshold (0.72); only the light panels (LAMP rung) and the glowing
// mushrooms, ferns and fireflies (WINDOW rung) sit above it, on the ladder.
//
// TORUS AND TIERS. As with the shell, each band (core / detail / fine) is
// wrapped into one canonical period, copied 2×2 and snapped by whole
// periods under the camera. The bands are concatenated in order, so a tier
// keeps a PREFIX — a drawRange that always ends on a band boundary, so a
// kept item has all four images and a dropped one has none.
//
// TIME. One uniform, the world clock main.ts latches (the one the QA
// harness pins), wrapped modulo TIME_WRAP so a float never loses its
// fraction; no per-frame allocation, nothing re-uploaded.

import {
  BORE_FLOOR_Y,
  TUNNELS,
  type Tunnel,
} from "@angels-bandits/common/city/tunnels";
import {
  EMISSIVE_LAMP,
  EMISSIVE_WINDOW,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { SHELL_CEILING, SHELL_WALL_MID, snapToPeriod } from "./tunnels";
import {
  BANDS,
  BIRD_BOB,
  DEEP_CEIL,
  LAKE,
  LINING,
  STATION,
  type UndergroundLayout,
  boreXZ,
  undergroundLayout,
} from "./underground-layout";

/** Program cache keys (three keys programs on onBeforeCompile.toString()
 * otherwise; see traffic.ts). */
export const DECOR_CACHE_KEY = "ab-u5-decor";
export const VEIL_CACHE_KEY = "ab-u5-veil";
export const MOTES_CACHE_KEY = "ab-u5-motes";
export const CRITTERS_CACHE_KEY = "ab-u5-critters";

/** The shader clock wraps here, s (an hour, like the train's). */
const TIME_WRAP = 3600;
/** Longest edge of a split strip, m: no triangle stretches over the seam. */
const MAX_EDGE = 8;

/** aAnim.x: what a vertex does. */
export const ANIM = {
  still: 0,
  /** Water: bright ripples travel along aAnim.y at aAnim.z m/s. */
  flow: 1,
  /** Bioluminescence: breathes on phase aAnim.y (WINDOW rung at peak). */
  glow: 2,
  /** Thin dressing (vine strands, leaves, fronds): fades into the surface
   * behind it — the wall (aAnim.y 0) or the ceiling (1) — with distance,
   * so a sub-pixel sliver never sparkles (O1's abLine rule, in geometry).
   * U5b: and at its edges — aAnim.zw are edge coordinates (0 on an edge;
   * aAnim.y + 2 on a triangle, whose third is 1 − z − w), so its outer
   * pixel fades into that surface too: an edge never pops on or off. */
  thin: 3,
  /** Falling water: streaks fall down aAnim.y (height), across aAnim.z. */
  fall: 4,
  /** A light panel or a stall lamp (LAMP rung, still). */
  lamp: 5,
} as const;

/** Linear colour of `hex` lit by `k`. */
const lit = (hex: number, k: number): THREE.Color =>
  new THREE.Color(hex).multiplyScalar(k);
/** Linear colour that puts `hex` on ladder rung `rung`. */
function emitOf(hex: number, rung: number): THREE.Color {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(emissiveBoost(c, rung));
}

const C = {
  panel: emitOf(0xfff2dc, EMISSIVE_LAMP),
  panelRim: lit(0xe9dcc4, 0.7),
  vineDark: lit(0x2f6a2c, 0.55),
  vineLight: lit(0x6fb04a, 0.75),
  leaf: lit(0x58a03e, 0.8),
  moss: lit(0x4f7f34, 0.62),
  mossDeep: lit(0x2f6f5a, 0.6),
  stem: lit(0xd9d2bf, 0.6),
  caps: [
    emitOf(0x52f0ff, EMISSIVE_WINDOW),
    emitOf(0xb27cff, EMISSIVE_WINDOW),
    emitOf(0x8cff7a, EMISSIVE_WINDOW),
  ],
  fernBase: lit(0x2d5f3a, 0.6),
  planter: lit(0x8b6a4c, 0.6),
  frond: lit(0x5fa646, 0.75),
  flowers: [lit(0xff8fb1, 0.7), lit(0xffd36a, 0.7), lit(0xf2f0ff, 0.62)],
  vent: lit(0x2a2f36, 0.6),
  lip: lit(0xb9ad98, 0.6),
  kerb: lit(0xcfc4ae, 0.62),
  water: lit(0x3fa6b8, 0.6),
  lake: lit(0x2f8fa8, 0.58),
  lily: lit(0x4c9a46, 0.6),
  bud: emitOf(0xffe6f2, EMISSIVE_WINDOW),
  hallFloor: lit(0xb7a88f, 0.62),
  platform: lit(0xd8cdb6, 0.66),
  safety: lit(0xf2c641, 0.7),
  bed: lit(0x4a4640, 0.55),
  rail: lit(0x9aa0a6, 0.6),
  tile: lit(0x5fb7ad, 0.62),
  sign: lit(0x2f6fb0, 0.62),
  plaster: lit(0xf1e6d2, 0.7),
  ceiling: lit(0xfff1da, 0.72),
  portal: new THREE.Color(0.012, 0.012, 0.016),
  mullion: lit(0x3a3f46, 0.6),
  counter: lit(0x9a7552, 0.6),
  awnings: [lit(0xd8473f, 0.62), lit(0x2f9e6e, 0.62), lit(0xe7a83a, 0.62)],
  awningStripe: lit(0xf4ecdc, 0.68),
  lamp: emitOf(0xffd9a0, EMISSIVE_LAMP),
  wares: [lit(0xe0563a, 0.66), lit(0xf0c040, 0.66), lit(0x7cc04a, 0.66)],
} as const;

const GLASS = { color: lit(0xcfe6f0, 0.6), alpha: 0.14 };
const SHEET = { color: lit(0xcfeefa, 0.66), alpha: 0.55 };
const FOAM = lit(0xe9f6fb, 0.7);
/** Firefly and pollen colours; fireflies on the WINDOW rung at peak. */
const FIREFLY = emitOf(0xd8ff7a, EMISSIVE_WINDOW);
const POLLEN = lit(0xfff3cf, 0.5);
const BIRD_COLORS = [
  lit(0x3b3532, 0.6),
  lit(0x6b5a4a, 0.6),
  lit(0xd8d0c4, 0.6),
];
const COAT_COLORS = [
  0x6b5a4a, 0x4a5a6b, 0x7a3b3b, 0x5d6b4a, 0x8a7a6a, 0xb58a3a,
].map((c) => lit(c, 0.8));

type P3 = [number, number, number];
type RGBA = readonly [number, number, number, number];
type Anim = readonly [number, number, number, number];
const STILL: Anim = [ANIM.still, 0, 0, 0];
/** Thin dressing over the wall (0) or the ceiling (1), at edge
 * coordinates (e1, e2) — see ANIM.thin. */
const thin = (behind: 0 | 1, e1: number, e2: number, tri = false): Anim => [
  ANIM.thin,
  behind + (tri ? 2 : 0),
  e1,
  e2,
];
/** A thin triangle's corners: two barycentrics each (the third implied). */
const thinTri = (behind: 0 | 1): readonly [Anim, Anim, Anim] => [
  thin(behind, 1, 0, true),
  thin(behind, 0, 1, true),
  thin(behind, 0, 0, true),
];
/** A thin quad a→b→c→d whose long edges are a–d and b–c. */
const thinQuad = (behind: 0 | 1): readonly [Anim, Anim, Anim, Anim] => [
  thin(behind, 0, 1),
  thin(behind, 1, 0),
  thin(behind, 1, 0),
  thin(behind, 0, 1),
];
const rgba = (c: THREE.Color, a = 1): RGBA => [c.r, c.g, c.b, a];

const scratch = { x: 0, z: 0, th: 0 };
/** A bore-frame point (s, lat, height) as an unwrapped world point. */
function at(t: Tunnel, s: number, lat: number, y: number): P3 {
  boreXZ(t, s, lat, scratch);
  return [scratch.x, y, scratch.z];
}

/** A triangle soup with RGBA colour and an animation vec4 per vertex. */
class Soup {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly anim: number[] = [];

  vertex(p: P3, c: RGBA, a: Anim): void {
    this.pos.push(p[0], p[1], p[2]);
    this.col.push(c[0], c[1], c[2], c[3]);
    this.anim.push(a[0], a[1], a[2], a[3]);
  }

  /** Quad a→b→c→d with a colour and an animation per corner. */
  quad(
    p: readonly [P3, P3, P3, P3],
    c: RGBA | readonly [RGBA, RGBA, RGBA, RGBA],
    a: Anim | readonly [Anim, Anim, Anim, Anim] = STILL,
  ): void {
    const cs = (typeof c[0] === "number" ? [c, c, c, c] : c) as readonly RGBA[];
    const as = (typeof a[0] === "number" ? [a, a, a, a] : a) as readonly Anim[];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      this.vertex(p[i] as P3, cs[i] as RGBA, as[i] as Anim);
    }
  }

  tri(
    p: readonly [P3, P3, P3],
    c: RGBA,
    a: Anim | readonly [Anim, Anim, Anim] = STILL,
  ): void {
    const as = (typeof a[0] === "number" ? [a, a, a] : a) as readonly Anim[];
    for (let i = 0; i < 3; i++) this.vertex(p[i] as P3, c, as[i] as Anim);
  }
}

/** Bands of soups → one geometry: each band wrapped by triangle centroid
 * into one period and tiled 2×2, bands concatenated. Returns the geometry
 * and each band's END (vertices). */
function tiledGeometry(bands: readonly Soup[]): {
  geometry: THREE.BufferGeometry;
  ends: number[];
} {
  let total = 0;
  for (const b of bands) total += b.pos.length / 3;
  const pos = new Float32Array(total * 3 * 4);
  const col = new Float32Array(total * 4 * 4);
  const anim = new Float32Array(total * 4 * 4);
  const ends: number[] = [];
  let base = 0;
  for (const soup of bands) {
    const n = soup.pos.length / 3;
    for (let t = 0; t < n; t += 3) {
      const cx =
        ((soup.pos[t * 3] as number) +
          (soup.pos[t * 3 + 3] as number) +
          (soup.pos[t * 3 + 6] as number)) /
        3;
      const cz =
        ((soup.pos[t * 3 + 2] as number) +
          (soup.pos[t * 3 + 5] as number) +
          (soup.pos[t * 3 + 8] as number)) /
        3;
      const sx = Math.floor(cx / WORLD_SIZE) * WORLD_SIZE;
      const sz = Math.floor(cz / WORLD_SIZE) * WORLD_SIZE;
      let k = 0;
      for (const ox of [0, WORLD_SIZE]) {
        for (const oz of [0, WORLD_SIZE]) {
          for (let v = t; v < t + 3; v++) {
            const o = base + k * n + v;
            pos[o * 3] = (soup.pos[v * 3] as number) - sx + ox;
            pos[o * 3 + 1] = soup.pos[v * 3 + 1] as number;
            pos[o * 3 + 2] = (soup.pos[v * 3 + 2] as number) - sz + oz;
            for (let j = 0; j < 4; j++) {
              col[o * 4 + j] = soup.col[v * 4 + j] as number;
              anim[o * 4 + j] = soup.anim[v * 4 + j] as number;
            }
          }
          k++;
        }
      }
    }
    base += n * 4;
    ends.push(base);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(col, 4));
  geometry.setAttribute("aAnim", new THREE.BufferAttribute(anim, 4));
  return { geometry, ends };
}

// --- Decor -------------------------------------------------------------------

const H = 18; // BORE_WIDTH / 2

/** A strip on a wall face (lat = side·(H − off)) from s0 to s1, y0 to y1,
 * split so no edge exceeds MAX_EDGE. */
function wallStrip(
  soup: Soup,
  t: Tunnel,
  side: 1 | -1,
  off: number,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  lo: RGBA,
  hi: RGBA,
  a: Anim | ((s: number, y: number) => Anim) = STILL,
): void {
  const ns = Math.max(1, Math.ceil((s1 - s0) / MAX_EDGE));
  const ny = Math.max(1, Math.ceil((y1 - y0) / MAX_EDGE));
  const lat = side * (H - off);
  const an = (s: number, y: number): Anim =>
    typeof a === "function" ? a(s, y) : a;
  for (let i = 0; i < ns; i++) {
    const sa = s0 + ((s1 - s0) * i) / ns;
    const sb = s0 + ((s1 - s0) * (i + 1)) / ns;
    for (let j = 0; j < ny; j++) {
      const ya = y0 + ((y1 - y0) * j) / ny;
      const yb = y0 + ((y1 - y0) * (j + 1)) / ny;
      const fa = (ya - y0) / (y1 - y0);
      const fb = (yb - y0) / (y1 - y0);
      const ca = mixC(lo, hi, fa);
      const cb = mixC(lo, hi, fb);
      soup.quad(
        [
          at(t, sa, lat, ya),
          at(t, sb, lat, ya),
          at(t, sb, lat, yb),
          at(t, sa, lat, yb),
        ],
        [ca, ca, cb, cb],
        [an(sa, ya), an(sb, ya), an(sb, yb), an(sa, yb)],
      );
    }
  }
}

/** A horizontal strip at height y, lateral la → lb, s0 → s1, split. */
function flatStrip(
  soup: Soup,
  t: Tunnel,
  s0: number,
  s1: number,
  la: number,
  lb: number,
  y: number,
  c: RGBA,
  a: Anim | ((s: number) => Anim) = STILL,
): void {
  const ns = Math.max(1, Math.ceil((s1 - s0) / MAX_EDGE));
  const nl = Math.max(1, Math.ceil(Math.abs(lb - la) / MAX_EDGE));
  const an = (s: number): Anim => (typeof a === "function" ? a(s) : a);
  for (let i = 0; i < ns; i++) {
    const sa = s0 + ((s1 - s0) * i) / ns;
    const sb = s0 + ((s1 - s0) * (i + 1)) / ns;
    for (let j = 0; j < nl; j++) {
      const l0 = la + ((lb - la) * j) / nl;
      const l1 = la + ((lb - la) * (j + 1)) / nl;
      soup.quad(
        [
          at(t, sa, l0, y),
          at(t, sb, l0, y),
          at(t, sb, l1, y),
          at(t, sa, l1, y),
        ],
        c,
        [an(sa), an(sb), an(sb), an(sa)],
      );
    }
  }
}

/** A vertical face across the bore (constant s), lateral la → lb, split. */
function crossFace(
  soup: Soup,
  t: Tunnel,
  s: number,
  la: number,
  lb: number,
  y0: number,
  y1: number,
  c: RGBA,
  a: Anim = STILL,
): void {
  const nl = Math.max(1, Math.ceil(Math.abs(lb - la) / MAX_EDGE));
  const ny = Math.max(1, Math.ceil((y1 - y0) / MAX_EDGE));
  for (let j = 0; j < nl; j++) {
    const l0 = la + ((lb - la) * j) / nl;
    const l1 = la + ((lb - la) * (j + 1)) / nl;
    for (let k = 0; k < ny; k++) {
      const ya = y0 + ((y1 - y0) * k) / ny;
      const yb = y0 + ((y1 - y0) * (k + 1)) / ny;
      soup.quad(
        [
          at(t, s, l0, ya),
          at(t, s, l1, ya),
          at(t, s, l1, yb),
          at(t, s, l0, yb),
        ],
        c,
        a,
      );
    }
  }
}

/** A vertical face along the bore (constant lat), s0 → s1, split. */
function alongFace(
  soup: Soup,
  t: Tunnel,
  lat: number,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  c: RGBA,
  a: Anim = STILL,
): void {
  const ns = Math.max(1, Math.ceil((s1 - s0) / MAX_EDGE));
  const ny = Math.max(1, Math.ceil((y1 - y0) / MAX_EDGE));
  for (let i = 0; i < ns; i++) {
    const sa = s0 + ((s1 - s0) * i) / ns;
    const sb = s0 + ((s1 - s0) * (i + 1)) / ns;
    for (let k = 0; k < ny; k++) {
      const ya = y0 + ((y1 - y0) * k) / ny;
      const yb = y0 + ((y1 - y0) * (k + 1)) / ny;
      soup.quad(
        [
          at(t, sa, lat, ya),
          at(t, sb, lat, ya),
          at(t, sb, lat, yb),
          at(t, sa, lat, yb),
        ],
        c,
        a,
      );
    }
  }
}

/** A box in the bore frame: s0..s1, lateral la..lb, y0..y1 (every face
 * but the bottom), split so no edge exceeds MAX_EDGE. */
function frameBox(
  soup: Soup,
  t: Tunnel,
  s0: number,
  s1: number,
  la: number,
  lb: number,
  y0: number,
  y1: number,
  c: RGBA,
  top: RGBA = c,
  a: Anim = STILL,
): void {
  flatStrip(soup, t, s0, s1, la, lb, y1, top, a);
  alongFace(soup, t, la, s0, s1, y0, y1, c, a);
  alongFace(soup, t, lb, s0, s1, y0, y1, c, a);
  crossFace(soup, t, s0, la, lb, y0, y1, c, a);
  crossFace(soup, t, s1, la, lb, y0, y1, c, a);
}

const mixC = (a: RGBA, b: RGBA, f: number): RGBA => [
  a[0] + (b[0] - a[0]) * f,
  a[1] + (b[1] - a[1]) * f,
  a[2] + (b[2] - a[2]) * f,
  a[3] + (b[3] - a[3]) * f,
];

const F = BORE_FLOOR_Y;

function buildDecor(L: UndergroundLayout, bands: Soup[]): void {
  for (const p of L.panels) {
    const soup = bands[p.band] as Soup;
    const y = DEEP_CEIL - 0.06;
    const q = (ds: number, dl: number) => at(p.t, p.s + ds, p.lat + dl, y);
    soup.quad(
      [
        q(-p.hl - 0.15, -p.hw - 0.15),
        q(p.hl + 0.15, -p.hw - 0.15),
        q(p.hl + 0.15, p.hw + 0.15),
        q(-p.hl - 0.15, p.hw + 0.15),
      ],
      rgba(C.panelRim),
    );
    const yl = y - 0.04;
    const r = (ds: number, dl: number) => at(p.t, p.s + ds, p.lat + dl, yl);
    soup.quad(
      [r(-p.hl, -p.hw), r(p.hl, -p.hw), r(p.hl, p.hw), r(-p.hl, p.hw)],
      rgba(C.panel),
      [ANIM.lamp, 0, 0, 0],
    );
  }

  for (const v of L.vines) {
    const soup = bands[v.band] as Soup;
    const strands = 3;
    for (let j = 0; j < strands; j++) {
      const s0 = v.s - v.width / 2 + (v.width * j) / strands;
      const s1 = s0 + (v.width / strands) * 0.8;
      const len =
        v.length *
        (0.65 + (0.35 * ((j * 7 + Math.floor(v.shade * 5)) % 3)) / 2);
      const off = 0.08 + 0.05 * j;
      const top = DEEP_CEIL;
      const bot = top - len;
      // Edge coordinates across the whole strand, not per split piece.
      const across = (s: number): Anim => {
        const u = (s - s0) / (s1 - s0);
        return thin(0, u, 1 - u);
      };
      wallStrip(
        soup,
        v.t,
        v.side,
        off,
        s0,
        s1,
        bot,
        top,
        rgba(C.vineLight),
        rgba(C.vineDark),
        across,
      );
      // Leaves angled off the wall, still well inside the lining.
      for (let y = top - 1; y > bot + 0.3; y -= 1.1) {
        const sm = (s0 + s1) / 2 + (((y * 3.1) % 1) - 0.5) * 0.4;
        const lw = v.side * (H - off);
        const lo = v.side * (H - 0.6);
        soup.tri(
          [
            at(v.t, sm - 0.25, lw, y),
            at(v.t, sm + 0.25, lw, y - 0.15),
            at(v.t, sm, lo, y - 0.45),
          ],
          rgba(C.leaf),
          thinTri(0),
        );
      }
    }
  }

  for (const m of L.moss) {
    const soup = bands[m.band] as Soup;
    const deep = m.shade > 0.55;
    const c = rgba(deep ? C.mossDeep : C.moss);
    const c2 = mixC(c, rgba(C.vineLight), 0.25);
    wallStrip(
      soup,
      m.t,
      m.side,
      0.06,
      m.s - m.hl,
      m.s + m.hl,
      F + m.y0,
      F + m.y1,
      c,
      c2,
    );
    // A mound at the wall's foot: a slope from the wall out to 0.7 m.
    const w = m.side * (H - 0.02);
    const o = m.side * (H - 0.7);
    soup.quad(
      [
        at(m.t, m.s - m.hl, o, F + 0.02),
        at(m.t, m.s + m.hl, o, F + 0.02),
        at(m.t, m.s + m.hl, w, F + 0.3),
        at(m.t, m.s - m.hl, w, F + 0.3),
      ],
      c,
    );
  }

  for (const g of L.glows) {
    const soup = bands[g.band] as Soup;
    const lat = g.side * (H - g.inset);
    const glow: Anim = [ANIM.glow, g.phase, 0, 0];
    if (g.kind === "mushroom") {
      const cap = C.caps[
        Math.floor(g.hue * C.caps.length) % C.caps.length
      ] as THREE.Color;
      const sw = Math.max(0.04, g.size * 0.22);
      const top = F + g.height;
      // Stem: two crossed quads.
      soup.quad(
        [
          at(g.t, g.s - sw, lat, F),
          at(g.t, g.s + sw, lat, F),
          at(g.t, g.s + sw, lat, top),
          at(g.t, g.s - sw, lat, top),
        ],
        rgba(C.stem),
      );
      soup.quad(
        [
          at(g.t, g.s, lat - sw, F),
          at(g.t, g.s, lat + sw, F),
          at(g.t, g.s, lat + sw, top),
          at(g.t, g.s, lat - sw, top),
        ],
        rgba(C.stem),
      );
      // Cap: a low four-sided dome.
      const apex = at(g.t, g.s, lat, top + g.size * 0.55);
      const rim = [
        at(g.t, g.s - g.size, lat, top - 0.05),
        at(g.t, g.s, lat - g.size, top - 0.05),
        at(g.t, g.s + g.size, lat, top - 0.05),
        at(g.t, g.s, lat + g.size, top - 0.05),
      ] as const;
      for (let i = 0; i < 4; i++) {
        soup.tri([rim[i] as P3, rim[(i + 1) % 4] as P3, apex], rgba(cap), glow);
      }
    } else {
      const tip = C.caps[
        Math.floor(g.hue * C.caps.length) % C.caps.length
      ] as THREE.Color;
      for (let i = 0; i < 3; i++) {
        const ang = (i - 1) * 0.45;
        const ds = Math.sin(ang) * g.size * 1.6;
        const dl = -g.side * Math.abs(Math.cos(ang)) * g.size * 0.6;
        const base = at(g.t, g.s, lat, F);
        const t1 = at(g.t, g.s + ds - 0.08, lat + dl, F + g.height);
        const t2 = at(g.t, g.s + ds + 0.08, lat + dl, F + g.height);
        soup.vertex(base, rgba(C.fernBase), STILL);
        soup.vertex(t1, rgba(tip), glow);
        soup.vertex(t2, rgba(tip), glow);
      }
    }
  }

  for (const g of L.gardens) {
    const soup = bands[g.band] as Soup;
    const la = g.lat - 0.6;
    const lb = g.lat + 0.6;
    frameBox(
      soup,
      g.t,
      g.s - g.hl,
      g.s + g.hl,
      la,
      lb,
      DEEP_CEIL - 0.5,
      DEEP_CEIL - 0.02,
      rgba(C.planter),
    );
    for (let i = 0; i < g.fronds; i++) {
      const f = (i + 0.5) / g.fronds;
      const s = g.s - g.hl + 2 * g.hl * f;
      const len = 0.5 + ((i * 0.37 + g.s * 0.013) % 1) * 0.9; // ≤ 1.4 under the planter
      const top = DEEP_CEIL - 0.5;
      const bot = Math.max(DEEP_CEIL - LINING + 0.02, top - len);
      const l = g.lat + ((i % 3) - 1) * 0.35;
      soup.quad(
        [
          at(g.t, s - 0.18, l, top),
          at(g.t, s + 0.18, l, top),
          at(g.t, s + 0.12, l, bot),
          at(g.t, s - 0.12, l, bot),
        ],
        [rgba(C.frond), rgba(C.frond), rgba(C.vineLight), rgba(C.vineLight)],
        thinQuad(1),
      );
      if (i % 2 === 0) {
        const fl = C.flowers[i % C.flowers.length] as THREE.Color;
        soup.tri(
          [
            at(g.t, s - 0.15, l, bot),
            at(g.t, s + 0.15, l, bot),
            at(g.t, s, l + 0.15, bot + 0.2),
          ],
          rgba(fl),
          thinTri(1),
        );
      }
    }
  }

  for (const w of L.waterfalls) {
    const soup = bands[w.band] as Soup;
    // The vent: a dark mouth and a stone lip over it.
    wallStrip(
      soup,
      w.t,
      w.side,
      0.04,
      w.s - w.hw - 0.3,
      w.s + w.hw + 0.3,
      F + w.top - 0.5,
      F + w.top + 0.9,
      rgba(C.vent),
      rgba(C.vent),
    );
    const l0 = w.side * (H - 0.45);
    const l1 = w.side * (H - 0.04);
    frameBox(
      soup,
      w.t,
      w.s - w.hw - 0.4,
      w.s + w.hw + 0.4,
      Math.min(l0, l1),
      Math.max(l0, l1),
      F + w.top + 0.9,
      F + w.top + 1.15,
      rgba(C.lip),
    );
    // Foam where it lands in the channel.
    const fo = w.side * (H - 0.9);
    const fi = w.side * (H - 0.1);
    flatStrip(
      soup,
      w.t,
      w.s - w.hw,
      w.s + w.hw,
      Math.min(fo, fi),
      Math.max(fo, fi),
      F + 0.3,
      rgba(FOAM),
      [ANIM.flow, 0, 1.5, 0],
    );
  }

  for (const ch of L.channels) {
    const soup = bands[0] as Soup;
    const kerbIn = ch.side * (H - 1.4);
    const kerbOut = ch.side * (H - 1.25);
    // The kerb's inner face, its top, then the water up to the wall.
    for (let s = ch.s0; s < ch.s1; s += MAX_EDGE) {
      const sb = Math.min(ch.s1, s + MAX_EDGE);
      soup.quad(
        [
          at(ch.t, s, kerbIn, F),
          at(ch.t, sb, kerbIn, F),
          at(ch.t, sb, kerbIn, F + 0.35),
          at(ch.t, s, kerbIn, F + 0.35),
        ],
        rgba(C.kerb),
      );
    }
    flatStrip(
      soup,
      ch.t,
      ch.s0,
      ch.s1,
      Math.min(kerbIn, kerbOut),
      Math.max(kerbIn, kerbOut),
      F + 0.35,
      rgba(C.kerb),
    );
    const wa = ch.side * (H - 1.25);
    const wb = ch.side * (H - 0.02);
    flatStrip(
      soup,
      ch.t,
      ch.s0,
      ch.s1,
      Math.min(wa, wb),
      Math.max(wa, wb),
      F + 0.25,
      rgba(C.water),
      (s) => [ANIM.flow, s, 1.2, 0],
    );
    // End caps where a channel meets the lake.
    for (const s of [ch.s0, ch.s1])
      crossFace(
        soup,
        ch.t,
        s,
        Math.min(kerbIn, ch.side * H),
        Math.max(kerbIn, ch.side * H),
        F,
        F + 0.25,
        rgba(C.kerb),
      );
  }

  buildLake(bands);
  buildStation(L, bands);
}

function buildLake(bands: Soup[]): void {
  const t = TUNNELS[LAKE.tunnel] as Tunnel;
  const core = bands[0] as Soup;
  const y = F + LAKE.rise;
  // Shore kerbs across the bore at both ends (0.4 high), then the water.
  for (const [a, b] of [
    [LAKE.s0 - 0.4, LAKE.s0],
    [LAKE.s1, LAKE.s1 + 0.4],
  ] as const) {
    frameBox(core, t, a, b, -H + 0.02, H - 0.02, F, F + 0.4, rgba(C.kerb));
  }
  flatStrip(
    core,
    t,
    LAKE.s0,
    LAKE.s1,
    -H + 0.02,
    H - 0.02,
    y,
    rgba(C.lake),
    (s) => [ANIM.flow, s, 0.3, 0],
  );
  // Lily pads and glowing buds (detail).
  const detail = bands[1] as Soup;
  for (let k = 0; k < 24; k++) {
    const s = LAKE.s0 + 4 + ((k * 37) % 72);
    const lat = ((k * 53) % 31) - 15;
    const r = 0.6 + ((k * 7) % 5) * 0.12;
    const yp = y + 0.06;
    const c = at(t, s, lat, yp);
    for (let i = 0; i < 6; i++) {
      const a0 = (i / 6) * Math.PI * 2;
      const a1 = ((i + 1) / 6) * Math.PI * 2;
      if (i === 0) continue; // the notch
      core.vertex(c, rgba(C.lily), STILL);
      core.vertex(
        at(t, s + Math.cos(a0) * r, lat + Math.sin(a0) * r, yp),
        rgba(C.lily),
        STILL,
      );
      core.vertex(
        at(t, s + Math.cos(a1) * r, lat + Math.sin(a1) * r, yp),
        rgba(C.lily),
        STILL,
      );
    }
    if (k % 3 === 0) {
      const glow: Anim = [ANIM.glow, k, 0, 0];
      detail.tri(
        [
          at(t, s - 0.12, lat, yp),
          at(t, s + 0.12, lat, yp),
          at(t, s, lat, yp + 0.35),
        ],
        rgba(C.bud),
        glow,
      );
      detail.tri(
        [
          at(t, s, lat - 0.12, yp),
          at(t, s, lat + 0.12, yp),
          at(t, s, lat, yp + 0.35),
        ],
        rgba(C.bud),
        glow,
      );
    }
  }
}

/** The metro hall: everything at lat ≥ H on the station side, in the rock
 * behind the glass. Core on every tier — it is what the glass shows. */
function buildStation(L: UndergroundLayout, bands: Soup[]): void {
  const t = TUNNELS[STATION.tunnel] as Tunnel;
  const core = bands[0] as Soup;
  const sd = STATION.side;
  const { s0, s1, back, edge, track, platformH } = STATION;
  const L0 = (l: number) => sd * l;
  const lo = (a: number, b: number) => Math.min(L0(a), L0(b));
  const hi = (a: number, b: number) => Math.max(L0(a), L0(b));
  const top = DEEP_CEIL;
  // Track bed, rails.
  flatStrip(core, t, s0, s1, lo(edge, back), hi(edge, back), F, rgba(C.bed));
  for (const r of [track - 0.75, track + 0.75]) {
    frameBox(
      core,
      t,
      s0,
      s1,
      lo(r - 0.06, r + 0.06),
      hi(r - 0.06, r + 0.06),
      F,
      F + 0.16,
      rgba(C.rail),
    );
  }
  // Platform: its top (safety line at the edge) and its edge face.
  flatStrip(
    core,
    t,
    s0,
    s1,
    lo(H, edge - 0.5),
    hi(H, edge - 0.5),
    F + platformH,
    rgba(C.platform),
  );
  flatStrip(
    core,
    t,
    s0,
    s1,
    lo(edge - 0.5, edge),
    hi(edge - 0.5, edge),
    F + platformH,
    rgba(C.safety),
  );
  for (let s = s0; s < s1; s += MAX_EDGE) {
    const sb = Math.min(s1, s + MAX_EDGE);
    core.quad(
      [
        at(t, s, L0(edge), F),
        at(t, sb, L0(edge), F),
        at(t, sb, L0(edge), F + platformH),
        at(t, s, L0(edge), F + platformH),
      ],
      rgba(C.kerb),
    );
  }
  // Back wall: tiles low, the line's colour band, plaster up to a glowing
  // ceiling.
  const backWall = (y0: number, y1: number, c: RGBA, c2 = c) => {
    for (let s = s0; s < s1; s += MAX_EDGE) {
      const sb = Math.min(s1, s + MAX_EDGE);
      const ny = Math.max(1, Math.ceil((y1 - y0) / MAX_EDGE));
      for (let j = 0; j < ny; j++) {
        const ya = y0 + ((y1 - y0) * j) / ny;
        const yb = y0 + ((y1 - y0) * (j + 1)) / ny;
        const ca = mixC(c, c2, (ya - y0) / (y1 - y0));
        const cb = mixC(c, c2, (yb - y0) / (y1 - y0));
        core.quad(
          [
            at(t, s, L0(back), ya),
            at(t, sb, L0(back), ya),
            at(t, sb, L0(back), yb),
            at(t, s, L0(back), yb),
          ],
          [ca, ca, cb, cb],
        );
      }
    }
  };
  backWall(F, F + 6, rgba(C.tile));
  backWall(F + 6, F + 7.2, rgba(C.sign));
  backWall(F + 7.2, top, rgba(C.plaster), rgba(C.ceiling));
  flatStrip(core, t, s0, s1, lo(H, back), hi(H, back), top, rgba(C.ceiling));
  // Hall ceiling panels: three rows.
  for (let s = s0 + 6; s < s1 - 3; s += 10) {
    for (const l of [H + 3.5, H + 8, H + 12.5]) {
      const y = top - 0.06;
      const p = (ds: number, dl: number) => at(t, s + ds, L0(l + dl), y);
      core.quad(
        [p(-2.2, -0.8), p(2.2, -0.8), p(2.2, 0.8), p(-2.2, 0.8)],
        rgba(C.panel),
        [ANIM.lamp, 0, 0, 0],
      );
    }
  }
  // End walls, each with a dark portal the metro runs through: the wall
  // round the opening, the opening's recess (sides, roof, a black back).
  const pw = 2.6;
  const ph = 6;
  for (const [s, dir] of [
    [s0, -1],
    [s1, 1],
  ] as const) {
    crossFace(core, t, s, lo(H, edge), hi(H, edge), F, top, rgba(C.plaster));
    crossFace(
      core,
      t,
      s,
      lo(edge, track - pw),
      hi(edge, track - pw),
      F,
      top,
      rgba(C.plaster),
    );
    crossFace(
      core,
      t,
      s,
      lo(track - pw, track + pw),
      hi(track - pw, track + pw),
      F + ph,
      top,
      rgba(C.plaster),
    );
    crossFace(
      core,
      t,
      s,
      lo(track + pw, back),
      hi(track + pw, back),
      F,
      top,
      rgba(C.plaster),
    );
    const deep = s + dir * 10;
    const sa = Math.min(s, deep);
    const sb = Math.max(s, deep);
    flatStrip(
      core,
      t,
      sa,
      sb,
      lo(track - pw, track + pw),
      hi(track - pw, track + pw),
      F + ph,
      rgba(C.portal),
    );
    flatStrip(
      core,
      t,
      sa,
      sb,
      lo(track - pw, track + pw),
      hi(track - pw, track + pw),
      F,
      rgba(C.portal),
    );
    for (const l of [track - pw, track + pw]) {
      for (let a = sa; a < sb; a += 5) {
        core.quad(
          [
            at(t, a, L0(l), F),
            at(t, a + 5, L0(l), F),
            at(t, a + 5, L0(l), F + ph),
            at(t, a, L0(l), F + ph),
          ],
          rgba(C.portal),
        );
      }
    }
    crossFace(
      core,
      t,
      deep,
      lo(track - pw, track + pw),
      hi(track - pw, track + pw),
      F,
      F + ph,
      rgba(C.portal),
    );
  }
  // Mullions on the bore side of the glass (in the lining), a sill and a
  // head rail.
  const m0 = H - 0.25;
  for (let s = s0; s <= s1 + 1e-6; s += STATION.pane) {
    frameBox(
      core,
      t,
      s - 0.15,
      s + 0.15,
      lo(m0, H),
      hi(m0, H),
      F,
      top,
      rgba(C.mullion),
    );
  }
  frameBox(
    core,
    t,
    s0,
    s1,
    lo(H - 0.4, H),
    hi(H - 0.4, H),
    F,
    F + 0.3,
    rgba(C.mullion),
  );
  frameBox(
    core,
    t,
    s0,
    s1,
    lo(H - 0.3, H),
    hi(H - 0.3, H),
    top - 0.3,
    top - 0.02,
    rgba(C.mullion),
  );
  // Market stalls on the platform.
  for (const st of L.stalls) {
    const soup = bands[st.band] as Soup;
    const y = F + platformH;
    const a = st.s - st.hl;
    const b = st.s + st.hl;
    frameBox(
      soup,
      t,
      a,
      b,
      lo(H + 1.6, H + 3.4),
      hi(H + 1.6, H + 3.4),
      y,
      y + 1.05,
      rgba(C.counter),
    );
    for (const s of [a + 0.1, b - 0.1]) {
      frameBox(
        soup,
        t,
        s - 0.06,
        s + 0.06,
        lo(H + 1.5, H + 1.62),
        hi(H + 1.5, H + 1.62),
        y,
        y + 2.6,
        rgba(C.mullion),
      );
    }
    const aw = C.awnings[
      Math.floor(st.hue * C.awnings.length) % C.awnings.length
    ] as THREE.Color;
    const n = 6;
    for (let i = 0; i < n; i++) {
      const sa = a - 0.2 + ((b - a + 0.4) * i) / n;
      const sb = a - 0.2 + ((b - a + 0.4) * (i + 1)) / n;
      const c = rgba(i % 2 === 0 ? aw : C.awningStripe);
      soup.quad(
        [
          at(t, sa, L0(H + 1.4), y + 2.7),
          at(t, sb, L0(H + 1.4), y + 2.7),
          at(t, sb, L0(H + 4.0), y + 2.3),
          at(t, sa, L0(H + 4.0), y + 2.3),
        ],
        c,
      );
    }
    // A string of lamps under the awning's front, wares on the counter.
    for (let s = a + 0.4; s < b; s += 0.9) {
      const p = (ds: number, dy: number) =>
        at(t, s + ds, L0(H + 3.9), y + 2.2 + dy);
      soup.quad(
        [p(-0.1, -0.1), p(0.1, -0.1), p(0.1, 0.1), p(-0.1, 0.1)],
        rgba(C.lamp),
        [ANIM.lamp, 0, 0, 0],
      );
    }
    for (let i = 0; i < 5; i++) {
      const s = a + 0.5 + i * ((b - a - 1) / 4);
      const w = C.wares[
        (i + Math.floor(st.hue * 7)) % C.wares.length
      ] as THREE.Color;
      frameBox(
        soup,
        t,
        s - 0.22,
        s + 0.22,
        lo(H + 1.9, H + 2.5),
        hi(H + 1.9, H + 2.5),
        y + 1.05,
        y + 1.3 + (i % 2) * 0.12,
        rgba(w),
      );
    }
  }
}

// --- Veil ---------------------------------------------------------------------

function buildVeil(L: UndergroundLayout, bands: Soup[]): void {
  // The glass first: core, never thinned, exactly the window gap.
  const t = TUNNELS[STATION.tunnel] as Tunnel;
  const core = bands[0] as Soup;
  const g = rgba(GLASS.color, GLASS.alpha);
  for (let s = STATION.s0; s < STATION.s1 - 1e-6; s += STATION.pane) {
    const sb = Math.min(STATION.s1, s + STATION.pane);
    const lat = STATION.side * H;
    for (const [y0, y1] of [
      [F, F + 8],
      [F + 8, F + 16],
      [F + 16, DEEP_CEIL],
    ] as const) {
      core.quad(
        [
          at(t, s, lat, y0),
          at(t, sb, lat, y0),
          at(t, sb, lat, y1),
          at(t, s, lat, y1),
        ],
        g,
      );
    }
  }
  for (const w of L.waterfalls) {
    const soup = bands[w.band] as Soup;
    wallStrip(
      soup,
      w.t,
      w.side,
      0.12,
      w.s - w.hw,
      w.s + w.hw,
      F + 0.25,
      F + w.top,
      rgba(SHEET.color, SHEET.alpha),
      rgba(SHEET.color, SHEET.alpha * 0.8),
      (s, y) => [ANIM.fall, y, s, 0],
    );
  }
}

// --- Motes and critters ---------------------------------------------------------

/** Points for the motes: base (tiled), colour, aMote (phase, amp, size, kind). */
function buildMotes(L: UndergroundLayout): {
  geometry: THREE.BufferGeometry;
  ends: number[];
} {
  const per: number[][] = [[], [], []];
  for (const m of L.motes) {
    const firefly = m.kind === "firefly";
    const c = firefly ? FIREFLY : POLLEN;
    (per[m.band] as number[]).push(
      m.x,
      m.y,
      m.z,
      c.r,
      c.g,
      c.b,
      m.phase,
      m.amp,
      firefly ? 0.45 : 0.16,
      firefly ? 1 : 0,
    );
  }
  const STRIDE = 10;
  let total = 0;
  for (const p of per) total += p.length / STRIDE;
  const pos = new Float32Array(total * 4 * 3);
  const col = new Float32Array(total * 4 * 3);
  const mote = new Float32Array(total * 4 * 4);
  const ends: number[] = [];
  let o = 0;
  for (const p of per) {
    for (let i = 0; i < p.length; i += STRIDE) {
      const x = wrap(p[i] as number);
      const z = wrap(p[i + 2] as number);
      for (const ox of [0, WORLD_SIZE]) {
        for (const oz of [0, WORLD_SIZE]) {
          pos.set([x + ox, p[i + 1] as number, z + oz], o * 3);
          col.set(
            [p[i + 3] as number, p[i + 4] as number, p[i + 5] as number],
            o * 3,
          );
          mote.set(
            [
              p[i + 6] as number,
              p[i + 7] as number,
              p[i + 8] as number,
              p[i + 9] as number,
            ],
            o * 4,
          );
          o++;
        }
      }
    }
    ends.push(o);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geometry.setAttribute("aMote", new THREE.BufferAttribute(mote, 4));
  return { geometry, ends };
}

const wrap = (v: number): number =>
  ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

/** Critter kinds (aMisc.x). */
const BIRD = 1;
const WALKER = 2;

/** One critter shape: local vertices (x forward, y up, z across) as tris. */
const BIRD_SHAPE: readonly P3[] = [
  // Body: a thin diamond, then the two wings.
  [0.6, 0, 0],
  [-0.5, 0.08, 0],
  [-0.5, -0.06, 0],
  [0.15, 0, 0],
  [-0.25, 0, 0],
  [-0.05, 0, 0.75],
  [0.15, 0, 0],
  [-0.05, 0, -0.75],
  [-0.25, 0, 0],
];
/** A standing figure: a box 0.5 × 1 × 0.35 (scaled by height), less its
 * bottom, plus a head. */
function walkerShape(h: number): P3[] {
  const w = 0.25;
  const d = 0.17;
  const body = h * 0.82;
  const out: P3[] = [];
  const box = (y0: number, y1: number, hw: number, hd: number) => {
    const p = (x: number, y: number, z: number): P3 => [x, y, z];
    const faces: P3[][] = [
      [p(-hd, y1, -hw), p(hd, y1, -hw), p(hd, y1, hw), p(-hd, y1, hw)],
      [p(-hd, y0, -hw), p(hd, y0, -hw), p(hd, y1, -hw), p(-hd, y1, -hw)],
      [p(-hd, y0, hw), p(hd, y0, hw), p(hd, y1, hw), p(-hd, y1, hw)],
      [p(-hd, y0, -hw), p(-hd, y0, hw), p(-hd, y1, hw), p(-hd, y1, -hw)],
      [p(hd, y0, -hw), p(hd, y0, hw), p(hd, y1, hw), p(hd, y1, -hw)],
    ];
    for (const f of faces)
      out.push(
        f[0] as P3,
        f[1] as P3,
        f[2] as P3,
        f[0] as P3,
        f[2] as P3,
        f[3] as P3,
      );
  };
  box(0, body, w, d);
  box(body + 0.02, h, 0.11, 0.11);
  return out;
}

function buildCritters(L: UndergroundLayout): {
  geometry: THREE.BufferGeometry;
  ends: number[];
} {
  type V = {
    local: P3;
    base: P3;
    move: number[];
    misc: number[];
    color: THREE.Color;
  };
  const per: V[][] = [[], [], []];
  L.birds.forEach((b, i) => {
    const c = BIRD_COLORS[i % BIRD_COLORS.length] as THREE.Color;
    for (const v of BIRD_SHAPE) {
      (per[b.band] as V[]).push({
        local: [v[0] * b.size * 1.4, v[1] * b.size, v[2] * b.size * 1.4],
        base: [b.x, b.y, b.z],
        move: [b.ux, b.uz, b.a, b.b],
        misc: [BIRD, b.speed, b.phase, 0],
        color: c,
      });
    }
  });
  for (const w of L.walkers) {
    const c = COAT_COLORS[
      Math.floor(w.shade * COAT_COLORS.length) % COAT_COLORS.length
    ] as THREE.Color;
    for (const v of walkerShape(w.height)) {
      (per[w.band] as V[]).push({
        local: v,
        base: [w.x, w.y, w.z],
        move: [w.ux, w.uz, w.length, w.speed],
        misc: [WALKER, w.phase, 0, 0],
        color: v[1] > w.height * 0.83 ? lit(0xd9b38c, 0.75) : c,
      });
    }
  }
  let total = 0;
  for (const p of per) total += p.length;
  const pos = new Float32Array(total * 4 * 3);
  const base = new Float32Array(total * 4 * 3);
  const move = new Float32Array(total * 4 * 4);
  const misc = new Float32Array(total * 4 * 4);
  const col = new Float32Array(total * 4 * 3);
  const ends: number[] = [];
  let o = 0;
  for (const p of per) {
    // Each critter's vertices are contiguous, and each copy of an item is
    // laid out whole: copy k of every vertex, then the next copy.
    for (const ox of [0, WORLD_SIZE]) {
      for (const oz of [0, WORLD_SIZE]) {
        for (const v of p) {
          pos.set(v.local, o * 3);
          base.set(
            [wrap(v.base[0]) + ox, v.base[1], wrap(v.base[2]) + oz],
            o * 3,
          );
          move.set(v.move, o * 4);
          misc.set(v.misc, o * 4);
          col.set([v.color.r, v.color.g, v.color.b], o * 3);
          o++;
        }
      }
    }
    ends.push(o);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("aBase", new THREE.BufferAttribute(base, 3));
  geometry.setAttribute("aMove", new THREE.BufferAttribute(move, 4));
  geometry.setAttribute("aMisc", new THREE.BufferAttribute(misc, 4));
  geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return { geometry, ends };
}

// --- Shaders ---------------------------------------------------------------------

const DECOR_VERTEX_PARS = /* glsl */ `
attribute vec4 aAnim;
uniform float uU5Time;
varying vec4 vAnim;
varying float vGlow;
varying float vThin;
`;
const DECOR_VERTEX = /* glsl */ `
vAnim = aAnim;
vGlow = 1.0;
vThin = 0.0;
if (aAnim.x > 2.5 && aAnim.x < 3.5) {
  vec4 thinView = modelViewMatrix * vec4(transformed, 1.0);
  vThin = smoothstep(20.0, 70.0, length(thinView.xyz));
}
if (aAnim.x > 1.5 && aAnim.x < 2.5) {
  vGlow = 0.72 + 0.28 * (0.5 + 0.5 * sin(uU5Time * 1.3 + aAnim.y));
}
`;
const DECOR_FRAGMENT_PARS = /* glsl */ `
uniform float uU5Time;
varying vec4 vAnim;
varying float vGlow;
varying float vThin;
`;
const glslColor = (c: THREE.Color): string =>
  `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
const DECOR_FRAGMENT = /* glsl */ `
diffuseColor.rgb *= vGlow;
// Derivatives outside any branch (undefined in non-uniform control flow).
vec3 thinEdge = vec3(vAnim.zw, 1.0 - vAnim.z - vAnim.w);
vec3 thinEdgeW = max(fwidth(thinEdge), vec3(1e-5));
if (vAnim.x > 2.5 && vAnim.x < 3.5) {
  // aAnim.y is 0..3 exactly; rounded, as an interpolated constant may
  // arrive an ulp off.
  float thinY = floor(vAnim.y + 0.5);
  vec3 behind = mod(thinY, 2.0) > 0.5 ? ${glslColor(SHELL_CEILING)} : ${glslColor(SHELL_WALL_MID)};
  // Pixels from the nearest edge; a quad has no third edge.
  vec3 px = thinEdge / thinEdgeW;
  float edgePx = min(px.x, thinY > 1.5 ? min(px.y, px.z) : px.y);
  float cover = clamp(edgePx, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, behind, max(vThin, 1.0 - cover));
}
if (vAnim.x > 0.5 && vAnim.x < 1.5) {
  float r = sin(vAnim.y * 1.7 - uU5Time * vAnim.z) *
    sin(vAnim.y * 0.63 + uU5Time * vAnim.z * 0.4 + 1.3);
  diffuseColor.rgb *= 0.92 + 0.12 * smoothstep(0.2, 1.0, r);
}
if (vAnim.x > 3.5 && vAnim.x < 4.5) {
  float n = 0.5 + 0.5 * sin(vAnim.z * 7.3);
  float f = fract((vAnim.y + uU5Time * 4.0 * (0.7 + 0.6 * n)) * 0.35);
  float streak = smoothstep(0.4, 1.0, f) * (1.0 - smoothstep(0.9, 1.0, f));
  diffuseColor.rgb *= 0.9 + 0.14 * streak;
  diffuseColor.a *= 0.85 + 0.15 * streak;
}
`;

const MOTES_VERTEX_PARS = /* glsl */ `
attribute vec4 aMote;
uniform float uU5Time;
varying float vMote;
`;
const MOTES_VERTEX = /* glsl */ `
float moteP = aMote.x;
float moteT = uU5Time;
transformed += aMote.y * vec3(
  sin(moteT * 0.31 + moteP),
  0.6 * sin(moteT * 0.47 + moteP * 1.7),
  cos(moteT * 0.27 + moteP * 2.3));
vMote = aMote.w > 0.5
  ? 0.25 + 0.75 * pow(0.5 + 0.5 * sin(moteT * 2.1 + moteP * 3.0), 3.0)
  : 0.8;
`;
/** After size attenuation: never a sub-pixel point (it would sparkle as it
 * drifts across pixels) — under 1.5 px it holds that size and dims instead;
 * and the motes fade out well inside the haze (they are not fogged). */
const MOTES_SIZE = /* glsl */ `
float motePx = gl_PointSize;
gl_PointSize = max(motePx, 1.5);
vMote *= min(1.0, motePx / 1.5) *
  (1.0 - smoothstep(50.0, 120.0, -mvPosition.z));
`;
const MOTES_FRAGMENT = /* glsl */ `
float d = length(gl_PointCoord - 0.5);
diffuseColor.rgb *= vMote;
diffuseColor.a *= smoothstep(0.5, 0.1, d);
`;

const CRITTERS_VERTEX_PARS = /* glsl */ `
attribute vec3 aBase;
attribute vec4 aMove;
attribute vec4 aMisc;
uniform float uU5Time;
`;
const CRITTERS_VERTEX = /* glsl */ `
vec2 u = aMove.xy;
vec2 left = vec2(-u.y, u.x);
vec3 loc = transformed;
vec3 at;
vec2 fwd;
if (aMisc.x < 1.5) {
  // A bird: an ellipse along the bore, a slow bob, flapping wings.
  float th = aMisc.z + aMisc.y * uU5Time;
  vec2 c = u * cos(th) * aMove.z + left * sin(th) * aMove.w;
  at = aBase + vec3(c.x, sin(th * 3.0 + aMisc.z) * ${BIRD_BOB.toFixed(2)}, c.y);
  vec2 d = (-u * sin(th) * aMove.z + left * cos(th) * aMove.w) * sign(aMisc.y);
  fwd = normalize(d);
  loc.y += abs(loc.z) * 0.8 * sin(uU5Time * 9.0 + aMisc.z * 5.0);
} else {
  // A walker: there and back along the platform, bobbing per step.
  float cyc = fract(uU5Time * aMove.w / (2.0 * aMove.z) + aMisc.y);
  float along = aMove.z * (1.0 - abs(2.0 * cyc - 1.0));
  at = aBase + vec3(u.x * along, abs(sin(along * 4.5)) * 0.05, u.y * along);
  fwd = u * (cyc < 0.5 ? 1.0 : -1.0);
}
vec2 side = vec2(-fwd.y, fwd.x);
transformed = at + vec3(fwd.x * loc.x + side.x * loc.z, loc.y,
  fwd.y * loc.x + side.y * loc.z);
// Far off, a critter shrinks to nothing rather than sparkle as a sub-pixel
// sliver (O5); the haze would have taken it anyway.
vec4 critterView = modelViewMatrix * vec4(at, 1.0);
transformed = mix(transformed, at,
  smoothstep(90.0, 140.0, length(critterView.xyz)));
`;

function patch(
  material: THREE.Material,
  key: string,
  time: { value: number },
  vPars: string,
  vBody: string,
  fPars: string,
  fBody: string,
): void {
  material.customProgramCacheKey = () => key;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uU5Time = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${vPars}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${vBody}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${fPars}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n${fBody}`,
      );
  };
}

// --- Geometry & renderer -------------------------------------------------------

export interface UndergroundBuffers {
  decor: { geometry: THREE.BufferGeometry; ends: number[] };
  veil: { geometry: THREE.BufferGeometry; ends: number[] };
  motes: { geometry: THREE.BufferGeometry; ends: number[] };
  critters: { geometry: THREE.BufferGeometry; ends: number[] };
}

/** Every buffer the renderer draws, banded. Exported for the tests. */
export function buildUndergroundBuffers(
  layout: UndergroundLayout = undergroundLayout(),
): UndergroundBuffers {
  const bands = (): Soup[] => Array.from({ length: BANDS }, () => new Soup());
  const decor = bands();
  buildDecor(layout, decor);
  const veil = bands();
  buildVeil(layout, veil);
  return {
    decor: tiledGeometry(decor),
    veil: tiledGeometry(veil),
    motes: buildMotes(layout),
    critters: buildCritters(layout),
  };
}

/** The underground's four draws. */
export class UndergroundLife {
  readonly group = new THREE.Group();
  readonly decor: THREE.Mesh;
  readonly veil: THREE.Mesh;
  readonly motes: THREE.Points;
  readonly critters: THREE.Mesh;
  private readonly buffers: UndergroundBuffers;
  private readonly time = { value: 0 };
  private bands: number = BANDS;

  constructor() {
    this.buffers = buildUndergroundBuffers();
    const time = this.time;

    const decorMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: true,
      // Panels and lips sit a few cm off the shell: never a z-fight.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    patch(
      decorMat,
      DECOR_CACHE_KEY,
      time,
      DECOR_VERTEX_PARS,
      DECOR_VERTEX,
      DECOR_FRAGMENT_PARS,
      DECOR_FRAGMENT,
    );
    this.decor = new THREE.Mesh(this.buffers.decor.geometry, decorMat);

    const veilMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    patch(
      veilMat,
      VEIL_CACHE_KEY,
      time,
      DECOR_VERTEX_PARS,
      DECOR_VERTEX,
      DECOR_FRAGMENT_PARS,
      DECOR_FRAGMENT,
    );
    this.veil = new THREE.Mesh(this.buffers.veil.geometry, veilMat);

    const motesMat = new THREE.PointsMaterial({
      size: 0.3,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Additive + fog brightens the distant scene (fountains.ts).
      fog: false,
    });
    patch(
      motesMat,
      MOTES_CACHE_KEY,
      time,
      MOTES_VERTEX_PARS,
      MOTES_VERTEX,
      "varying float vMote;",
      MOTES_FRAGMENT,
    );
    const onMotes = motesMat.onBeforeCompile;
    motesMat.onBeforeCompile = (shader, renderer) => {
      onMotes(shader, renderer);
      shader.vertexShader = shader.vertexShader
        .replace("gl_PointSize = size;", "gl_PointSize = size * aMote.z / 0.3;")
        .replace(
          "#include <logdepthbuf_vertex>",
          `${MOTES_SIZE}\n#include <logdepthbuf_vertex>`,
        );
    };
    this.motes = new THREE.Points(this.buffers.motes.geometry, motesMat);

    const critterMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: true,
    });
    patch(
      critterMat,
      CRITTERS_CACHE_KEY,
      time,
      CRITTERS_VERTEX_PARS,
      CRITTERS_VERTEX,
      "",
      "",
    );
    this.critters = new THREE.Mesh(this.buffers.critters.geometry, critterMat);

    // Spans 2×2 periods and animates in the shader: never culled as a
    // whole; opaque after the city (like the shell), transparents after.
    this.decor.renderOrder = 1;
    this.critters.renderOrder = 1;
    this.veil.renderOrder = 2;
    this.motes.renderOrder = 2;
    for (const o of [this.decor, this.veil, this.motes, this.critters]) {
      o.frustumCulled = false;
    }
    this.group.add(this.decor, this.veil, this.critters, this.motes);
    this.applyBands();
  }

  /** Snap under the camera; advance the shader clock (world ms). */
  update(cameraPos: Vec3, worldMs: number): void {
    snapToPeriod(this.group, cameraPos);
    this.time.value = (((worldMs / 1000) % TIME_WRAP) + TIME_WRAP) % TIME_WRAP;
  }

  /** O3: a tier keeps its first `tunnelLife` bands (a drawRange prefix
   * ending on a band boundary). Never a material change. */
  setQuality(tier: QualityTier): void {
    this.bands = Math.max(
      1,
      Math.min(BANDS, QUALITY_PROFILES[tier].tunnelLife),
    );
    this.applyBands();
  }

  /** Vertices drawn per buffer at the current tier (QA and the tests). */
  drawn(): { decor: number; veil: number; motes: number; critters: number } {
    return {
      decor: this.decor.geometry.drawRange.count,
      veil: this.veil.geometry.drawRange.count,
      motes: this.motes.geometry.drawRange.count,
      critters: this.critters.geometry.drawRange.count,
    };
  }

  private applyBands(): void {
    const b = this.buffers;
    const k = this.bands - 1;
    for (const [mesh, buf] of [
      [this.decor, b.decor],
      [this.veil, b.veil],
      [this.motes, b.motes],
      [this.critters, b.critters],
    ] as const) {
      mesh.geometry.setDrawRange(0, buf.ends[k] as number);
    }
  }
}
