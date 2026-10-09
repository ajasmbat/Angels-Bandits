// L4 rain: camera-local streaks in ONE instanced draw call. Every drop lives
// in a world-anchored lattice that tiles space with period BOX; the vertex
// shader folds each one into the box centred on the camera, so the field
// never runs out wherever you fly, and parallax is real (drops are fixed in
// the world, not glued to the lens). Motion is a single drift offset kept on
// the CPU in double precision and wrapped mod BOX before upload — the GPU
// never sees a large number, and nothing is allocated per frame. The fall is
// closed-form on the synced clock; the sideways drift integrates L9's shared
// windAt() (common/src/wind.ts) over the same clock, so rain leans with the
// same air the trees sway in, and a pinned world (O4) is a still field. The
// field is camera-local scenery, so integrating per client is fine — no two
// players compare drops.
//
// BOX_XZ divides WORLD_SIZE, so the camera's torus wrap (a 2000 m jump)
// leaves every drop exactly where it was.
//
// Readability (R3; the maths and its tests live in rain-look.ts): a streak
// lies along the drop's own fall — gravity plus wind, with only a mild
// capped lean from the camera's motion — never along the relative velocity,
// which at flight speed fanned every streak out of the vanishing point into
// a full-screen "warp". Speed thins, dims and shortens the rain; the count
// is capped so streaks never cover more than STREAK_COVERAGE_BUDGET of the
// screen at the live focal length; drops fade out inside ~8 m of the lens
// and around the pipper, so tracers and the aim point stay clear. Streaks
// are thin and additive, adding ≤ ~0.14 luminance each (far under the 0.72
// bloom threshold). RENDER_ORDER.rain draws it after the sky, clouds and
// smoke and BEFORE the tracers, planes (0) and searchlight beams (2), so
// those always paint over it.

import { mulberry32 } from "@angels-bandits/common/city";
import { underCover } from "@angels-bandits/common/city/tunnels";
import { CLOUD_BASE, WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Weather } from "@angels-bandits/common/weather";
import { type Wind, windAt } from "@angels-bandits/common/wind";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import {
  RAIN_BOX_XZ as BOX_XZ,
  RAIN_BOX_Y as BOX_Y,
  RAIN_FALL_SPEED as FALL_SPEED,
  RAIN_MAX_DROPS as MAX_DROPS,
  RAIN_NEAR_CUT as NEAR_CUT,
  RAIN_NEAR_FULL as NEAR_FULL,
  RAIN_FADE_END,
  RAIN_THIN_BAND,
  type RainLook,
  STREAK_HALF_WIDTH,
  STREAK_MIN_PX,
  STREAK_WIDEN_PER_M,
  focalPx,
  rainCount,
  rainSpeedLook,
  streakDir,
} from "./rain-look";
import { RENDER_ORDER } from "./render-order";

/** Sideways drift, m/s, at windAt() strength 0 and 1. */
const DRIFT_CALM = 1.5;
const DRIFT_GUST = 6.5;
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
/** Camera-velocity smoothing, s: chase lag, shake and uneven frames must not
 * make the lean, length or density jitter. */
const VEL_SMOOTH_S = 0.3;
/** A weather-clock step longer than this (a pin, a resync) is not motion. */
const MAX_CLOCK_STEP_S = 0.1;
/** The aim zone around the pipper, in NDC heights: no rain inside the
 * first radius, full rain past the second. */
const AIM_CLEAR = 0.08;
const AIM_FULL = 0.3;

if (WORLD_SIZE % BOX_XZ !== 0) {
  throw new Error("rain: BOX_XZ must divide WORLD_SIZE");
}

const VERTEX = /* glsl */ `
uniform vec3 uOffset;
uniform vec3 uDir;
uniform float uLen;
uniform float uDensity;
uniform float uFade;
uniform vec2 uAim;
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
  float k = smoothstep(${NEAR_CUT.toFixed(1)}, ${NEAR_FULL.toFixed(1)}, dist)
    * (1.0 - smoothstep(BOX.x * 0.35, BOX.x * ${RAIN_FADE_END.toFixed(2)}, length(rel.xz)))
    * (1.0 - smoothstep(BOX.y * 0.35, BOX.y * ${RAIN_FADE_END.toFixed(2)}, abs(rel.y)));
  // Speed thinning (R3): a per-drop hash against the drawn share, with a
  // soft band so drops fade rather than pop as the speed changes.
  float hash = fract(aSeed.w * 97.13 + aSeed.x * 13.71);
  float thin = clamp((uDensity * ${(1 + RAIN_THIN_BAND).toFixed(3)} - hash) / ${RAIN_THIN_BAND.toFixed(3)}, 0.0, 1.0);
  k *= thin;
  vec3 head = cameraPosition + rel;
  vec3 side = cross(uDir, normalize(cameraPosition - head));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  // k == 0 collapses all four corners onto the head: a zero-area quad.
  float on = step(1e-3, k);
  // Width floor (STREAK_MIN_PX): widen to it, and pay for it in alpha.
  float halfW = ${STREAK_HALF_WIDTH.toFixed(3)} * (1.0 + dist * ${STREAK_WIDEN_PER_M.toFixed(3)});
  float widthPx = 2.0 * halfW * projectionMatrix[1][1] * uHalfHeight / max(dist, 1e-3);
  float widen = max(1.0, ${STREAK_MIN_PX.toFixed(2)} / max(widthPx, 1e-4));
  // The streak trails back up its fall: the head leads.
  vec3 pos = head - uDir * (uLen * position.y * on)
    + side * (position.x * on * halfW * widen);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  // Aim zone: clear around the pipper (uAim, NDC), aspect-corrected.
  vec4 hc = projectionMatrix * viewMatrix * vec4(head, 1.0);
  vec2 dn = (hc.xy / max(abs(hc.w), 1e-3) - uAim)
    * vec2(projectionMatrix[1][1] / projectionMatrix[0][0], 1.0);
  float aim = smoothstep(${AIM_CLEAR.toFixed(2)}, ${AIM_FULL.toFixed(2)}, length(dn));
  vAlpha = k * aim * uFade * (0.6 + 0.4 * aSeed.w) * mix(1.0, 0.15, position.y) / widen;
  vSide = position.x;
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
  private readonly dir = new THREE.Vector3(0, -1, 0);
  private readonly len = { value: 1 };
  private readonly thin = { value: 1 };
  private readonly fade = { value: 0 };
  private readonly aim = new THREE.Vector2();
  /** Half the drawing buffer's height, px — refreshed on every draw. */
  private readonly halfHeight = { value: 360 };
  private readonly bufferSize = new THREE.Vector2();
  /** Pixel focal length at the last draw (the coverage cap's scale). */
  private focal = focalPx(720, 70);
  private readonly lastCam = new THREE.Vector3();
  private hasLastCam = false;
  /** Smoothed camera velocity, m/s. */
  private readonly camVel = { x: 0, y: 0, z: 0 };
  private readonly fall = { x: 0, y: -FALL_SPEED, z: 0 };
  private readonly look: RainLook = {
    density: 1,
    alpha: 1,
    length: 1,
    lens: 0,
  };
  private lastClockMs: number | null = null;
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
          uDir: { value: this.dir },
          uLen: this.len,
          uDensity: this.thin,
          uFade: this.fade,
          uAim: { value: this.aim },
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
    // The pixel scale follows the resolution scaler's every rung and the FOV
    // kick — and so does the coverage cap, re-applied right before the draw.
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(this.bufferSize);
      this.halfHeight.value = this.bufferSize.y / 2;
      this.focal = camera.projectionMatrix.elements[5] * this.halfHeight.value;
      this.geometry.instanceCount = rainCount(
        this.heard,
        this.density,
        this.look,
        this.focal,
      );
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

  /** The pipper, CSS px in a `width` × `height` view (null: screen centre) —
   * the aim zone the streaks keep clear. */
  setAim(p: { x: number; y: number } | null, width: number, height: number) {
    if (p === null || width <= 0 || height <= 0) this.aim.set(0, 0);
    else this.aim.set((p.x / width) * 2 - 1, 1 - (p.y / height) * 2);
  }

  /** Rain heard at the camera, 0..1 (none above the cloud base). */
  get level(): number {
    return this.heard;
  }

  /** Rain on the lens rim, 0..1 (hud.ts): the level, more of it at speed. */
  get lens(): number {
    return this.heard * this.look.lens;
  }

  /**
   * Once per frame. `wx` is the shared weather, `syncedMs` the synced clock
   * (null before sync — the weather is clear then anyway), `camera` the
   * render camera's world position and `dt` the frame time, s.
   */
  update(wx: Weather, syncedMs: number | null, camera: Vec3, dt: number): void {
    // Camera velocity, smoothed, for the lean and the speed look (teleports
    // and wraps ignored).
    if (this.hasLastCam && dt > 0) {
      const dx = camera.x - this.lastCam.x;
      const dy = camera.y - this.lastCam.y;
      const dz = camera.z - this.lastCam.z;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < MAX_FRAME_JUMP) {
        const a = 1 - Math.exp(-dt / VEL_SMOOTH_S);
        this.camVel.x += (dx / dt - this.camVel.x) * a;
        this.camVel.y += (dy / dt - this.camVel.y) * a;
        this.camVel.z += (dz / dt - this.camVel.z) * a;
      }
    }
    this.lastCam.set(camera.x, camera.y, camera.z);
    this.hasLastCam = true;
    const v = this.camVel;
    rainSpeedLook(Math.hypot(v.x, v.y, v.z), this.look);

    // No rain above the deck: it falls FROM the cloud base.
    const altK =
      1 - Math.min(1, Math.max(0, (camera.y - (CLOUD_BASE - 40)) / 40));
    // U4: and none under a tunnel's ceiling (an open portal cut still gets
    // it — that is sky).
    const k = underCover(camera) ? 0 : wx.rain * altK;
    this.heard = k;
    const count = rainCount(k, this.density, this.look, this.focal);
    if (count === 0 || syncedMs === null) {
      this.mesh.visible = false;
      this.lastClockMs = null;
      return;
    }
    this.mesh.visible = true;
    this.geometry.instanceCount = count;
    this.fade.value = (0.55 + 0.45 * Math.min(1, k)) * this.look.alpha;
    this.len.value = this.look.length;
    this.thin.value = this.look.density;

    // Fall: closed-form on the synced clock. Drift: the shared wind,
    // integrated over the same clock and wrapped (it veers and gusts, so it
    // has no closed form) — a pinned clock is a still field.
    const step =
      this.lastClockMs === null
        ? 0
        : Math.min(
            MAX_CLOCK_STEP_S,
            Math.max(0, (syncedMs - this.lastClockMs) / 1000),
          );
    this.lastClockMs = syncedMs;
    windAt(syncedMs, this.wind);
    const drift = DRIFT_CALM + (DRIFT_GUST - DRIFT_CALM) * this.wind.strength;
    this.fall.x = this.wind.x * drift;
    this.fall.z = this.wind.z * drift;
    this.driftX = wrap(this.driftX + this.fall.x * step, BOX_XZ);
    this.driftZ = wrap(this.driftZ + this.fall.z * step, BOX_XZ);
    this.offset.set(
      this.driftX,
      wrap((-FALL_SPEED * syncedMs) / 1000, BOX_Y),
      this.driftZ,
    );
    streakDir(this.fall, this.camVel, this.dir);
  }
}
