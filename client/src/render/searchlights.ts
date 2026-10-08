// Searchlights (L2, restyled): rooftop sweeps and the helicopters' belly
// spots. Beams are LIGHT, not geometry — so by the ticket's design rule they
// carry no collision, and they are the one piece of L2 spectacle that lives
// entirely in the flight band without being solid. A beam you can fly
// through reads as a beam; a beam you cannot would be an invisible wall,
// which is exactly what the rule exists to prevent.
//
// One additive InstancedMesh of open cones = one draw call, for the rooftop
// stations AND every helicopter's spot. The cone is drawn by a small custom
// shader that makes it read as a volume rather than a painted shell: a hot
// core at the lamp that falls off along the beam, and silhouette edges that
// fade to nothing so the beam has no hard outline. The lamp head itself is a
// point in the shared MoverLights cloud — the only part that blooms.
//
// Deliberately SUB-BLOOM: the beam's peak effective luminance stays under the
// 0.72 bloom threshold rather than sitting on an emissive rung, the same call
// storm.ts makes for its rim flash. A bloomed cone would smear over half the
// screen and bury tracers.
//
// L1 (ANGE-WCQNFJ): rooftop beams blend toward planes passing within ~250 m
// (reactions.ts trackPlanesInto — a continuous weight, so no hand-off pop).
//
// Stations and sweeps are pure functions of (city, server time) — no seed
// stream of its own, no state — so every client sweeps in lockstep.

import type { Building } from "@angels-bandits/common/city";
import {
  EMISSIVE_BEACON,
  LANDMARK_HEIGHT,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { AB_FOG_DISTANCE_GLSL, AB_FOG_GLSL } from "./fog";
import type { MoverLights } from "./movers";
import { trackPlanesInto } from "./reactions";
import { RENDER_ORDER } from "./render-order";
import { glslFloat } from "./window-pattern";
import { nearestImage } from "./wrapPlacement";

/** How many rooftops carry a light. */
export const SEARCHLIGHT_COUNT = 10;
/** Rooftop beam length and radius at the far end, m — a 4.6° half-angle. */
const BEAM_LENGTH = 420;
const BEAM_RADIUS = 34;
/** Seconds for one full sweep cycle; each station is offset around it. */
const SWEEP_PERIOD_S = 23;
/** How far the beam leans off vertical at the extremes, rad. */
const SWEEP_TILT = 0.72;

/** A helicopter's spot: shorter and tighter, thrown down at the street. */
const SPOT_LENGTH_MAX = 260;
const SPOT_RADIUS = 20;
/** The spot leads the aircraft (fraction of the drop) and wanders a little. */
const SPOT_LEAD = 0.42;
const SPOT_WANDER = 0.16;
const SPOT_WANDER_PERIOD_S = 7.3;

/** One rooftop light: where it stands and where in the cycle it starts. */
export interface SearchlightStation {
  x: number;
  y: number;
  z: number;
  /** Phase offset into the sweep cycle, 0..1. */
  phase: number;
}

/**
 * A beam thrown by something that moves — a helicopter's spot. The renderer
 * takes these per frame from the mover renderer, already nearest-image
 * placed, so the beam hangs off the hull the player actually sees.
 */
export interface SpotBeam {
  /** Lamp position, rendered (nearest-image) coordinates. */
  x: number;
  y: number;
  z: number;
  /** Heading unit vector in the XZ plane: where the aircraft is going. */
  ax: number;
  az: number;
  /** Per-aircraft phase so the spots do not wander in unison, rad. */
  phase: number;
  /** L10: an explicit unit beam direction (the news heli holding its kill
   * site) instead of the wandering street spot, and the throw it needs. */
  aim?: Vec3;
  length?: number;
}

/**
 * Pick the rooftops. Deterministic from the city alone: the tallest
 * non-landmark buildings, tie-broken by position so the order can never
 * depend on sort stability. Landmarks are excluded because they already
 * carry the roof beacons — doubling up would blow out one silhouette.
 */
export function searchlightStations(
  buildings: readonly Building[],
): SearchlightStation[] {
  const candidates = buildings
    .filter((b) => b.height < LANDMARK_HEIGHT)
    .slice()
    .sort((a, b) => b.height - a.height || a.x - b.x || a.z - b.z)
    .slice(0, SEARCHLIGHT_COUNT);
  return candidates.map((b, i) => ({
    x: b.x,
    y: b.height,
    z: b.z,
    phase: i / SEARCHLIGHT_COUNT,
  }));
}

/**
 * A station's beam direction at a server time — a unit vector pointing up and
 * away. The sweep is a slow cone: the beam leans SWEEP_TILT off vertical and
 * rotates, so from the ground it scythes across the sky.
 */
export function beamDirection(
  station: SearchlightStation,
  serverTimeMs: number,
): Vec3 {
  const cycle = (serverTimeMs / 1000 / SWEEP_PERIOD_S + station.phase) % 1;
  const spin = cycle * Math.PI * 2;
  // Tilt breathes over the cycle so the beams do not all trace one cone.
  const tilt = SWEEP_TILT * (0.55 + 0.45 * Math.sin(spin * 2));
  return {
    x: Math.sin(tilt) * Math.cos(spin),
    y: Math.cos(tilt),
    z: Math.sin(tilt) * Math.sin(spin),
  };
}

/**
 * A helicopter spot's direction at a server time — a unit vector pointing
 * down and ahead, wandering slowly across the street the aircraft follows.
 */
export function spotDirection(spot: SpotBeam, serverTimeMs: number): Vec3 {
  const t = (serverTimeMs / 1000 / SPOT_WANDER_PERIOD_S) * Math.PI * 2;
  const side = Math.sin(t + spot.phase) * SPOT_WANDER;
  const lead = SPOT_LEAD + Math.cos(t * 0.61 + spot.phase) * SPOT_WANDER * 0.5;
  // Heading is (ax, az); its right-hand perpendicular in XZ is (-az, ax).
  const x = spot.ax * lead - spot.az * side;
  const z = spot.az * lead + spot.ax * side;
  const len = Math.hypot(x, 1, z);
  return { x: x / len, y: -1 / len, z: z / len };
}

// --- Renderer (consumes the pure model above) ---

/**
 * Cool arc-lamp white, and the PEAK alpha it is drawn at — the hottest point
 * of the beam, right at the lamp, on the beam's centre line. Everywhere else
 * is darker: the shader below only ever scales this down.
 *
 * Deliberately SUB-BLOOM: the effective luminance stays under the 0.72
 * threshold rather than sitting on an emissive rung, the same call storm.ts
 * makes for its rim flash. Exported so a test can pin that — a bloomed beam
 * cone would smear across the screen and bury tracers, which is the one
 * readability contract the emissive ladder exists to protect.
 */
export const BEAM_COLOR = new THREE.Color(0.62, 0.72, 0.9);
export const BEAM_OPACITY = 0.4;
/** A helicopter's spot is a warmer, whiter lamp than the rooftop arcs. */
const SPOT_COLOR = new THREE.Color(0.8, 0.76, 0.64);

// --- Camera falloff (V1, ANGE-6OM7QM) ---------------------------------------
// From INSIDE a cone (or right beside its wall) the beam drew as a flat pale
// sheet over most of the screen, cut by a hard edge. Three causes, each fixed
// below with a continuous term, so no camera position can produce a step:
//   - Facing was a per-VERTEX value smeared across wall triangles that span
//     the whole 420 m throw; from inside, every wall faces the eye at ~1. It
//     is now taken per FRAGMENT from the true radial normal.
//   - A wall passing the camera is clipped along the near plane, a straight
//     line on screen. The NEAR fade takes a fragment to zero as its distance
//     from the eye drops to a few local beam radii, so the clip is invisible.
//   - L1's tracking aims a rooftop beam AT the own plane, which parks the
//     chase camera in or beside the cone exactly when the beam matters. The
//     CAMERA term dims the whole beam toward a floor as the eye nears the
//     axis, keeping the far lamp end readable.
// beamAlpha() is the model, and BEAM_FALLOFF_GLSL is it again for the shader,
// generated from the same constants (the crownSway twin pattern, wind.ts).

/** Floor on the beam radius the falloff measures against, m — the lamp end
 * is a point, and a camera 4 m from it is already in the glare. Spots keep
 * their own 6 m minimum throw radius on top of this. */
export const BEAM_MIN_RADIUS = 4;
/** Near fade, in local beam radii from the eye: 0 → 1 across [IN, OUT]. With
 * the 4 m floor it is exactly 0 at the 1 m near plane. */
export const BEAM_NEAR_IN = 0.5;
export const BEAM_NEAR_OUT = 3;
/** Camera term, in beam radii from the axis (rho): the beam is at the floor
 * from the wall inward and full strength from RHO_OUT out. */
export const BEAM_RHO_IN = 1;
export const BEAM_RHO_OUT = 3;
export const BEAM_INSIDE_FLOOR = 0.25;
/** Sides of the beam's open cone. */
export const BEAM_SEGMENTS = 18;
/**
 * The silhouette fade starts here, in |facing|. O5: the cone is an
 * 18-gon, so where its outline is drawn the TRUE radial normal still faces
 * the eye by up to sin(π/18) ≈ 0.17 — fading from 0 left ~12 % of the
 * beam's alpha on the polygon edge, a hard line that crawled as the beam
 * swept. From just past sin(π/SEGMENTS) the edge is 0 wherever it is drawn.
 */
export const BEAM_EDGE_IN = Math.sin(Math.PI / BEAM_SEGMENTS) + 0.01;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Where the eye sits relative to one beam: its distance from the beam's axis
 * SEGMENT (apex → tip) over the beam's radius at the closest point, floored
 * at BEAM_MIN_RADIUS. 0 on the axis, 1 on the wall, growing outside; behind
 * the lamp or past the tip it measures from the end point, so it is
 * continuous everywhere. `dir` is the unit beam direction; `radius` the
 * radius at the tip (the instance scale).
 */
export function beamCameraRho(
  eye: Vec3,
  apex: Vec3,
  dir: Vec3,
  length: number,
  radius: number,
): number {
  const rx = eye.x - apex.x;
  const ry = eye.y - apex.y;
  const rz = eye.z - apex.z;
  const t = Math.min(
    1,
    Math.max(0, (rx * dir.x + ry * dir.y + rz * dir.z) / length),
  );
  const d = Math.hypot(
    rx - dir.x * length * t,
    ry - dir.y * length * t,
    rz - dir.z * length * t,
  );
  return d / Math.max(radius * t, BEAM_MIN_RADIUS);
}

/** The camera term: the floor at or inside the wall, 1 from RHO_OUT out. */
export const beamCameraFade = (rho: number): number =>
  BEAM_INSIDE_FLOOR +
  (1 - BEAM_INSIDE_FLOOR) * smoothstep(BEAM_RHO_IN, BEAM_RHO_OUT, rho);

/** The near fade of one fragment `viewDist` m from the eye, where the beam's
 * radius is `localRadius` m. */
export const beamNearFade = (viewDist: number, localRadius: number): number =>
  smoothstep(
    BEAM_NEAR_IN,
    BEAM_NEAR_OUT,
    viewDist / Math.max(localRadius, BEAM_MIN_RADIUS),
  );

/** One fragment of a beam, as the shader sees it. */
export interface BeamFragment {
  /** Fraction of the way along the throw, 0 at the lamp. */
  t: number;
  /** |cos| between the wall's radial normal and the direction to the eye. */
  facing: number;
  /** Distance from the eye, m. */
  viewDist: number;
  /** The beam's radius at this fragment, m. */
  localRadius: number;
  /** The eye's beamCameraRho for this beam. */
  rho: number;
}

/**
 * A beam fragment's alpha before the dust shimmer and fog: the hot core and
 * the falloff along the throw, the soft silhouette, and the two camera
 * terms. Peaks at BEAM_OPACITY; only ever scales it down.
 */
export function beamAlpha(f: BeamFragment): number {
  const fade = (1 - f.t) ** 1.5;
  const hot = 0.4 + 0.6 * Math.exp(-f.t * 6);
  const edge = smoothstep(BEAM_EDGE_IN, 0.8, f.facing);
  return (
    BEAM_OPACITY *
    fade *
    hot *
    edge *
    beamNearFade(f.viewDist, f.localRadius) *
    beamCameraFade(f.rho)
  );
}

/**
 * The model again in GLSL, from the same constants: `abBeamCameraRho` and
 * `abBeamCameraFade` (per instance, in the vertex shader) and `abBeamAlpha`
 * (per fragment, taking the camera fade already applied).
 */
export const BEAM_FALLOFF_GLSL = /* glsl */ `
float abBeamSmooth(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float abBeamCameraRho(vec3 eye, vec3 apex, vec3 dir, float len, float radius) {
  vec3 r = eye - apex;
  float t = clamp(dot(r, dir) / len, 0.0, 1.0);
  return length(r - dir * (len * t)) / max(radius * t, ${glslFloat(BEAM_MIN_RADIUS)});
}
float abBeamCameraFade(float rho) {
  return ${glslFloat(BEAM_INSIDE_FLOOR)} + ${glslFloat(1 - BEAM_INSIDE_FLOOR)} *
    abBeamSmooth(${glslFloat(BEAM_RHO_IN)}, ${glslFloat(BEAM_RHO_OUT)}, rho);
}
float abBeamAlpha(float peak, float t, float facing, float viewDist,
                  float localRadius, float cameraFade) {
  float fade = pow(1.0 - t, 1.5);
  float hot = 0.4 + 0.6 * exp(-t * 6.0);
  float edge = abBeamSmooth(${glslFloat(BEAM_EDGE_IN)}, 0.8, facing);
  float near = abBeamSmooth(${glslFloat(BEAM_NEAR_IN)}, ${glslFloat(BEAM_NEAR_OUT)},
    viewDist / max(localRadius, ${glslFloat(BEAM_MIN_RADIUS)}));
  return peak * fade * hot * edge * near * cameraFade;
}
`;

/** The lamp head: the one part of a searchlight that sits ON a rung. */
const HEAD_COLOR = new THREE.Color(0.85, 0.9, 1.0);
const headBoost = HEAD_COLOR.clone().multiplyScalar(
  emissiveBoost(HEAD_COLOR, EMISSIVE_BEACON),
);
const SPOT_HEAD_COLOR = new THREE.Color(1.0, 0.95, 0.82);
const spotHeadBoost = SPOT_HEAD_COLOR.clone().multiplyScalar(
  emissiveBoost(SPOT_HEAD_COLOR, EMISSIVE_BEACON),
);
const HEAD_SIZE = 7;
const SPOT_HEAD_SIZE = 4;

/** Instances the mesh can hold beyond the rooftop stations (4 street helis,
 * the L10 news heli, headroom). */
const SPOT_CAPACITY = 9;

const BEAM_VERTEX = /* glsl */ `
attribute vec3 aTint;
uniform float uTime;
varying float vT;
varying vec3 vTint;
varying float vShimmer;
varying float vDepth;
varying float vWorldY;
varying vec3 vWorldPos;
varying vec3 vApex;
varying vec3 vAxis;
varying float vTipRadius;
varying float vCameraFade;
${BEAM_FALLOFF_GLSL}

void main() {
  #ifdef USE_INSTANCING
    mat4 model = modelMatrix * instanceMatrix;
  #else
    mat4 model = modelMatrix;
  #endif
  vec4 worldPos = model * vec4(position, 1.0);
  // The cone is unit: apex at the origin, axis +Y, so position.y is the
  // fraction of the way along the beam.
  vT = position.y;
  // The instance's beam, for the per-fragment falloff: apex, unit axis, and
  // the (r, L, r) scale read back off the matrix. These are the same at every
  // vertex of an instance, so they interpolate to themselves.
  vec3 apex = (model * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 axisL = mat3(model) * vec3(0.0, 1.0, 0.0);
  float len = length(axisL);
  vec3 axis = axisL / len;
  float tipRadius = length(mat3(model) * vec3(1.0, 0.0, 0.0));
  vApex = apex;
  vAxis = axis;
  vTipRadius = tipRadius;
  vCameraFade = abBeamCameraFade(
    abBeamCameraRho(cameraPosition, apex, axis, len, tipRadius));
  vWorldPos = worldPos.xyz;
  vTint = aTint;
  // Slow drift of faint bands along the beam: dust in the throw.
  vShimmer = 0.88 + 0.12 * sin(position.y * 38.0 - uTime * 1.7 + apex.x * 0.01);
  vec4 mvPosition = viewMatrix * worldPos;
  vDepth = ${AB_FOG_DISTANCE_GLSL}; // radial, like every fogged material (O1)
  vWorldY = worldPos.y;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const BEAM_FRAGMENT = /* glsl */ `
uniform float uOpacity;
uniform float fogNear;
uniform float fogFar;
varying float vT;
varying vec3 vTint;
varying float vShimmer;
varying float vDepth;
varying float vWorldY;
varying vec3 vWorldPos;
varying vec3 vApex;
varying vec3 vAxis;
varying float vTipRadius;
varying float vCameraFade;
${AB_FOG_GLSL}
${BEAM_FALLOFF_GLSL}

void main() {
  // Silhouette softness from the TRUE wall normal at this fragment: the
  // radial direction off the beam axis. Built from the axis rather than the
  // mesh normal because the (r, L, r) scale is wildly non-uniform, and per
  // fragment because one wall triangle spans the whole throw.
  vec3 rel = vWorldPos - vApex;
  vec3 radial = rel - vAxis * dot(rel, vAxis);
  float rlen = length(radial);
  vec3 normal_w = rlen > 1e-4 ? radial / rlen : vAxis;
  vec3 toEye = cameraPosition - vWorldPos;
  float viewDist = length(toEye);
  float facing = abs(dot(normal_w, toEye / max(viewDist, 1e-4)));
  float a = abBeamAlpha(uOpacity, vT, facing, viewDist, vTipRadius * vT,
    vCameraFade) * vShimmer;
  // S5 god rays: the throw breaks into shafts as it scatters through the
  // haze — fixed in the beam's own frame (the angle about its axis), so they
  // ride the sweep and never crawl, stronger down the throw and in the low,
  // thick air. Only ever scales the alpha down (the beam stays sub-bloom).
  vec3 abRef = abs(vAxis.z) < 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 abB1 = normalize(cross(vAxis, abRef));
  vec3 abB2 = cross(vAxis, abB1);
  float abAng = rlen > 1e-4 ? atan(dot(radial, abB2), dot(radial, abB1)) : 0.0;
  float abRays = 0.55 + 0.45 * (0.5 + 0.5 * sin(abAng * 7.0 + vApex.x * 0.013))
    * (0.6 + 0.4 * sin(abAng * 13.0 + vApex.z * 0.017));
  float abScatter = exp(-max(vWorldY, 0.0) / AB_HAZE_H) * (1.0 + abWeather.x);
  a *= mix(1.0, abRays, smoothstep(0.04, 0.35, vT) * (0.55 + 0.35 * min(abScatter, 1.0)));
  // Fog, the additive way: a beam in the distance ATTENUATES to nothing,
  // exactly as the buildings behind it dissolve — it never lerps toward the
  // fog colour (that would brighten the sky). Both layers: the linear fog
  // that guarantees the torus, and the height haze the city sits in.
  float fogFactor = smoothstep(fogNear, fogFar, vDepth);
  float haze = abHazeAmount(cameraPosition.y, vWorldY, vDepth);
  a *= (1.0 - fogFactor) * (1.0 - haze);
  gl_FragColor = vec4(vTint * a, 1.0);
}
`;

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Every beam in one additive InstancedMesh. The cone is built apex-at-origin
 * pointing along +Y, so a single quaternion from +Y to the beam direction
 * places it — no per-frame geometry work.
 */
export class Searchlights {
  readonly mesh: THREE.InstancedMesh;
  private readonly stations: SearchlightStation[];
  private readonly tints: THREE.InstancedBufferAttribute;
  private readonly capacity: number;
  private readonly uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    { uOpacity: { value: BEAM_OPACITY }, uTime: { value: 0 } },
  ]) as { uOpacity: { value: number }; uTime: { value: number } };
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  /** L1 tracking scratch: the canonical lamp and the biased direction. */
  private readonly lamp = { x: 0, y: 0, z: 0 };
  private readonly tracked = { x: 0, y: 1, z: 0 };
  /** Beams drawn last frame — for the perf report. */
  private drawn = 0;

  constructor(buildings: readonly Building[]) {
    this.stations = searchlightStations(buildings);
    // Open-ended cone, apex at the origin, opening along +Y. ConeGeometry
    // puts its apex at +height/2, so it is flipped and then lifted.
    const cone = new THREE.ConeGeometry(1, 1, BEAM_SEGMENTS, 1, true);
    cone.rotateX(Math.PI);
    cone.translate(0, 0.5, 0);
    const capacity = this.stations.length + SPOT_CAPACITY;
    this.capacity = capacity;
    const tints = new Float32Array(capacity * 3);
    for (let i = 0; i < capacity; i++) {
      const c = i < this.stations.length ? BEAM_COLOR : SPOT_COLOR;
      tints[i * 3] = c.r;
      tints[i * 3 + 1] = c.g;
      tints[i * 3 + 2] = c.b;
    }
    this.tints = new THREE.InstancedBufferAttribute(tints, 3);
    cone.setAttribute("aTint", this.tints);
    this.mesh = new THREE.InstancedMesh(
      cone,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        // `fog: true` only feeds the scene's fogNear/fogFar/fogColor
        // uniforms (so the storm's in-cloud fog reaches the beams); the
        // shader attenuates rather than lerping to the fog colour, which is
        // what additive + three's fog would do (the V1 lesson).
        fog: true,
      }),
      Math.max(1, capacity),
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // Draw after the opaque city so the cones blend over it, and after the
    // sky dome (renderOrder -1) — a beam must never be painted under the sky.
    this.mesh.renderOrder = RENDER_ORDER.beams;
  }

  /** Beams drawn — for the perf report. */
  get beamCount(): number {
    return this.drawn;
  }

  private place(index: number, dir: Vec3, length: number, radius: number) {
    this.dir.set(dir.x, dir.y, dir.z).normalize();
    this.quat.setFromUnitVectors(UP, this.dir);
    this.scale.set(radius, length, radius);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(index, this.matrix);
  }

  /**
   * Sweep every beam. A null clock hides them, like the rest of L2.
   *
   * `spots` are the helicopters' lamps for this frame, already nearest-image
   * placed by the mover renderer. `lights` takes the lamp heads — call this
   * between MoverLights.begin() and commit(), like the movers themselves.
   */
  update(
    cameraPos: Vec3,
    serverTimeMs: number | null,
    spots: readonly SpotBeam[] = [],
    lights?: MoverLights,
    planes: readonly Vec3[] = [],
  ): void {
    if (serverTimeMs === null) {
      this.mesh.visible = false;
      this.drawn = 0;
      return;
    }
    this.mesh.visible = true;
    this.uniforms.uTime.value = (serverTimeMs / 1000) % 1000;
    let index = 0;
    for (const station of this.stations) {
      const p = nearestImage(cameraPos, {
        x: station.x,
        y: station.y,
        z: station.z,
      });
      // The lamp sits a little above the parapet, so the beam's root is not
      // swallowed by the roof slab.
      this.pos.set(p.x, p.y + 1.5, p.z);
      // L1: the sweep swings toward planes within range of the lamp
      // (canonical lamp → torus-aware deltas inside trackPlanesInto).
      this.lamp.x = station.x;
      this.lamp.y = station.y + 1.5;
      this.lamp.z = station.z;
      const sweep = beamDirection(station, serverTimeMs);
      this.place(
        index++,
        planes.length > 0
          ? trackPlanesInto(this.lamp, sweep, planes, this.tracked)
          : sweep,
        BEAM_LENGTH,
        BEAM_RADIUS,
      );
      lights?.place({ x: p.x, y: p.y + 1.5, z: p.z }, headBoost, HEAD_SIZE);
    }
    for (const spot of spots) {
      if (index >= this.capacity) break;
      this.pos.set(spot.x, spot.y, spot.z);
      const d = spot.aim ?? spotDirection(spot, serverTimeMs);
      // Throw as far as the ground and a little past it, never further than
      // the lamp is rated for — a spot on the deck is a pool, not a pillar.
      const length =
        spot.length ?? Math.min(SPOT_LENGTH_MAX, (spot.y + 12) / -d.y);
      const radius = SPOT_RADIUS * (length / SPOT_LENGTH_MAX);
      this.place(index++, d, length, Math.max(6, radius));
      lights?.place(spot, spotHeadBoost, SPOT_HEAD_SIZE);
    }
    this.drawn = index;
    this.mesh.count = Math.max(1, index);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
