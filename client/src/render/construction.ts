// L1 construction sparks: intermittent night welding on the pavement of a few
// blocks. Client-only, non-collidable, altitude-gated. Both the site list and
// each spark's ballistic arc are pure functions of (seed, time) — no emitter,
// no particle pool, no per-frame state.
//
// ONE SOURCE OF TRUTH FOR WHERE THE CITY IS BEING BUILT. The L2 macro tier
// (ANGE-1PVSJE) landed `CONSTRUCTION_BLOCKS` in common/src/city/layout.ts and
// stands its tower cranes on exactly those blocks, so the welders read the
// SAME list rather than rolling a second, disagreeing one. The result is a
// crane overhead and night street works at its foot; a private 7 % roll here
// would have scattered welders across blocks with no crane on them.

import {
  CITY_GRID,
  CONSTRUCTION_BLOCKS,
  mulberry32,
} from "@angels-bandits/common/city";
import { EMISSIVE_BEACON } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import {
  BLOCK_WINDOW_RADIUS,
  PED_BAND_MAX,
  PED_BAND_MIN,
  type RingPoint,
  TAG_CONSTRUCTION,
  blockOf,
  blockStream,
  ringPerimeter,
  ringPointInto,
} from "./streetlife";
import { nearestImage } from "./wrapPlacement";

/** Welders per construction block — a small night crew, not a work camp. */
const WELDERS_PER_BLOCK = 2;
/** Burst repeat period band, seconds. */
const PERIOD_MIN = 3;
const PERIOD_SPAN = 4;
/** Fraction of the period the arc is struck. */
export const BURST_DUTY = 0.12;
/** Ballistic sparks thrown per burst. */
export const SPARKS_PER_BURST = 20;
/** Welder's torch height above the pavement, meters. */
const TORCH_HEIGHT = 3.4;
/** Gravity for the ballistic arcs, m/s². */
const GRAVITY = 9.8;

/** One welding site: a fixed point on a block's sidewalk ring. */
export interface ConstructionSite {
  bx: number;
  bz: number;
  /** Canonical torch position. */
  x: number;
  y: number;
  z: number;
  /** Seconds between bursts. */
  period: number;
  /** Phase offset in [0, 1) so sites never strike together. */
  phase: number;
}

/** Wrapped block-index distance along one axis (the city is a torus). */
const blockDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % CITY_GRID;
  return Math.min(d, CITY_GRID - d);
};

/**
 * Every welding site in the city: WELDERS_PER_BLOCK crews on each of the
 * shared CONSTRUCTION_BLOCKS, deterministic from the seed alone.
 *
 * The list is built and ordered HERE, not at draw time. A renderer-side cap
 * or filter would drop sites in window-iteration order, i.e. by camera
 * position, and two tabs would then see different sites — the same class of
 * bug the steam vent cap exists to prevent.
 *
 * The welder stands in the middle of the pedestrian band, so night street
 * works read as being on the pavement, under the L2 crane on the same block.
 */
export function constructionSites(seed: number): ConstructionSite[] {
  const sites: ConstructionSite[] = [];
  const scratch: RingPoint = { x: 0, z: 0, dx: 0, dz: 0 };
  const d = (PED_BAND_MIN + PED_BAND_MAX) / 2;
  const perimeter = ringPerimeter(d);
  for (const [bx, bz] of CONSTRUCTION_BLOCKS) {
    const rand = blockStream(seed, bx, bz, TAG_CONSTRUCTION);
    for (let i = 0; i < WELDERS_PER_BLOCK; i++) {
      // Crews are spread around the ring rather than clustered: the i/N stride
      // keeps two welders on the same block from standing on each other.
      const station = (rand() + i / WELDERS_PER_BLOCK) % 1;
      ringPointInto(bx, bz, d, station * perimeter, scratch);
      sites.push({
        bx,
        bz,
        x: scratch.x,
        y: TORCH_HEIGHT,
        z: scratch.z,
        period: PERIOD_MIN + rand() * PERIOD_SPAN,
        phase: rand(),
      });
    }
  }
  return sites;
}

/** Whether a site's arc is struck right now, and how far into the burst. */
export interface SparkBurst {
  active: boolean;
  /** Seconds since the arc struck; 0 when inactive. */
  age: number;
}

/** Is `site` welding at server time `timeSeconds`? Pure, stateless. */
export function sparkBurst(
  site: ConstructionSite,
  timeSeconds: number,
): SparkBurst {
  let cycle = (timeSeconds / site.period + site.phase) % 1;
  if (cycle < 0) cycle += 1;
  if (cycle >= BURST_DUTY) return { active: false, age: 0 };
  return { active: true, age: cycle * site.period };
}

/** One spark's position and how far through its own life it is. */
export interface SparkPose {
  pos: Vec3;
  /** 0 at the arc, 1 when it dies. */
  life: number;
}

/**
 * Spark `i` of `site`'s current burst, `age` seconds after the arc struck.
 * `p = p0 + v·age − ½g·age²` with a seeded direction per index — deterministic,
 * so two tabs throw the same sparks. `life >= 1` means this spark is already
 * out and the caller should skip it.
 */
export function sparkPoseInto(
  site: ConstructionSite,
  i: number,
  age: number,
  timeSeconds: number,
  out: SparkPose,
): SparkPose {
  // Reseed per BURST, so each strike throws a different fan but every client
  // agrees on which burst is which.
  const burst = Math.floor(timeSeconds / site.period + site.phase);
  const rand = mulberry32(
    (Math.imul(burst + 1, 2654435761) ^ Math.imul(i + 1, 40503)) >>> 0,
  );
  const angle = rand() * Math.PI * 2;
  const speed = 2.2 + rand() * 5.4;
  const up = 0.35 + rand() * 1.5;
  const lifetime = 0.35 + rand() * 0.5;
  out.pos.x = site.x + Math.cos(angle) * speed * age;
  out.pos.y = Math.max(
    0.05,
    site.y + up * speed * age - 0.5 * GRAVITY * age * age,
  );
  out.pos.z = site.z + Math.sin(angle) * speed * age;
  out.life = age / lifetime;
  return out;
}

/** Allocating form — for tests. */
export const sparkPose = (
  site: ConstructionSite,
  i: number,
  age: number,
  timeSeconds: number,
): SparkPose =>
  sparkPoseInto(site, i, age, timeSeconds, {
    pos: { x: 0, y: 0, z: 0 },
    life: 0,
  });

// --- Renderer -------------------------------------------------------------

/**
 * Welding arcs are the hottest thing on the street — boosted to the BEACON
 * rung, two rungs under EMISSIVE_TRACER, and each flash lasts under a second,
 * so a spark can never compete with a combat read.
 */
const SPARK_COLOR = 0xcfe6ff;
const SPARK_SIZE = 0.55;
const CORE_SIZE = 2.2;

function sparkTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.22, "rgba(255,255,255,0.42)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(canvas);
}

/** Every drawn spark in ONE THREE.Points — one draw call. */
export class ConstructionSparks {
  readonly points: THREE.Points;
  private readonly sites: ConstructionSite[];
  private readonly positions: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  private readonly material: THREE.PointsMaterial;
  private readonly pose: SparkPose = { pos: { x: 0, y: 0, z: 0 }, life: 0 };
  private drawn = 0;

  constructor(seed: number) {
    this.sites = constructionSites(seed);
    // Every site could in principle burst at once; +1 per site for the arc core.
    const budget = Math.max(1, this.sites.length) * (SPARKS_PER_BURST + 1);
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(budget), 1);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("aSize", this.sizes);
    geometry.setDrawRange(0, 0);
    const hot = new THREE.Color(SPARK_COLOR);
    hot.multiplyScalar(emissiveBoost(hot, EMISSIVE_BEACON));
    this.material = new THREE.PointsMaterial({
      color: hot,
      map: sparkTexture(),
      size: 1,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false, // the V1 rule: additive + fog brightens the distant ground
    });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "attribute float aSize;\n#include <common>",
        )
        .replace(
          "gl_PointSize = size;",
          "gl_PointSize = clamp(size * aSize, 1.0, 120.0);",
        );
    };
    this.material.customProgramCacheKey = () => "ab-spark-asize";
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  /** Phase-only, so a missing clock falls back to local time. */
  update(cameraPos: Vec3, timeMs: number, gate: number): void {
    if (gate <= 0) {
      this.points.visible = false;
      this.drawn = 0;
      return;
    }
    this.points.visible = true;
    this.material.opacity = gate;
    const t = timeMs / 1000;
    // Only sites inside the block window are drawn — a welding flash 800 m
    // out is 86 % fogged and would not read anyway. Checked by wrapped block
    // distance rather than by building a Set every frame: there are at most
    // MAX_SITES of them.
    const cam = blockOf(cameraPos);
    let i = 0;
    for (const site of this.sites) {
      if (
        blockDistance(cam.bx, site.bx) > BLOCK_WINDOW_RADIUS ||
        blockDistance(cam.bz, site.bz) > BLOCK_WINDOW_RADIUS
      ) {
        continue;
      }
      const burst = sparkBurst(site, t);
      if (!burst.active) continue;
      const base = nearestImage(cameraPos, { x: site.x, y: 0, z: site.z });
      const shiftX = base.x - site.x;
      const shiftZ = base.z - site.z;
      // The arc core: one bright, fat point at the torch.
      this.positions.setXYZ(i, base.x, site.y, base.z);
      this.sizes.setX(i, CORE_SIZE);
      i++;
      for (let s = 0; s < SPARKS_PER_BURST; s++) {
        sparkPoseInto(site, s, burst.age, t, this.pose);
        if (this.pose.life >= 1) continue;
        this.positions.setXYZ(
          i,
          this.pose.pos.x + shiftX,
          this.pose.pos.y,
          this.pose.pos.z + shiftZ,
        );
        this.sizes.setX(i, SPARK_SIZE * (1 - this.pose.life));
        i++;
      }
    }
    this.drawn = i;
    this.points.geometry.setDrawRange(0, i);
    this.positions.needsUpdate = true;
    this.sizes.needsUpdate = true;
  }

  /** Points drawn last frame. */
  get count(): number {
    return this.drawn;
  }

  /** QA: the site list (the L2 handoff surface, and a determinism check). */
  get siteList(): readonly ConstructionSite[] {
    return this.sites;
  }
}
