// U7 tunnel look: what the bores are MADE of and the air inside them —
// shared by the shell (tunnels.ts), the dressing (underground.ts) and the
// cave-in rock (caveins.ts).
//
// WHY. U4–U6 baked every surface at linear luminance 0.55–0.7 — just under
// the 0.72 bloom threshold — and ACES at the night exposure (~1.2) took that
// to near white: a flat cream box. Bright now means WELL LIT AND COLOURFUL:
// darker, saturated albedos per section, warm lamp pools under the crown
// lights over a cool bounce, procedural relief and strata in the shader,
// and a coloured air in place of the pale fog.
//
// SECTIONS. Each themed stretch (underground-layout.ts's zones, plus the
// garden's lake) has its own palette — the mine amber, the works concrete
// grey, the garden green-gold, the grotto teal, the lake blue, the metro a
// clean white-blue. The shell blends palettes over 16 m at a boundary.
//
// NOISE. Every pattern is computed in BORE-FRAME surface coordinates
// (s along the bore, v up a wall or across the floor / ceiling), never from
// world or model position: the 2×2-tiled meshes snap by whole periods
// under the camera, and a world-space pattern would jump with them. Inputs
// stay under ~2 km, float-exact. Value noise hashes floored lattice cells
// only (concepts/traps/interpolated-hash-inputs.md), and each fBm octave
// fades out by its own footprint in pixels — albedo AND the bump gradient —
// so nothing sub-pixel is ever drawn to sparkle (the O5 / U5b lesson).
//
// LIGHT BUDGET. Non-emissive output goes through abUnderClamp: luminance at
// most UNDER_CLAMP (0.62), which leaves room for the additive light shafts
// (≤ SHAFT_PEAK each, at most two overlapping) under the 0.72 threshold.
//
// AIR. fog.ts tints every fogged material's near fog toward TUNNEL_AIR
// below street level — so planes, bullets and particles in a bore sit in
// the same coloured air as the walls. This file drives it from the camera:
// its zone's air colour (eased), and its depth (0 above −2 m, 1 below
// −14 m) so a portal cross-fades. It ignores the L12 sky cycle on purpose:
// the bores are lit by their own lamps, day or night.

import {
  type Tunnel,
  type TunnelFrame,
  tunnelAt,
  tunnelFrameInto,
} from "@angels-bandits/common/city/tunnels";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { TUNNEL_AIR } from "./fog";
import type { QualityTier } from "./quality";
import { QUALITY_PROFILES } from "./quality";
import { LAKE, deepRange, zoneAt } from "./underground-layout";

/** Non-emissive output never exceeds this linear luminance. */
export const UNDER_CLAMP = 0.62;
/** One light shaft's peak added luminance (two may overlap). */
export const SHAFT_PEAK = 0.05;
/** Warm lamp pools sit under the crown panels, this far apart, m. */
export const POOL_STEP = 12;

/** The look sections, in GLSL index order. */
export const LOOK_ZONES = [
  "mine",
  "works",
  "garden",
  "grotto",
  "lake",
  "station",
] as const;
export type LookZone = (typeof LOOK_ZONES)[number];

export interface Palette {
  /** Rock / concrete / tile albedo of the walls, the ceiling, the floor. */
  wall: THREE.Color;
  ceiling: THREE.Color;
  floor: THREE.Color;
  /** The air: what distance fades toward, underground. */
  air: THREE.Color;
}

const col = (hex: number, k = 1): THREE.Color =>
  new THREE.Color(hex).multiplyScalar(k);

/** Linear albedos (wall luminance ~0.18–0.3 before light). */
export const PALETTES: Record<LookZone, Palette> = {
  mine: {
    wall: col(0xa47448),
    ceiling: col(0x6a4c34),
    floor: col(0x76604a),
    air: col(0xd8944c, 0.36),
  },
  works: {
    wall: col(0x7e7c76),
    ceiling: col(0x5e6064),
    floor: col(0x5e6064),
    air: col(0x94aac0, 0.3),
  },
  garden: {
    wall: col(0x8c8a4c),
    ceiling: col(0x5c6a3a),
    floor: col(0x5c5a3a),
    air: col(0xb4cc74, 0.32),
  },
  grotto: {
    wall: col(0x3f8088),
    ceiling: col(0x2c5864),
    floor: col(0x3a5c5e),
    air: col(0x48c4cc, 0.32),
  },
  lake: {
    wall: col(0x5a80aa),
    ceiling: col(0x3c5a80),
    floor: col(0x4a6078),
    air: col(0x6aa4e8, 0.32),
  },
  station: {
    wall: col(0x9cbce0, 0.36),
    ceiling: col(0x7c94b0, 0.42),
    floor: col(0x56647a),
    air: col(0x9cc4f0, 0.17),
  },
};

/** The look section at arc length `s` of `t`. The ramps and cuts (outside
 * the deep run) are the works' concrete. */
export function lookZoneAt(t: Tunnel, s: number): LookZone {
  const [d0, d1] = deepRange(t);
  if (s < d0 || s > d1) return "works";
  const z = zoneAt(t, s);
  if (z === "garden" && s > LAKE.s0 - 30 && s < LAKE.s1 + 30) return "lake";
  return z;
}

/** Surface materials (the shell's aSurf.x = 1 + 3·material + face). */
export const SURF = { rock: 0, concrete: 1, tile: 2 } as const;
export const FACE = { wall: 0, ceiling: 1, floor: 2 } as const;
export const surfKind = (material: number, face: number): number =>
  1 + 3 * material + face;

/** The material of a section's walls. */
export function materialOf(zone: LookZone): number {
  if (zone === "works") return SURF.concrete;
  if (zone === "station") return SURF.tile;
  return SURF.rock;
}

/** `zone`'s palette blended over ±8 m round `s` (a triangle filter on the
 * sections at s−8 … s+8), into `out`. */
export function blendedPalette(t: Tunnel, s: number, out: Palette): Palette {
  out.wall.setRGB(0, 0, 0);
  out.ceiling.setRGB(0, 0, 0);
  out.floor.setRGB(0, 0, 0);
  out.air.setRGB(0, 0, 0);
  const W = [1, 2, 3, 2, 1];
  for (let k = 0; k < 5; k++) {
    const p = PALETTES[lookZoneAt(t, s + (k - 2) * 4)];
    const w = (W[k] as number) / 9;
    out.wall.r += p.wall.r * w;
    out.wall.g += p.wall.g * w;
    out.wall.b += p.wall.b * w;
    out.ceiling.r += p.ceiling.r * w;
    out.ceiling.g += p.ceiling.g * w;
    out.ceiling.b += p.ceiling.b * w;
    out.floor.r += p.floor.r * w;
    out.floor.g += p.floor.g * w;
    out.floor.b += p.floor.b * w;
    out.air.r += p.air.r * w;
    out.air.g += p.air.g * w;
    out.air.b += p.air.b * w;
  }
  return out;
}

export const blankPalette = (): Palette => ({
  wall: new THREE.Color(),
  ceiling: new THREE.Color(),
  floor: new THREE.Color(),
  air: new THREE.Color(),
});

/** Mirror of abUnderClamp: `c` scaled down to luminance ≤ UNDER_CLAMP. */
export function underClamp(c: THREE.Color): THREE.Color {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return l > UNDER_CLAMP ? c.multiplyScalar(UNDER_CLAMP / l) : c;
}

/** The shader's detail level: fBm octaves (2–4); MOBILE's 2 also drops the
 * bump and the glints. One shared uniform: a tier switch never recompiles. */
export const TUNNEL_DETAIL = { value: 4 };

export function setTunnelDetail(tier: QualityTier): void {
  const life = QUALITY_PROFILES[tier].tunnelLife;
  TUNNEL_DETAIL.value = life >= 3 ? 4 : life === 2 ? 3 : 2;
}

const glslC = (c: THREE.Color): string =>
  `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

/** GLSL: a zone's mid wall and ceiling colour, as lit at a typical spot —
 * what thin dressing fades into (underground.ts). */
export const LOOK_BEHIND_GLSL = /* glsl */ `
vec3 abLookBehind(float zone, float ceiling) {
${LOOK_ZONES.map((z, i) => {
  const p = PALETTES[z];
  const w = p.wall.clone().multiplyScalar(0.95);
  const c = p.ceiling.clone().multiplyScalar(0.8);
  return `  if (zone < ${i}.5) return ceiling > 0.5 ? ${glslC(c)} : ${glslC(w)};`;
}).join("\n")}
  return ${glslC(PALETTES.works.wall)};
}
`;

/** GLSL: hash, value noise with its analytic gradient, a footprint-faded
 * fBm, the light-budget clamp. */
export const LOOK_NOISE_GLSL = /* glsl */ `
uniform float uTunnelDetail;
float abHash(vec2 c) {
  vec3 p3 = fract(vec3(c.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Value noise in [0,1] (x) and its gradient (yz).
vec3 abNoiseD(vec2 x) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = abHash(i);
  float b = abHash(i + vec2(1.0, 0.0));
  float c = abHash(i + vec2(0.0, 1.0));
  float d = abHash(i + vec2(1.0, 1.0));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y,
    du * vec2(b - a + k * u.y, c - a + k * u.x));
}
// fBm round 0 (x, about ±0.5) and its gradient per metre (yz), at base
// frequency \`fr\` cycles/m; \`px\` is metres per pixel at this fragment.
// Each octave fades out as its cells shrink under ~3 pixels.
vec3 abFbm(vec2 p, float fr, float px) {
  vec3 acc = vec3(0.0);
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uTunnelDetail) break;
    float fade = 1.0 - smoothstep(0.12, 0.33, px * fr);
    vec3 n = abNoiseD(p * fr + float(i) * 17.31);
    acc += vec3(n.x - 0.5, n.yz * fr) * (amp * fade);
    amp *= 0.5;
    fr *= 2.03;
  }
  return acc;
}
vec3 abUnderClamp(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return l > ${UNDER_CLAMP.toFixed(3)} ? c * (${UNDER_CLAMP.toFixed(3)} / l) : c;
}
`;

// --- The air ------------------------------------------------------------------

const frame: TunnelFrame = { s: 0, lat: 0, th: 0 };
const probe: Vec3 = { x: 0, y: 0, z: 0 };
const target = new THREE.Color();
const current = new THREE.Color(PALETTES.works.air);
const scratch = blankPalette();
let lastMs = -1;

const wrap = (v: number): number =>
  ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

/** Per frame, from the camera (render space): the zone's air colour eased
 * over ~1.5 s, the strength by depth under the street. */
export function updateTunnelAir(cameraPos: Vec3, nowMs: number): void {
  const dt = lastMs < 0 ? 1 : Math.min(1, (nowMs - lastMs) / 1000);
  lastMs = nowMs;
  probe.x = wrap(cameraPos.x);
  probe.y = cameraPos.y;
  probe.z = wrap(cameraPos.z);
  const t = cameraPos.y < 0 ? tunnelAt(probe) : null;
  if (t) {
    tunnelFrameInto(t, probe, frame);
    target.copy(blendedPalette(t, frame.s, scratch).air);
  } else {
    target.copy(PALETTES.works.air);
  }
  current.lerp(target, 1 - Math.exp(-dt / 0.5));
  // 0 at −2 m, 1 at −14 m.
  const d = Math.min(1, Math.max(0, (-2 - cameraPos.y) / 12));
  const depth = d * d * (3 - 2 * d);
  TUNNEL_AIR[0] = current.r;
  TUNNEL_AIR[1] = current.g;
  TUNNEL_AIR[2] = current.b;
  TUNNEL_AIR[3] = depth;
}
