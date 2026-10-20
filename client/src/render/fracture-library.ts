// DS2 fracture library: the shapes a collapse's pieces break into. DS1's
// pieces are oriented boxes (what Rapier and the crash check collide), and
// D10 drew every one of them as the same chipped box. Real debris is
// irregular, and each material breaks its own way, so the shapes come from
// a baked library instead:
//
//   - each VARIANT is a Voronoi-style cell — the unit box clipped by a few
//     seeded planes, i.e. a convex polytope INSIDE the box, so a piece is
//     still drawn inside the box it collides as (drawn ⊆ collided);
//   - each material CLASS seeds its planes its own way: a concrete slab's
//     cuts are torn edges round its outline (rebar bristling out of them),
//     masonry crumbles into chunky cells cut every way, a glass panel
//     splits into slivers, a steel member is torn off at a slant at its
//     ends (and twisted and bowed in the shader, debris.ts);
//   - the classes are canonical: Y is the plate's THIN axis (the steel's
//     LONG one), and the vertex shader rotates it onto the piece's own.
//
// One mesh still draws every piece (no new draw): every variant shares one
// index buffer — FACE_SLOTS polygon slots of FACE_VERTS vertices each (a
// fan; a shorter polygon repeats its last vertex, a missing face collapses
// to a point) plus REBAR_BARS bars of BAR_VERTS — and the debris vertex
// shader reads its variant's vertex from one float texture by gl_VertexID.
// Built once at boot (pure, seeded: every client bakes the same library).

import { mulberry32 } from "@angels-bandits/common/city";
import * as THREE from "three";

/** The material classes a piece breaks as (the texture's row blocks). */
export const FracClass = {
  CONCRETE: 0,
  MASONRY: 1,
  GLASS: 2,
  STEEL: 3,
} as const;
export type FracClass = (typeof FracClass)[keyof typeof FracClass];
export const FRAC_CLASSES = 4;

/** Variants per class. */
export const FRACTURE_VARIANTS = 8;
/** Polygon slots: the box's six faces, then one per cut plane. */
export const MAX_CUTS = 6;
export const FACE_SLOTS = 6 + MAX_CUTS;
/** Vertices per polygon slot (the most a face of a variant may have). */
export const FACE_VERTS = 8;
/** Rebar bars per variant (concrete only), and vertices per bar: two
 * crossed ribbons. */
export const REBAR_BARS = 6;
export const BAR_VERTS = 8;
/** Vertices per piece: every variant draws all of them. */
export const LIB_VERTS = FACE_SLOTS * FACE_VERTS + REBAR_BARS * BAR_VERTS;
/** The budget the library is held to (vertex shader work per piece). */
export const FRACTURE_VERT_BUDGET = 160;
/** The texture's row of the intact box (a piece not broken yet). */
export const INTACT_ROW = FRAC_CLASSES * FRACTURE_VARIANTS;
export const LIB_ROWS = INTACT_ROW + 1;
/** Texels per vertex row: position + flag, normal + bar id, rebar offset,
 * and a rebar vertex's bar start + whether it is the outer end. */
export const ROW_TEXELS = 4;

/** texel 0's w: what a vertex lies on. */
export const ON_BOX = 0;
export const ON_CUT = 1;
export const ON_REBAR = 2;

/** A cell keeps at least this share of its box's volume (no slivers that
 * vanish), and at most this (it is visibly broken). */
export const MIN_VOLUME_SHARE = 0.3;
export const MAX_VOLUME_SHARE = 0.97;

type V3 = [number, number, number];

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => mul(a, 1 / Math.max(1e-9, Math.hypot(...a)));

/** One polygon of a cell: its outward normal, its vertices (CCW about the
 * normal), and whether a cut made it. */
export interface CellFace {
  n: V3;
  poly: V3[];
  cut: boolean;
}

/** A bar of rebar: from `a` (inside the broken concrete) to `b` (out in
 * the air the break opened, still inside the box). */
export interface Bar {
  a: V3;
  b: V3;
}

/** One baked variant, centred canonical coordinates ([-0.5, 0.5]³). */
export interface Cell {
  /** Slot k < 6: the box face k (empty if cut away); k ≥ 6: cut k − 6. */
  faces: (CellFace | null)[];
  bars: Bar[];
}

/** The box's six faces in slot order (±X, ±Y, ±Z), CCW about the normal. */
function boxFaces(): CellFace[] {
  const spec: [V3, V3, V3][] = [
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [0, 1, 0],
      [1, 0, 0],
    ],
  ];
  return spec.map(([n, u, v]) => {
    const c = mul(n, 0.5);
    const at = (su: number, sv: number) =>
      add(add(c, mul(u, 0.5 * su)), mul(v, 0.5 * sv));
    return {
      n,
      poly: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)],
      cut: false,
    };
  });
}

const EPS = 1e-7;

/** Clip the cell's faces by n·p ≤ d; returns the cap (null if the plane
 * missed the cell). Sutherland–Hodgman per face; the cap is the points the
 * clipped edges made, sorted round the plane normal. */
function clipCell(
  faces: (CellFace | null)[],
  n: V3,
  d: number,
): CellFace | null {
  const capPts: V3[] = [];
  let clipped = false;
  for (let k = 0; k < faces.length; k++) {
    const f = faces[k];
    if (!f) continue;
    const out: V3[] = [];
    const poly = f.poly;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as V3;
      const q = poly[(i + 1) % poly.length] as V3;
      const dp = dot(n, p) - d;
      const dq = dot(n, q) - d;
      if (dp <= EPS) out.push(p);
      else clipped = true;
      if ((dp < -EPS && dq > EPS) || (dp > EPS && dq < -EPS)) {
        const t = dp / (dp - dq);
        const x = add(p, mul(sub(q, p), t));
        out.push(x);
        capPts.push(x);
      } else if (Math.abs(dp) <= EPS) {
        capPts.push(p);
      }
    }
    faces[k] = out.length >= 3 ? { ...f, poly: out } : null;
  }
  if (!clipped) return null;
  // Dedupe, then sort CCW about n.
  const pts: V3[] = [];
  for (const p of capPts) {
    if (!pts.some((q) => Math.hypot(...sub(p, q)) < 1e-6)) pts.push(p);
  }
  if (pts.length < 3) return null;
  const c = mul(
    pts.reduce((s, p) => add(s, p), [0, 0, 0] as V3),
    1 / pts.length,
  );
  const t1 = norm(sub(pts[0] as V3, c));
  const t2 = cross(n, t1);
  pts.sort(
    (a, b) =>
      Math.atan2(dot(sub(a, c), t2), dot(sub(a, c), t1)) -
      Math.atan2(dot(sub(b, c), t2), dot(sub(b, c), t1)),
  );
  return { n, poly: pts, cut: true };
}

/** Where the ray p + t·dir leaves the box [-0.5, 0.5]³ (t ≥ 0). */
function boxExit(p: V3, dir: V3): number {
  let t = Number.POSITIVE_INFINITY;
  for (let a = 0; a < 3; a++) {
    const v = dir[a] as number;
    if (Math.abs(v) < 1e-9) continue;
    const wall = v > 0 ? 0.5 : -0.5;
    t = Math.min(t, (wall - (p[a] as number)) / v);
  }
  return t;
}

/** A random unit vector from `rand`, its y in [yLo, yHi] (signed). */
function dirWithY(rand: () => number, yLo: number, yHi: number): V3 {
  const a = rand() * Math.PI * 2;
  const y = (yLo + (yHi - yLo) * rand()) * (rand() < 0.5 ? -1 : 1);
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return [Math.cos(a) * r, y, Math.sin(a) * r];
}

/** How each class seeds its planes: [normal, cut share of the box's
 * support along it] — a share s puts the plane at (1 − s) of the way out. */
type PlaneSpec = { n: V3; share: number };
function classPlanes(cls: FracClass, rand: () => number): PlaneSpec[] {
  const planes: PlaneSpec[] = [];
  const lerp = (lo: number, hi: number) => lo + (hi - lo) * rand();
  if (cls === FracClass.CONCRETE) {
    // Torn edges round the slab's outline, a chunk or two off its faces.
    const edges = 3 + Math.floor(rand() * 2);
    for (let i = 0; i < edges; i++) {
      planes.push({ n: norm(dirWithY(rand, 0, 0.3)), share: lerp(0.12, 0.38) });
    }
    const chips = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < chips; i++) {
      planes.push({
        n: norm(dirWithY(rand, 0.45, 0.85)),
        share: lerp(0.06, 0.25),
      });
    }
  } else if (cls === FracClass.MASONRY) {
    // Crumbled: chunky cuts every way.
    const n = 5 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      planes.push({ n: norm(dirWithY(rand, 0, 0.8)), share: lerp(0.14, 0.4) });
    }
  } else if (cls === FracClass.GLASS) {
    // A pane splits into slivers: deep cuts across the plate.
    const n = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      planes.push({
        n: norm(dirWithY(rand, 0, 0.08)),
        share: lerp(0.22, 0.55),
      });
    }
  } else {
    // Steel (canonical Y long): torn off at a slant at both ends, maybe
    // gouged along its length.
    for (const end of [1, -1]) {
      const t = lerp(0.5, 1.4);
      const a = rand() * Math.PI * 2;
      planes.push({
        n: norm([Math.cos(a) * t, end, Math.sin(a) * t]),
        share: lerp(0.08, 0.22),
      });
    }
    if (rand() < 0.5) {
      planes.push({ n: norm(dirWithY(rand, 0, 0.2)), share: lerp(0.1, 0.25) });
    }
  }
  return planes.slice(0, MAX_CUTS);
}

/** The box's support along n (half extent of the unit box along n). */
const support = (n: V3): number =>
  0.5 * (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]));

/** A cell's volume, by the divergence theorem over its fans. */
export function cellVolume(cell: Cell): number {
  let v = 0;
  for (const f of cell.faces) {
    if (!f) continue;
    const p0 = f.poly[0] as V3;
    for (let i = 1; i + 1 < f.poly.length; i++) {
      v += dot(p0, cross(f.poly[i] as V3, f.poly[i + 1] as V3)) / 6;
    }
  }
  return v;
}

/** Bake one variant of `cls` from `seed`: retried (seed + 1, …) until no
 * face passes FACE_VERTS and the volume share is in range. */
export function bakeCell(cls: FracClass, seed: number): Cell {
  for (let attempt = 0; ; attempt++) {
    const rand = mulberry32((seed + attempt * 7919) >>> 0);
    const faces: (CellFace | null)[] = boxFaces();
    for (const p of classPlanes(cls, rand)) {
      const cap = clipCell(faces, p.n, support(p.n) * (1 - p.share));
      faces.push(cap);
    }
    while (faces.length < FACE_SLOTS) faces.push(null);
    const cell: Cell = { faces, bars: [] };
    const vol = cellVolume(cell);
    const ok =
      faces.every((f) => !f || f.poly.length <= FACE_VERTS) &&
      vol >= MIN_VOLUME_SHARE &&
      vol <= MAX_VOLUME_SHARE;
    if (!ok && attempt < 64) continue;
    if (cls === FracClass.CONCRETE) cell.bars = rebarFor(cell, rand);
    return cell;
  }
}

/** Rebar out of a concrete cell's torn edges: from a point just behind a
 * near-vertical cut face, out along its normal (fanned, drooping) until
 * just short of the box. */
function rebarFor(cell: Cell, rand: () => number): Bar[] {
  const bars: Bar[] = [];
  for (let k = 6; k < cell.faces.length && bars.length < REBAR_BARS; k++) {
    const f = cell.faces[k];
    if (!f || Math.abs(f.n[1]) > 0.6) continue;
    const per = 1 + Math.floor(rand() * 2);
    const c = mul(
      f.poly.reduce((s, p) => add(s, p), [0, 0, 0] as V3),
      1 / f.poly.length,
    );
    for (let j = 0; j < per && bars.length < REBAR_BARS; j++) {
      const corner = f.poly[Math.floor(rand() * f.poly.length)] as V3;
      let a = add(c, mul(sub(corner, c), 0.15 + 0.55 * rand()));
      a = [a[0], 0, a[2]]; // mid-depth of the slab
      a = sub(a, mul(f.n, 0.03));
      const turn = (rand() - 0.5) * 0.8;
      const hx = f.n[0] * Math.cos(turn) - f.n[2] * Math.sin(turn);
      const hz = f.n[0] * Math.sin(turn) + f.n[2] * Math.cos(turn);
      const dir = norm([hx, -0.25 * rand(), hz]);
      const reach = boxExit(a, dir);
      const len = (reach - 0.01) * (0.55 + 0.45 * rand());
      if (!(len > 0.04)) continue;
      bars.push({ a, b: add(a, mul(dir, len)) });
    }
  }
  return bars;
}

/** The intact box: its six faces, no cuts, no bars. */
export function intactCell(): Cell {
  const faces: (CellFace | null)[] = boxFaces();
  while (faces.length < FACE_SLOTS) faces.push(null);
  return { faces, bars: [] };
}

/** Every variant: class-major rows, then the intact box. */
export function bakeLibrary(seed = 0x0d52): Cell[] {
  const cells: Cell[] = [];
  for (let cls = 0; cls < FRAC_CLASSES; cls++) {
    for (let v = 0; v < FRACTURE_VARIANTS; v++) {
      cells.push(bakeCell(cls as FracClass, seed + cls * 1009 + v * 131));
    }
  }
  cells.push(intactCell());
  return cells;
}

/**
 * The library as texture rows: per cell ROW_TEXELS rows of LIB_VERTS
 * texels — (position, what it lies on), (normal, bar id), (rebar offset
 * direction, side), (a bar's start, 1 on its outer end). Missing faces and
 * bars collapse to the centre.
 */
export function libraryTexels(cells: readonly Cell[]) {
  const data = new Float32Array(LIB_VERTS * cells.length * ROW_TEXELS * 4);
  cells.forEach((cell, r) => {
    const put = (
      row: number,
      v: number,
      x: number,
      y: number,
      z: number,
      w: number,
    ) => {
      const o = ((r * ROW_TEXELS + row) * LIB_VERTS + v) * 4;
      data[o] = x;
      data[o + 1] = y;
      data[o + 2] = z;
      data[o + 3] = w;
    };
    for (let s = 0; s < FACE_SLOTS; s++) {
      const f = cell.faces[s];
      for (let i = 0; i < FACE_VERTS; i++) {
        const v = s * FACE_VERTS + i;
        if (!f) {
          put(0, v, 0, 0, 0, ON_BOX);
          put(1, v, 0, 1, 0, 0);
          put(2, v, 0, 0, 0, 0);
          put(3, v, 0, 0, 0, 0);
          continue;
        }
        const p = f.poly[Math.min(i, f.poly.length - 1)] as V3;
        put(0, v, p[0], p[1], p[2], f.cut ? ON_CUT : ON_BOX);
        put(1, v, f.n[0], f.n[1], f.n[2], 0);
        put(2, v, 0, 0, 0, 0);
        put(3, v, 0, 0, 0, 0);
      }
    }
    for (let b = 0; b < REBAR_BARS; b++) {
      const bar = cell.bars[b];
      const base = FACE_SLOTS * FACE_VERTS + b * BAR_VERTS;
      if (!bar) {
        for (let i = 0; i < BAR_VERTS; i++) {
          put(0, base + i, 0, 0, 0, ON_REBAR);
          put(1, base + i, 0, 1, 0, b);
          put(2, base + i, 0, 0, 0, 0);
          put(3, base + i, 0, 0, 0, 0);
        }
        continue;
      }
      const d = norm(sub(bar.b, bar.a));
      const side = norm([-d[2], 0, d[0]]);
      const up: V3 = [0, 1, 0];
      // Ribbon A (offset up, faces sideways), ribbon B (offset sideways,
      // faces up): a, a, b, b with the offset −/+.
      const ribbons: [V3, V3][] = [
        [up, side],
        [side, up],
      ];
      ribbons.forEach(([off, n], k) => {
        const pts: [V3, number][] = [
          [bar.a, -1],
          [bar.a, 1],
          [bar.b, -1],
          [bar.b, 1],
        ];
        pts.forEach(([p, sgn], i) => {
          const v = base + k * 4 + i;
          put(0, v, p[0], p[1], p[2], ON_REBAR);
          put(1, v, n[0], n[1], n[2], b);
          put(2, v, off[0] * sgn, off[1] * sgn, off[2] * sgn, 0);
          put(3, v, bar.a[0], bar.a[1], bar.a[2], p === bar.b ? 1 : 0);
        });
      });
    }
  });
  return data;
}

/** The shared index buffer: a fan per polygon slot, both windings for the
 * two ribbons of each bar. */
export function libraryIndices(): number[] {
  const idx: number[] = [];
  for (let s = 0; s < FACE_SLOTS; s++) {
    const b = s * FACE_VERTS;
    for (let i = 1; i + 1 < FACE_VERTS; i++) idx.push(b, b + i, b + i + 1);
  }
  for (let bar = 0; bar < REBAR_BARS; bar++) {
    for (let k = 0; k < 2; k++) {
      const b = FACE_SLOTS * FACE_VERTS + bar * BAR_VERTS + k * 4;
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  return idx;
}

/** The baked library as a float texture (built once, shared). */
let libTexture: THREE.DataTexture | null = null;
export function fractureLibraryTexture(): THREE.DataTexture {
  if (libTexture) return libTexture;
  const cells = bakeLibrary();
  const tex = new THREE.DataTexture(
    libraryTexels(cells),
    LIB_VERTS,
    cells.length * ROW_TEXELS,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  libTexture = tex;
  return tex;
}

/** DL1 rebar (the Destruction Lab's look, destruct-look.ts): the share of
 * each torn slab's bars drawn. 1 (the default): all of them. */
export const REBAR_UNIFORM = { value: 1 };
