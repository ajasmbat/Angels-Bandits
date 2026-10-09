// L4 rain: camera-local streaks in ONE instanced draw call. Every drop lives
// in a world-anchored lattice that tiles space with period BOX; the vertex
// shader folds each one into the box centred on the camera, so the field
// never runs out wherever you fly, and parallax is real (drops are fixed in
// the world, not glued to the lens). Motion is a single drift offset kept on
// the CPU in double precision and wrapped mod BOX before upload — the GPU
// never sees a large number, and nothing is allocated per frame. The fall is
// closed-form on the synced clock; the sideways drift integrates L9's shared
// windAt() (common/src/wind.ts), so rain leans with the same air the trees
// sway in. The field is camera-local scenery, so integrating per client is
// fine — no two players compare drops.
//
// BOX_XZ divides WORLD_SIZE, so the camera's torus wrap (a 2000 m jump)
// leaves every drop exactly where it was.
//
// Readability (the ticket's hard rule: rain never hides tracers or planes):
// streaks are thin and additive, adding ≤ ~0.14 luminance each (far under
// the 0.72 bloom threshold), and a drop within NEAR_CUT of the camera
// collapses to zero size in the vertex shader — no lens-filling streak and no
// wasted fill. RENDER_ORDER.rain draws it after the sky, clouds and smoke and
// BEFORE the tracers, planes (0) and searchlight beams (2), so those always
// paint over it.

import { mulberry32 } from "@angels-bandits/common/city";
import { underCover } from "@angels-bandits/common/city/tunnels";
import { CLOUD_BASE, WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Weather } from "@angels-bandits/common/weather";
import { type Wind, windAt } from "@angels-bandits/common/wind";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";

/** Horizontal box edge, m — must divide WORLD_SIZE (seam-invariant field). */
const BOX_XZ = 80;
/** Vertical box edge, m (no seam on Y). */
const BOX_Y = 40;
/** Drops at full downpour. */
const MAX_DROPS = 8000;
/** Terminal fall speed, m/s. */
const FALL_SPEED = 11;
/** Sideways drift, m/s, at windAt() strength 0 and 1. */
const DRIFT_CALM = 1.5;
const DRIFT_GUST = 6.5;
/** Streak length = relative speed × this exposure, clamped (plane speeds). */
const EXPOSURE_S = 0.06;
const STREAK_MIN = 1.2;
const STREAK_MAX = 4;
/** Streak half-width, m (widens a little with distance against shimmer). */
const STREAK_HALF_WIDTH = 0.02;
/**
 * O5: a streak is never drawn thinner than this many drawing-buffer pixels;
 * its alpha pays for the widening (true width / drawn width), so a far
 * streak keeps its light. A 0.04 m streak is under a pixel past ~40 m at
 * 720p — thinner, it rasterised as a broken dashed line that crawled and
 * sparkled as drops fell through pixel rows.
 */
const STREAK_MIN_PX = 1.5;
/** Drops nearer than this collapse — the lens never fills with rain. */
const NEAR_CUT = 3;
/** Peak streak alpha (low: tracers and planes must read through rain). */
const RAIN_ALPHA = 0.26;
/** Lit-by-the-city blue-white, linear luminance ≈ 0.55. ADDITIVE: a blended
 * pale streak vanishes against the bright downpour haze, so a streak instead
 * adds at most 0.55 × RAIN_ALPHA ≈ 0.14 — visible on dark sky and lit haze
 * alike, never a bloom source on its own. */
const RAIN_COLOR = 0xb8c4e8;
/** A camera jump larger than this in one frame (teleport, torus wrap) is not
 * motion — the streaks ignore it. */
const MAX_FRAME_JUMP = 60;

if (WORLD_SIZE % BOX_XZ !== 0) {
  throw new Error("rain: BOX_XZ must divide WORLD_SIZE");
}

const VERTEX = /* glsl */ `
uniform vec3 uOffset;
uniform vec3 uVel;
uniform float uFade;
// Half the drawing buffer's height, px (set per draw): with
// projectionMatrix[1][1] it turns metres at a distance into pixels.
uniform float uHalfHeight;
attribute vec4 aSeed;
varying float vAlpha;
varying float vSide;
const vec3 BOX = vec3(${BOX_XZ.toFixed(1)}, ${BOX_Y.toFixed(1)}, ${BOX_XZ.toFixed(1)});
void main() {
  // World-anchored lattice drop, folded into the box around the camera.
  vec3 rel = mod(aSeed.xyz * BOX + uOffset - cameraPosition, BOX) - BOX * 0.5;
  float dist = length(rel);
  float k = smoothstep(${NEAR_CUT.toFixed(1)}, ${(NEAR_CUT + 3).toFixed(1)}, dist)
    * (1.0 - smoothstep(BOX.x * 0.35, BOX.x * 0.5, length(rel.xz)))
    * (1.0 - smoothstep(BOX.y * 0.35, BOX.y * 0.5, abs(rel.y)));
  vec3 head = cameraPosition + rel;
  float speed = length(uVel);
  vec3 dir = speed > 1e-3 ? uVel / speed : vec3(0.0, -1.0, 0.0);
  float len = clamp(speed * ${EXPOSURE_S.toFixed(3)}, ${STREAK_MIN.toFixed(2)}, ${STREAK_MAX.toFixed(2)});
  vec3 side = cross(dir, normalize(cameraPosition - head));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  // k == 0 collapses all four corners onto the head: a zero-area quad.
  float on = step(1e-3, k);
  // Width floor (STREAK_MIN_PX): widen to it, and pay for it in alpha.
  float halfW = ${STREAK_HALF_WIDTH.toFixed(3)} * (1.0 + dist * 0.03);
  float widthPx = 2.0 * halfW * projectionMatrix[1][1] * uHalfHeight / max(dist, 1e-3);
  float widen = max(1.0, ${STREAK_MIN_PX.toFixed(2)} / max(widthPx, 1e-4));
  vec3 pos = head - dir * (len * position.y * on)
    + side * (position.x * on * halfW * widen);
  vAlpha = k * uFade * (0.6 + 0.4 * aSeed.w) * mix(1.0, 0.15, position.y) / widen;
  vSide = position.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
varying float vSide;
void main() {
  gl_FragColor = vec4(uColor, vAlpha * (1.0 - abs(vSide)) * ${RAIN_ALPHA.toFixed(3)});
}
`;

const wrap = (v: number, period: number): number =>
  ((v % period) + period) % period;

export class Rain {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly offset = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly fade = { value: 0 };
  /** Half the drawing buffer's height, px — refreshed on every draw. */
  private readonly halfHeight = { value: 360 };
  private readonly bufferSize = new THREE.Vector2();
  private readonly lastCam = new THREE.Vector3();
  private hasLastCam = false;
  private heard = 0;
  private readonly wind: Wind = { x: 0, z: 0, strength: 0 };
  private driftX = 0;
  private driftZ = 0;
  /** O3 quality tier: share of the streaks drawn (the haze is untouched). */
  private density = 1;

  constructor() {
    // Unit streak quad: x = side (−1..1), y = along (0 head .. 1 tail).
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0],
        3,
      ),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    // Camera-local scenery, not shared state: a fixed stream is enough.
    const rand = mulberry32(0x7a1e5eed);
    const seeds = new Float32Array(MAX_DROPS * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    geometry.setAttribute(
      "aSeed",
      new THREE.InstancedBufferAttribute(seeds, 4),
    );
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        uniforms: {
          uOffset: { value: this.offset },
          uVel: { value: this.vel },
          uFade: this.fade,
          uHalfHeight: this.halfHeight,
          uColor: { value: new THREE.Color(RAIN_COLOR) },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        // The quad is billboarded in the shader; its winding faces either way.
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: true,
        fog: false,
      }),
    );
    this.mesh.frustumCulled = false; // drawn around the camera by the shader
    // The pixel scale follows the resolution scaler's every rung.
    this.mesh.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.bufferSize);
      this.halfHeight.value = this.bufferSize.y / 2;
    };
    this.mesh.renderOrder = RENDER_ORDER.rain;
    this.mesh.visible = false;
  }

  /** Streaks drawn this frame (QA). */
  get drops(): number {
    return this.mesh.visible ? this.geometry.instanceCount : 0;
  }

  /** O3: the tier thins the streaks; `level` (the rain bed) never changes. */
  setQuality(tier: QualityTier): void {
    this.density = QUALITY_PROFILES[tier].rainDensity;
  }

  /** Rain heard at the camera, 0..1 (none above the cloud base). */
  get level(): number {
    return this.heard;
  }

  /**
   * Once per frame. `wx` is the shared weather, `syncedMs` the synced clock
   * (null before sync — the weather is clear then anyway), `camera` the
   * render camera's world position and `dt` the frame time, s.
   */
  update(wx: Weather, syncedMs: number | null, camera: Vec3, dt: number): void {
    // Camera velocity for the streak direction (teleports and wraps ignored).
    let cvx = 0;
    let cvy = 0;
    let cvz = 0;
    if (this.hasLastCam && dt > 0) {
      const dx = camera.x - this.lastCam.x;
      const dy = camera.y - this.lastCam.y;
      const dz = camera.z - this.lastCam.z;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < MAX_FRAME_JUMP) {
        cvx = dx / dt;
        cvy = dy / dt;
        cvz = dz / dt;
      }
    }
    this.lastCam.set(camera.x, camera.y, camera.z);
    this.hasLastCam = true;

    // No rain above the deck: it falls FROM the cloud base.
    const altK =
      1 - Math.min(1, Math.max(0, (camera.y - (CLOUD_BASE - 40)) / 40));
    // U4: and none under a tunnel's ceiling (an open portal cut still gets
    // it — that is sky).
    const k = underCover(camera) ? 0 : wx.rain * altK;
    this.heard = k;
    const count = Math.round(MAX_DROPS * Math.min(1, k / 0.9) * this.density);
    if (count === 0 || syncedMs === null) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.geometry.instanceCount = count;
    this.fade.value = 0.55 + 0.45 * Math.min(1, k);

    // Fall: closed-form on the synced clock. Drift: the shared wind,
    // integrated and wrapped (it veers and gusts, so it has no closed form).
    windAt(syncedMs, this.wind);
    const drift = DRIFT_CALM + (DRIFT_GUST - DRIFT_CALM) * this.wind.strength;
    const wx2 = this.wind.x * drift;
    const wz2 = this.wind.z * drift;
    this.driftX = wrap(this.driftX + wx2 * dt, BOX_XZ);
    this.driftZ = wrap(this.driftZ + wz2 * dt, BOX_XZ);
    this.offset.set(
      this.driftX,
      wrap((-FALL_SPEED * syncedMs) / 1000, BOX_Y),
      this.driftZ,
    );
    this.vel.set(wx2 - cvx, -FALL_SPEED - cvy, wz2 - cvz);
  }
}
