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
  CAVEIN_WARN_MS,
  type CaveIn,
} from "@angels-bandits/common/city/caveins";
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
import {
  LOOK_BEHIND_GLSL,
  LOOK_NOISE_GLSL,
  LOOK_ZONES,
  TUNNEL_DETAIL,
  lookZoneAt,
} from "./tunnel-look";
import { snapToPeriod } from "./tunnels";
import {
  BANDS,
  BIRD_BOB,
  CABLE_SPAN,
  DEEP_CEIL,
  LAKE,
  LINING,
  STATION,
  type UndergroundLayout,
  boreXZ,
  undergroundLayout,
} from "./underground-layout";
import { nearestImageInto } from "./wrapPlacement";

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
  /** U7: glazed tile — grout drawn at bore-frame metres (aAnim.y, z). */
  tile: 6,
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
  panelRim: lit(0xc9bca4, 0.4),
  vineDark: lit(0x2f6a2c, 0.55),
  vineLight: lit(0x6fb04a, 0.75),
  leaf: lit(0x58a03e, 0.8),
  moss: lit(0x4f7f34, 0.62),
  mossDeep: lit(0x2f6f5a, 0.6),
  stem: lit(0xd9cdb0, 0.42),
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
  lip: lit(0x9a8e7a, 0.42),
  kerb: lit(0xa89c86, 0.42),
  water: lit(0x1f86a8, 0.55),
  lake: lit(0x1474b0, 0.58),
  lily: lit(0x4c9a46, 0.6),
  bud: emitOf(0xffe6f2, EMISSIVE_WINDOW),
  hallFloor: lit(0x8a96a4, 0.5),
  platform: lit(0xa8b4c2, 0.38),
  safety: lit(0xf2c641, 0.7),
  bed: lit(0x4a4640, 0.55),
  rail: lit(0x9aa0a6, 0.6),
  tile: lit(0xc4d6ec, 0.34),
  sign: lit(0x2f6fb0, 0.55),
  plaster: lit(0xb4c6dc, 0.32),
  rib: lit(0x8aa0bc, 0.36),
  ceiling: lit(0x9cb0c8, 0.32),
  portal: new THREE.Color(0.012, 0.012, 0.016),
  mullion: lit(0x3a3f46, 0.6),
  counter: lit(0x9a7552, 0.6),
  awnings: [lit(0xd8473f, 0.62), lit(0x2f9e6e, 0.62), lit(0xe7a83a, 0.62)],
  awningStripe: lit(0xf4ecdc, 0.5),
  lamp: emitOf(0xffd9a0, EMISSIVE_LAMP),
  wares: [lit(0xe0563a, 0.66), lit(0xf0c040, 0.66), lit(0x7cc04a, 0.66)],
  // U6
  timber: lit(0x7a5434, 0.6),
  timberEnd: lit(0x9a7048, 0.62),
  railTop: lit(0xb4b8bc, 0.62),
  sleeper: lit(0x4a3a2c, 0.55),
  machines: [lit(0x3f6b4a, 0.6), lit(0xb0702e, 0.6), lit(0x5a6470, 0.6)],
  grille: lit(0x1f2226, 0.55),
  cable: lit(0x262626, 0.5),
  bracket: lit(0x55585c, 0.58),
  signs: [lit(0x1d7a4c, 0.62), lit(0x2a5aa8, 0.62), lit(0xc98a12, 0.62)],
  signRim: lit(0x2b2d30, 0.58),
  signInk: lit(0xf4f1e8, 0.55),
  pipes: [lit(0x8a5a3c, 0.6), lit(0x6c7a74, 0.6)],
  flange: lit(0x9aa0a4, 0.6),
  grateFrame: lit(0x2e3236, 0.58),
  daylight: emitOf(0xe2f0ff, EMISSIVE_LAMP),
  lightPool: lit(0xece0c2, 0.5),
  dripTop: lit(0x7c705e, 0.5),
  dripTip: lit(0xb8ac94, 0.5),
  crystals: [
    emitOf(0x7af4ff, EMISSIVE_WINDOW),
    emitOf(0xc08cff, EMISSIVE_WINDOW),
    emitOf(0xff8ad8, EMISSIVE_WINDOW),
  ],
  crystalBase: lit(0x3a4a5a, 0.5),
  root: lit(0x5e4430, 0.6),
  rootTip: lit(0x8a6a4a, 0.62),
  // U7: real plants
  fernDark: lit(0x2c6a2a, 0.55),
  fernLight: lit(0x7cc04e, 0.62),
  leafDark: lit(0x3a7a30, 0.6),
  bush: [lit(0x2f6a2c, 0.55), lit(0x4a8a36, 0.6), lit(0x3d7a48, 0.58)],
  bloom: [
    lit(0xff7aa8, 0.62),
    lit(0xffd25a, 0.62),
    lit(0xf4f0ff, 0.52),
    lit(0xc08cff, 0.6),
  ],
} as const;

const GLASS = { color: lit(0xbcd8ec, 0.4), alpha: 0.12 };
const SHEET = { color: lit(0xbfe6f6, 0.55), alpha: 0.6 };
const FOAM = lit(0xe9f6fb, 0.55);
/** Firefly and pollen colours; fireflies on the WINDOW rung at peak. */
const FIREFLY = emitOf(0xd8ff7a, EMISSIVE_WINDOW);
const POLLEN = lit(0xfff3cf, 0.5);
/** U6 motes: steam off a pipe, mist off a waterfall, dust in a light shaft
 * — aMote.w 2, 3, 4 (0 pollen, 1 firefly); colour, point size. */
const MOTE_KIND: Record<
  "firefly" | "pollen" | "steam" | "mist" | "shaft",
  { w: number; color: THREE.Color; size: number }
> = {
  pollen: { w: 0, color: POLLEN, size: 0.16 },
  firefly: { w: 1, color: FIREFLY, size: 0.45 },
  steam: { w: 2, color: lit(0xe8eef0, 0.5), size: 0.7 },
  mist: { w: 3, color: lit(0xd4ecf4, 0.42), size: 0.6 },
  shaft: { w: 4, color: lit(0xfff0d0, 0.62), size: 0.2 },
};
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
 * coordinates (e1, e2) — see ANIM.thin. U7: aAnim.y packs
 * behind + 2·triangle + 4·zone (the look section it fades into, an index
 * into LOOK_ZONES), decoded with floor(+0.5) and mod in the shader. */
const thin = (
  behind: 0 | 1,
  e1: number,
  e2: number,
  tri = false,
  zone = 0,
): Anim => [ANIM.thin, behind + (tri ? 2 : 0) + 4 * zone, e1, e2];
/** A thin triangle's corners: two barycentrics each (the third implied). */
const thinTri = (behind: 0 | 1, zone = 0): readonly [Anim, Anim, Anim] => [
  thin(behind, 1, 0, true, zone),
  thin(behind, 0, 1, true, zone),
  thin(behind, 0, 0, true, zone),
];
/** A thin quad a→b→c→d whose long edges are a–d and b–c. */
const thinQuad = (
  behind: 0 | 1,
  zone = 0,
): readonly [Anim, Anim, Anim, Anim] => [
  thin(behind, 0, 1, false, zone),
  thin(behind, 1, 0, false, zone),
  thin(behind, 1, 0, false, zone),
  thin(behind, 0, 1, false, zone),
];
/** U7: the look section index of bore `t` at `s` (for the thin fade). */
const zoneIx = (t: Tunnel, s: number): number =>
  LOOK_ZONES.indexOf(lookZoneAt(t, s));
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

  // U7: vines are strands that hang free of the wall — a narrow ribbon
  // bowing out and swaying along the bore — with real leaves angled off
  // them (two triangles each), not cards on the rock.
  for (const v of L.vines) {
    const soup = bands[v.band] as Soup;
    const z = zoneIx(v.t, v.s);
    const strands = 2;
    for (let j = 0; j < strands; j++) {
      const sj = v.s - v.width / 2 + (v.width * (j + 0.5)) / strands;
      const len =
        v.length *
        (0.65 + (0.35 * ((j * 7 + Math.floor(v.shade * 5)) % 3)) / 2);
      const top = DEEP_CEIL;
      const n = Math.max(2, Math.ceil(len / 3.2));
      const ph = v.shade * 6.3 + j * 2.1;
      const pt = (k: number): [number, number, number] => {
        const u = k / n;
        const off = 0.1 + 0.05 * j + 0.3 * Math.sin(Math.PI * u) * u;
        return [sj + 0.18 * Math.sin(k * 1.7 + ph) * u, off, top - len * u];
      };
      for (let k = 0; k < n; k++) {
        const [sa, oa, ya] = pt(k);
        const [sb, ob, yb] = pt(k + 1);
        const wa = 0.1 * (1 - (0.5 * k) / n);
        const wb = 0.1 * (1 - (0.5 * (k + 1)) / n);
        const ca = mixC(rgba(C.vineDark), rgba(C.vineLight), k / n);
        const cb = mixC(rgba(C.vineDark), rgba(C.vineLight), (k + 1) / n);
        soup.quad(
          [
            at(v.t, sa - wa, v.side * (H - oa), ya),
            at(v.t, sa + wa, v.side * (H - oa), ya),
            at(v.t, sb + wb, v.side * (H - ob), yb),
            at(v.t, sb - wb, v.side * (H - ob), yb),
          ],
          [ca, ca, cb, cb],
          thinQuad(0, z),
        );
      }
      // Leaves every 1.6 m down the strand, alternating, each a blade
      // angled out from the wall and down — tips into the bore.
      let i = 0;
      for (let d = 0.5; d < len - 0.2; d += 1.6, i++) {
        const k = (d / len) * n;
        const [sm, om, ym] = pt(k);
        const dir = i % 2 === 0 ? 1 : -1;
        const leafLen = 0.45 + 0.12 * ((i * 5 + j) % 3);
        const lc = rgba((i + j) % 3 === 0 ? C.leafDark : C.leaf);
        soup.tri(
          [
            at(v.t, sm - dir * 0.08, v.side * (H - om), ym + 0.1),
            at(v.t, sm + dir * 0.08, v.side * (H - om), ym - 0.1),
            at(
              v.t,
              sm + dir * leafLen * 0.75,
              v.side * (H - om - leafLen * 0.6),
              ym - 0.16,
            ),
          ],
          lc,
          thinTri(0, z),
        );
      }
    }
  }

  // U7: moss is a lumpy carpet over the wall's foot and out onto the floor
  // — an irregular mound with a ragged top, not a flat patch.
  for (const m of L.moss) {
    const soup = bands[m.band] as Soup;
    const deep = m.shade > 0.55;
    const c0 = rgba(deep ? C.mossDeep : C.moss);
    const c1 = mixC(c0, rgba(C.vineLight), 0.3);
    const c2 = mixC(c0, rgba(C.vineDark), 0.35);
    const nc = Math.max(3, Math.ceil((2 * m.hl) / 1.5));
    const top = m.y1;
    const seed = Math.floor(m.s * 7.13) + (m.side > 0 ? 0 : 977);
    const pts: P3[][] = [];
    const cols: RGBA[][] = [];
    for (let i = 0; i <= nc; i++) {
      const s = m.s - m.hl + (2 * m.hl * i) / nc;
      const edge = i === 0 || i === nc;
      // A rounded crown along the carpet, a little ragged.
      // Low and cushioned: a carpet, never a fin up the wall.
      const crown =
        Math.min(2.2, top * 0.7) *
        (0.35 + 0.65 * Math.sin((Math.PI * i) / nc) ** 0.7) *
        (0.85 + 0.15 * hash01(seed + i * 31));
      // The profile: out on the floor, a cushion at the wall's foot, up
      // the wall to the crown.
      const prof: [number, number][] = [
        [0.8, 0.02],
        [0.24, 0.25 + Math.min(0.5, crown * 0.3)],
        [0.06, crown],
      ];
      const row: P3[] = [];
      const crow: RGBA[] = [];
      for (let j = 0; j < prof.length; j++) {
        const [inset, y] = prof[j] as [number, number];
        const h = hash01(seed + i * 31 + j * 7);
        const bump = edge || j === 0 ? 0 : 0.14 * h;
        const lat = edge ? 0.04 : inset + bump;
        row.push(at(m.t, s, m.side * (H - lat), F + (edge ? y * 0.6 : y)));
        crow.push(h < 0.33 ? c1 : h < 0.66 ? c0 : c2);
      }
      pts.push(row);
      cols.push(crow);
    }
    const rows = 3;
    for (let i = 0; i < nc; i++) {
      for (let j = 0; j + 1 < rows; j++) {
        const r0 = pts[i] as P3[];
        const r1 = pts[i + 1] as P3[];
        const k0 = cols[i] as RGBA[];
        const k1 = cols[i + 1] as RGBA[];
        soup.quad(
          [r0[j] as P3, r1[j] as P3, r1[j + 1] as P3, r0[j + 1] as P3],
          [k0[j] as RGBA, k1[j] as RGBA, k1[j + 1] as RGBA, k0[j + 1] as RGBA],
        );
      }
    }
  }

  for (const g of L.glows) {
    const soup = bands[g.band] as Soup;
    const lat = g.side * (H - g.inset);
    const glow: Anim = [ANIM.glow, g.phase, 0, 0];
    if (g.kind === "mushroom") {
      const cap = C.caps[
        Math.floor(g.hue * C.caps.length) % C.caps.length
      ] as THREE.Color;
      const sw = Math.max(0.04, g.size * 0.2);
      const top = F + g.height;
      // U7: a three-sided stem under a five-sided glowing cap.
      const ring = (r: number, y: number, n: number, rot: number): P3[] =>
        Array.from({ length: n }, (_, i) => {
          const a = (i / n) * Math.PI * 2 + rot;
          return at(g.t, g.s + Math.cos(a) * r, lat + Math.sin(a) * r, y);
        });
      const foot = ring(sw * 1.2, F, 3, g.phase);
      const neck = ring(sw, top, 3, g.phase);
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        soup.quad(
          [foot[i] as P3, foot[j] as P3, neck[j] as P3, neck[i] as P3],
          rgba(C.stem),
        );
      }
      const rim = ring(g.size, top - 0.06, 5, g.phase);
      const apex = at(g.t, g.s, lat, top + g.size * 0.55);
      for (let i = 0; i < 5; i++) {
        const j = (i + 1) % 5;
        soup.tri([rim[i] as P3, rim[j] as P3, apex], rgba(cap), glow);
      }
    } else {
      // U7: a glowing fern — five arching fronds, tips alight.
      const tip = C.caps[
        Math.floor(g.hue * C.caps.length) % C.caps.length
      ] as THREE.Color;
      fern(soup, g.t, g.s, g.side, g.inset, g.size, g.height, 3, g.phase, {
        base: rgba(C.fernBase),
        tip: rgba(tip),
        tipAnim: glow,
      });
    }
  }

  for (const g of L.gardens) {
    const soup = bands[g.band] as Soup;
    const gz = zoneIx(g.t, g.s);
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
        thinQuad(1, gz),
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
          thinTri(1, gz),
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
  buildU6Decor(L, bands);
  buildU7Decor(L, bands);
}

/** U7: ferns and flowering bushes on the floor along the walls. */
function buildU7Decor(L: UndergroundLayout, bands: Soup[]): void {
  for (const f of L.ferns) {
    const soup = bands[f.band] as Soup;
    const base = mixC(rgba(C.fernDark), rgba(C.moss), f.shade * 0.4);
    fern(soup, f.t, f.s, f.side, f.inset, f.size, f.height, f.fronds, f.phase, {
      base,
      tip: mixC(rgba(C.fernLight), rgba(C.leaf), f.shade),
      zone: zoneIx(f.t, f.s),
    });
  }
  for (const b of L.bushes) {
    const soup = bands[b.band] as Soup;
    const seed = Math.floor(b.s * 17.3) + (b.side > 0 ? 0 : 5003);
    const greens = C.bush;
    const n = 3;
    const tops: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + hash01(seed + i) * 1.2;
      const ds = Math.cos(a) * b.r * 0.55;
      const di = Math.sin(a) * b.r * 0.45;
      const ry = b.height * (0.45 + 0.25 * hash01(seed + 40 + i));
      const y = F + ry * 0.75;
      const g = greens[(seed + i) % greens.length] as THREE.Color;
      blob(
        soup,
        b.t,
        b.side,
        b.s + ds,
        b.inset + di,
        y,
        b.r * 0.6,
        b.r * 0.5,
        ry,
        seed + i,
        rgba(g),
        mixC(rgba(g), rgba(C.vineLight), 0.35),
      );
      tops.push([b.s + ds, b.inset + di, y + ry * 0.8]);
    }
    // Flowers: small crossed stars on the mounds' tops.
    const bloom = C.bloom[
      Math.floor(b.hue * C.bloom.length) % C.bloom.length
    ] as THREE.Color;
    for (let i = 0; i < b.flowers; i++) {
      const [ts, ti, ty] = tops[i % tops.length] as [number, number, number];
      const os = (hash01(seed + 90 + i) - 0.5) * b.r * 0.7;
      const oi = (hash01(seed + 120 + i) - 0.5) * b.r * 0.6;
      const y = ty - 0.05 - 0.15 * hash01(seed + 150 + i);
      const q = (ds: number, di: number, dy: number): P3 =>
        at(b.t, ts + os + ds, b.side * (H - (ti + oi + di)), y + dy);
      const fc = rgba(bloom);
      soup.tri([q(-0.09, 0, 0), q(0.09, 0, 0), q(0, 0, 0.1)], fc);
      soup.tri([q(0, -0.09, 0), q(0, 0.09, 0), q(0, 0, 0.1)], fc);
    }
  }
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
  // U7: the hall is tiled — glazed white-blue tiles with grout (ANIM.tile
  // at bore-frame metres), the line's colour band across them.
  const tileAt = (s: number, y: number): Anim => [ANIM.tile, s, y - F, 0];
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
          [tileAt(s, ya), tileAt(sb, ya), tileAt(sb, yb), tileAt(s, yb)],
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
  // U7: arched ribs across the hall every 10 m — a diaphragm arch from
  // the glass's head to the back wall, its soffit curving up to the
  // ceiling, the spandrels filled to the ceiling: the hall reads vaulted.
  const RIB_SEG = 12;
  const ribIn = H + 0.35;
  const ribOut = back - 0.15;
  const ribY = (f: number) => top - 3.2 * (1 - Math.sin(Math.PI * f) ** 0.6);
  for (let s = s0 + 5; s < s1 - 4; s += 10) {
    for (let i = 0; i < RIB_SEG; i++) {
      const fa = i / RIB_SEG;
      const fb = (i + 1) / RIB_SEG;
      const la = L0(ribIn + (ribOut - ribIn) * fa);
      const lb = L0(ribIn + (ribOut - ribIn) * fb);
      const ya = Math.min(ribY(fa), top - 0.45);
      const yb = Math.min(ribY(fb), top - 0.45);
      // The soffit (seen from below), then both faces up to the ceiling.
      core.quad(
        [
          at(t, s - 0.3, la, ya),
          at(t, s + 0.3, la, ya),
          at(t, s + 0.3, lb, yb),
          at(t, s - 0.3, lb, yb),
        ],
        rgba(C.rib),
      );
      for (const ds of [-0.3, 0.3]) {
        core.quad(
          [
            at(t, s + ds, la, ya),
            at(t, s + ds, lb, yb),
            at(t, s + ds, lb, top - 0.01),
            at(t, s + ds, la, top - 0.01),
          ],
          [rgba(C.rib), rgba(C.rib), rgba(C.plaster), rgba(C.plaster)],
        );
      }
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

// --- U6: the sections' own character ---------------------------------------------

/** A box in the bore frame with ALL six faces (frameBox leaves the bottom
 * out; things overhead are seen from below). */
function solidBox(
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
  bottom: RGBA = c,
  a: Anim = STILL,
): void {
  frameBox(soup, t, s0, s1, la, lb, y0, y1, c, top, a);
  flatStrip(soup, t, s0, s1, la, lb, y0, bottom, a);
}

/** Lateral bounds of a band `from` m to `to` m off the `side` wall. */
const offWall = (side: 1 | -1, from: number, to: number): [number, number] => {
  const a = side * (H - from);
  const b = side * (H - to);
  return [Math.min(a, b), Math.max(a, b)];
};

/** A four-sided spike: base square (half `r`) at `y0`, apex at `y1`. */
function spike(
  soup: Soup,
  t: Tunnel,
  s: number,
  lat: number,
  y0: number,
  y1: number,
  r: number,
  base: RGBA,
  tip: RGBA,
  a: Anim = STILL,
  lean = 0,
): void {
  const apex = at(t, s + lean, lat, y1);
  const ring = [
    at(t, s - r, lat, y0),
    at(t, s, lat - r, y0),
    at(t, s + r, lat, y0),
    at(t, s, lat + r, y0),
  ] as const;
  for (let i = 0; i < 4; i++) {
    const v0 = ring[i] as P3;
    const v1 = ring[(i + 1) % 4] as P3;
    soup.vertex(v0, base, a);
    soup.vertex(v1, base, a);
    soup.vertex(apex, tip, a);
  }
}

// --- U7: real plants -------------------------------------------------------------

/** A deterministic 0..1 hash of an integer. */
function hash01(n: number): number {
  let x = Math.imul(n | 0, 0x2c1b3c6d) ^ 0x297a2d39;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

interface FernLook {
  base: RGBA;
  tip: RGBA;
  /** The tips' animation (a glowing fern); thin edge AA otherwise. */
  tipAnim?: Anim;
  zone?: number;
}

/** A fern rooted `inset` m off the `side` wall at `s`: `fronds` tapered
 * ribbons arching out (to `size` m) and up (to ~0.75 `height`) and
 * drooping, spread round the side away from the wall — none reaching
 * back into it. */
function fern(
  soup: Soup,
  t: Tunnel,
  s: number,
  side: 1 | -1,
  inset: number,
  size: number,
  height: number,
  fronds: number,
  phase: number,
  look: FernLook,
): void {
  const SEG = 2;
  for (let f = 0; f < fronds; f++) {
    const a = -2.2 + (4.4 * (f + 0.5)) / fronds + 0.25 * Math.sin(phase + f);
    const dS = Math.sin(a);
    const dIn = Math.cos(a);
    // Never into the wall: reach toward it at most inset − 0.05.
    const reach =
      size *
      (0.8 + 0.25 * hash01(Math.floor(phase * 1000) + f)) *
      (dIn < 0 ? Math.min(1, (inset - 0.05) / (size * 1.05 * -dIn)) : 1);
    const pt = (u: number, w: number): P3 => {
      const r = reach * u;
      const y = F + 0.02 + height * (2.2 * u - 1.6 * u * u);
      return at(
        t,
        s + dS * r - dIn * w,
        side * (H - (inset + dIn * r + dS * w)),
        y,
      );
    };
    for (let k = 0; k < SEG; k++) {
      const u0 = k / SEG;
      const u1 = (k + 1) / SEG;
      const w0 = size * 0.2 * (1 - 0.75 * u0) + 0.015;
      const w1 = size * 0.2 * (1 - 0.75 * u1) + 0.015;
      const c0 = mixC(look.base, look.tip, u0);
      const c1 = mixC(look.base, look.tip, u1);
      const quad: readonly [P3, P3, P3, P3] = [
        pt(u0, -w0),
        pt(u0, w0),
        pt(u1, w1),
        pt(u1, -w1),
      ];
      if (look.tipAnim) {
        // One animation per frond: a mixed one would interpolate through
        // the other kinds' ranges in the fragment shader.
        soup.quad(quad, [c0, c0, c1, c1], look.tipAnim);
      } else {
        soup.quad(quad, [c0, c0, c1, c1], thinQuad(0, look.zone ?? 0));
      }
    }
  }
}

/** A low-poly mound: an octahedron round (s, inset, y) with half extents
 * (rs, rIn, ry), its corners jittered by `seed`. */
function blob(
  soup: Soup,
  t: Tunnel,
  side: 1 | -1,
  s: number,
  inset: number,
  y: number,
  rs: number,
  rIn: number,
  ry: number,
  seed: number,
  lo: RGBA,
  hi: RGBA,
): void {
  const j = (k: number) => 0.8 + 0.35 * hash01(seed * 13 + k);
  const p = (ds: number, di: number, dy: number): P3 =>
    at(t, s + ds, side * (H - (inset + di)), y + dy);
  const top = p(0.1 * rs, 0, ry * j(0));
  const bot = p(0, 0, -ry * 0.3);
  const ring = [
    p(rs * j(1), 0, 0.1 * ry),
    p(0, rIn * j(2), -0.05 * ry),
    p(-rs * j(3), 0, 0.12 * ry),
    p(0, -rIn * j(4), 0),
  ];
  for (let i = 0; i < 4; i++) {
    const a = ring[i] as P3;
    const b = ring[(i + 1) % 4] as P3;
    soup.vertex(a, lo, STILL);
    soup.vertex(b, lo, STILL);
    soup.vertex(top, hi, STILL);
    soup.vertex(b, lo, STILL);
    soup.vertex(a, lo, STILL);
    soup.vertex(bot, mixC(lo, rgba(C.vineDark), 0.5), STILL);
  }
}

function buildU6Decor(L: UndergroundLayout, bands: Soup[]): void {
  const core = bands[0] as Soup;
  // Mine timber sets: a post against each wall, a cap under the ceiling.
  for (const tm of L.timbers) {
    const soup = bands[tm.band] as Soup;
    const s0 = tm.s - 0.2;
    const s1 = tm.s + 0.2;
    for (const side of [1, -1] as const) {
      const [la, lb] = offWall(side, 0.05, 0.4);
      frameBox(
        soup,
        tm.t,
        s0,
        s1,
        la,
        lb,
        F,
        DEEP_CEIL - 0.05,
        rgba(C.timber),
        rgba(C.timberEnd),
      );
    }
    solidBox(
      soup,
      tm.t,
      s0 - 0.05,
      s1 + 0.05,
      -(H - 0.05),
      H - 0.05,
      DEEP_CEIL - 0.42,
      DEEP_CEIL - 0.03,
      rgba(C.timber),
      rgba(C.timber),
      rgba(C.timberEnd),
    );
  }
  // Rails and sleepers at the foot of a wall.
  for (const rl of L.rails) {
    for (const off of [0.55, 1.15]) {
      const [la, lb] = offWall(rl.side, off - 0.04, off + 0.04);
      frameBox(
        core,
        rl.t,
        rl.s0,
        rl.s1,
        la,
        lb,
        F,
        F + 0.12,
        rgba(C.rail),
        rgba(C.railTop),
      );
    }
    const [sa, sb] = offWall(rl.side, 0.35, 1.35);
    const detail = bands[1] as Soup;
    for (let s = rl.s0; s < rl.s1 - 0.3; s += 1.2) {
      frameBox(detail, rl.t, s, s + 0.24, sa, sb, F, F + 0.05, rgba(C.sleeper));
    }
  }
  // Old machinery: a housing, its grille, a lamp; a winch drum on top.
  for (const m of L.machines) {
    const soup = bands[m.band] as Soup;
    const col = C.machines[
      Math.floor(m.hue * C.machines.length) % C.machines.length
    ] as THREE.Color;
    const [la, lb] = offWall(m.side, 0.05, m.depth);
    frameBox(
      soup,
      m.t,
      m.s - m.hl,
      m.s + m.hl,
      la,
      lb,
      F,
      F + m.height,
      rgba(col),
      mixC(rgba(col), rgba(C.panelRim), 0.25),
    );
    // Grille slats on the face toward the bore.
    const face = m.side * (H - m.depth - 0.01);
    for (let i = 0; i < 3; i++) {
      const ya = F + 0.25 + i * 0.32;
      alongFace(
        soup,
        m.t,
        face,
        m.s - m.hl * 0.7,
        m.s + m.hl * 0.1,
        ya,
        ya + 0.16,
        rgba(C.grille),
      );
    }
    const lampLat = m.side * (H - m.depth - 0.02);
    const ly = F + m.height - 0.25;
    const q = (ds: number, dy: number) =>
      at(m.t, m.s + m.hl * 0.55 + ds, lampLat, ly + dy);
    soup.quad(
      [q(-0.12, -0.08), q(0.12, -0.08), q(0.12, 0.08), q(-0.12, 0.08)],
      rgba(C.lamp),
      [ANIM.lamp, 0, 0, 0],
    );
    if (m.kind === 1) {
      const [da, db] = offWall(m.side, 0.15, m.depth - 0.1);
      frameBox(
        soup,
        m.t,
        m.s - m.hl * 0.6,
        m.s + m.hl * 0.6,
        da,
        db,
        F + m.height,
        F + m.height + 0.5,
        rgba(C.bracket),
        rgba(C.railTop),
      );
    }
  }
  // Cable runs slung between brackets: thin cards with U5b's edge AA.
  for (const cb of L.cables) {
    const soup = core;
    const lat = cb.side * (H - 0.08);
    const top = F + cb.y;
    const sag = (u: number) => top - 0.45 * 4 * u * (1 - u);
    const cz = zoneIx(cb.t, (cb.s0 + cb.s1) / 2);
    const lo = thin(0, 0, 1, false, cz);
    const hi = thin(0, 1, 0, false, cz);
    for (let s = cb.s0; s < cb.s1 - 1e-6; s += CABLE_SPAN) {
      const end = Math.min(cb.s1, s + CABLE_SPAN);
      const n = Math.max(1, Math.ceil(end - s));
      for (let i = 0; i < n; i++) {
        const ua = i / n;
        const ub = (i + 1) / n;
        const sa = s + (end - s) * ua;
        const sb = s + (end - s) * ub;
        soup.quad(
          [
            at(cb.t, sa, lat, sag(ua) - 0.04),
            at(cb.t, sb, lat, sag(ub) - 0.04),
            at(cb.t, sb, lat, sag(ub) + 0.04),
            at(cb.t, sa, lat, sag(ua) + 0.04),
          ],
          rgba(C.cable),
          [lo, lo, hi, hi],
        );
      }
      const [ba, bb] = offWall(cb.side, 0.03, 0.2);
      frameBox(
        soup,
        cb.t,
        s - 0.06,
        s + 0.06,
        ba,
        bb,
        top - 0.1,
        top + 0.1,
        rgba(C.bracket),
      );
    }
  }
  // Wall signs: a rim, a coloured panel, a white arrow and stripe, a lamp.
  for (const sg of L.signs) {
    const soup = bands[sg.band] as Soup;
    const col = C.signs[
      Math.floor(sg.hue * C.signs.length) % C.signs.length
    ] as THREE.Color;
    const y0 = F + 5.4;
    const y1 = F + 6.6;
    wallStrip(
      soup,
      sg.t,
      sg.side,
      0.04,
      sg.s - 1.55,
      sg.s + 1.55,
      y0 - 0.1,
      y1 + 0.1,
      rgba(C.signRim),
      rgba(C.signRim),
    );
    wallStrip(
      soup,
      sg.t,
      sg.side,
      0.06,
      sg.s - 1.4,
      sg.s + 1.4,
      y0,
      y1,
      rgba(col),
      rgba(col),
    );
    const lat = sg.side * (H - 0.08);
    const ym = (y0 + y1) / 2;
    const d = sg.arrow;
    soup.tri(
      [
        at(sg.t, sg.s + d * 1.15, lat, ym),
        at(sg.t, sg.s + d * 0.55, lat, ym + 0.4),
        at(sg.t, sg.s + d * 0.55, lat, ym - 0.4),
      ],
      rgba(C.signInk),
    );
    const a0 = sg.s - d * 1.1;
    const a1 = sg.s + d * 0.6;
    soup.quad(
      [
        at(sg.t, a0, lat, ym - 0.12),
        at(sg.t, a1, lat, ym - 0.12),
        at(sg.t, a1, lat, ym + 0.12),
        at(sg.t, a0, lat, ym + 0.12),
      ],
      rgba(C.signInk),
    );
    // A lamp hood over it, lit underneath.
    const [ha, hb] = offWall(sg.side, 0.05, 0.45);
    frameBox(
      soup,
      sg.t,
      sg.s - 0.5,
      sg.s + 0.5,
      ha,
      hb,
      y1 + 0.25,
      y1 + 0.4,
      rgba(C.signRim),
    );
    flatStrip(
      soup,
      sg.t,
      sg.s - 0.45,
      sg.s + 0.45,
      ha,
      hb,
      y1 + 0.24,
      rgba(C.lamp),
      [ANIM.lamp, 0, 0, 0],
    );
  }
  // Pipe runs with flanges every 6 m.
  L.pipes.forEach((pp, i) => {
    const col = C.pipes[i % C.pipes.length] as THREE.Color;
    const [la, lb] = offWall(pp.side, 0.05, 0.05 + 2 * pp.r);
    solidBox(
      core,
      pp.t,
      pp.s0,
      pp.s1,
      la,
      lb,
      F + pp.y - pp.r,
      F + pp.y + pp.r,
      rgba(col),
      mixC(rgba(col), rgba(C.panelRim), 0.2),
      mixC(rgba(col), rgba(C.vent), 0.4),
    );
    const [fa, fb] = offWall(pp.side, 0.03, 0.12 + 2 * pp.r);
    const detail = bands[1] as Soup;
    for (let s = pp.s0 + 3; s < pp.s1 - 0.2; s += 6) {
      solidBox(
        detail,
        pp.t,
        s - 0.12,
        s + 0.12,
        fa,
        fb,
        F + pp.y - pp.r - 0.07,
        F + pp.y + pp.r + 0.07,
        rgba(C.flange),
      );
    }
  });
  // Ceiling grates with daylight behind (a 3 × 2 grid of lit panes in a
  // dark frame — coarse on purpose: bars would shimmer), a pool of light
  // on the floor under each.
  for (const g of L.grates) {
    const soup = bands[g.band] as Soup;
    const y = DEEP_CEIL - 0.05;
    const q = (ds: number, dl: number, yy: number) =>
      at(g.t, g.s + ds, g.lat + dl, yy);
    soup.quad(
      [q(-1.9, -1.4, y), q(1.9, -1.4, y), q(1.9, 1.4, y), q(-1.9, 1.4, y)],
      rgba(C.grateFrame),
    );
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const sa = -1.65 + i * 1.15;
        const la = -1.15 + j * 1.2;
        const yy = y - 0.03;
        soup.quad(
          [
            q(sa, la, yy),
            q(sa + 0.95, la, yy),
            q(sa + 0.95, la + 1.1, yy),
            q(sa, la + 1.1, yy),
          ],
          rgba(C.daylight),
          [ANIM.lamp, 0, 0, 0],
        );
      }
    }
    flatStrip(
      soup,
      g.t,
      g.s - 2.2,
      g.s + 2.2,
      g.lat - 1.7,
      g.lat + 1.7,
      F + 0.03,
      rgba(C.lightPool),
    );
  }
  // Stalactites and stalagmites.
  for (const d of L.drips) {
    const soup = bands[d.band] as Soup;
    const base = mixC(rgba(C.dripTop), rgba(C.moss), d.shade * 0.25);
    if (d.up)
      spike(
        soup,
        d.t,
        d.s,
        d.lat,
        F + 0.02,
        F + d.len,
        d.r,
        base,
        rgba(C.dripTip),
      );
    else
      spike(
        soup,
        d.t,
        d.s,
        d.lat,
        DEEP_CEIL - 0.02,
        DEEP_CEIL - d.len,
        d.r,
        base,
        rgba(C.dripTip),
      );
  }
  // Glowing crystal clusters (U7): three four-sided prisms with pointed
  // tips, leaning — the base dark, the faces alight.
  for (const cr of L.crystals) {
    const soup = bands[cr.band] as Soup;
    const col = C.crystals[
      Math.floor(cr.hue * C.crystals.length) % C.crystals.length
    ] as THREE.Color;
    const glow: Anim = [ANIM.glow, cr.phase, 0, 0];
    const lat = cr.side * (H - cr.inset);
    for (let i = 0; i < 3; i++) {
      const ds = (i - 1) * cr.size * 0.6;
      const h = cr.height * (i === 1 ? 1 : 0.65);
      const r = cr.size * (i === 1 ? 0.4 : 0.28);
      const lean = ds * 0.4;
      const shoulder = 0.78;
      const ring = (y: number, rr: number, l: number): P3[] =>
        Array.from({ length: 4 }, (_, k) => {
          const a = (k / 4) * Math.PI * 2 + i;
          return at(
            cr.t,
            cr.s + ds + l + Math.cos(a) * rr,
            lat + Math.sin(a) * rr,
            y,
          );
        });
      const lo = ring(F, r, 0);
      const hi = ring(F + h * shoulder, r * 0.92, lean * shoulder);
      const apex = at(cr.t, cr.s + ds + lean, lat, F + h);
      for (let k = 0; k < 4; k++) {
        const j = (k + 1) % 4;
        const face = mixC(rgba(col), rgba(C.crystalBase), (k % 2) * 0.25);
        soup.quad(
          [lo[k] as P3, lo[j] as P3, hi[j] as P3, hi[k] as P3],
          [rgba(C.crystalBase), rgba(C.crystalBase), face, face],
          glow,
        );
        soup.tri([hi[k] as P3, hi[j] as P3, apex], rgba(col), glow);
      }
    }
  }
  // Hanging roots (U7): tapered three-sided strands with a kink — every
  // face keeps U5b's edge AA and fades into the ceiling with distance.
  for (const rt of L.roots) {
    const soup = bands[rt.band] as Soup;
    const z = zoneIx(rt.t, rt.s);
    const top = DEEP_CEIL - 0.01;
    const w = rt.width / 2;
    const c0 = rgba(C.root);
    const c1 = mixC(rgba(C.root), rgba(C.rootTip), 0.6 + 0.4 * rt.shade);
    const kink = (rt.shade - 0.5) * 0.25;
    const spine: [number, number, number, number][] = [
      [rt.s, rt.lat, top, w],
      [rt.s + kink, rt.lat - kink * 0.6, top - rt.len * 0.55, w * 0.6],
      [rt.s + kink * 0.4, rt.lat - kink, top - rt.len, w * 0.15],
    ];
    for (let k = 0; k < 2; k++) {
      const [sa, la, ya, wa] = spine[k] as [number, number, number, number];
      const [sb, lb, yb, wb] = spine[k + 1] as [number, number, number, number];
      const ca = mixC(c0, c1, k / 2);
      const cb = mixC(c0, c1, (k + 1) / 2);
      for (let f = 0; f < 3; f++) {
        const a0 = (f / 3) * Math.PI * 2;
        const a1 = ((f + 1) / 3) * Math.PI * 2;
        soup.quad(
          [
            at(rt.t, sa + Math.cos(a0) * wa, la + Math.sin(a0) * wa, ya),
            at(rt.t, sa + Math.cos(a1) * wa, la + Math.sin(a1) * wa, ya),
            at(rt.t, sb + Math.cos(a1) * wb, lb + Math.sin(a1) * wb, yb),
            at(rt.t, sb + Math.cos(a0) * wb, lb + Math.sin(a0) * wb, yb),
          ],
          [ca, ca, cb, cb],
          thinQuad(1, z),
        );
      }
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
    const kind = MOTE_KIND[m.kind];
    const c = kind.color;
    (per[m.band] as number[]).push(
      m.x,
      m.y,
      m.z,
      c.r,
      c.g,
      c.b,
      m.phase,
      m.amp,
      kind.size,
      kind.w,
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
/** U6: bats, fish and grazers (deer, foxes). People and the cart are
 * walkers. */
const BAT = 3;
const FISH = 4;
const GRAZER = 5;

/** A box's faces (all but the bottom) as triangles, local x forward, y up,
 * z across. */
function boxTris(
  out: P3[],
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  const faces: P3[][] = [
    [
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
    ],
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
    ],
    [
      [x1, y0, z0],
      [x1, y0, z1],
      [x1, y1, z1],
      [x1, y1, z0],
    ],
  ];
  for (const f of faces) {
    out.push(
      f[0] as P3,
      f[1] as P3,
      f[2] as P3,
      f[0] as P3,
      f[2] as P3,
      f[3] as P3,
    );
  }
}

/** A bat: a small body and broad scalloped wings (local x forward). */
const BAT_SHAPE: readonly P3[] = [
  [0.14, 0, 0],
  [-0.12, 0.04, 0],
  [-0.12, -0.04, 0],
  [0.06, 0, 0],
  [-0.08, 0, 0],
  [0.02, 0, 0.5],
  [0.02, 0, 0.5],
  [-0.08, 0, 0],
  [-0.14, 0, 0.32],
  [0.06, 0, 0],
  [-0.08, 0, 0],
  [0.02, 0, -0.5],
  [0.02, 0, -0.5],
  [-0.08, 0, 0],
  [-0.14, 0, -0.32],
];

/** A fish, flat in the water: a body diamond and a tail. */
const FISH_SHAPE: readonly P3[] = [
  [0.36, 0, 0],
  [0, 0, 0.11],
  [-0.26, 0, 0],
  [0.36, 0, 0],
  [-0.26, 0, 0],
  [0, 0, -0.11],
  [-0.22, 0, 0],
  [-0.44, 0, 0.13],
  [-0.44, 0, -0.13],
];

/** Where a grazer's head starts (local x), m, at scale 1. */
const HEAD_X = 0.38;

/** A deer at scale 1 (a fox is one at ~0.55): body, neck and head, legs,
 * tail. Returns [vertex, part] — part 0 body, 1 legs, 2 head. */
function grazerShape(fox: boolean): [P3, number][] {
  const k = fox ? 0.55 : 1;
  const out: [P3, number][] = [];
  const add = (
    part: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
  ) => {
    const tris: P3[] = [];
    boxTris(tris, x0 * k, x1 * k, y0 * k, y1 * k, z0 * k, z1 * k);
    for (const v of tris) out.push([v, part]);
  };
  add(0, -0.55, 0.45, 0.72, 1.2, -0.17, 0.17);
  add(2, HEAD_X, 0.8, 1.05, 1.58, -0.09, 0.09);
  for (const x of [-0.42, 0.32]) {
    for (const z of [-0.11, 0.11])
      add(1, x - 0.06, x + 0.06, 0, 0.78, z - 0.06, z + 0.06);
  }
  if (fox) add(0, -1.05, -0.5, 0.75, 0.95, -0.08, 0.08);
  return out;
}

/** A worker: U5's walker, a helmet and its lamp (local x forward). */
function workerShape(h: number): [P3, number][] {
  const out: [P3, number][] = walkerShape(h).map((v) => [
    v,
    v[1] > h * 0.83 ? 1 : 0,
  ]);
  const tris: P3[] = [];
  boxTris(tris, -0.14, 0.14, h - 0.04, h + 0.1, -0.14, 0.14);
  for (const v of tris) out.push([v, 2]);
  const lamp: P3[] = [];
  boxTris(lamp, 0.13, 0.19, h - 0.01, h + 0.07, -0.05, 0.05);
  for (const v of lamp) out.push([v, 3]);
  return out;
}

/** The maintenance cart: a tub, its chassis, a lamp at each end. */
function cartShape(): [P3, number][] {
  const out: [P3, number][] = [];
  const push = (part: number, tris: P3[]) => {
    for (const v of tris) out.push([v, part]);
  };
  const tub: P3[] = [];
  boxTris(tub, -0.75, 0.75, 0.12, 0.85, -0.38, 0.38);
  push(0, tub);
  const chassis: P3[] = [];
  boxTris(chassis, -0.7, 0.7, -0.06, 0.12, -0.34, 0.34);
  push(1, chassis);
  for (const x of [0.75, -0.79]) {
    const lamp: P3[] = [];
    boxTris(lamp, x, x + 0.04, 0.45, 0.6, -0.1, 0.1);
    push(2, lamp);
  }
  return out;
}

const BAT_COLOR = lit(0x2c2624, 0.55);
const FISH_COLORS = [
  lit(0xe8743a, 0.66),
  lit(0xece6dc, 0.64),
  lit(0xd8a838, 0.66),
];
const DEER = {
  body: lit(0x8a6240, 0.62),
  legs: lit(0x5a3e2a, 0.58),
  head: lit(0x9a7048, 0.64),
};
const FOX = {
  body: lit(0xc8642a, 0.64),
  legs: lit(0x3a2a22, 0.56),
  head: lit(0xd87a3a, 0.66),
};
const WORKER = {
  vest: [lit(0xe8702a, 0.66), lit(0xd8d040, 0.64)],
  skin: lit(0xd9b38c, 0.75),
  helmet: lit(0xf2c230, 0.7),
  lamp: lit(0xfff2b0, 0.7),
};
const CART = {
  tub: lit(0x7a5032, 0.6),
  chassis: lit(0x2e2a28, 0.55),
  lamp: lit(0xffe2a0, 0.7),
};

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
  // --- U6 ---
  for (const b of L.bats) {
    for (const v of BAT_SHAPE) {
      (per[b.band] as V[]).push({
        local: v,
        base: [b.x, b.y, b.z],
        move: [b.ux, b.uz, b.r, 0],
        misc: [BAT, b.speed, b.phase, 0],
        color: BAT_COLOR,
      });
    }
  }
  for (const fi of L.fish) {
    const c = FISH_COLORS[
      Math.floor(fi.hue * FISH_COLORS.length) % FISH_COLORS.length
    ] as THREE.Color;
    for (const v of FISH_SHAPE) {
      (per[fi.band] as V[]).push({
        local: v,
        base: [fi.x, fi.y, fi.z],
        move: [fi.ux, fi.uz, fi.a, fi.b],
        misc: [FISH, fi.speed, fi.phase, fi.jump],
        color: c,
      });
    }
  }
  for (const g of L.grazers) {
    const fox = g.kind === "fox";
    const pal = fox ? FOX : DEER;
    for (const [v, part] of grazerShape(fox)) {
      (per[g.band] as V[]).push({
        local: v,
        base: [g.x, g.y, g.z],
        move: [g.ux, g.uz, g.length, g.speed],
        misc: [GRAZER, g.phase, HEAD_X * (fox ? 0.55 : 1), 0],
        color: part === 0 ? pal.body : part === 1 ? pal.legs : pal.head,
      });
    }
  }
  for (const w of L.workers) {
    const vest = WORKER.vest[
      Math.floor(w.shade * WORKER.vest.length) % WORKER.vest.length
    ] as THREE.Color;
    for (const [v, part] of workerShape(w.height)) {
      (per[w.band] as V[]).push({
        local: v,
        base: [w.x, w.y, w.z],
        move: [w.ux, w.uz, w.length, w.speed],
        misc: [WALKER, w.phase, 0, 0],
        color:
          part === 0
            ? vest
            : part === 1
              ? WORKER.skin
              : part === 2
                ? WORKER.helmet
                : WORKER.lamp,
      });
    }
  }
  for (const w of L.passengers) {
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
  for (const w of L.carts) {
    for (const [v, part] of cartShape()) {
      (per[w.band] as V[]).push({
        local: v,
        base: [w.x, w.y, w.z],
        move: [w.ux, w.uz, w.length, w.speed],
        misc: [WALKER, w.phase, 0, 0],
        color: part === 0 ? CART.tub : part === 1 ? CART.chassis : CART.lamp,
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

/** U6: cave-ins the lamps flicker for at once. */
const CAVE_SLOTS = 4;

const DECOR_VERTEX_PARS = /* glsl */ `
attribute vec4 aAnim;
uniform float uU5Time;
uniform vec4 uCaveIn[${CAVE_SLOTS}];
varying vec4 vAnim;
varying float vGlow;
varying float vThin;
varying vec3 vLookWorld;
`;
const DECOR_VERTEX = /* glsl */ `
vAnim = aAnim;
vLookWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vGlow = 1.0;
vThin = 0.0;
if (aAnim.x > 2.5 && aAnim.x < 3.5) {
  vec4 thinView = modelViewMatrix * vec4(transformed, 1.0);
  vThin = smoothstep(20.0, 70.0, length(thinView.xyz));
}
if (aAnim.x > 1.5 && aAnim.x < 2.5) {
  vGlow = 0.72 + 0.28 * (0.5 + 0.5 * sin(uU5Time * 1.3 + aAnim.y));
}
// U6: a lamp near a warned or falling cave-in stutters (one stutter per
// event, the same for every lamp of it; no division anywhere).
if (aAnim.x > 4.5 && aAnim.x < 5.5) {
  vec3 caveW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  for (int k = 0; k < ${CAVE_SLOTS}; k++) {
    vec4 cave = uCaveIn[k];
    float caveNear = cave.z *
      (1.0 - smoothstep(16.0, 36.0, distance(caveW.xz, cave.xy)));
    float caveN = fract(sin(floor(uU5Time * 13.0) * 12.9898 + cave.w) * 43758.5453);
    vGlow *= 1.0 - caveNear * (caveN > 0.5 ? 0.88 : 0.15);
  }
}
`;
const DECOR_FRAGMENT_PARS = /* glsl */ `
${LOOK_BEHIND_GLSL}
${LOOK_NOISE_GLSL}
varying vec3 vLookWorld;
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
vec2 tileFw = fwidth(vAnim.yz);
vec2 waterFw = fwidth(vLookWorld.xz);
float waterPx = max(waterFw.x, waterFw.y);
if (vAnim.x > 2.5 && vAnim.x < 3.5) {
  // aAnim.y is behind + 2·tri + 4·zone, exact integers; rounded, as an
  // interpolated constant may arrive an ulp off.
  float thinY = floor(vAnim.y + 0.5);
  float thinTriBit = mod(floor(thinY / 2.0 + 0.01), 2.0);
  vec3 behind = abLookBehind(floor(thinY / 4.0 + 0.01), mod(thinY, 2.0));
  // Pixels from the nearest edge; a quad has no third edge.
  vec3 px = thinEdge / thinEdgeW;
  float edgePx = min(px.x, thinTriBit > 0.5 ? min(px.y, px.z) : px.y);
  float cover = clamp(edgePx, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, behind, max(vThin, 1.0 - cover));
}
if (vAnim.x > 0.5 && vAnim.x < 1.5) {
  // U7 WATER: three wave trains moving down the stream — wave vectors are
  // whole cycles per world period, so the pattern is periodic in WORLD_SIZE
  // and the 2×2 snap never moves it — their analytic slope tilting the
  // normal; a fresnel reflection of the bore's air and lamps, and soft
  // warm streaks under the crown lights (vAnim.y is s along the bore).
  vec2 wp = mod(vLookWorld.xz, ${WORLD_SIZE.toFixed(1)});
  float wt = uU5Time * (0.6 + vAnim.z);
  vec2 slope = vec2(0.0);
  float crest = 0.0;
  for (int i = 0; i < 3; i++) {
    vec2 K = i == 0 ? vec2(900.0, 300.0) : i == 1 ? vec2(-500.0, 1100.0) : vec2(700.0, -650.0);
    K *= ${((2 * Math.PI) / WORLD_SIZE).toFixed(7)};
    float kl = length(K);
    float fade = 1.0 - smoothstep(0.1, 0.3, waterPx * kl * 0.159);
    float ph = dot(K, wp) - wt * (1.6 + 0.5 * float(i));
    slope += K * cos(ph) * 0.006 * fade;
    crest += sin(ph) * fade;
  }
  vec3 wN = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 wV = normalize(cameraPosition - vLookWorld);
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(wN, wV), 0.0, 1.0), 5.0);
  vec3 refl = vec3(0.05, 0.11, 0.2);
  #ifdef USE_FOG
    refl = mix(refl, abTunnelAir.rgb, 0.45 * abTunnelAir.a);
  #endif
  float wds = (fract(vAnim.y / 12.0 + 0.5) - 0.5) * 12.0 + slope.x * 25.0;
  float streak = exp(-wds * wds / 5.0) * (0.5 + 0.5 * clamp(crest * 0.5 + 0.5, 0.0, 1.0));
  float glint = step(3.5, uTunnelDetail);
  vec3 water = mix(diffuseColor.rgb * (0.85 + 0.12 * crest), refl, fres * 0.55);
  water += vec3(1.0, 0.8, 0.56) * streak * (0.03 + 0.14 * fres) * (0.4 + 0.6 * glint);
  diffuseColor.rgb = abUnderClamp(water);
}
if (vAnim.x > 3.5 && vAnim.x < 4.5) {
  // Falling water: streaks down the sheet (vAnim.y is height), foam and
  // spray thickening toward its foot.
  float n = 0.5 + 0.5 * sin(vAnim.z * 7.3);
  float n2 = 0.5 + 0.5 * sin(vAnim.z * 3.1 + 1.7);
  float f = fract((vAnim.y + uU5Time * 4.0 * (0.7 + 0.6 * n)) * 0.35);
  float streak = smoothstep(0.35, 1.0, f) * (1.0 - smoothstep(0.88, 1.0, f));
  float foam = 1.0 - smoothstep(${(BORE_FLOOR_Y + 0.3).toFixed(2)}, ${(BORE_FLOOR_Y + 2.4).toFixed(2)}, vAnim.y);
  diffuseColor.rgb *= 0.78 + 0.3 * streak * (0.6 + 0.4 * n2);
  diffuseColor.rgb = mix(diffuseColor.rgb, ${glslColor(FOAM)}, foam * 0.7);
  diffuseColor.a *= mix(0.72 + 0.28 * streak, 1.25, foam);
}
if (vAnim.x > 5.5 && vAnim.x < 6.5) {
  // U7 TILE: 0.6 × 0.3 m glazed tiles, grout, a tone per tile, faded to
  // the average once a tile is a few pixels.
  vec2 tsz = vec2(0.6, 0.3);
  vec2 tc = vAnim.yz / tsz;
  vec2 te = (0.5 - abs(fract(tc) - 0.5)) * tsz;
  float tpx = max(max(tileFw.x, tileFw.y), 1e-4);
  float grout = 1.0 - smoothstep(0.009, 0.009 + tpx * 1.5, min(te.x, te.y));
  float fine = 1.0 - smoothstep(0.01, 0.035, tpx);
  float tone = abHash(floor(tc) + 7.0);
  diffuseColor.rgb *= mix(1.0, 0.94 + 0.12 * tone, fine) * (1.0 - 0.38 * grout * fine);
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
float moteK = aMote.w;
if (moteK > 1.5 && moteK < 2.5) {
  // U6 steam: a puff rising and spreading off its leak, then gone, on a
  // 2.4 s cycle (the motes of one leak are spread round its phase).
  float puff = fract(moteT * 0.4167 + moteP * 0.15915);
  transformed += aMote.y * puff * vec3(
    0.55 * sin(moteP * 3.1), 1.0, 0.55 * cos(moteP * 2.3));
  vMote = 0.75 * smoothstep(0.0, 0.12, puff) * (1.0 - puff);
} else {
  // Pollen, fireflies, mist and shaft dust drift; mist and dust slower.
  float drift = moteK > 2.5 ? 0.45 : 1.0;
  transformed += aMote.y * vec3(
    sin(moteT * 0.31 * drift + moteP),
    0.6 * sin(moteT * 0.47 * drift + moteP * 1.7),
    cos(moteT * 0.27 * drift + moteP * 2.3));
  vMote = moteK > 0.5 && moteK < 1.5
    // O7: max() — a GPU sin() may round below -1, and pow(<0) is NaN.
    ? 0.25 + 0.75 * pow(max(0.5 + 0.5 * sin(moteT * 2.1 + moteP * 3.0), 0.0), 3.0)
    : moteK > 3.5 ? 0.9 : moteK > 2.5 ? 0.55 + 0.25 * sin(moteT * 0.8 + moteP) : 0.8;
}
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
uniform vec3 uPlane;
`;
const CRITTERS_VERTEX = /* glsl */ `
vec2 u = aMove.xy;
vec2 left = vec2(-u.y, u.x);
vec3 loc = transformed;
vec3 at;
vec2 fwd;
float kind = aMisc.x;
if (kind < 1.5) {
  // A bird: an ellipse along the bore, a slow bob, flapping wings.
  float th = aMisc.z + aMisc.y * uU5Time;
  vec2 c = u * cos(th) * aMove.z + left * sin(th) * aMove.w;
  at = aBase + vec3(c.x, sin(th * 3.0 + aMisc.z) * ${BIRD_BOB.toFixed(2)}, c.y);
  vec2 d = (-u * sin(th) * aMove.z + left * cos(th) * aMove.w) * sign(aMisc.y);
  fwd = normalize(d);
  loc.y += abs(loc.z) * 0.8 * sin(uU5Time * 9.0 + aMisc.z * 5.0);
} else if (kind < 2.5 || kind > 4.5) {
  // A walker (U6: a worker, a passenger, the cart) or a grazer: there and
  // back along its line, bobbing per step.
  float cyc = fract(uU5Time * aMove.w / (2.0 * aMove.z) + aMisc.y);
  float along = aMove.z * (1.0 - abs(2.0 * cyc - 1.0));
  at = aBase + vec3(u.x * along, abs(sin(along * 4.5)) * 0.05, u.y * along);
  fwd = u * (cyc < 0.5 ? 1.0 : -1.0);
  if (kind > 4.5) {
    // A deer or a fox: the head (local x past aMisc.z) dips to graze.
    float graze = smoothstep(0.1, 0.8, sin(uU5Time * 0.45 + aMisc.y * 6.2832));
    loc.y -= graze * 0.9 * max(0.0, loc.x - aMisc.z);
  }
} else if (kind < 3.5) {
  // U6 bat: hangs at its roost until the plane comes near, then swarms in
  // a loop below it, wings beating — and settles back as the plane goes.
  vec3 roost = (modelMatrix * vec4(aBase, 1.0)).xyz;
  float stir = 1.0 - smoothstep(30.0, 70.0, distance(roost, uPlane));
  float th = aMisc.z + aMisc.y * uU5Time;
  vec2 c = (u * cos(th) + left * sin(th)) * aMove.z * stir;
  at = aBase + vec3(c.x, -stir * (2.5 + 1.2 * sin(th * 1.7 + aMisc.z)), c.y);
  fwd = (-u * sin(th) + left * cos(th)) * sign(aMisc.y);
  loc.z *= mix(0.3, 1.0, stir);
  loc.y += abs(loc.z) * stir * 0.8 * sin(uU5Time * 20.0 + aMisc.z * 5.0);
} else {
  // U6 fish: an ellipse in the lake at its surface, tail beating, and a
  // jump now and then (5 % of a 14 s cycle).
  float th = aMisc.z + aMisc.y * uU5Time;
  vec2 c = u * cos(th) * aMove.z + left * sin(th) * aMove.w;
  float jc = fract(uU5Time * 0.071 + aMisc.w);
  float jump = jc < 0.05 ? sin(jc * 62.832) : 0.0;
  at = aBase + vec3(c.x, jump * 0.8, c.y);
  vec2 d = (-u * sin(th) * aMove.z + left * cos(th) * aMove.w) * sign(aMisc.y);
  fwd = normalize(d);
  loc.z += sin(uU5Time * 9.0 + aMisc.z * 3.0) * 0.1 * max(0.0, -loc.x);
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
  uniforms: Record<string, THREE.IUniform>,
  vPars: string,
  vBody: string,
  fPars: string,
  fBody: string,
): void {
  material.customProgramCacheKey = () => key;
  material.onBeforeCompile = (shader) => {
    // Every program binds every shared uniform (the time, U6's cave-ins
    // and the plane): one object per renderer, updated in place.
    Object.assign(shader.uniforms, uniforms);
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
  /** U6: up to CAVE_SLOTS warned / falling cave-ins near the camera —
   * render-space x, z, flicker amount (0: none), seed. A fixed-size array:
   * never a #define, so no tier or event ever recompiles a program. */
  private readonly caveIn = {
    value: Array.from({ length: CAVE_SLOTS }, () => new THREE.Vector4()),
  };
  /** U6: the camera's plane, render space — the bats leave their roost
   * as it passes. */
  private readonly plane = { value: new THREE.Vector3(0, 1e5, 0) };
  private readonly caveScratch: Vec3 = { x: 0, y: 0, z: 0 };
  private bands: number = BANDS;

  constructor() {
    this.buffers = buildUndergroundBuffers();
    const time = {
      uU5Time: this.time,
      uCaveIn: this.caveIn,
      uPlane: this.plane,
      uTunnelDetail: TUNNEL_DETAIL,
    };

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

  /** Snap under the camera; advance the shader clock (world ms). U6:
   * `planePos` (render space; default the camera) stirs the bats. */
  update(cameraPos: Vec3, worldMs: number, planePos: Vec3 = cameraPos): void {
    snapToPeriod(this.group, cameraPos);
    this.time.value = (((worldMs / 1000) % TIME_WRAP) + TIME_WRAP) % TIME_WRAP;
    this.plane.value.set(planePos.x, planePos.y, planePos.z);
  }

  /** U6: the bores' lamps flicker over each cave-in from its warning until
   * just after its rock is down — the nearest CAVE_SLOTS to `viewer` at
   * render time `renderMs` (null: none). */
  setCaveIns(
    list: readonly CaveIn[],
    viewer: Vec3,
    renderMs: number | null,
  ): void {
    const slots = this.caveIn.value;
    let k = 0;
    if (renderMs !== null) {
      for (let i = 0; i < list.length && k < CAVE_SLOTS; i++) {
        const c = list[i] as CaveIn;
        const ms = renderMs - c.t0;
        if (!(ms >= 0) || ms > c.downMs + 800) continue;
        const amount =
          ms < CAVEIN_WARN_MS ? 0.55 + (0.45 * ms) / CAVEIN_WARN_MS : 1;
        this.caveScratch.x = c.x;
        this.caveScratch.z = c.z;
        nearestImageInto(this.caveScratch, viewer, this.caveScratch);
        (slots[k++] as THREE.Vector4).set(
          this.caveScratch.x,
          this.caveScratch.z,
          amount,
          (c.id % 97) * 1.37,
        );
      }
    }
    for (; k < CAVE_SLOTS; k++) {
      const v = slots[k] as THREE.Vector4;
      if (v.z !== 0) v.set(0, 0, 0, 0);
    }
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
