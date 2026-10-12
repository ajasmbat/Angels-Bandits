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
//
// Stormlit L5 (cinematic rain; the maths in rain-look.ts):
//  - Thinner, fainter and sparse near the lens, each drop its own length.
//  - DEPTH: every RAIN_FAR_EVERY-th instance is a FAR drop in a 400 m box
//    (it divides WORLD_SIZE, so the wrap still moves nothing), drawn from
//    40 m out, longer and fainter, and attenuated by the shaped fog
//    (abFogFactor × the height haze, never lerped to the fog colour — the
//    sky-meets-fog rule for additive things). Same draw call.
//  - LIT BY THE CITY: a streak near a street-lamp head turns sodium-warm
//    (the lamp stations come from the street contract, the same imports the
//    ground's lamp reflections use), and one inside a searchlight or spot
//    cone turns the beam's colour. The light REDISTRIBUTES the streak
//    budget: an unlit streak adds ≈ 0.09 luminance, a fully lit one reaches
//    R3's old 0.14 peak and no more, so rain never adds more over a lit
//    facade or a lamp pool than it used to.

import { mulberry32 } from "@angels-bandits/common/city";
import {
  FURNITURE_LINE,
  LAMP_STATIONS_MINUS,
  LAMP_STATIONS_PLUS,
} from "@angels-bandits/common/city/street";
import { underCover } from "@angels-bandits/common/city/tunnels";
import {
  BLOCK_PITCH,
  CLOUD_BASE,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import type { Weather } from "@angels-bandits/common/weather";
import { type Wind, windAt } from "@angels-bandits/common/wind";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { AB_FOG_GLSL } from "./fog";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import {
  RAIN_BOX_XZ as BOX_XZ,
  RAIN_BOX_Y as BOX_Y,
  RAIN_FALL_SPEED as FALL_SPEED,
  RAIN_FAR_BOX_XZ as FAR_BOX_XZ,
  RAIN_FAR_BOX_Y as FAR_BOX_Y,
  RAIN_MAX_DROPS as MAX_DROPS,
  RAIN_NEAR_CUT as NEAR_CUT,
  RAIN_NEAR_FULL as NEAR_FULL,
  RAIN_FADE_END,
  RAIN_FAR_ALPHA,
  RAIN_FAR_FADE_XZ,
  RAIN_FAR_FADE_Y,
  RAIN_FAR_FULL,
  RAIN_FAR_LENGTH,
  RAIN_FAR_NEAR,
  RAIN_LENGTH_SPREAD,
  RAIN_THIN_BAND,
  type RainLook,
  STREAK_HALF_WIDTH,
  STREAK_MIN_PX,
  STREAK_WIDEN_PER_M,
  focalPx,
  isFarDrop,
  rainCount,
  rainSpeedLook,
  streakDir,
} from "./rain-look";
import { RENDER_ORDER } from "./render-order";

/** Sideways drift, m/s, at windAt() strength 0 and 1. */
const DRIFT_CALM = 1.5;
const DRIFT_GUST = 6.5;
/** Peak streak alpha (low: tracers and planes must read through rain). L5:
 * 0.26 → 0.16, the unlit streak — the light gain below spends the rest. */
const RAIN_ALPHA = 0.16;
/** Lit-by-the-city blue-white, linear luminance ≈ 0.55. ADDITIVE: a blended
 * pale streak vanishes against the bright downpour haze, so a streak instead
 * adds at most 0.55 × RAIN_ALPHA ≈ 0.09 — visible on dark sky and lit haze
 * alike, never a bloom source on its own. */
const RAIN_COLOR = 0xb8c4e8;
/** L5: a fully lit streak is this much brighter than an unlit one: 0.09 ×
 * 1.6 ≈ 0.14, R3's peak — the light redistributes, it never adds a rung. */
const LIGHT_GAIN = 0.6;
/** Sodium lamp warmth (sRGB, normalised to RAIN_COLOR's luminance below). */
const LAMP_TINT = 0xffb36b;
/** Lamp head height (streetlights.ts POLE_HEIGHT) and the glow's reach, m. */
const LAMP_HEAD_Y = 7;
const LAMP_REACH = 5.5;
/** Searchlight cones the streaks read (the nearest few) and how far from
 * the camera a beam can be and still matter, m. */
const MAX_BEAMS = 4;
const BEAM_RANGE = 260;
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

if (WORLD_SIZE % BOX_XZ !== 0 || WORLD_SIZE % FAR_BOX_XZ !== 0) {
  throw new Error("rain: BOX_XZ and FAR_BOX_XZ must divide WORLD_SIZE");
}
// One offset drives both layers: it wraps on the far box, which is a whole
// number of near boxes, so the near lattice sees the same offset mod BOX.
if (FAR_BOX_XZ % BOX_XZ !== 0 || FAR_BOX_Y % BOX_Y !== 0) {
  throw new Error("rain: the far box must be a multiple of the near box");
}

/** Linear colour at RAIN_COLOR's luminance (lit streaks never brighter). */
const lumaMatched = (hex: number): THREE.Color => {
  const base = new THREE.Color(RAIN_COLOR);
  const c = new THREE.Color(hex);
  const k =
    (0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b) /
    (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  return c.multiplyScalar(k);
};
const glslVec3 = (c: THREE.Color): string =>
  `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
const glslStations = (s: readonly number[]): string =>
  `vec3(${s.map((v) => v.toFixed(2)).join(", ")})`;

const VERTEX = /* glsl */ `
uniform vec3 uOffset;
uniform vec3 uDir;
uniform float uLen;
uniform float uDensity;
uniform float uFade;
uniform vec2 uAim;
uniform vec3 uColor;
// Half the drawing buffer's height, px (set per draw): with
// projectionMatrix[1][1] it turns metres at a distance into pixels.
uniform float uHalfHeight;
// L5 searchlight/spot cones: apex (xyz) + tan of the half-angle (w), unit
// axis (xyz) + throw (w), and colour × opacity; uBeamCount of them.
uniform vec4 uBeamPos[${MAX_BEAMS}];
uniform vec4 uBeamDir[${MAX_BEAMS}];
uniform vec3 uBeamTint[${MAX_BEAMS}];
uniform int uBeamCount;
uniform float fogNear;
uniform float fogFar;
attribute vec4 aSeed;
attribute float aLayer;
varying float vAlpha;
varying float vSide;
varying vec3 vColor;
${AB_FOG_GLSL}
const vec3 BOX = vec3(${BOX_XZ.toFixed(1)}, ${BOX_Y.toFixed(1)}, ${BOX_XZ.toFixed(1)});
const vec3 FAR_BOX = vec3(${FAR_BOX_XZ.toFixed(1)}, ${FAR_BOX_Y.toFixed(1)}, ${FAR_BOX_XZ.toFixed(1)});
const float PITCH = ${BLOCK_PITCH.toFixed(1)};
// Signed offset to the nearest street centre line (a PITCH multiple).
float rnLine(float v) {
  float m = mod(v, PITCH);
  return m > PITCH * 0.5 ? m - PITCH : m;
}
// Distance along a street to its nearest lamp station (one side's three).
float rnStation(float v, vec3 stations) {
  vec3 m = abs(vec3(mod(v, PITCH)) - stations);
  vec3 w = min(m, PITCH - m);
  return min(w.x, min(w.y, w.z));
}
float rnLamp(float cross, float along, float dy) {
  // Lamps throw light down: the glow reaches further below the head.
  float v = dy > 0.0 ? dy * 1.6 : dy * 0.6;
  return exp(-(cross * cross + along * along + v * v) / ${(2 * LAMP_REACH * LAMP_REACH).toFixed(1)});
}
// Every lamp of the street contract (common/src/city/street.ts
// streetlampPositions): both furniture lines of the N–S and E–W streets.
float rnLamps(vec3 p) {
  float cx = rnLine(p.x);
  float cz = rnLine(p.z);
  float dy = p.y - ${LAMP_HEAD_Y.toFixed(1)};
  if (abs(dy) > 20.0 || min(abs(cx), abs(cz)) > ${(FURNITURE_LINE + 4 * LAMP_REACH).toFixed(1)}) return 0.0;
  const vec3 PLUS = ${glslStations(LAMP_STATIONS_PLUS)};
  const vec3 MINUS = ${glslStations(LAMP_STATIONS_MINUS)};
  const float FL = ${FURNITURE_LINE.toFixed(2)};
  return rnLamp(cx - FL, rnStation(p.z, PLUS), dy)
    + rnLamp(cx + FL, rnStation(p.z, MINUS), dy)
    + rnLamp(cz - FL, rnStation(p.x, PLUS), dy)
    + rnLamp(cz + FL, rnStation(p.x, MINUS), dy);
}
void main() {
  bool far = aLayer > 0.5;
  vec3 box = far ? FAR_BOX : BOX;
  // World-anchored lattice drop, folded into the box around the camera.
  vec3 rel = mod(aSeed.xyz * box + uOffset - cameraPosition, box) - box * 0.5;
  float dist = length(rel);
  float k;
  if (far) {
    // The curtain: from where the near layer ends, out into the fog —
    // attenuated by it (and the haze), never lerped to its colour.
    k = smoothstep(${RAIN_FAR_NEAR.toFixed(1)}, ${RAIN_FAR_FULL.toFixed(1)}, dist)
      * (1.0 - smoothstep(${RAIN_FAR_FADE_XZ[0].toFixed(1)}, ${RAIN_FAR_FADE_XZ[1].toFixed(1)}, length(rel.xz)))
      * (1.0 - smoothstep(${RAIN_FAR_FADE_Y[0].toFixed(1)}, ${RAIN_FAR_FADE_Y[1].toFixed(1)}, abs(rel.y)))
      * (1.0 - abFogFactor(fogNear, fogFar, dist))
      * (1.0 - abHazeAmount(cameraPosition.y, cameraPosition.y + rel.y, dist))
      * ${RAIN_FAR_ALPHA.toFixed(3)};
  } else {
    k = smoothstep(${NEAR_CUT.toFixed(1)}, ${NEAR_FULL.toFixed(1)}, dist)
      * (1.0 - smoothstep(BOX.x * 0.35, BOX.x * ${RAIN_FADE_END.toFixed(2)}, length(rel.xz)))
      * (1.0 - smoothstep(BOX.y * 0.35, BOX.y * ${RAIN_FADE_END.toFixed(2)}, abs(rel.y)));
  }
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
  // L5: each drop its own length (mean 1 — rain-look.ts rainLengthFactor).
  float lenK = ${(1 - RAIN_LENGTH_SPREAD).toFixed(3)} + ${(2 * RAIN_LENGTH_SPREAD).toFixed(3)} * fract(aSeed.x * 71.37 + aSeed.z * 19.91);
  float len = uLen * lenK * (far ? ${RAIN_FAR_LENGTH.toFixed(1)} : 1.0);
  // The streak trails back up its fall: the head leads.
  vec3 pos = head - uDir * (len * position.y * on)
    + side * (position.x * on * halfW * widen);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  // Aim zone: clear around the pipper (uAim, NDC), aspect-corrected.
  vec4 hc = projectionMatrix * viewMatrix * vec4(head, 1.0);
  vec2 dn = (hc.xy / max(abs(hc.w), 1e-3) - uAim)
    * vec2(projectionMatrix[1][1] / projectionMatrix[0][0], 1.0);
  float aim = smoothstep(${AIM_CLEAR.toFixed(2)}, ${AIM_FULL.toFixed(2)}, length(dn));
  // L5: lit by the city — the lamps, then the beams (the drop's head).
  float lamp = on > 0.0 ? min(1.0, rnLamps(head)) : 0.0;
  vec3 beamC = vec3(0.0);
  float beam = 0.0;
  for (int i = 0; i < ${MAX_BEAMS}; i++) {
    if (i >= uBeamCount || on == 0.0) break;
    vec3 v = head - uBeamPos[i].xyz;
    float t = dot(v, uBeamDir[i].xyz);
    if (t <= 0.0 || t >= uBeamDir[i].w) continue;
    float rad = max(2.0, t * uBeamPos[i].w);
    float r = length(v - uBeamDir[i].xyz * t);
    float b = (1.0 - smoothstep(rad * 0.55, rad, r)) * (1.0 - t / uBeamDir[i].w);
    beamC += uBeamTint[i] * b;
    beam += b;
  }
  float light = min(1.0, lamp + beam);
  vec3 litC = lamp * ${glslVec3(lumaMatched(LAMP_TINT))} + beamC;
  float litW = lamp + beam;
  vColor = mix(uColor, litW > 1e-4 ? litC / litW : uColor, light) * (1.0 + ${LIGHT_GAIN.toFixed(2)} * light);
  vAlpha = k * aim * uFade * (0.6 + 0.4 * aSeed.w) * mix(1.0, 0.15, position.y) / widen;
  vSide = position.x;
}
`;

const FRAGMENT = /* glsl */ `
varying float vAlpha;
varying float vSide;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha * (1.0 - abs(vSide)) * ${RAIN_ALPHA.toFixed(3)});
}
`;

const wrap = (v: number, period: number): number =>
  ((v % period) + period) % period;

/** RAIN_COLOR's linear luminance — every lit colour is normalised to it. */
const RAIN_LUMA = (() => {
  const c = new THREE.Color(RAIN_COLOR);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
})();

/** What the rain reads of the searchlights (L5): searchlights.ts's
 * renderer — its instanced cones and how many are drawn. */
export interface RainBeamSource {
  readonly mesh: THREE.InstancedMesh;
  readonly beamCount: number;
}

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
  /** L5: the beams the streaks read (searchlights.ts's instanced cones). */
  private readonly beamPos = Array.from(
    { length: MAX_BEAMS },
    () => new THREE.Vector4(),
  );
  private readonly beamDir = Array.from(
    { length: MAX_BEAMS },
    () => new THREE.Vector4(),
  );
  private readonly beamTint = Array.from(
    { length: MAX_BEAMS },
    () => new THREE.Vector3(),
  );
  private readonly beamCount = { value: 0 };
  private readonly beamM = new THREE.Matrix4();
  private readonly beamScratch = new THREE.Color();
  /** Candidate beams this frame: instance index and distance (reused). */
  private readonly beamPick: { i: number; d: number }[] = [];

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
    // L5: the far curtain is every RAIN_FAR_EVERY-th instance, so any drawn
    // prefix carries both layers in the ratio the coverage cap assumes.
    const layers = new Float32Array(MAX_DROPS);
    for (let i = 0; i < MAX_DROPS; i++) layers[i] = isFarDrop(i) ? 1 : 0;
    geometry.setAttribute(
      "aLayer",
      new THREE.InstancedBufferAttribute(layers, 1),
    );
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        // UniformsLib.fog (fogNear/fogFar and the shared abWeather) for the
        // far layer's fog attenuation; `fog: true` below feeds them live.
        uniforms: {
          ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
          uOffset: { value: this.offset },
          uDir: { value: this.dir },
          uLen: this.len,
          uDensity: this.thin,
          uFade: this.fade,
          uAim: { value: this.aim },
          uHalfHeight: this.halfHeight,
          uColor: { value: new THREE.Color(RAIN_COLOR) },
          uBeamPos: { value: this.beamPos },
          uBeamDir: { value: this.beamDir },
          uBeamTint: { value: this.beamTint },
          uBeamCount: this.beamCount,
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        // The quad is billboarded in the shader; its winding faces either way.
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: true,
        // Feeds fogNear/fogFar only: the shader attenuates, never lerps.
        fog: true,
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
   * render camera's world position and `dt` the frame time, s. `beams`
   * (L5) is the searchlight renderer: the streaks inside its nearest cones
   * take the beam's light.
   */
  update(
    wx: Weather,
    syncedMs: number | null,
    camera: Vec3,
    dt: number,
    beams?: RainBeamSource,
  ): void {
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
    // L5: wrapped on the FAR box (a whole number of near boxes), so the
    // one offset serves both layers.
    this.driftX = wrap(this.driftX + this.fall.x * step, FAR_BOX_XZ);
    this.driftZ = wrap(this.driftZ + this.fall.z * step, FAR_BOX_XZ);
    this.offset.set(
      this.driftX,
      wrap((-FALL_SPEED * syncedMs) / 1000, FAR_BOX_Y),
      this.driftZ,
    );
    streakDir(this.fall, this.camVel, this.dir);
    this.pickBeams(camera, beams);
  }

  /**
   * L5: the MAX_BEAMS drawn beams nearest the camera (distance from the
   * camera to the beam's axis segment), read straight off the searchlight
   * renderer's instance matrices — column 0 is the cone's tip radius, column
   * 1 its axis × throw, column 3 its apex. A collapsed instance (a felled
   * roof's lamp, an empty slot) is skipped, and so is a hidden mesh.
   */
  private pickBeams(camera: Vec3, beams: RainBeamSource | undefined): void {
    this.beamCount.value = 0;
    if (!beams || !beams.mesh.visible) return;
    const m = this.beamM;
    const e = m.elements;
    const pick = this.beamPick;
    pick.length = 0;
    const n = Math.min(beams.beamCount, beams.mesh.count);
    for (let i = 0; i < n; i++) {
      beams.mesh.getMatrixAt(i, m);
      const len = Math.hypot(e[4], e[5], e[6]);
      if (len < 1) continue;
      // Camera → segment distance.
      const ax = e[4] / len;
      const ay = e[5] / len;
      const az = e[6] / len;
      const vx = camera.x - e[12];
      const vy = camera.y - e[13];
      const vz = camera.z - e[14];
      const t = Math.min(len, Math.max(0, vx * ax + vy * ay + vz * az));
      const d = Math.hypot(vx - ax * t, vy - ay * t, vz - az * t);
      if (d > BEAM_RANGE) continue;
      pick.push({ i, d });
    }
    pick.sort((a, b) => a.d - b.d);
    const tints = beams.mesh.geometry.getAttribute("aTint");
    const count = Math.min(MAX_BEAMS, pick.length);
    for (let k = 0; k < count; k++) {
      const { i } = pick[k] as { i: number; d: number };
      beams.mesh.getMatrixAt(i, m);
      const len = Math.hypot(e[4], e[5], e[6]);
      const radius = Math.hypot(e[0], e[1], e[2]);
      (this.beamPos[k] as THREE.Vector4).set(e[12], e[13], e[14], radius / len);
      (this.beamDir[k] as THREE.Vector4).set(
        e[4] / len,
        e[5] / len,
        e[6] / len,
        len,
      );
      // The beam's own colour, at the rain's luminance (a lit streak is
      // never brighter than LIGHT_GAIN allows).
      const c = this.beamScratch;
      if (tints) c.setRGB(tints.getX(i), tints.getY(i), tints.getZ(i));
      else c.setRGB(1, 1, 1);
      const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const s = l > 1e-4 ? RAIN_LUMA / l : 0;
      (this.beamTint[k] as THREE.Vector3).set(c.r * s, c.g * s, c.b * s);
    }
    this.beamCount.value = count;
  }
}
