// L1 "Stormlit" storm sky: the cloud layers the dome shader paints (no
// mesh, no texture, no extra draw call), and the coverage the stars and the
// airliner lights read so they only show in the gaps.
//
// Two layers on planes a fixed height above the EYE (horizontal parallax
// only — climbing never changes them): big dark cumulus masses at
// CLOUD_A.height and a thin high deck at CLOUD_B.height. A view ray `d`
// meets a plane at eye.xz + d.xz / d.y · H, so the masses slide past
// faster than the high deck as the camera flies — that is the depth.
//
// The torus: the camera's canonical position jumps by WORLD_SIZE at the
// seam, and noise periodic in WORLD_SIZE would visibly repeat along a ray
// (a feature 1.4 km out at 60° comes back 3.4 km out at 35°). So the planes
// are sampled at an UNWRAPPED camera offset (CloudOffset): it accumulates
// the torus step `wrapDelta(prev, cam)` every frame and is kept mod
// CLOUD_PERIOD, a whole number of noise cells at every octave, so the
// noise is truly periodic there and the mod never shows. A cut (respawn,
// kill-cam, a QA camera jump) resets it to the canonical position, so a
// view's clouds depend on where the camera is, never on what was shot
// before — the gallery's before/after pairs and the flicker harness's
// HEAD-vs-ref captures stay comparable.
//
// Noise: 2D gradient noise with an integer (uint) hash — the `sin` hash
// is fragile at the magnitudes a periodic lattice reaches — and quintic
// fade. Budget per sky pixel above SKY_FOG_STOP (gradient-noise calls):
// layer A coverage 3 + detail ≤ 2 + rim ≤ 2, layer B 2 → 9 on High/Medium,
// 8 on Low, 6 on Mobile; nothing at all in the fog band below the stop.
// Coverage octaves are identical on every tier (the silhouettes are the
// same for everyone); only fine detail and the rim's second octave drop.

import { WORLD_SIZE } from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaInto } from "@angels-bandits/common/world";
import * as THREE from "three";
import type { QualityTier } from "./quality";

/** Period of the cloud planes, m: 64 × 900 = 36 × 1600 — a whole number of
 * cells at every octave of both layers (see the cell sizes below). */
export const CLOUD_PERIOD = 57_600;

/** Layer A — the cumulus masses. */
export const CLOUD_A = {
  /** Plane height above the eye, m. */
  height: 700,
  /** Coarsest octave's cell, m; each octave halves it. */
  cell: 900,
  /** Wind on the synced clock, m/s (x, z) — whole numbers, so the drift
   * reduced mod CLOUD_PERIOD never jumps (CloudOffset.layer). */
  wind: [6, 2] as const,
} as const;

/** Layer B — the thin high deck. */
export const CLOUD_B = {
  height: 1800,
  cell: 1600,
  wind: [9, -3] as const,
} as const;

/** A frame step implying more than this speed is a cut, not flight, m/s.
 * Far above any plane (the sim clamps dt, so a hitch never moves the camera
 * further than a normal frame does). */
export const CUT_SPEED = 600;
/** Slack on the cut test, m. */
const CUT_SLACK = 20;

/** Elevation band (rad above SKY_FOG_STOP) over which the clouds fade in
 * from zero — distant cloud melts into the horizon haze (L7b: ≈ 5°, was
 * 12°, so a view out toward the horizon shows the deck right down to the
 * haze, as reference 1 does; still exactly zero at the stop). */
export const CLOUD_FADE = 0.09;

/** Angular radius of the clear gap around the moon, rad (≈ 3.5 discs). */
export const MOON_GAP = 0.16;

/** Peak linear luminance of a moonlit cloud rim outside the moon's halo —
 * sub-bloom (0.72), so rims read as silver edges, not lamps. */
export const RIM_PEAK = 0.45;
/** Peak rim luminance right beside the moon (inside its halo): bright
 * enough to bloom softly like the reference's lit cloud edges, far under
 * the tracer rung (1.5). */
export const RIM_PEAK_HALO = 0.85;
/** Peak in-cloud lightning luminance at full flash — under the tracer rung
 * (1.5) even before the dome's flash gain, which never applies to it. */
export const CLOUD_FLASH_PEAK = 1.1;
/** The storm flash's colour (sRGB): the cold blue-white of a real flash —
 * the fog stain, the ambient pulse and the lit clouds share it (L1; ST2's
 * was violet). */
export const STORM_FLASH_COLOR = 0x9fb4ff;

/** Cloud body colours (sRGB): storm-grey masses a step ABOVE the near-black
 * gaps (the reference's clouds read lighter than the sky between them, the
 * thick cores darker than the thin edges), the high deck a touch lighter,
 * and the warm city glow on their undersides near the horizon. */
export const CLOUD_BODY = 0x2e374b; // L7b: a step lighter (was 0x283143)
export const CLOUD_CORE = 0x121822;
export const CLOUD_HIGH = 0x222b3c;
export const CLOUD_CITY_GLOW = 0x2a2018;

/** Fine-detail octaves and rim octaves per tier (uniforms, never defines —
 * a tier switch must not compile; quality.ts rule 1). */
export const CLOUD_TIER: Readonly<
  Record<QualityTier, { detail: number; rim: number }>
> = {
  high: { detail: 2, rim: 2 },
  medium: { detail: 2, rim: 2 },
  low: { detail: 1, rim: 2 },
  mobile: { detail: 0, rim: 1 },
};

/** The uniforms every cloud-aware shader shares BY REFERENCE (the dome,
 * the stars, the airliners): one write a frame reaches all three. */
export interface CloudUniforms {
  [name: string]: THREE.IUniform;
  /** Layer offsets on their planes, m, already mod CLOUD_PERIOD. */
  uCloudOffA: { value: THREE.Vector2 };
  uCloudOffB: { value: THREE.Vector2 };
  /** Fine octaves (0..2) and rim octaves (1..2). */
  uCloudDetail: { value: number };
  uCloudRim: { value: number };
  /** 1 on, 0 off (`?clouds=0`, the perf A/B). */
  uCloudOn: { value: number };
  /** Unit vector toward the moon (the gap). */
  uCloudMoon: { value: THREE.Vector3 };
}

export function createCloudUniforms(): CloudUniforms {
  return {
    uCloudOffA: { value: new THREE.Vector2() },
    uCloudOffB: { value: new THREE.Vector2() },
    uCloudDetail: { value: CLOUD_TIER.high.detail },
    uCloudRim: { value: CLOUD_TIER.high.rim },
    uCloudOn: { value: 1 },
    uCloudMoon: { value: new THREE.Vector3(0, 1, 0) },
  };
}

const f1 = (n: number): string => n.toFixed(1);
const f5 = (n: number): string => n.toFixed(5);

/** GLSL (ES 3.00 — every three program is): the noise, both layers'
 * coverage, and `abCloudCover(dir)` for the point shaders. Needs the
 * CloudUniforms declared (CLOUD_PARS_GLSL) and SKY_FOG_ELEVATION. */
export function cloudGlsl(fogElevation: number): string {
  return /* glsl */ `
uniform vec2 uCloudOffA;
uniform vec2 uCloudOffB;
uniform float uCloudDetail;
uniform float uCloudRim;
uniform float uCloudOn;
uniform vec3 uCloudMoon;
// Integer lattice hash → a gradient in [-1, 1]². The cell is wrapped to the
// layer's period first, so the noise repeats exactly every CLOUD_PERIOD m.
vec2 abCloudGrad(vec2 cell, float period) {
  uvec2 q = uvec2(mod(cell, period));
  q = q * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  n ^= n >> 15u;
  n *= 2246822519u;
  return vec2(float(n & 0xffffu), float(n >> 16u)) * (2.0 / 65535.0) - 1.0;
}
float abCloudNoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n00 = dot(abCloudGrad(i, period), f);
  float n10 = dot(abCloudGrad(i + vec2(1.0, 0.0), period), f - vec2(1.0, 0.0));
  float n01 = dot(abCloudGrad(i + vec2(0.0, 1.0), period), f - vec2(0.0, 1.0));
  float n11 = dot(abCloudGrad(i + vec2(1.0, 1.0), period), f - vec2(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}
// Layer A's coarse octaves (the silhouette), p in metres on its plane.
float abCloudCoarseA(vec2 p, float octaves) {
  vec2 q = p / ${f1(CLOUD_A.cell)};
  float per = ${f1(CLOUD_PERIOD / CLOUD_A.cell)};
  float n = 0.5 * abCloudNoise(q, per);
  if (octaves > 1.5) n += 0.25 * abCloudNoise(q * 2.0, per * 2.0);
  return n;
}
// Layer A's density field (≈ 0..1, mean 0.5), with up to two detail octaves
// faded by how far the plane is along the ray (no aliasing at the grazing
// band). .y and .z are its first one and two octaves — abCloudCoarseA at
// this point, for the rim.
vec3 abCloudFieldA(vec2 p, float rayLen, float detail) {
  vec2 q = p / ${f1(CLOUD_A.cell)};
  float per = ${f1(CLOUD_PERIOD / CLOUD_A.cell)};
  float c1 = 0.5 * abCloudNoise(q, per);
  float c2 = c1 + 0.25 * abCloudNoise(q * 2.0, per * 2.0);
  float n = c2 + 0.14 * abCloudNoise(q * 4.0 + 17.0, per * 4.0);
  float fine = 1.0 - smoothstep(2500.0, 5000.0, rayLen);
  if (detail > 0.5) n += 0.07 * fine * abCloudNoise(q * 8.0 + 31.0, per * 8.0);
  if (detail > 1.5) n += 0.035 * fine * abCloudNoise(q * 16.0 + 5.0, per * 16.0);
  return vec3(n + 0.5, c1, c2);
}
float abCloudFieldB(vec2 p) {
  vec2 q = p / ${f1(CLOUD_B.cell)};
  float per = ${f1(CLOUD_PERIOD / CLOUD_B.cell)};
  return 0.5 + 0.5 * abCloudNoise(vec2(q.x * 0.6, q.y * 1.4), per)
    + 0.25 * abCloudNoise(q * 2.0 + 9.0, per * 2.0);
}
// Fade from zero at the fog stop (the torus contract) to full CLOUD_FADE
// above it.
float abCloudFade(float sdY) {
  float el = asin(clamp(sdY, -1.0, 1.0));
  return smoothstep(${f5(fogElevation)}, ${f5(fogElevation + CLOUD_FADE)}, el);
}
// The clear gap around the moon, noise-edged by the cloud field itself.
float abCloudGap(vec3 sd, float field) {
  float r = acos(clamp(dot(sd, uCloudMoon), -1.0, 1.0)) + (field - 0.5) * 0.12;
  return smoothstep(${f5(MOON_GAP * 0.55)}, ${f5(MOON_GAP)}, r);
}
float abCloudDensityA(float field) { return smoothstep(0.32, 0.5, field); }
float abCloudDensityB(float field) { return 0.55 * smoothstep(0.55, 0.85, field); }
// Coverage for the point shaders (stars, airliner lights): coarse octaves
// only — a point needs to know whether it is behind cloud, not the detail.
float abCloudCover(vec3 sd) {
  if (uCloudOn < 0.5 || sd.y <= 0.02) return 0.0;
  float fade = abCloudFade(sd.y);
  if (fade <= 0.0) return 0.0;
  vec2 hz = sd.xz / sd.y;
  vec2 q = (uCloudOffA + hz * ${f1(CLOUD_A.height)}) / ${f1(CLOUD_A.cell)};
  float per = ${f1(CLOUD_PERIOD / CLOUD_A.cell)};
  float fa = 0.5 + 0.5 * abCloudNoise(q, per) + 0.25 * abCloudNoise(q * 2.0, per * 2.0);
  float a = abCloudDensityA(fa) * abCloudGap(sd, fa);
  float b = abCloudDensityB(abCloudFieldB(uCloudOffB + hz * ${f1(CLOUD_B.height)}));
  return fade * clamp(a + b * (1.0 - a), 0.0, 1.0);
}
`;
}

/**
 * The unwrapped camera offset each layer is sampled at (see the header):
 * accumulates the torus step every frame, resets on a cut, and adds the
 * layer's wind on the synced clock — all mod CLOUD_PERIOD, in doubles, so
 * the float the shader gets never loses its fraction.
 */
export class CloudOffset {
  /** Unwrapped camera x/z, m (mod `period`). */
  x = 0;
  z = 0;
  private readonly prev: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly step: Vec3 = { x: 0, y: 0, z: 0 };
  private primed = false;

  /** `period`: what x/z are kept mod — CLOUD_PERIOD for the clouds; L2's
   * far skyline keeps a whole number of torus widths instead, so x/z stay
   * congruent to the canonical position mod WORLD_SIZE. */
  constructor(private readonly period = CLOUD_PERIOD) {}

  /** Advance to the camera's canonical position after `dtSec` (the sim's
   * clamped step). Returns true when this frame was a cut (reset). */
  advance(cam: Readonly<Vec3>, dtSec: number): boolean {
    let cut = !this.primed;
    if (this.primed) {
      const d = wrapDeltaInto(this.prev, cam, this.step);
      const moved = Math.hypot(d.x, d.z);
      if (moved > CUT_SLACK + CUT_SPEED * Math.max(0, dtSec)) cut = true;
      else {
        this.x = mod(this.x + d.x, this.period);
        this.z = mod(this.z + d.z, this.period);
      }
    }
    if (cut) {
      // Canonical coords are already in [0, WORLD_SIZE) ⊂ [0, period).
      this.x = mod(cam.x, WORLD_SIZE);
      this.z = mod(cam.z, WORLD_SIZE);
    }
    this.prev.x = cam.x;
    this.prev.y = cam.y;
    this.prev.z = cam.z;
    this.primed = true;
    return cut;
  }

  /** A layer's plane offset at synced time `timeMs` (null: no drift). */
  layer(
    wind: readonly [number, number],
    timeMs: number | null,
    out: THREE.Vector2,
  ): THREE.Vector2 {
    const t = (timeMs ?? 0) / 1000;
    // Wind first reduced mod the period (t·wind reaches 1e10 m), then added.
    const wx = mod(mod(t, CLOUD_PERIOD) * wind[0], CLOUD_PERIOD);
    const wz = mod(mod(t, CLOUD_PERIOD) * wind[1], CLOUD_PERIOD);
    return out.set(
      mod(this.x + wx, CLOUD_PERIOD),
      mod(this.z + wz, CLOUD_PERIOD),
    );
  }
}

const mod = (a: number, m: number): number => ((a % m) + m) % m;
