// U4 underground tunnels, drawn: the concrete shell (ramps, walls, ceilings,
// lintels, the kerbs round each plaza cut) and the light fixtures (ceiling
// strips, wall guide lights, portal kerb lights, the river mouths' frames).
// Two draw calls for the whole network.
//
// Everything solid is drawn from common/src/city/tunnels.ts — the SAME
// tunnelSamples / tunnelSectionInto the tests check against hitsGround — so
// a wall, a ramp or a lintel is exactly where it kills. The ground plane
// (sky.ts) discards itself over the plaza cuts; the river structure
// (river.ts) leaves the mouth openings out of its embankment walls.
//
// UNLIT ON PURPOSE. A bore is under 40 m of rock: the moon, the hemisphere
// fill and the storm's lightning must not reach it. The shell is a
// MeshBasicMaterial whose vertex colours carry baked light (brighter under
// the ceiling strips, toward the wall tops), so the interior reads as a
// well-lit tunnel on every tier — the fixtures are dressing, which is what
// MOBILE drops. Fog still applies (fog: true), like everything else.
//
// U5: BRIGHT INSIDE. The bore is the night city's opposite, every surface
// still under the bloom threshold (0.72; the tests check every vertex).
// The station's glass (underground.ts) replaces the left wall along its
// window: the shell leaves that stretch of wall out.
//
// U7: bright means WELL LIT AND COLOURFUL, not a cream box (tunnel-look.ts).
// Vertex colours now carry each section's albedo (blended over 16 m) on
// exactly U4's faces, and `aSurf` carries (kind, s, v, wet|open) in
// bore-frame surface coordinates. The shader lights it (warm pools under
// the crown lights over a cool bounce, corner occlusion) and gives it
// form: rock relief and strata, concrete formwork seams, the metro's
// tiles, a gravel floor, a wet sheen by the water.
// The fixtures carry kind 0: drawn exactly as baked.
//
// TORUS. The network spans the whole world, so no single nearest-image
// offset places it. Each triangle is wrapped by its centroid into one
// canonical period, the period is copied 2×2, and the meshes are snapped by
// whole periods so the camera always sits in the middle — every image
// within the fog radius is present, and no triangle is ever stretched
// across the seam.

import {
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
} from "@angels-bandits/common/city/river";
import {
  BORE_WIDTH,
  PORTAL_CUTS,
  RIVER_MOUTHS,
  TUNNELS,
  type Tunnel,
  type TunnelSection,
  inCut,
  tunnelSamples,
  tunnelSectionInto,
  wallStart,
} from "@angels-bandits/common/city/tunnels";
import {
  EMISSIVE_LAMP,
  EMISSIVE_WINDOW,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { QualityTier } from "./quality";
import { QUALITY_PROFILES } from "./quality";
import {
  FACE,
  LOOK_NOISE_GLSL,
  type LookZone,
  POOL_STEP,
  SURF,
  TUNNEL_DETAIL,
  blankPalette,
  blendedPalette,
  lookZoneAt,
  materialOf,
  setTunnelDetail,
  surfKind,
  updateTunnelAir,
} from "./tunnel-look";
import { inStationWindow } from "./underground-layout";

/** Program cache key (the shell's surface shader). */
export const SHELL_CACHE_KEY = "ab-u7-shell";

/** Ceiling light strips: lateral offset, width, dash and gap, m. */
const STRIP_OFFSET = 7;
const STRIP_HALF = 0.4;
const STRIP_DASH = 8;
const STRIP_PERIOD = 12;
/** Wall guide lights: spacing, height over the floor, size, m. */
const GUIDE_STEP = 10;
const GUIDE_Y = 1.2;
const GUIDE_HALF = 0.3;
/** The kerb round a plaza cut: width and height, m (under the lamp-pole
 * band: dressing, not a solid). */
const KERB_W = 1;
const KERB_H = 0.4;
/** Portal kerb lights: spacing along the kerb, m. */
const KERB_LIGHT_STEP = 4;
/** The river mouth's frame lights: spacing up the jambs, m. */
const FRAME_STEP = 2.5;

const COLORS = {
  stone: 0x6f6a62,
  kerb: 0xbdb8ac,
  lane: 0xe8c45a,
  strip: 0xfff3dc,
  guide: 0xffa040,
  portal: 0x62e6ff,
  frame: 0xffc070,
} as const;

/** Baked light on the dressing drawn as-is (kind 0) and on the open cuts'
 * retaining walls (night air, no lamps). */
const LIGHT = {
  cutWallLow: 0.3,
  cutWallHigh: 0.42,
  kerb: 0.4,
  lane: 0.42,
} as const;

/** U7 corner occlusion (the shader's): a wall's foot and head, the floor
 * and the ceiling along the walls, reaching this far from a corner, m. */
const AO = { foot: 0.66, head: 0.76, edge: 0.73, reach: 1.6 };
/** U7: how wet each section's surfaces are near the floor, 0..1. */
const WET: Partial<Record<LookZone, number>> = {
  garden: 0.8,
  lake: 1,
  grotto: 0.45,
};

/** Linear colour of `hex` lit by `k`. */
const lit = (hex: number, k: number): THREE.Color =>
  new THREE.Color(hex).multiplyScalar(k);

/** Linear emissive colour that puts `hex` on ladder rung `rung`. */
function emitOf(hex: number, rung: number): THREE.Color {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(emissiveBoost(c, rung));
}

type P3 = readonly [number, number, number];

/** U7: a quad's surface — its kind (0: drawn as baked), the bore-frame
 * (u, v) of each corner, and wet (0..1, +2 over an open cut). */
interface Surf {
  kind: number;
  uv: readonly [number, number][];
  w: number;
}
const BAKED: Surf = {
  kind: 0,
  uv: [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ],
  w: 0,
};

/** A non-indexed triangle soup with per-vertex colour and surface, in
 * unwrapped world coordinates; geometry() wraps and tiles it (see the
 * header). */
class Soup {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly surf: number[] = [];

  /** Quad a→b→c→d, one colour per vertex pair (bottom a/b, top c/d) or
   * one per corner. */
  quad(
    a: P3,
    b: P3,
    c: P3,
    d: P3,
    lo: THREE.Color,
    hi: THREE.Color | readonly THREE.Color[] = lo,
    surf: Surf = BAKED,
  ): void {
    const corner = Array.isArray(hi)
      ? (hi as readonly THREE.Color[])
      : [lo, lo, hi as THREE.Color, hi as THREE.Color];
    const vs = [a, b, c, d];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const v = vs[i] as P3;
      const k = corner[i] as THREE.Color;
      const uv = surf.uv[i] as [number, number];
      this.pos.push(v[0], v[1], v[2]);
      this.col.push(k.r, k.g, k.b);
      this.surf.push(surf.kind, uv[0], uv[1], surf.w);
    }
  }

  /** A flat light quad centred at (x, y, z), spanning ±u along unit
   * (ux, uy, uz) and ±v along (vx, vy, vz). */
  patch(
    x: number,
    y: number,
    z: number,
    u: P3,
    v: P3,
    color: THREE.Color,
  ): void {
    const p = (su: number, sv: number): P3 => [
      x + u[0] * su + v[0] * sv,
      y + u[1] * su + v[1] * sv,
      z + u[2] * su + v[2] * sv,
    ];
    this.quad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), color);
  }

  /** Wrap every triangle into one period by its centroid, tile it 2×2. */
  geometry(): THREE.BufferGeometry {
    const n = this.pos.length;
    const out = new Float32Array(n * 4);
    const col = new Float32Array(n * 4);
    const surf = new Float32Array((n / 3) * 4 * 4);
    for (let t = 0; t < n; t += 9) {
      const cx =
        ((this.pos[t] as number) +
          (this.pos[t + 3] as number) +
          (this.pos[t + 6] as number)) /
        3;
      const cz =
        ((this.pos[t + 2] as number) +
          (this.pos[t + 5] as number) +
          (this.pos[t + 8] as number)) /
        3;
      const sx = Math.floor(cx / WORLD_SIZE) * WORLD_SIZE;
      const sz = Math.floor(cz / WORLD_SIZE) * WORLD_SIZE;
      let k = 0;
      for (const ox of [0, WORLD_SIZE]) {
        for (const oz of [0, WORLD_SIZE]) {
          const base = k * n + t;
          for (let v = 0; v < 9; v += 3) {
            out[base + v] = (this.pos[t + v] as number) - sx + ox;
            out[base + v + 1] = this.pos[t + v + 1] as number;
            out[base + v + 2] = (this.pos[t + v + 2] as number) - sz + oz;
            col[base + v] = this.col[t + v] as number;
            col[base + v + 1] = this.col[t + v + 1] as number;
            col[base + v + 2] = this.col[t + v + 2] as number;
          }
          // The surface rides along unchanged: bore-frame, not world.
          const sb = ((k * n + t) / 3) * 4;
          const st = (t / 3) * 4;
          for (let j = 0; j < 12; j++) {
            surf[sb + j] = this.surf[st + j] as number;
          }
          k++;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(out, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSurf", new THREE.BufferAttribute(surf, 4));
    return g;
  }
}

const secA: TunnelSection = {
  lx: 0,
  lz: 0,
  rx: 0,
  rz: 0,
  floor: 0,
  top: 0,
  covered: false,
};
const secB: TunnelSection = { ...secA };

/** One bore's shell (into `shell`) and fixtures (into `fix`). */
function buildBore(t: Tunnel, shell: Soup, fix: Soup): void {
  const samples = tunnelSamples(t);
  // River-mouth ends: each side wall starts at the embankment plane.
  const startL = wallStart(t, 0, 1);
  const startR = wallStart(t, 0, -1);
  const endL = wallStart(t, 1, 1);
  const endR = wallStart(t, 1, -1);
  const s0 = Math.min(startL, startR);
  const s1 = Math.max(endL, endR);
  const clampL = (s: number) => Math.min(Math.max(s, startL), endL);
  const clampR = (s: number) => Math.min(Math.max(s, startR), endR);
  const cutLow = lit(COLORS.stone, 0.75);
  const cutHigh = lit(COLORS.stone, 0.95);
  const laneC = lit(COLORS.lane, LIGHT.lane);
  const strip = emitOf(COLORS.strip, EMISSIVE_LAMP);
  const guide = emitOf(COLORS.guide, EMISSIVE_WINDOW);
  const palA = blankPalette();
  const palB = blankPalette();

  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i] as number;
    const b = samples[i + 1] as number;
    if (b <= s0 || a >= s1) continue;
    const covered = !inCut(t, (a + b) / 2);
    // Left edge at its own clipped s, right edge at its own.
    const la = clampL(a);
    const lb = clampL(b);
    const ra = clampR(a);
    const rb = clampR(b);
    tunnelSectionInto(t, la, covered, secA);
    const lA: P3 = [secA.lx, secA.floor, secA.lz];
    const lAt = secA.top;
    tunnelSectionInto(t, lb, covered, secB);
    const lB: P3 = [secB.lx, secB.floor, secB.lz];
    const lBt = secB.top;
    tunnelSectionInto(t, ra, covered, secA);
    const rA: P3 = [secA.rx, secA.floor, secA.rz];
    const rAt = secA.top;
    tunnelSectionInto(t, rb, covered, secB);
    const rB: P3 = [secB.rx, secB.floor, secB.rz];
    const rBt = secB.top;
    // U7: the section's look — its material, its palette at each end
    // (blended over 16 m), how wet it runs.
    const mid = (a + b) / 2;
    const zone = lookZoneAt(t, mid);
    const mat = covered ? materialOf(zone) : SURF.concrete;
    blendedPalette(t, a, palA);
    blendedPalette(t, b, palB);
    const wet = covered ? (WET[zone] ?? 0) : 0;
    const open = covered ? 0 : 2;
    // Floor, ceiling and walls: one quad each, as U4 drew them (the corner
    // occlusion is the shader's, from the bore-frame coordinates).
    const floorMat = mat === SURF.tile ? SURF.concrete : mat;
    const H2 = BORE_WIDTH / 2;
    shell.quad(
      lA,
      rA,
      rB,
      lB,
      palA.floor,
      [palA.floor, palA.floor, palB.floor, palB.floor],
      {
        kind: surfKind(floorMat, FACE.floor),
        uv: [
          [la, H2],
          [ra, -H2],
          [rb, -H2],
          [lb, H2],
        ],
        w: wet * 0.6 + open,
      },
    );
    if (covered) {
      shell.quad(
        [lA[0], lAt, lA[2]],
        [rA[0], rAt, rA[2]],
        [rB[0], rBt, rB[2]],
        [lB[0], lBt, lB[2]],
        palA.ceiling,
        [palA.ceiling, palA.ceiling, palB.ceiling, palB.ceiling],
        {
          kind: surfKind(mat, FACE.ceiling),
          uv: [
            [la, H2],
            [ra, -H2],
            [rb, -H2],
            [lb, H2],
          ],
          w: 0,
        },
      );
    }
    // Walls: the section's rock / concrete / tile in the bore, stone
    // retaining walls over a cut. Wet runs down the wall's foot: the
    // shader fades it by height.
    const wall = (
      pA: P3,
      pB: P3,
      topA: number,
      topB: number,
      sA: number,
      sB: number,
    ) => {
      const hA = topA - pA[1];
      const hB = topB - pB[1];
      shell.quad(
        pA,
        pB,
        [pB[0], topB, pB[2]],
        [pA[0], topA, pA[2]],
        covered ? palA.wall : cutLow,
        covered ? [palA.wall, palB.wall, palB.wall, palA.wall] : cutHigh,
        {
          kind: surfKind(mat, FACE.wall),
          uv: [
            [sA, 0],
            [sB, 0],
            [sB, hB],
            [sA, hA],
          ],
          w: wet + open,
        },
      );
    };
    // U5: the station's glass stands where the left wall would.
    if (!inStationWindow(t, mid0(a, b), 1)) wall(lA, lB, lAt, lBt, la, lb);
    wall(rA, rB, rAt, rBt, ra, rb);
    // Lane paint: a dashed centre line, slightly proud of the floor — on
    // the concrete runs only (a cave floor has none).
    if (
      floorMat === SURF.concrete &&
      Math.floor(mid / 6) % 2 === 0 &&
      a >= s0 + 2 &&
      b <= s1 - 2
    ) {
      const cA = mix(lA, rA, 0.5);
      const cB = mix(lB, rB, 0.5);
      const dx = (rA[0] - lA[0]) / BORE_WIDTH;
      const dz = (rA[2] - lA[2]) / BORE_WIDTH;
      shell.quad(
        [cA[0] - dx * 0.15, cA[1] + 0.03, cA[2] - dz * 0.15],
        [cA[0] + dx * 0.15, cA[1] + 0.03, cA[2] + dz * 0.15],
        [cB[0] + dx * 0.15, cB[1] + 0.03, cB[2] + dz * 0.15],
        [cB[0] - dx * 0.15, cB[1] + 0.03, cB[2] - dz * 0.15],
        laneC,
      );
    }
    // Ceiling strips: dashes, both sides of the crown.
    if (covered && Math.floor(mid) % STRIP_PERIOD < STRIP_DASH) {
      for (const off of [-STRIP_OFFSET, STRIP_OFFSET]) {
        const f = 0.5 - off / BORE_WIDTH;
        const pA = mix([lA[0], lAt, lA[2]], [rA[0], rAt, rA[2]], f);
        const pB = mix([lB[0], lBt, lB[2]], [rB[0], rBt, rB[2]], f);
        const dx = ((rA[0] - lA[0]) / BORE_WIDTH) * STRIP_HALF;
        const dz = ((rA[2] - lA[2]) / BORE_WIDTH) * STRIP_HALF;
        fix.quad(
          [pA[0] - dx, pA[1] - 0.05, pA[2] - dz],
          [pA[0] + dx, pA[1] - 0.05, pA[2] + dz],
          [pB[0] + dx, pB[1] - 0.05, pB[2] + dz],
          [pB[0] - dx, pB[1] - 0.05, pB[2] - dz],
          strip,
        );
      }
    }
    // Wall guide lights: amber, low on both walls, cut and bore alike.
    if (Math.floor(b / GUIDE_STEP) !== Math.floor(a / GUIDE_STEP)) {
      for (const [p, q, sgn] of [
        [lA, lB, 1],
        [rA, rB, -1],
      ] as const) {
        if (inStationWindow(t, mid0(a, b), sgn)) continue;
        const ux = (q[0] - p[0]) / Math.max(1e-6, b - a);
        const uz = (q[2] - p[2]) / Math.max(1e-6, b - a);
        // Inward, off the wall face: toward the other wall.
        const ix = ((rA[0] - lA[0]) / BORE_WIDTH) * sgn * 0.05;
        const iz = ((rA[2] - lA[2]) / BORE_WIDTH) * sgn * 0.05;
        fix.patch(
          p[0] + ix,
          p[1] + GUIDE_Y,
          p[2] + iz,
          [ux * GUIDE_HALF, 0, uz * GUIDE_HALF],
          [0, GUIDE_HALF * 0.6, 0],
          guide,
        );
      }
    }
  }

  // The lintel faces where a cut meets the bore, and each cut's kerb.
  const kerb = lit(COLORS.kerb, LIGHT.kerb);
  const portal = emitOf(COLORS.portal, EMISSIVE_LAMP);
  for (const end of [0, 1] as const) {
    const e = t.ends[end];
    if (e.kind !== "plaza") continue;
    const sm = end === 0 ? e.cut : t.length - e.cut;
    tunnelSectionInto(t, sm, true, secA);
    const lintelY = secA.top;
    const lintel = lit(COLORS.stone, 0.95);
    shell.quad(
      [secA.lx, secA.top, secA.lz],
      [secA.rx, secA.top, secA.rz],
      [secA.rx, 0, secA.rz],
      [secA.lx, 0, secA.lz],
      lintel,
      lintel,
      {
        kind: surfKind(SURF.concrete, FACE.wall),
        uv: [
          [0, secA.top],
          [BORE_WIDTH, secA.top],
          [BORE_WIDTH, 0],
          [0, 0],
        ],
        w: 2,
      },
    );
    // Kerbs: the two long sides (lip to lintel) and across the lintel top.
    const sl = end === 0 ? 0 : t.length;
    tunnelSectionInto(t, sl, false, secA);
    tunnelSectionInto(t, sm, false, secB);
    const ox = ((secA.lx - secA.rx) / BORE_WIDTH) * KERB_W;
    const oz = ((secA.lz - secA.rz) / BORE_WIDTH) * KERB_W;
    const ux = (secB.lx - secA.lx) / e.cut;
    const uz = (secB.lz - secA.lz) / e.cut;
    const kerbBox = (x0: number, z0: number, x1: number, z1: number) => {
      // A top face and the face toward the cut.
      shell.quad(
        [x0, KERB_H, z0],
        [x1, KERB_H, z1],
        [x1 + ox, KERB_H, z1 + oz],
        [x0 + ox, KERB_H, z0 + oz],
        kerb,
      );
      shell.quad(
        [x0, 0, z0],
        [x1, 0, z1],
        [x1, KERB_H, z1],
        [x0, KERB_H, z0],
        kerb,
      );
    };
    const ext = KERB_W;
    kerbBox(
      secA.lx - ux * ext,
      secA.lz - uz * ext,
      secB.lx + ux * ext,
      secB.lz + uz * ext,
    );
    // The right kerb grows the other way: flip the outward offset.
    shell.quad(
      [secA.rx - ux * ext, KERB_H, secA.rz - uz * ext],
      [secB.rx + ux * ext, KERB_H, secB.rz + uz * ext],
      [secB.rx + ux * ext - ox, KERB_H, secB.rz + uz * ext - oz],
      [secA.rx - ux * ext - ox, KERB_H, secA.rz - uz * ext - oz],
      kerb,
    );
    shell.quad(
      [secA.rx - ux * ext, 0, secA.rz - uz * ext],
      [secB.rx + ux * ext, 0, secB.rz + uz * ext],
      [secB.rx + ux * ext, KERB_H, secB.rz + uz * ext],
      [secA.rx - ux * ext, KERB_H, secA.rz - uz * ext],
      kerb,
    );
    // Across the lintel's top edge.
    shell.quad(
      [secB.lx, KERB_H, secB.lz],
      [secB.rx, KERB_H, secB.rz],
      [secB.rx + ux * KERB_W, KERB_H, secB.rz + uz * KERB_W],
      [secB.lx + ux * KERB_W, KERB_H, secB.lz + uz * KERB_W],
      kerb,
    );
    // Portal lights along both kerbs and the lintel edge: the "dive here".
    for (let d = 0; d <= e.cut; d += KERB_LIGHT_STEP) {
      for (const [x, z, sx] of [
        [secA.lx + ux * d, secA.lz + uz * d, 0.5],
        [secA.rx + ux * d, secA.rz + uz * d, -0.5],
      ] as const) {
        fix.patch(
          x + ox * sx,
          KERB_H + 0.02,
          z + oz * sx,
          [ux * 0.6, 0, uz * 0.6],
          [ox * 0.25, 0, oz * 0.25],
          portal,
        );
      }
    }
    for (let w = 2; w < BORE_WIDTH - 1; w += KERB_LIGHT_STEP) {
      const f = w / BORE_WIDTH;
      const x = secB.lx + (secB.rx - secB.lx) * f;
      const z = secB.lz + (secB.rz - secB.lz) * f;
      // Along the lintel's underside edge, on its face toward the cut.
      fix.patch(
        x - ux * 0.05,
        lintelY + 0.5,
        z - uz * 0.05,
        [
          ((secB.rx - secB.lx) / BORE_WIDTH) * 0.6,
          0,
          ((secB.rz - secB.lz) / BORE_WIDTH) * 0.6,
        ],
        [0, 0.25, 0],
        portal,
      );
    }
  }
}

const mid0 = (a: number, b: number): number => (a + b) / 2;

const mix = (a: P3, b: P3, f: number): P3 => [
  a[0] + (b[0] - a[0]) * f,
  a[1] + (b[1] - a[1]) * f,
  a[2] + (b[2] - a[2]) * f,
];

/** The river mouths' frames: lights up both jambs and along the lintel,
 * on the channel face of the embankment wall. */
function buildMouthFrames(fix: Soup): void {
  const frame = emitOf(COLORS.frame, EMISSIVE_LAMP);
  for (const m of RIVER_MOUTHS) {
    const z = RIVER_CENTER_Z + m.side * (RIVER_HALF_WIDTH - 0.07);
    for (const x of [m.x0 - 0.6, m.x1 + 0.6]) {
      for (let y = m.y0 + 1.5; y < m.y1; y += FRAME_STEP) {
        fix.patch(x, y, z, [0.25, 0, 0], [0, 0.6, 0], frame);
      }
    }
    for (let x = m.x0; x <= m.x1; x += FRAME_STEP * 1.6) {
      fix.patch(x, m.y1 + 0.5, z, [0.6, 0, 0], [0, 0.22, 0], frame);
    }
  }
}

/** Both meshes' geometry: [shell, fixtures]. Exported for the tests. */
export function buildTunnelGeometry(): [
  THREE.BufferGeometry,
  THREE.BufferGeometry,
] {
  const shell = new Soup();
  const fix = new Soup();
  for (const t of TUNNELS) buildBore(t, shell, fix);
  buildMouthFrames(fix);
  return [shell.geometry(), fix.geometry()];
}

/** Snap a 2×2-tiled group by whole periods so the camera sits in the
 * middle of it (every image within the fog radius is present). */
export function snapToPeriod(group: THREE.Object3D, cameraPos: Vec3): void {
  const x = Math.floor((cameraPos.x - WORLD_SIZE / 2) / WORLD_SIZE);
  const z = Math.floor((cameraPos.z - WORLD_SIZE / 2) / WORLD_SIZE);
  group.position.set(x * WORLD_SIZE, 0, z * WORLD_SIZE);
}

// --- U7: the surface shader --------------------------------------------------

const SHELL_VERTEX_PARS = /* glsl */ `
attribute vec4 aSurf;
flat varying float vSurfKind;
varying vec3 vSurf;
varying vec3 vLookWorld;
`;
const SHELL_VERTEX = /* glsl */ `
vSurfKind = aSurf.x;
vSurf = aSurf.yzw;
vLookWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const SHELL_FRAGMENT_PARS = /* glsl */ `
flat varying float vSurfKind;
varying vec3 vSurf;
varying vec3 vLookWorld;
${LOOK_NOISE_GLSL}
`;
/** After color_fragment: diffuseColor.rgb is the baked albedo × occlusion
 * (kind > 0) — light it and give it form. Kind 0 is drawn as baked. */
const SHELL_FRAGMENT = /* glsl */ `
// Derivatives outside any branch (undefined in non-uniform control flow).
vec2 abUV = vSurf.xy;
vec2 abFw = fwidth(abUV);
float abPx = max(max(abFw.x, abFw.y), 1e-4);
vec3 abNf = cross(dFdx(vLookWorld), dFdy(vLookWorld));
// kind is the same at every corner (flat): rounded, never an interpolant.
float abKind = floor(vSurfKind + 0.5);
if (abKind > 0.5) {
  float abFace = mod(abKind - 1.0, 3.0);
  float abMat = floor((abKind - 1.0) / 3.0 + 0.01);
  float abOpen = step(1.5, vSurf.z);
  float abWet = clamp(vSurf.z - 2.0 * abOpen, 0.0, 1.0);
  float isWall = 1.0 - step(0.5, abFace);
  float isFloor = step(1.5, abFace);
  float isCeil = 1.0 - isWall - isFloor;
  // Corner occlusion: a wall's foot (v is height) and the deep bore's
  // head; the floor and the ceiling along the walls (v is lateral).
  float aoWall = mix(${AO.foot.toFixed(2)}, 1.0, smoothstep(0.0, ${AO.reach.toFixed(1)}, abUV.y)) *
    mix(1.0, ${AO.head.toFixed(2)}, smoothstep(${(24 - AO.reach).toFixed(1)}, 24.0, abUV.y));
  float aoFlat = mix(1.0, ${AO.edge.toFixed(2)}, smoothstep(${(18 - AO.reach).toFixed(1)}, 18.0, abs(abUV.y)));
  vec3 alb = diffuseColor.rgb * mix(aoFlat, aoWall, isWall * (1.0 - abOpen));
  abWet *= mix(1.0, max(0.0, 1.0 - abUV.y / 8.0), isWall);
  // Warm pools under the crown lights (every POOL_STEP along the bore), a
  // cool bounce everywhere; an open cut only has the night air.
  float ds = (fract(abUV.x / ${POOL_STEP.toFixed(1)} + 0.5) - 0.5) * ${POOL_STEP.toFixed(1)};
  float vh = clamp(abUV.y / 24.0, 0.0, 1.0);
  float latK = clamp(abs(abUV.y) / 18.0, 0.0, 1.0);
  float pool = exp(-ds * ds / 22.0) *
    (isWall * (0.3 + 0.7 * vh) + isFloor * (1.0 - 0.5 * latK * latK) + isCeil * 0.32) *
    (1.0 - abOpen);
  float amb = mix(isWall * (0.6 - 0.1 * vh) + isFloor * 0.56 + isCeil * 0.46, 0.42, abOpen);
  vec3 abWarm = vec3(1.0, 0.8, 0.56);
  vec3 abCool = vec3(0.66, 0.8, 1.0);
  // Relief: fBm in bore-frame metres, its gradient lit toward the pool.
  vec3 n = abFbm(abUV, 0.42, abPx);
  vec2 grad = n.yz;
  float detail = 0.84 + 0.5 * n.x;
  float gloss = 0.0;
  if (abMat < 0.5) {
    // ROCK: strata on the walls — bands up the face, warped slowly.
    if (isWall > 0.5) {
      float warp = abNoiseD(abUV * vec2(0.025, 0.07) + 3.1).x;
      float band = abUV.y * 1.3 + warp * 7.0 + n.x * 1.5;
      float strataFade = 1.0 - smoothstep(0.06, 0.2, abPx * 1.3);
      float st = smoothstep(-0.55, 0.75, sin(band * 3.1));
      detail *= mix(1.0, 0.74 + 0.36 * st, strataFade);
    }
    // The floor: gravel and the odd crack — only on the floor (a whole
    // triangle takes one side of this branch: no divergence, and the walls
    // and ceiling skip half the noise).
    if (isFloor > 0.5) {
      vec3 g = abFbm(abUV + 40.0, 2.4, abPx);
      float ridge = 1.0 - abs(2.0 * abNoiseD(abUV * 0.16 + 9.0).x - 1.0);
      float crack = smoothstep(0.95, 0.99, ridge) * (1.0 - smoothstep(0.03, 0.09, abPx));
      detail *= (0.92 + 0.4 * g.x) * (1.0 - 0.45 * crack);
      grad += g.yz * 0.25;
    }
  } else if (abMat < 1.5) {
    // CONCRETE: formwork panels 2.4 × 1.2 m, seams and tie holes,
    // streaks down the walls; a floor of 6 m slabs.
    vec2 sz = mix(vec2(2.4, 1.2), vec2(6.0, 4.5), isFloor);
    vec2 cell = abUV / sz;
    vec2 e = (0.5 - abs(fract(cell) - 0.5)) * sz;
    float seam = 1.0 - smoothstep(0.02, 0.02 + abPx * 1.5, min(e.x, e.y));
    vec2 q = (fract(cell * vec2(2.0, 1.0)) - 0.5) * sz * vec2(0.5, 1.0);
    float tie = (1.0 - smoothstep(0.035, 0.035 + abPx * 1.5, length(q))) * (1.0 - isFloor);
    float fine = 1.0 - smoothstep(0.02, 0.07, abPx);
    float stain = abNoiseD(abUV * vec2(0.9, 0.05) + 5.0).x;
    detail = (0.9 + 0.22 * n.x) * (0.88 + 0.24 * stain) *
      (1.0 - 0.42 * max(seam, tie) * fine);
    grad *= 0.3;
  } else {
    // TILE (the metro): 0.6 × 0.3 m glazed tiles, grout, a tone per tile.
    vec2 sz = vec2(0.6, 0.3);
    vec2 cell = abUV / sz;
    vec2 e = (0.5 - abs(fract(cell) - 0.5)) * sz;
    float grout = 1.0 - smoothstep(0.009, 0.009 + abPx * 1.5, min(e.x, e.y));
    float fine = 1.0 - smoothstep(0.01, 0.035, abPx);
    float tone = abHash(floor(cell) + 7.0);
    detail = mix(1.0, 0.94 + 0.12 * tone, fine) * (1.0 - 0.38 * grout * fine);
    grad *= 0.08;
    gloss = 1.0;
  }
  // The bump, lit from the pool's side and from above (walls) — MOBILE
  // (detail 2) keeps the albedo pattern, drops the bump.
  float bumpOn = step(2.5, uTunnelDetail);
  vec2 L = vec2(-ds / (abs(ds) + 4.0), isWall * 0.9 - isCeil * 0.5);
  float shade = clamp(1.0 - bumpOn * 0.85 * dot(grad, L), 0.6, 1.4);
  vec3 light = abCool * amb + abWarm * pool;
  // A wet sheen near the water and on the metro's glaze: the warm light
  // caught at grazing angles.
  vec3 V = normalize(cameraPosition - vLookWorld);
  // max(): an |dot| that rounds past 1 must not reach pow() (NaN, O7).
  float fres = pow(max(1.0 - abs(dot(abSafeNormal(abNf, V), V)), 0.0), 4.0);
  alb *= 1.0 - 0.3 * abWet;
  vec3 sheen = abWarm * fres * (0.04 + 0.45 * pool) *
    (abWet * (0.6 + 0.8 * clamp(n.x + 0.5, 0.0, 1.0)) + gloss * 0.35);
  diffuseColor.rgb = abUnderClamp(alb * detail * shade * light + sheen);
}
`;

/** The network's two draws. */
export class TunnelRenderer {
  readonly group = new THREE.Group();
  readonly shell: THREE.Mesh;
  readonly fixtures: THREE.Mesh;

  constructor() {
    const [shellGeo, fixGeo] = buildTunnelGeometry();
    // One unlit material for both (one program): vertex colours carry the
    // baked albedo and the emissive rungs; U7's surface shader lights the
    // shell (kind > 0) and leaves the fixtures (kind 0) as baked.
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: true,
    });
    material.customProgramCacheKey = () => SHELL_CACHE_KEY;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTunnelDetail = TUNNEL_DETAIL;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${SHELL_VERTEX_PARS}`)
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${SHELL_VERTEX}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\n${SHELL_FRAGMENT_PARS}`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>\n${SHELL_FRAGMENT}`,
        );
    };
    this.shell = new THREE.Mesh(shellGeo, material);
    this.fixtures = new THREE.Mesh(fixGeo, material);
    for (const m of [this.shell, this.fixtures]) {
      // Spans 2×2 world periods: never culled as a whole (it is snapped
      // under the camera every frame), drawn after the opaque city so the
      // ground and the facades reject most of it early.
      m.frustumCulled = false;
      m.renderOrder = 1;
    }
    this.group.add(this.shell, this.fixtures);
  }

  /** Snap both meshes by whole periods so the camera sits in the middle;
   * U7: and set the bores' air from where the camera is. */
  update(cameraPos: Vec3): void {
    snapToPeriod(this.group, cameraPos);
    updateTunnelAir(cameraPos);
  }

  setQuality(tier: QualityTier): void {
    this.fixtures.visible = QUALITY_PROFILES[tier].tunnelFixtures;
    setTunnelDetail(tier);
  }
}

/** The plaza cuts as the ground shader's discard table: `vec4(x0, z0, x1,
 * z1)` per cut, canonical. */
export const PORTAL_CUT_RECTS: readonly [number, number, number, number][] =
  PORTAL_CUTS.map((c) => [c.x0, c.z0, c.x1, c.z1]);

/** GLSL: true where the ground plane must not draw — over a plaza cut. */
export const TUNNEL_GROUND_PARS = /* glsl */ `
bool abPortalOpen(vec2 w) {
  vec2 c = mod(w, ${glsl(WORLD_SIZE)});
${PORTAL_CUT_RECTS.map(
  ([x0, z0, x1, z1]) =>
    `  if (c.x > ${glsl(x0)} && c.x < ${glsl(x1)} && c.y > ${glsl(z0)} && c.y < ${glsl(z1)}) return true;`,
).join("\n")}
  return false;
}
`;

function glsl(v: number): string {
  const s = String(v);
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
}
