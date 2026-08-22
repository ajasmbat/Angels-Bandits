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
  EMISSIVE_EXHAUST,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_STROBE,
  MAX_SPEED,
  ROOM_CAP,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { QuatLike } from "./trails";

// --- Strobe pattern spec (all clients share it verbatim) ---
/** Full strobe cycle, ms. */
export const STROBE_PERIOD_MS = 1200;
/** One flash pulse, ms. */
export const STROBE_FLASH_MS = 70;
/** Pulse starts within the cycle, ms — the aviation double-flash. */
export const STROBE_FLASH_OFFSETS = [0, 180] as const;

/** FNV-1a over the plane id — a stable, cheap per-plane phase seed. */
export function strobePhaseMs(planeId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < planeId.length; i++) {
    h ^= planeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % STROBE_PERIOD_MS;
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
// Derived from the approved biplane model (model nose +Z, flown inside a
// π-turned parent): upper-wing tips at model x = ±4.5, y = 1.38, z = 0.62;
// tail post at model z ≈ −3.3; cowl at model z ≈ +3.1. The π turn maps
// model (x, z) → game (−x, −z). Do not restyle the model — these are
// attachment offsets only.
export const LIGHT_MOUNTS = {
  /** Red — LEFT wingtip (game −X). */
  navL: { x: -4.5, y: 1.38, z: -0.62 },
  /** Green — RIGHT wingtip (game +X). */
  navR: { x: 4.5, y: 1.38, z: -0.62 },
  /** White — tail post (game +Z is aft). */
  tail: { x: 0, y: 1.2, z: 3.25 },
  /** White anti-collision strobe on the fuselage spine. */
  strobe: { x: 0, y: 0.75, z: 1.7 },
  /** Warm exhaust glow at the cowl (nose is −Z). */
  exhaust: { x: -0.3, y: -0.15, z: -3.0 },
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
   */
  place(
    planeId: string,
    rendered: Vec3,
    quat: QuatLike,
    speed: number,
    syncedTimeMs: number,
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
    scratchColor.copy(exhaustBoost).multiplyScalar(throttle * flicker);
    this.appendColor(
      rendered,
      LIGHT_MOUNTS.exhaust,
      scratchColor,
      EXHAUST_SIZE,
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

// --- Fresnel rim sheen: a faint moonlit edge on the plane materials ---

/** Cool moon tint × strength — peaks ~0.15 luminance, far under the 0.72
 * bloom threshold: a silhouette hint, never a glow source. */
const RIM_GLSL =
  "totalEmissiveRadiance += vec3(0.055, 0.075, 0.13) * " +
  "pow(1.0 - saturate(dot(normalize(vViewPosition), normalize(normal))), 3.0);";

/**
 * Patch every material under a plane group with a view-angle rim term
 * (same onBeforeCompile idiom as buildings-material). The biplane nests
 * groups, so traverse — and materials are per-plane clones, so patching
 * here never leaks to unrelated meshes.
 */
export function applyRimSheen(plane: THREE.Group): void {
  plane.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const material = child.material as THREE.MeshStandardMaterial;
    material.customProgramCacheKey = () => "ab-plane-rim";
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${RIM_GLSL}`,
      );
    };
  });
}
