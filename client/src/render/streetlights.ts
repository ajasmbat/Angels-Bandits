// Street lamps (V1 lighting pass, repositioned by S1): deterministic emissive
// lamp heads along the street grid, plus a faked warm glow pool under each —
// NO point lights, the night look is emissive + bloom only. Layout is a pure
// function of the block grid (no PRNG): each block owns its west and south
// street LINES and dresses BOTH furniture lines of each (the S1 street
// contract's curbside lamp row, never the roadway), so every street is
// covered exactly once despite the torus wrap.

import { FURNITURE_LINE } from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  EMISSIVE_LAMP,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { nearestImage } from "./wrapPlacement";

/** Lamps per owned street segment, at these fractions along it. */
const LAMP_FRACTIONS = [0.125, 0.5, 0.875] as const;
/** The negative side is staggered by this fraction (5/16, binary-exact) so
 * the two curbside rows never mirror each other across the street. Its
 * stations land at 37.5 / 87.5 / 162.5 m — the same 50/75/75 rhythm, kept
 * clear of block corners so no lamp falls into a CROSSING street's roadway
 * (a naive half-step stagger puts one station 12.5 m from the corner). */
const STAGGER = 0.3125;

/** Lamp stations in meters along a street segment, per side — the ground
 * shader's faked lamp reflections (S1 wet look) anchor to these, so the
 * streaks always sit under the actual lamps. */
export const LAMP_STATIONS_PLUS: readonly number[] = LAMP_FRACTIONS.map(
  (f) => f * BLOCK_PITCH,
);
export const LAMP_STATIONS_MINUS: readonly number[] = LAMP_FRACTIONS.map(
  (f) => ((f + STAGGER) % 1) * BLOCK_PITCH,
);

/** Canonical ground position of one lamp (on a furniture line, y = 0). */
export interface StreetlampPosition {
  x: number;
  z: number;
}

/**
 * Every street lamp in canonical [0, WORLD_SIZE) coords, deterministic from
 * the block grid. Each block contributes its west line (x = bx·PITCH) and its
 * south line (z = bz·PITCH), placing lamps on BOTH of the line's furniture
 * lines (contract: FURNITURE_LINE m off the centerline, 1 m behind the curb);
 * with the torus wrap that tiles all street lines exactly once, corners
 * excluded (fractions never land on 0 or 1).
 */
export function streetlampPositions(): StreetlampPosition[] {
  const grid = WORLD_SIZE / BLOCK_PITCH;
  const canon = (v: number) => canonicalize({ x: v, y: 0, z: 0 }).x;
  const lamps: StreetlampPosition[] = [];
  for (let bx = 0; bx < grid; bx++) {
    for (let bz = 0; bz < grid; bz++) {
      const x0 = bx * BLOCK_PITCH;
      const z0 = bz * BLOCK_PITCH;
      for (let i = 0; i < LAMP_FRACTIONS.length; i++) {
        const along = LAMP_STATIONS_PLUS[i] as number;
        const staggered = LAMP_STATIONS_MINUS[i] as number;
        // West line: a lamp on each furniture line, negative side staggered.
        lamps.push({ x: x0 + FURNITURE_LINE, z: z0 + along });
        lamps.push({ x: canon(x0 - FURNITURE_LINE), z: z0 + staggered });
        // South line: same cross-section, axes swapped.
        lamps.push({ x: x0 + along, z: z0 + FURNITURE_LINE });
        lamps.push({ x: x0 + staggered, z: canon(z0 - FURNITURE_LINE) });
      }
    }
  }
  return lamps;
}

const POLE_HEIGHT = 7;
/** Lamp-head color, boosted to the ladder's LAMP rung so heads read hot to
 * the bloom pass — above the window emissives, below beacons and tracers. */
const LAMP_COLOR = 0xffb35c;
const GLOW_RADIUS = 9;
const GLOW_OPACITY = 0.32;

/** Soft radial falloff for the faked pool of light (same canvas idiom as sky.ts). */
function glowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255, 179, 92, 1)");
    grad.addColorStop(0.4, "rgba(255, 179, 92, 0.35)");
    grad.addColorStop(1, "rgba(255, 179, 92, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The instanced street-lamp renderer: dark poles, emissive heads, and an
 * additive ground-glow quad per lamp (the faked light pool — no depth write,
 * no real lights). Same pattern as CityRenderer: canonical positions from the
 * pure layout above, re-placed every frame at the torus image nearest the
 * camera.
 */
export class Streetlights {
  readonly group = new THREE.Group();
  private readonly lamps: StreetlampPosition[];
  private readonly poles: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly glows: THREE.InstancedMesh;
  private readonly scratch = new THREE.Matrix4();

  constructor() {
    this.lamps = streetlampPositions();
    const n = this.lamps.length;

    const poleGeometry = new THREE.CylinderGeometry(0.1, 0.16, POLE_HEIGHT, 5);
    poleGeometry.translate(0, POLE_HEIGHT / 2, 0); // base on the ground
    this.poles = new THREE.InstancedMesh(
      poleGeometry,
      new THREE.MeshStandardMaterial({ color: 0x1a1a26, roughness: 1 }),
      n,
    );

    const headMaterial = new THREE.MeshBasicMaterial({ color: LAMP_COLOR });
    headMaterial.color.multiplyScalar(
      emissiveBoost(headMaterial.color, EMISSIVE_LAMP),
    );
    this.heads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.45, 8, 6),
      headMaterial,
      n,
    );

    const glowGeometry = new THREE.CircleGeometry(GLOW_RADIUS, 16);
    glowGeometry.rotateX(-Math.PI / 2); // flat on the street
    this.glows = new THREE.InstancedMesh(
      glowGeometry,
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        transparent: true,
        opacity: GLOW_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false, // additive + fog would brighten the distant ground
      }),
      n,
    );

    for (const mesh of [this.poles, this.heads, this.glows]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // instances move relative to the camera every frame
      this.group.add(mesh);
    }
  }

  /** Place every lamp at its torus image nearest the camera. Call per frame. */
  update(cameraPos: Vec3): void {
    this.lamps.forEach((lamp, i) => {
      const p = nearestImage(cameraPos, { x: lamp.x, y: 0, z: lamp.z });
      this.scratch.makeTranslation(p.x, 0, p.z);
      this.poles.setMatrixAt(i, this.scratch);
      this.scratch.makeTranslation(p.x, POLE_HEIGHT, p.z);
      this.heads.setMatrixAt(i, this.scratch);
      // Slightly above the street so the pool never z-fights the ground plane.
      this.scratch.makeTranslation(p.x, 0.2, p.z);
      this.glows.setMatrixAt(i, this.scratch);
    });
    this.poles.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    this.glows.instanceMatrix.needsUpdate = true;
  }

  /**
   * QA hook (seam checks, headless harness): the position the lamp nearest
   * canonical (x, z) is currently DRAWN at, read back from the head's
   * instance matrix — the rendered truth, not a re-derivation.
   */
  imageOf(x: number, z: number): { x: number; z: number } | null {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    this.lamps.forEach((lamp, i) => {
      const d = wrapDelta({ x, y: 0, z }, { x: lamp.x, y: 0, z: lamp.z });
      const dist = d.x * d.x + d.z * d.z;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    if (best < 0) return null;
    this.heads.getMatrixAt(best, this.scratch);
    const e = this.scratch.elements;
    return { x: e[12] as number, z: e[14] as number };
  }
}
