// Aviation lights (ticket ANGE-L7F2OS): red/green/white nav lights, a
// clock-synced anti-collision strobe, and the engine-exhaust glow — the
// plane-attached light that makes planes readable at night without
// brightening the world.
//
// Pure section first (strobe phase math + the mount-point table — the unit
// test surface), then the renderer: ALL planes' lights live in ONE
// THREE.Points draw call (5 points per plane), with per-point size/color via
// a small onBeforeCompile patch — same idiom as the other night systems.

import {
  BOOST_MAX_SPEED,
  EMISSIVE_AFTERBURN,
  EMISSIVE_EXHAUST,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_STROBE,
  MAX_SPEED,
  ROOM_CAP,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { applyPointFloor } from "./point-floor";
import { DUSK, MOON_DIR } from "./sky";
import type { QuatLike } from "./trails";

// --- Strobe pattern spec (all clients share it verbatim) ---
/** Full strobe cycle, ms. */
export const STROBE_PERIOD_MS = 1200;
/** One flash pulse, ms. */
export const STROBE_FLASH_MS = 70;
/** Pulse starts within the cycle, ms — the aviation double-flash. */
export const STROBE_FLASH_OFFSETS = [0, 180] as const;

/** FNV-1a over the plane id (uint32) — the stable, cheap per-plane seed
 * behind the strobe phase and the remote livery pick. */
export function planeHash(planeId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < planeId.length; i++) {
    h ^= planeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Strobe phase offset within the cycle, ms. */
export function strobePhaseMs(planeId: string): number {
  return planeHash(planeId) % STROBE_PERIOD_MS;
}

/**
 * Whether `planeId`'s strobe is lit at synced server time `timeMs`. Pure —
 * every client computes the same answer for the same instant, and distinct
 * ids flash at distinct phases.
 */
export function strobeOn(planeId: string, timeMs: number): boolean {
  const period = STROBE_PERIOD_MS;
  const p = (((timeMs - strobePhaseMs(planeId)) % period) + period) % period;
  for (const off of STROBE_FLASH_OFFSETS) {
    if (p >= off && p < off + STROBE_FLASH_MS) return true;
  }
  return false;
}

// --- Mount points, game-local coords (forward −Z, right +X, up +Y) ---
// Derived from the biplane model (model nose +Z, flown inside a π-turned
// parent): upper-wing tips at model x = ±4.5, z = 0.62, raised by the F3
// 1.2° dihedral from y = 1.38 to ≈ 1.47; tail post at model z ≈ −3.3;
// exhaust-stub outlets below the cowl's left flank at model ≈ (0.53, −0.34,
// 2.46). The π turn maps model (x, z) → game (−x, −z). Wingtip trails
// (trails.ts) ride the nav mounts, so moving a tip here moves both.
export const LIGHT_MOUNTS = {
  /** Red — LEFT wingtip (game −X). */
  navL: { x: -4.5, y: 1.47, z: -0.62 },
  /** Green — RIGHT wingtip (game +X). */
  navR: { x: 4.5, y: 1.47, z: -0.62 },
  /** White — tail post (game +Z is aft). */
  tail: { x: 0, y: 1.2, z: 3.25 },
  /** White anti-collision strobe on the fuselage spine. */
  strobe: { x: 0, y: 0.75, z: 1.7 },
  /** Warm exhaust glow at the stub outlets (nose is −Z). */
  exhaust: { x: -0.53, y: -0.34, z: -2.46 },
} as const satisfies Record<string, Vec3>;

// --- Renderer: one Points draw call for every plane's five lights ---

const LIGHTS_PER_PLANE = 5;
const CAPACITY = ROOM_CAP * LIGHTS_PER_PLANE;

/** Concept 1 "Regulation Night Traffic": small steady points, tight halos. */
const NAV_SIZE = 1.7;
const TAIL_SIZE = 1.4;
const STROBE_SIZE = 3.2;
const EXHAUST_SIZE = 1.1;
/** Exhaust flicker rate, Hz-ish components (deliberately incommensurate). */
const FLICKER_A = 13;
const FLICKER_B = 7.3;

const NAV_RED = new THREE.Color(1.0, 0.1, 0.1);
const NAV_GREEN = new THREE.Color(0.12, 1.0, 0.3);
const NAV_WHITE = new THREE.Color(1.0, 1.0, 1.0);
const EXHAUST_AMBER = new THREE.Color(1.0, 0.55, 0.22);

/** HDR ladder boosts: steady lights at NAVLIGHT, strobe peak at STROBE,
 * exhaust capped at EXHAUST — all below tracers (combat outranks scenery). */
const redBoost = NAV_RED.clone().multiplyScalar(
  emissiveBoost(NAV_RED, EMISSIVE_NAVLIGHT),
);
const greenBoost = NAV_GREEN.clone().multiplyScalar(
  emissiveBoost(NAV_GREEN, EMISSIVE_NAVLIGHT),
);
const whiteBoost = NAV_WHITE.clone().multiplyScalar(
  emissiveBoost(NAV_WHITE, EMISSIVE_NAVLIGHT),
);
const strobeBoost = NAV_WHITE.clone().multiplyScalar(
  emissiveBoost(NAV_WHITE, EMISSIVE_STROBE),
);
const exhaustBoost = EXHAUST_AMBER.clone().multiplyScalar(
  emissiveBoost(EXHAUST_AMBER, EMISSIVE_EXHAUST),
);
/** Boost afterburn (F2): a hotter, whiter flame on its own rung, still
 * under tracers. */
const AFTERBURN_WHITE_HOT = new THREE.Color(1, 0.86, 0.62);
const afterburnBoost = AFTERBURN_WHITE_HOT.clone().multiplyScalar(
  emissiveBoost(AFTERBURN_WHITE_HOT, EMISSIVE_AFTERBURN),
);
/** Afterburn flame size at full burn, as a multiple of EXHAUST_SIZE. */
const AFTERBURN_SIZE = 2.2;
/** Remotes show the flame from streamed speed past this, m/s — high enough
 * that it lights within a beat of the burn and dies ~1 s into the tail. */
const AFTERBURN_FROM_SPEED = 105;

/** Soft round glow: hard bright core, gentle falloff — one shared sprite. */
function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture();
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const scratchQuat = new THREE.Quaternion();
const scratchVec = new THREE.Vector3();

export class PlaneLights {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private count = 0;

  constructor() {
    this.positions = new Float32Array(CAPACITY * 3);
    this.colors = new Float32Array(CAPACITY * 3);
    this.sizes = new Float32Array(CAPACITY);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 3),
    );
    this.geometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(this.sizes, 1),
    );
    // Never let three cull the shared cloud by a stale sphere.
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.POSITIVE_INFINITY,
    );

    const material = new THREE.PointsMaterial({
      size: 1, // scaled per point by aSize (meters) in the patch below
      sizeAttenuation: true,
      map: glowTexture(),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Additive + fog brightens the distant scene (V1 lesson) — keep off.
      fog: false,
    });
    // Per-point size: the same explicit-cache-key idiom as the other
    // patched night materials (three keys on onBeforeCompile.toString()).
    material.customProgramCacheKey = () => "ab-plane-lights";
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "uniform float size;",
          "uniform float size;\nattribute float aSize;",
        )
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
      // O5: never drawn under 2 px, alpha-paid, faded below 1 px.
      applyPointFloor(shader);
    };
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
  }

  /** Start a frame: forget last frame's points. */
  begin(): void {
    this.count = 0;
  }

  /**
   * Append one plane's five lights. `rendered` is the plane's already
   * nearest-image-placed world position (the same one its mesh uses), so
   * lights can never drift to another torus image than their plane.
   * `afterburn` (0..1) is the boost flame: the own plane passes its real burn
   * state; remotes leave it out and it is read from streamed speed.
   */
  place(
    planeId: string,
    rendered: Vec3,
    quat: QuatLike,
    speed: number,
    syncedTimeMs: number,
    afterburn: number = Math.min(
      1,
      Math.max(
        0,
        (speed - AFTERBURN_FROM_SPEED) /
          (BOOST_MAX_SPEED - AFTERBURN_FROM_SPEED),
      ),
    ),
  ): void {
    if (this.count + LIGHTS_PER_PLANE > CAPACITY) return;
    scratchQuat.set(quat.x, quat.y, quat.z, quat.w);

    this.append(rendered, LIGHT_MOUNTS.navL, redBoost, NAV_SIZE);
    this.append(rendered, LIGHT_MOUNTS.navR, greenBoost, NAV_SIZE);
    this.append(rendered, LIGHT_MOUNTS.tail, whiteBoost, TAIL_SIZE);

    // Strobe: synced-clock double flash, phase from the plane id.
    const lit = strobeOn(planeId, syncedTimeMs);
    this.append(
      rendered,
      LIGHT_MOUNTS.strobe,
      strobeBoost,
      lit ? STROBE_SIZE : 0,
    );

    // Exhaust: throttle proxy (streamed speed) with a small flicker.
    const t = syncedTimeMs / 1000;
    const flicker =
      0.8 + 0.2 * Math.sin(t * FLICKER_A) * Math.sin(t * FLICKER_B);
    const throttle = Math.min(1, Math.max(0.25, speed / MAX_SPEED));
    scratchColor
      .copy(exhaustBoost)
      .multiplyScalar(throttle * flicker)
      .lerp(
        scratchFlame.copy(afterburnBoost).multiplyScalar(flicker),
        afterburn,
      );
    this.appendColor(
      rendered,
      LIGHT_MOUNTS.exhaust,
      scratchColor,
      EXHAUST_SIZE * (1 + (AFTERBURN_SIZE - 1) * afterburn),
    );
  }

  private append(
    rendered: Vec3,
    mount: Vec3,
    color: THREE.Color,
    size: number,
  ): void {
    this.appendColor(rendered, mount, color, size);
  }

  private appendColor(
    rendered: Vec3,
    mount: Vec3,
    color: THREE.Color,
    size: number,
  ): void {
    const i = this.count++;
    scratchVec.set(mount.x, mount.y, mount.z).applyQuaternion(scratchQuat);
    this.positions[i * 3] = rendered.x + scratchVec.x;
    this.positions[i * 3 + 1] = rendered.y + scratchVec.y;
    this.positions[i * 3 + 2] = rendered.z + scratchVec.z;
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
    this.sizes[i] = size;
  }

  /** End a frame: upload the appended points. */
  commit(): void {
    this.geometry.setDrawRange(0, this.count);
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate =
      true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate =
      true;
    (this.geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate =
      true;
  }
}

const scratchColor = new THREE.Color();
const scratchFlame = new THREE.Color();

// --- Hero light (VO4): every plane lights ITSELF, in its own shader ---
//
// A per-plane key/fill/rim rig evaluated in the plane materials' fragment
// shader — zero scene-light cost, and it follows each plane everywhere. All
// terms are peak linear luminances at albedo 1, N·L 1 and F 1 (the colours are
// boosted to them with emissiveBoost, so the constants ARE what the shader
// bakes). The lit body — scene rig + hero — is then capped in the shader
// below the bloom threshold: the airframe never blooms, only the plane's
// lights and its exhaust ring do. `material.emissive` (spawn shimmer, storm
// reveal) is never touched here and stays additive and uncapped.

/** Warm key from the camera side (view space: right, up, toward camera) —
 * ~45° off the view axis, so it models the airframe instead of flattening
 * it like a headlamp. */
const HERO_KEY_DIR = new THREE.Vector3(0.45, 0.55, 0.7).normalize();
/** Wrap-Lambert factor for the key: a soft terminator, no hard black side. */
const HERO_KEY_WRAP = 0.25;
/** Roughness floor for the key glint (keeps chrome from a pinpoint lobe). */
const HERO_SPEC_MIN_ROUGHNESS = 0.18;

export const HERO_KEY_LUM = 0.16;
/** Key glint peak (F0 = 1); dielectrics see 4% of it, polished metal most. */
export const HERO_SPEC_LUM = 0.3;
/** Cool sky top-up for dielectrics — small: the HemisphereLight already fills. */
export const HERO_FILL_LUM = 0.05;
/** Moon rim (fresnel³), brightest on the moon-facing side — ~2.4× the old
 * pre-VO4 rim sheen. */
export const HERO_RIM_LUM = 0.18;
/** Fake environment reflection for metals: there is no envMap anywhere, so
 * without it chrome, wires and gold render black between highlights. */
export const HERO_ENV_LUM = 0.22;
/** Lit-body luminance cap (scene rig + hero), under the 0.72 bloom threshold. */
export const HERO_BODY_CAP = 0.68;
/** Exhaust-ring glow (radial cylinders): over the bloom threshold so it glows,
 * under EMISSIVE_EXHAUST so the exhaust point stays the hottest thing. */
export const EXHAUST_RING_LUM = 0.82;

const HERO_KEY_COLOR = new THREE.Color(1.0, 0.82, 0.62);
const HERO_FILL_COLOR = new THREE.Color(0.55, 0.66, 1.0);
const HERO_RIM_COLOR = new THREE.Color(DUSK.moon);
const HERO_ENV_SKY = new THREE.Color(DUSK.hemiSky);
const HERO_ENV_GROUND = new THREE.Color(DUSK.hemiGround);
const EXHAUST_RING_COLOR = new THREE.Color(1.0, 0.42, 0.12);

const boosted = (c: THREE.Color, lum: number): THREE.Color =>
  c.clone().multiplyScalar(emissiveBoost(c, lum));

/** Pre-cap upper bound of the hero add on a white, fully-lit, F=1 surface. */
export function heroPeakLuminance(): number {
  return (
    HERO_KEY_LUM + HERO_SPEC_LUM + HERO_FILL_LUM + HERO_RIM_LUM + HERO_ENV_LUM
  );
}

const glF = (n: number): string => n.toFixed(5);
const glV = (c: { r: number; g: number; b: number }): string =>
  `vec3(${glF(c.r)}, ${glF(c.g)}, ${glF(c.b)})`;
const glDir = (v: THREE.Vector3): string =>
  `vec3(${glF(v.x)}, ${glF(v.y)}, ${glF(v.z)})`;

// The env pair shares ONE boost (the sky's), keeping its sky:ground ratio;
// the ground colour is the dimmer of the two, so the sky sets the peak.
const envBoost = emissiveBoost(HERO_ENV_SKY, HERO_ENV_LUM);

/** Injected after <emissivemap_fragment>: only names declared by then. */
function heroTerms(exhaust: boolean): string {
  return `
vec3 abHero = vec3(0.0);
vec3 abExhaust = vec3(0.0);
{
  vec3 abN = normalize(normal);
  vec3 abV = normalize(vViewPosition);
  vec3 abUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 abMoon = normalize((viewMatrix * vec4(${glDir(MOON_DIR)}, 0.0)).xyz);
  vec3 abK = ${glDir(HERO_KEY_DIR)};
  vec3 abAlbedo = diffuseColor.rgb;
  float abMetal = metalnessFactor;
  vec3 abF0 = mix(vec3(0.04), abAlbedo, abMetal);
  float abNK = dot(abN, abK);
  abHero += ${glV(boosted(HERO_KEY_COLOR, HERO_KEY_LUM))} * abAlbedo * (1.0 - abMetal)
    * saturate((abNK + ${glF(HERO_KEY_WRAP)}) / ${glF(1 + HERO_KEY_WRAP)});
  float abA = max(roughnessFactor, ${glF(HERO_SPEC_MIN_ROUGHNESS)});
  abA *= abA;
  float abShine = clamp(2.0 / (abA * abA) - 2.0, 4.0, 256.0);
  abHero += ${glV(boosted(HERO_KEY_COLOR, HERO_SPEC_LUM))} * abF0 * step(0.0, abNK)
    * pow(saturate(dot(abN, normalize(abK + abV))), abShine);
  abHero += ${glV(boosted(HERO_FILL_COLOR, HERO_FILL_LUM))} * abAlbedo * (1.0 - abMetal)
    * (0.5 + 0.5 * dot(abN, abUp));
  float abSkyward = saturate(dot(reflect(-abV, abN), abUp) * 0.5 + 0.5);
  abHero += abMetal * abF0 * mix(${glV(HERO_ENV_GROUND.clone().multiplyScalar(envBoost))},
    ${glV(HERO_ENV_SKY.clone().multiplyScalar(envBoost))}, abSkyward);
  abHero += ${glV(boosted(HERO_RIM_COLOR, HERO_RIM_LUM))}
    * pow(1.0 - saturate(dot(abN, abV)), 3.0)
    * (0.35 + 0.65 * saturate(dot(abN, abMoon) * 0.5 + 0.5));
${
  exhaust
    ? `  abExhaust = ${glV(boosted(EXHAUST_RING_COLOR, EXHAUST_RING_LUM))}
    * (0.75 + 0.25 * saturate(dot(abN, abV)));`
    : ""
}
}`;
}

const EMISSIVE_TARGET = "#include <emissivemap_fragment>";
const OUTGOING_TARGET =
  "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;";
/** Lit body capped below bloom; shimmer/reveal and the exhaust ride on top. */
const OUTGOING_CAPPED = `vec3 abLit = totalDiffuse + totalSpecular + abHero;
abLit *= min(1.0, ${glF(HERO_BODY_CAP)} / max(luminance(abLit), 1e-4));
vec3 outgoingLight = abLit + totalEmissiveRadiance + abExhaust;`;

let patchMissReported = false;

/** The fragment rewrite for one variant (exported for one-off checks). */
export function patchHeroFragment(fragment: string, exhaust: boolean): string {
  if (
    !fragment.includes(EMISSIVE_TARGET) ||
    !fragment.includes(OUTGOING_TARGET)
  ) {
    if (!patchMissReported) {
      patchMissReported = true;
      console.error(
        "plane hero light: shader targets missing (three upgrade?)",
      );
    }
    return fragment;
  }
  return fragment
    .replace(EMISSIVE_TARGET, `${EMISSIVE_TARGET}\n${heroTerms(exhaust)}`)
    .replace(OUTGOING_TARGET, OUTGOING_CAPPED);
}

export const HERO_CACHE_KEY = "ab-plane-hero";
export const HERO_EXHAUST_CACHE_KEY = "ab-plane-hero-exhaust";

/**
 * Patch every material under a plane group with the hero light. The biplane
 * nests groups (LOD levels, hinges), so traverse; materials are per-plane
 * (createBiplane builds fresh ones — only the merged GEOMETRY is shared), so
 * patching never leaks. Transparent glass is skipped — a key
 * light would wash the windscreen white. Materials flagged
 * `userData.exhaustGlow` (the radial engine) also get the exhaust ring.
 */
export function applyHeroLight(plane: THREE.Group): void {
  plane.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const material = child.material as THREE.MeshStandardMaterial;
    if (material.transparent) return;
    const exhaust = material.userData.exhaustGlow === true;
    material.customProgramCacheKey = () =>
      exhaust ? HERO_EXHAUST_CACHE_KEY : HERO_CACHE_KEY;
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = patchHeroFragment(shader.fragmentShader, exhaust);
    };
  });
}
