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
// well-lit concrete tunnel on every tier — the fixtures are dressing, which
// is what MOBILE drops. Fog still applies (fog: true), like everything else.
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
  concrete: 0xc2c6cf,
  floor: 0x5c6069,
  ceiling: 0x9da2ad,
  stone: 0x8d8579,
  kerb: 0xd9d6cc,
  lane: 0xe8c45a,
  strip: 0xfff3dc,
  guide: 0xffa040,
  portal: 0x62e6ff,
  frame: 0xffc070,
} as const;

/** Baked light levels (multipliers on the albedo): walls brighten toward
 * the strips, the floor toward the middle. Kept under the bloom threshold —
 * a lit wall is never a ladder rung. */
const LIGHT = {
  floor: 0.42,
  wallLow: 0.36,
  wallHigh: 0.62,
  ceiling: 0.5,
  cutWallLow: 0.3,
  cutWallHigh: 0.42,
  kerb: 0.55,
} as const;

/** Linear colour of `hex` lit by `k`. */
const lit = (hex: number, k: number): THREE.Color =>
  new THREE.Color(hex).multiplyScalar(k);

/** Linear emissive colour that puts `hex` on ladder rung `rung`. */
function emitOf(hex: number, rung: number): THREE.Color {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(emissiveBoost(c, rung));
}

type P3 = readonly [number, number, number];

/** A non-indexed triangle soup with per-vertex colour, in unwrapped world
 * coordinates; geometry() wraps and tiles it (see the header). */
class Soup {
  readonly pos: number[] = [];
  readonly col: number[] = [];

  /** Quad a→b→c→d, one colour per vertex pair (bottom a/b, top c/d). */
  quad(a: P3, b: P3, c: P3, d: P3, lo: THREE.Color, hi = lo): void {
    const cols = [lo, lo, hi, lo, hi, hi];
    const vs = [a, b, c, a, c, d];
    for (let i = 0; i < 6; i++) {
      const v = vs[i] as P3;
      const k = cols[i] as THREE.Color;
      this.pos.push(v[0], v[1], v[2]);
      this.col.push(k.r, k.g, k.b);
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
          k++;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(out, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
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
  const wallC = lit(COLORS.concrete, LIGHT.wallLow);
  const wallTop = lit(COLORS.concrete, LIGHT.wallHigh);
  const cutLow = lit(COLORS.stone, LIGHT.cutWallLow);
  const cutHigh = lit(COLORS.stone, LIGHT.cutWallHigh);
  const floorC = lit(COLORS.floor, LIGHT.floor);
  const ceilC = lit(COLORS.ceiling, LIGHT.ceiling);
  const laneC = lit(COLORS.lane, 0.55);
  const strip = emitOf(COLORS.strip, EMISSIVE_LAMP);
  const guide = emitOf(COLORS.guide, EMISSIVE_WINDOW);

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
    // Floor.
    shell.quad(lA, rA, rB, lB, floorC);
    // Walls: concrete in the bore, stone retaining walls over a cut.
    const lo = covered ? wallC : cutLow;
    const hi = covered ? wallTop : cutHigh;
    shell.quad(lA, lB, [lB[0], lBt, lB[2]], [lA[0], lAt, lA[2]], lo, hi);
    shell.quad(rA, rB, [rB[0], rBt, rB[2]], [rA[0], rAt, rA[2]], lo, hi);
    if (covered) {
      shell.quad(
        [lA[0], lAt, lA[2]],
        [rA[0], rAt, rA[2]],
        [rB[0], rBt, rB[2]],
        [lB[0], lBt, lB[2]],
        ceilC,
      );
    }
    // Lane paint: a dashed centre line, slightly proud of the floor.
    const mid = (a + b) / 2;
    if (Math.floor(mid / 6) % 2 === 0 && a >= s0 + 2 && b <= s1 - 2) {
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
    shell.quad(
      [secA.lx, secA.top, secA.lz],
      [secA.rx, secA.top, secA.rz],
      [secA.rx, 0, secA.rz],
      [secA.lx, 0, secA.lz],
      wallTop,
      cutHigh,
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

/** The network's two draws. */
export class TunnelRenderer {
  readonly group = new THREE.Group();
  readonly shell: THREE.Mesh;
  readonly fixtures: THREE.Mesh;

  constructor() {
    const [shellGeo, fixGeo] = buildTunnelGeometry();
    // One unlit material for both (one program): vertex colours carry the
    // baked light and the emissive rungs.
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: true,
    });
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

  /** Snap both meshes by whole periods so the camera sits in the middle. */
  update(cameraPos: Vec3): void {
    const x = Math.floor((cameraPos.x - WORLD_SIZE / 2) / WORLD_SIZE);
    const z = Math.floor((cameraPos.z - WORLD_SIZE / 2) / WORLD_SIZE);
    this.group.position.set(x * WORLD_SIZE, 0, z * WORLD_SIZE);
  }

  setQuality(tier: QualityTier): void {
    this.fixtures.visible = QUALITY_PROFILES[tier].tunnelFixtures;
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
