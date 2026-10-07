// Headlights (L6): every vehicle throws a soft cone into the street haze and a
// warm pool onto the asphalt ahead of it. Light, not geometry — no collision,
// the accepted flight-band exception — so the cones can be seen glowing in
// the canyons from altitude, which is why they fade with CAMERA DISTANCE
// rather than through streetlife's microGate (that gate would delete them
// exactly where they read).
//
// Two additive InstancedMeshes = two draw calls for the whole city, fed from
// the poses Traffic placed this frame (Traffic.frame), so a beam can never
// detach from its car. The cone shader is the searchlights' volume idiom — a
// hot core that falls off along the throw, silhouette edges that thin to
// nothing — and both layers fade the additive way: ATTENUATED by the linear
// fog and the height haze, never lerped toward the fog colour (the V1 lesson).
//
// Deliberately SUB-BLOOM, like the searchlight beams: a cone's peak effective
// luminance stays well under the 0.72 threshold, so even a queue of four
// overlapping cones does not bloom and bury tracers. The bright points are the
// headlight dots on the car bodies, which already sit on their rung.

import { wrapDeltaAxis } from "@angels-bandits/common/world";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { AB_FOG_DISTANCE_GLSL, AB_FOG_GLSL } from "./fog";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import type { Traffic } from "./traffic";

/** Lamp height above the street, m. */
const LAMP_Y = 0.65;
/** Cone throw, m, its horizontal and vertical radius at the far end, and how
 * far it dips below level, rad — a low beam. */
const CONE_LENGTH = 24;
const CONE_SPREAD = 4.6;
const CONE_HEIGHT = 2.1;
const CONE_DIP = 0.05;
/** Ground pool: length ahead of the bumper and width, m. */
const POOL_LENGTH = 17;
const POOL_WIDTH = 6.5;
/** Pools sit this far above the street (plus polygonOffset) — no z-fight. */
const POOL_Y = 0.05;
/** Camera-distance fade, m: full inside NEAR, gone (and culled) past FAR. */
export const HEADLIGHT_NEAR = 260;
export const HEADLIGHT_FAR = 380;

/** Warm halogen white for the cone and pool, and their PEAK alphas. */
const CONE_COLOR = new THREE.Color(1.0, 0.87, 0.64);
const CONE_OPACITY = 0.16;
const POOL_COLOR = new THREE.Color(1.0, 0.78, 0.5);
const POOL_OPACITY = 0.22;

/** Distance fade for one vehicle's lights: 1 near, 0 at and past FAR. */
export function headlightFade(distance: number): number {
  if (distance <= HEADLIGHT_NEAR) return 1;
  if (distance >= HEADLIGHT_FAR) return 0;
  const k = (HEADLIGHT_FAR - distance) / (HEADLIGHT_FAR - HEADLIGHT_NEAR);
  return k * k * (3 - 2 * k);
}

const FOG_FRAGMENT_PARS = /* glsl */ `
uniform float fogNear;
uniform float fogFar;
${AB_FOG_GLSL}
// Additive fog: attenuate by both layers, never lerp toward the fog colour.
float abAdditiveFog(float depth, float worldY) {
  float fogFactor = smoothstep(fogNear, fogFar, depth);
  float haze = abHazeAmount(cameraPosition.y, worldY, depth);
  return (1.0 - fogFactor) * (1.0 - haze);
}
`;

const CONE_VERTEX = /* glsl */ `
attribute float aFade;
varying float vT;
varying float vFacing;
varying float vFade;
varying float vDepth;
varying float vWorldY;

void main() {
  mat4 model = modelMatrix * instanceMatrix;
  vec4 worldPos = model * vec4(position, 1.0);
  // Unit cone, apex at the origin, axis +Y: position.y is the fraction of the
  // way along the throw.
  vT = position.y;
  // Silhouette softness from the radial direction off the beam axis (the
  // scale is non-uniform, so the mesh normal would be skewed) — searchlights.
  vec3 apex = (model * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 axis = normalize(mat3(model) * vec3(0.0, 1.0, 0.0));
  vec3 rel = worldPos.xyz - apex;
  vec3 radial = rel - axis * dot(rel, axis);
  float rlen = length(radial);
  vec3 normalW = rlen > 1e-4 ? radial / rlen : axis;
  vFacing = abs(dot(normalW, normalize(cameraPosition - worldPos.xyz)));
  vFade = aFade;
  vec4 mvPosition = viewMatrix * worldPos;
  vDepth = ${AB_FOG_DISTANCE_GLSL}; // radial, like every fogged material (O1)
  vWorldY = worldPos.y;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const CONE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vT;
varying float vFacing;
varying float vFade;
varying float vDepth;
varying float vWorldY;
${FOG_FRAGMENT_PARS}

void main() {
  float along = 1.0 - vT;
  // Bright at the lamp, gone before the tip (no pow: along * along).
  float fade = along * along;
  float hot = 0.45 + 0.55 * exp(-vT * 5.0);
  float edge = smoothstep(0.0, 0.85, vFacing);
  float a = uOpacity * fade * hot * edge * vFade;
  a *= abAdditiveFog(vDepth, vWorldY);
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

const POOL_VERTEX = /* glsl */ `
attribute float aFade;
varying vec2 vLocal;
varying float vFade;
varying float vDepth;
varying float vWorldY;

void main() {
  // Local x across (−0.5..0.5), local z ahead (0 at the bumper .. −1 at the
  // far end: forward is −Z).
  vLocal = vec2(position.x * 2.0, -position.z);
  vFade = aFade;
  vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * worldPos;
  vDepth = ${AB_FOG_DISTANCE_GLSL}; // radial, like every fogged material (O1)
  vWorldY = worldPos.y;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const POOL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vLocal;
varying float vFade;
varying float vDepth;
varying float vWorldY;
${FOG_FRAGMENT_PARS}

void main() {
  float ahead = vLocal.y;
  // The pool widens with distance like the beam that casts it.
  float lateral = abs(vLocal.x) / (0.4 + 0.6 * ahead);
  float body = smoothstep(0.0, 0.14, ahead) * (1.0 - smoothstep(0.3, 1.0, ahead));
  float side = 1.0 - smoothstep(0.35, 1.0, lateral);
  float a = uOpacity * body * side * vFade;
  a *= abAdditiveFog(vDepth, vWorldY);
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

function additiveMaterial(
  vertexShader: string,
  fragmentShader: string,
  color: THREE.Color,
  opacity: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uColor: { value: color }, uOpacity: { value: opacity } },
    ]),
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // `fog: true` only feeds fogNear/fogFar (so the storm's in-cloud fog
    // reaches the beams); the shader attenuates rather than lerping.
    fog: true,
  });
}

/** Both headlight layers: cones in the haze and pools on the asphalt. */
export class Headlights {
  readonly cones: THREE.InstancedMesh;
  readonly pools: THREE.InstancedMesh;
  private readonly coneFade: THREE.InstancedBufferAttribute;
  private readonly poolFade: THREE.InstancedBufferAttribute;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly yawQuat = new THREE.Quaternion();
  /** +Y (the unit cone's axis) tipped onto forward (−Z), then dipped. */
  private readonly tilt = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -Math.PI / 2 - CONE_DIP,
  );
  private readonly pos = new THREE.Vector3();
  private readonly coneScale = new THREE.Vector3(
    CONE_SPREAD,
    CONE_LENGTH,
    CONE_HEIGHT,
  );
  private readonly poolScale = new THREE.Vector3(POOL_WIDTH, 1, POOL_LENGTH);
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private lit = 0;
  /** O3 quality tier: the additive cones are the cost; the pools stay. */
  private conesOn = true;

  constructor(capacity: number) {
    // Open cone, apex at the origin, opening along +Y. ConeGeometry puts its
    // apex at +height/2, so it is flipped and then lifted (the searchlights
    // trap: unflipped, the beam would open BACK into the car).
    const cone = new THREE.ConeGeometry(1, 1, 14, 1, true);
    cone.rotateX(Math.PI);
    cone.translate(0, 0.5, 0);
    this.coneFade = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity),
      1,
    );
    this.coneFade.setUsage(THREE.DynamicDrawUsage);
    cone.setAttribute("aFade", this.coneFade);
    const coneMaterial = additiveMaterial(
      CONE_VERTEX,
      CONE_FRAGMENT,
      CONE_COLOR,
      CONE_OPACITY,
    );
    // The camera can sit inside a beam at street level. One pass, not three's
    // default back-then-front pair for transparent double-sided materials:
    // additive blending is order-free, and the second pass is a draw call.
    coneMaterial.side = THREE.DoubleSide;
    coneMaterial.forceSinglePass = true;
    this.cones = new THREE.InstancedMesh(cone, coneMaterial, capacity);

    // A unit quad on the ground, from the bumper (z = 0) forward to z = −1.
    const pool = new THREE.PlaneGeometry(1, 1);
    pool.rotateX(-Math.PI / 2);
    pool.translate(0, 0, -0.5);
    this.poolFade = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity),
      1,
    );
    this.poolFade.setUsage(THREE.DynamicDrawUsage);
    pool.setAttribute("aFade", this.poolFade);
    const poolMaterial = additiveMaterial(
      POOL_VERTEX,
      POOL_FRAGMENT,
      POOL_COLOR,
      POOL_OPACITY,
    );
    poolMaterial.polygonOffset = true;
    poolMaterial.polygonOffsetFactor = -2;
    poolMaterial.polygonOffsetUnits = -2;
    this.pools = new THREE.InstancedMesh(pool, poolMaterial, capacity);

    for (const mesh of [this.cones, this.pools]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.count = 0;
      // After the opaque city and the sky dome, like the searchlight cones.
      mesh.renderOrder = 2;
    }
  }

  /** Vehicles lit last frame — for the perf report. */
  get count(): number {
    return this.lit;
  }

  /** Light every vehicle Traffic drew this frame within HEADLIGHT_FAR. */
  update(cameraPos: Vec3, traffic: Traffic): void {
    const frame = traffic.frame;
    let n = 0;
    for (let i = 0; i < traffic.drawn; i++) {
      const f = i * 4;
      const x = frame[f] as number;
      const z = frame[f + 1] as number;
      const yaw = frame[f + 2] as number;
      const dx = wrapDeltaAxis(cameraPos.x, x);
      const dz = wrapDeltaAxis(cameraPos.z, z);
      const dy = LAMP_Y - cameraPos.y;
      const fade = headlightFade(Math.sqrt(dx * dx + dy * dy + dz * dz));
      if (fade <= 0) continue;
      this.yawQuat.setFromAxisAngle(Headlights.UP, yaw);
      if (this.conesOn) {
        this.quat.copy(this.yawQuat).multiply(this.tilt);
        this.pos.set(x, LAMP_Y, z);
        this.matrix.compose(this.pos, this.quat, this.coneScale);
        this.cones.setMatrixAt(n, this.matrix);
        this.coneFade.setX(n, fade);
      }
      this.pos.set(x, POOL_Y, z);
      this.matrix.compose(this.pos, this.yawQuat, this.poolScale);
      this.pools.setMatrixAt(n, this.matrix);
      this.poolFade.setX(n, fade);
      n++;
    }
    this.lit = n;
    const cones = this.conesOn ? n : 0;
    this.cones.count = cones;
    this.cones.visible = cones > 0;
    if (cones > 0) {
      this.cones.instanceMatrix.needsUpdate = true;
      this.coneFade.needsUpdate = true;
    }
    this.pools.count = n;
    this.pools.visible = n > 0;
    this.pools.instanceMatrix.needsUpdate = true;
    this.poolFade.needsUpdate = true;
  }

  /** O3: Low drops the cones (additive fill over the street); pools stay. */
  setQuality(tier: QualityTier): void {
    this.conesOn = QUALITY_PROFILES[tier].headlightCones;
  }
}
