// L4 rain: camera-local streaks in ONE instanced draw call. Every drop lives
// in a world-anchored lattice that tiles space with period BOX; the vertex
// shader folds each one into the box centred on the camera, so the field
// never runs out wherever you fly, and parallax is real (drops are fixed in
// the world, not glued to the lens). Motion is a single drift offset (fall +
// the cycle's wind) computed in closed form on the CPU in double precision
// from the synced clock and wrapped mod BOX before upload — the GPU never sees
// a large number, and nothing is allocated per frame.
//
// BOX_XZ divides WORLD_SIZE, so the camera's torus wrap (a 2000 m jump)
// leaves every drop exactly where it was.
//
// Readability (the ticket's hard rule: rain never hides tracers or planes):
// streaks are thin, alpha ≤ RAIN_ALPHA, colour luminance ≈ 0.37 (far under
// the 0.72 bloom threshold), and a drop within NEAR_CUT of the camera
// collapses to zero size in the vertex shader — no lens-filling streak and no
// wasted fill. renderOrder −0.5 draws it after the sky dome (−1) and BEFORE
// the tracers (0) and searchlight beams (2), so those always paint over it.

import { mulberry32 } from "@angels-bandits/common/city";
import { CLOUD_BASE, WORLD_SIZE } from "@angels-bandits/common/constants";
import { WEATHER_CYCLE_MS, type Weather } from "@angels-bandits/common/weather";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";

/** Horizontal box edge, m — must divide WORLD_SIZE (seam-invariant field). */
const BOX_XZ = 80;
/** Vertical box edge, m (no seam on Y). */
const BOX_Y = 60;
/** Drops at full downpour. */
const MAX_DROPS = 7000;
/** Terminal fall speed, m/s. */
const FALL_SPEED = 11;
/** Streak length = relative speed × this exposure, clamped (plane speeds). */
const EXPOSURE_S = 0.03;
const STREAK_MIN = 0.6;
const STREAK_MAX = 3.5;
/** Streak half-width, m (widens a little with distance against shimmer). */
const STREAK_HALF_WIDTH = 0.012;
/** Drops nearer than this collapse — the lens never fills with rain. */
const NEAR_CUT = 3;
/** Peak streak alpha (low: tracers and planes must read through rain). */
const RAIN_ALPHA = 0.18;
/** Lit-by-the-city blue-grey (linear luminance ≈ 0.37 — sub-bloom). */
const RAIN_COLOR = 0x9aa4c8;
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
  vec3 pos = head - dir * (len * position.y * on)
    + side * (position.x * on * ${STREAK_HALF_WIDTH.toFixed(3)} * (1.0 + dist * 0.04));
  vAlpha = k * uFade * (0.6 + 0.4 * aSeed.w) * mix(1.0, 0.15, position.y);
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
  private readonly lastCam = new THREE.Vector3();
  private hasLastCam = false;
  private heard = 0;

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
          uColor: { value: new THREE.Color(RAIN_COLOR) },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        fog: false,
      }),
    );
    this.mesh.frustumCulled = false; // drawn around the camera by the shader
    this.mesh.renderOrder = -0.5;
    this.mesh.visible = false;
  }

  /** Streaks drawn this frame (QA). */
  get drops(): number {
    return this.mesh.visible ? this.geometry.instanceCount : 0;
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
    const k = wx.rain * altK;
    this.heard = k;
    const count = Math.round(MAX_DROPS * Math.min(1, k / 0.9));
    if (count === 0 || syncedMs === null) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.geometry.instanceCount = count;
    this.fade.value = 0.55 + 0.45 * Math.min(1, k);

    // Closed-form drift: fall on the synced clock, wind since the cycle
    // began (the wind is constant within a cycle, and the cycle boundary is
    // dry — weather.test.ts — so the switch never shows).
    const tS = syncedMs / 1000;
    const sinceCycleS = (syncedMs - wx.cycle * WEATHER_CYCLE_MS) / 1000;
    this.offset.set(
      wrap(wx.wind.x * sinceCycleS, BOX_XZ),
      wrap(-FALL_SPEED * tS, BOX_Y),
      wrap(wx.wind.z * sinceCycleS, BOX_XZ),
    );
    this.vel.set(wx.wind.x - cvx, -FALL_SPEED - cvy, wx.wind.z - cvz);
  }
}
