// L1 steam: slow plumes off gutter vents and rooftop HVAC. Client-only,
// non-collidable, altitude-gated. Puff position is a pure function of (vent,
// puff index, server time) — no emitter state, nothing to drift, so two tabs
// with synced clocks breathe together.
//
// THE HARD CAP IS PART OF THE SEAM, NOT THE RENDERER. A block can hold up to
// eight buildings under the roof-vent height plus three gutter vents, so a
// budget sized on the average would overflow — and the overflow would be
// dropped by the renderer in WINDOW-ITERATION order, i.e. by where the camera
// happens to be standing. Two tabs would then draw different steam and the
// determinism check would fail by construction. Truncation therefore happens
// inside the pure function, on a stable ordering, so a block's vent list is
// the same on every client wherever anyone stands.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { roofClutterFor } from "./roofclutter";
import {
  BLOCK_WINDOW_RADIUS,
  GUTTER_LINE,
  type RingPoint,
  TAG_STEAM,
  blockStream,
  blockWindow,
  ringPerimeter,
  ringPointInto,
} from "./streetlife";
import { nearestImage } from "./wrapPlacement";

/** Hard per-block vent budget — enforced in the pure function (see header). */
export const MAX_VENTS_PER_BLOCK = 5;
/** Puffs alive per vent at any instant. */
export const PUFFS_PER_VENT = 6;
/** Most gutter vents a block can roll. */
const MAX_STREET_VENTS = 3;
/** Buildings taller than this have roofs you never see from the canyon band. */
const ROOF_VENT_MAX_HEIGHT = 90;
/** Chance a low building's roof unit vents steam. */
const ROOF_VENT_CHANCE = 0.25;
/** Seconds a puff takes to travel its full rise. */
const PUFF_LIFE = 5.5;
/** How far a street plume climbs over its life, meters. */
const STREET_RISE = 9;
/** Lateral wander over the rise, meters. */
const STREET_SPREAD = 1.6;
/** Sprite size band, meters. */
const PUFF_SIZE = 3.4;

/** One steam source: a fixed point that emits PUFFS_PER_VENT puffs forever. */
export interface SteamVent {
  /** Canonical ground position. */
  x: number;
  z: number;
  /** Emitter altitude, meters (0-ish for a gutter, roof height for HVAC). */
  y: number;
  /** Total climb over one puff life, meters. */
  rise: number;
  /** Lateral drift amplitude, meters. */
  spread: number;
  /** Phase offset in [0, 1) so vents never pulse in lockstep. */
  phase: number;
  /** True for rooftop HVAC, false for a gutter grate. */
  roof: boolean;
}

/** Stable per-vent hash — orders roof vents so truncation is camera-independent. */
const ventHash = (x: number, z: number): number =>
  mulberry32(
    (Math.imul(Math.round(x) + 1, 73856093) ^
      Math.imul(Math.round(z) + 1, 19349663)) >>>
      0,
  )();

/**
 * Every steam vent on block (bx, bz), capped at MAX_VENTS_PER_BLOCK.
 * `blockBuildings` is the block's slice of the shared Building[] — the client
 * buckets it once (generateCity returns a flat array and its blockKey is
 * module-private in common/), so the slice is identical on every client.
 */
export function steamVentsForBlock(
  bx: number,
  bz: number,
  blockBuildings: readonly Building[],
  seed: number,
): SteamVent[] {
  const rand = blockStream(seed, bx, bz, TAG_STEAM);
  const street: SteamVent[] = [];
  const nStreet = Math.floor(rand() * (MAX_STREET_VENTS + 1));
  const perimeter = ringPerimeter(GUTTER_LINE);
  const scratch: RingPoint = { x: 0, z: 0, dx: 0, dz: 0 };
  for (let i = 0; i < nStreet; i++) {
    const s = rand() * perimeter;
    const phase = rand();
    ringPointInto(bx, bz, GUTTER_LINE, s, scratch);
    street.push({
      x: scratch.x,
      z: scratch.z,
      y: 0.1,
      rise: STREET_RISE,
      spread: STREET_SPREAD,
      phase,
      roof: false,
    });
  }

  const roof: SteamVent[] = [];
  for (const b of blockBuildings) {
    if (b.height > ROOF_VENT_MAX_HEIGHT) continue;
    // Per-building stream, not the block stream: a building's roof must not
    // depend on how many buildings the generator happened to emit before it.
    const rr = mulberry32(
      (Math.imul(Math.round(b.x) + 1024, 73856093) ^
        Math.imul(Math.round(b.z) + 1024, 19349663)) >>>
        0,
    );
    if (rr() > ROOF_VENT_CHANCE) continue;
    // Anchor on a unit that is actually DRAWN, so steam never rises out of
    // bare roof deck — the roofClutterFor seam already placed these.
    const acBox = roofClutterFor(b).acBoxes[0];
    if (!acBox) continue;
    roof.push({
      x: acBox.x,
      z: acBox.z,
      y: acBox.y + acBox.height,
      rise: STREET_RISE * 0.7,
      spread: STREET_SPREAD * 0.8,
      phase: rr(),
      roof: true,
    });
  }
  // Street vents first (they are the ones a player at 40 m actually reads),
  // then roof vents in stable hash order. Both orderings are pure functions
  // of the world, never of the camera.
  roof.sort((a, c) => ventHash(a.x, a.z) - ventHash(c.x, c.z));
  return [...street, ...roof].slice(0, MAX_VENTS_PER_BLOCK);
}

/** A puff's rendered state. */
export interface PuffPose {
  pos: Vec3;
  /** Normalised age in [0, 1). */
  age: number;
  /** Sprite diameter, meters. */
  size: number;
}

/**
 * Puff `j` of `vent` at server time `timeSeconds`, written into `out`.
 * The puffs of one vent are evenly spread through the life cycle, so a vent
 * reads as a continuous plume rather than a burst.
 */
export function puffPoseInto(
  vent: SteamVent,
  j: number,
  timeSeconds: number,
  out: PuffPose,
): PuffPose {
  // JS `%` (this never enters a shader — there is no `frac` in this repo).
  let age = (timeSeconds / PUFF_LIFE + vent.phase + j / PUFFS_PER_VENT) % 1;
  if (age < 0) age += 1;
  const sway = Math.sin(age * 3.1 + vent.phase * 6.3) * vent.spread * age;
  out.pos.x = vent.x + sway;
  out.pos.y = vent.y + age * vent.rise;
  out.pos.z = vent.z + sway * 0.6;
  out.age = age;
  // Grow while dispersing, then collapse over the last 15 % of life: the
  // smoke.ts trick for faking an alpha fade under a constant-opacity
  // PointsMaterial.
  const grow = PUFF_SIZE * (0.45 + age * 2.1);
  out.size = age > 0.85 ? grow * (1 - (age - 0.85) / 0.15) : grow;
  return out;
}

/** Allocating form — for tests. */
export const puffPose = (
  vent: SteamVent,
  j: number,
  timeSeconds: number,
): PuffPose =>
  puffPoseInto(vent, j, timeSeconds, {
    pos: { x: 0, y: 0, z: 0 },
    age: 0,
    size: 0,
  });

// --- Renderer -------------------------------------------------------------

/** Cool grey-white: steam is lit by the city, not self-lit. */
const STEAM_COLOR = 0xc8cfd6;
const STEAM_OPACITY = 0.28;

/** Soft round puff sprite — a bare PointsMaterial renders hard squares. */
function puffTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.55, "rgba(255,255,255,0.42)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(canvas);
}

/** Every drawn puff in ONE THREE.Points — one draw call. */
export class Steam {
  readonly points: THREE.Points;
  private readonly seed: number;
  private readonly buildingsByBlock: Map<number, Building[]>;
  private readonly byBlock = new Map<number, SteamVent[]>();
  private readonly positions: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  private readonly material: THREE.PointsMaterial;
  private readonly pose: PuffPose = {
    pos: { x: 0, y: 0, z: 0 },
    age: 0,
    size: 0,
  };
  private drawn = 0;

  constructor(buildingsByBlock: Map<number, Building[]>, seed: number) {
    this.seed = seed;
    this.buildingsByBlock = buildingsByBlock;
    const budget =
      (2 * BLOCK_WINDOW_RADIUS + 1) ** 2 * MAX_VENTS_PER_BLOCK * PUFFS_PER_VENT;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(budget), 1);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("aSize", this.sizes);
    geometry.setDrawRange(0, 0);
    this.material = new THREE.PointsMaterial({
      color: STEAM_COLOR,
      map: puffTexture(),
      size: 1, // per-point aSize carries the real size
      transparent: true,
      opacity: STEAM_OPACITY,
      depthWrite: false,
      // NOT additive, and fog ON: steam is grey and must recede with the
      // street it sits on, unlike the additive spark/glow materials.
    });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "attribute float aSize;\n#include <common>",
        )
        // Clamp so a puff directly under the camera cannot ask for a
        // thousand-pixel point sprite.
        .replace(
          "gl_PointSize = size;",
          "gl_PointSize = clamp(size * aSize, 1.0, 420.0);",
        );
    };
    // Distinct key — onBeforeCompile patches silently collide without one.
    this.material.customProgramCacheKey = () => "ab-steam-asize";
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  private ventsFor(bx: number, bz: number): SteamVent[] {
    const key = bx * 1000 + bz;
    let vents = this.byBlock.get(key);
    if (!vents) {
      vents = steamVentsForBlock(
        bx,
        bz,
        this.buildingsByBlock.get(key) ?? [],
        this.seed,
      );
      this.byBlock.set(key, vents);
    }
    return vents;
  }

  /** Phase-only, so a missing clock falls back to local time (the signage
   * policy): a plume in the wrong part of its cycle is invisible, where
   * hiding every vent until the first snapshot would not be. */
  update(cameraPos: Vec3, timeMs: number, gate: number): void {
    if (gate <= 0) {
      this.points.visible = false;
      this.drawn = 0;
      return;
    }
    this.points.visible = true;
    this.material.opacity = STEAM_OPACITY * gate;
    const t = timeMs / 1000;
    let i = 0;
    for (const { bx, bz } of blockWindow(cameraPos)) {
      for (const vent of this.ventsFor(bx, bz)) {
        const base = nearestImage(cameraPos, { x: vent.x, y: 0, z: vent.z });
        for (let j = 0; j < PUFFS_PER_VENT; j++) {
          puffPoseInto(vent, j, t, this.pose);
          this.positions.setXYZ(
            i,
            base.x + (this.pose.pos.x - vent.x),
            this.pose.pos.y,
            base.z + (this.pose.pos.z - vent.z),
          );
          this.sizes.setX(i, this.pose.size);
          i++;
        }
      }
    }
    this.drawn = i;
    this.points.geometry.setDrawRange(0, i);
    this.positions.needsUpdate = true;
    this.sizes.needsUpdate = true;
  }

  /** Puffs drawn last frame (perf + the altitude-gate acceptance check). */
  get count(): number {
    return this.drawn;
  }
}
