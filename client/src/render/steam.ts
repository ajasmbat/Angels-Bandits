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
//
// D8: a roof vent stands on its building's deck; a felled or chewed-off roof
// stops steaming (decorStands of the vent's stack, cached per damage
// version) until the rebuild. Street vents are not on a building.
//
// Stormlit L5 (white plumes, like the reference's rooftops):
//  - Roof plumes are big, white and tall (ROOF_RISE, ROOF_SCALE), from more
//    roofs, taller ones included, and are seen from much higher up than the
//    street life (steamRoofGate) — street vents keep the micro gate.
//  - They DRIFT WITH THE WIND: a puff is carried by airDrift(now) −
//    airDrift(its birth) — the integrated shared air, so the plume bends
//    and a veer never swings a whole plume at once. Still a pure function of
//    (vent, puff, time). A street vent's plume drifts only along its street.
//  - Per-puff alpha (THREE vertex colours, rgba) fades a puff in at birth
//    and out at the end, replacing the old shrink-to-nothing trick; the tint
//    is sodium-warm near the street and moon-white aloft.
//  - SOFT, NO HARD INTERSECTIONS: there is no depth texture, so the soft-
//    particle fade is analytic — fogbanks.ts's clearance (a puff is gone
//    before its sprite could reach a building box), a lift that keeps each
//    sprite above the surface it rises from, a near-camera fade, and a
//    screen-edge fade (a point is culled whole when its centre leaves the
//    screen; a big one must have faded first). Sprites are capped at
//    MAX_FILL × their view distance.
//  - Still ONE pooled THREE.Points draw; the per-block cap stays in the
//    pure function, so every client steams alike.

import {
  type Building,
  CITY_GRID,
  type LocalBox,
  decorStands,
  mulberry32,
} from "@angels-bandits/common/city";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import { airDrift } from "@angels-bandits/common/wind";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { clearanceAgainst } from "./fogbanks";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";
import { roofDetailsFor } from "./roof-details";
import type { StandingLayer } from "./standing-watch";
import {
  BLOCK_WINDOW_RADIUS,
  type BlockIndex,
  GUTTER_LINE,
  type RingPoint,
  TAG_STEAM,
  blockStream,
  blockWindowInto,
  pruneBlockCache,
  ringPerimeter,
  ringPointInto,
} from "./streetlife";
import { nearestImageInto, uploadPrefix } from "./wrapPlacement";

/** Hard per-block vent budget — enforced in the pure function (see header). */
export const MAX_VENTS_PER_BLOCK = 6;
/** Puffs alive per vent at any instant. */
export const PUFFS_PER_VENT = 6;
/** Most gutter vents a block can roll. */
const MAX_STREET_VENTS = 3;
/** L5: roofs up to this tall steam (the plumes read from above now). */
const ROOF_VENT_MAX_HEIGHT = 160;
/** Chance a roof's unit vents steam. */
const ROOF_VENT_CHANCE = 0.45;
/** L5 roof plume: its climb over one life, m, and its size multiplier. */
const ROOF_RISE = 20;
const ROOF_SCALE = 2;
/** Share of the shared air's drift a puff takes. */
const STEAM_DRIFT = 0.8;
/** Alpha over a life: in over the first share, out from this one. */
const FADE_IN = 0.12;
const FADE_OUT = 0.6;
/** The clearance fade's soft band, m. */
const STEAM_PART_SOFT = 2;
/** A vent's neighbours (for the clearance) lie within this of it, m. */
const NEIGHBOUR_REACH = 45;
/** Widest a sprite is drawn, as a share of its view distance. */
const MAX_FILL = 0.35;
/** Seconds a puff takes to travel its full rise. */
const PUFF_LIFE = 5.5;
/** How far a street plume climbs over its life, meters. */
const STREET_RISE = 9;
/** Lateral wander over the rise, meters. */
const STREET_SPREAD = 1.6;
/** Sprite size band, meters. */
const PUFF_SIZE = 3.4;

/** D8: each roof vent's building (kept off the vent itself, which is plain
 * serialisable layout). */
const ventOwner = new WeakMap<SteamVent, Building>();

/**
 * Building `b`'s roof vent, or null. A pure function of the building: its
 * own stream, anchored on the stack R2's roof dressing actually draws.
 */
export function roofVentFor(b: Building): SteamVent | null {
  if (b.height > ROOF_VENT_MAX_HEIGHT) return null;
  // Per-building stream, not the block stream: a building's roof must not
  // depend on how many buildings the generator happened to emit before it.
  const rr = mulberry32(
    (Math.imul(Math.round(b.x) + 1024, 73856093) ^
      Math.imul(Math.round(b.z) + 1024, 19349663)) >>>
      0,
  );
  if (rr() > ROOF_VENT_CHANCE) return null;
  // Anchor on a stack that is actually DRAWN, so steam never rises out of
  // bare roof deck — R2's roof dressing puts an exhaust stack on the first
  // HVAC unit of every roof (roofDetailsFor().vents).
  const stack = roofDetailsFor(b).vents[0];
  if (!stack) return null;
  const vent: SteamVent = {
    x: stack.x,
    z: stack.z,
    y: stack.y,
    rise: ROOF_RISE,
    spread: STREET_SPREAD * 1.5,
    phase: rr(),
    roof: true,
    scale: ROOF_SCALE,
  };
  ventOwner.set(vent, b);
  return vent;
}

/** D8: a roof vent's stack, from the deck up, in its building's frame. */
export function roofVentBox(b: Building, vent: SteamVent): LocalBox {
  const x = wrapDeltaAxis(b.x, vent.x);
  const z = wrapDeltaAxis(b.z, vent.z);
  return {
    x0: x - 0.3,
    x1: x + 0.3,
    y0: b.height,
    y1: vent.y,
    z0: z - 0.3,
    z1: z + 0.3,
  };
}

/** D8: the steam StandingLayer — each building's roof vent (if it rolled
 * one; the per-block cap may still drop it, never add one). */
export function steamStandingLayer(
  buildings: readonly Building[],
): StandingLayer {
  return {
    boxes(index: number): readonly LocalBox[] {
      const b = buildings[index];
      const vent = b ? roofVentFor(b) : null;
      return b && vent ? [roofVentBox(b, vent)] : [];
    },
  };
}

/** D8: each roof vent's last verdict and the damage version it was taken at. */
const ventVerdict = new WeakMap<SteamVent, { version: number; ok: boolean }>();

/** Does roof vent `vent` still have a deck to steam from? O(1) a frame: the
 * verdict is re-taken only when its building's damage version moves. */
function ventStands(vent: SteamVent): boolean {
  const b = ventOwner.get(vent);
  if (!b) return true;
  const version = b.damage?.version ?? 0;
  let v = ventVerdict.get(vent);
  if (!v) {
    v = { version: Number.NaN, ok: true };
    ventVerdict.set(vent, v);
  }
  if (v.version !== version) {
    v.version = version;
    v.ok = decorStands(b, roofVentBox(b, vent));
  }
  return v.ok;
}

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
  /** Puff size multiplier (G1 food carts are small, close plumes); 1 if absent. */
  scale?: number;
  /** L5: a street vent's street direction (unit): its plume drifts only
   * along it. Absent: the full wind. */
  tx?: number;
  tz?: number;
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
      tx: scratch.dx,
      tz: scratch.dz,
    });
  }

  const roof: SteamVent[] = [];
  for (const b of blockBuildings) {
    const vent = roofVentFor(b);
    if (vent) roof.push(vent);
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
  /** L5: the life's alpha, 0..1 (in at birth, out at the end). */
  alpha: number;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** airDrift scratch (module level: the pose stays allocation-free). */
const driftNow = { x: 0, z: 0 };
const driftBirth = { x: 0, z: 0 };

/** Server ms at which life `n` of puff `j` of `vent` was born. */
const birthMs = (vent: SteamVent, j: number, n: number): number =>
  (n - vent.phase - j / PUFFS_PER_VENT) * PUFF_LIFE * 1000;

/**
 * L5: the renderer's memo of the air's drift — "now" once per frame, each
 * puff's birth once per life. The same values puffPoseInto computes without
 * it (a pure function either way), at ~1/300 of the airDrift calls.
 */
export class SteamDriftMemo {
  private nowS = Number.NaN;
  private readonly now = { x: 0, z: 0 };
  private readonly births = new WeakMap<SteamVent, Float64Array>();
  private readonly out = { x: 0, z: 0 };

  nowAt(timeSeconds: number): { x: number; z: number } {
    if (timeSeconds !== this.nowS) {
      this.nowS = timeSeconds;
      airDrift(timeSeconds * 1000, this.now);
    }
    return this.now;
  }

  birthOf(vent: SteamVent, j: number, n: number): { x: number; z: number } {
    let b = this.births.get(vent);
    if (!b) {
      b = new Float64Array(PUFFS_PER_VENT * 3).fill(Number.NaN);
      this.births.set(vent, b);
    }
    if (b[j * 3] !== n) {
      airDrift(birthMs(vent, j, n), this.out);
      b[j * 3] = n;
      b[j * 3 + 1] = this.out.x;
      b[j * 3 + 2] = this.out.z;
    }
    this.out.x = b[j * 3 + 1] as number;
    this.out.z = b[j * 3 + 2] as number;
    return this.out;
  }
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
  memo?: SteamDriftMemo,
): PuffPose {
  // JS `%` (this never enters a shader — there is no `frac` in this repo).
  const cyc = timeSeconds / PUFF_LIFE + vent.phase + j / PUFFS_PER_VENT;
  let age = cyc % 1;
  if (age < 0) age += 1;
  const sway = Math.sin(age * 3.1 + vent.phase * 6.3) * vent.spread * age;
  // L5: carried by the shared air since this puff's birth (integrated, so
  // pure and smooth); a street plume only along its street.
  // A puff's birth is fixed for its whole life (life number `n`), so the
  // renderer memoises it: one airDrift per puff per life, one per frame.
  const n = Math.floor(cyc);
  const now = memo
    ? memo.nowAt(timeSeconds)
    : airDrift(timeSeconds * 1000, driftNow);
  const birth = memo
    ? memo.birthOf(vent, j, n)
    : airDrift(birthMs(vent, j, n), driftBirth);
  let wx = wrapDeltaAxis(birth.x, now.x) * STEAM_DRIFT;
  let wz = wrapDeltaAxis(birth.z, now.z) * STEAM_DRIFT;
  if (vent.tx !== undefined && vent.tz !== undefined) {
    const a = wx * vent.tx + wz * vent.tz;
    wx = a * vent.tx;
    wz = a * vent.tz;
  }
  // Grow while dispersing (monotonic: the alpha does the fading now).
  out.size = PUFF_SIZE * (vent.scale ?? 1) * (0.45 + age * 2.1);
  out.pos.x = vent.x + sway + wx;
  // Lifted so the sprite never dips into the surface it rises from (and
  // never past the top of the rise).
  out.pos.y =
    vent.y + Math.max(age * vent.rise, Math.min(0.5 * out.size, vent.rise));
  out.pos.z = vent.z + sway * 0.6 + wz;
  out.age = age;
  out.alpha = smooth(0, FADE_IN, age) * (1 - smooth(FADE_OUT, 1, age));
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
    alpha: 0,
  });

/** L5: roof plumes read from far higher than the street life — full to
 * 300 m of camera height, gone by 460 m. */
export function steamRoofGate(cameraY: number): number {
  return 1 - smooth(300, 460, cameraY);
}

// --- Renderer -------------------------------------------------------------

/** Steam is lit by the city, not self-lit (L5: whiter, denser). Linear rgb
 * per puff: moon-white aloft, sodium-warm low over the street. */
const STEAM_WHITE = [0.86, 0.9, 0.96] as const;
const STEAM_WARM = [1.0, 0.74, 0.5] as const;
const STEAM_OPACITY = 0.42;

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
  private readonly extraVents?: (
    bx: number,
    bz: number,
  ) => readonly SteamVent[];
  private readonly positions: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  /** L5: per-puff tint (rgb) and alpha (a) — THREE's rgba vertex colours. */
  private readonly colors: THREE.BufferAttribute;
  private readonly material: THREE.PointsMaterial;
  private readonly pose: PuffPose = {
    pos: { x: 0, y: 0, z: 0 },
    age: 0,
    size: 0,
    alpha: 0,
  };
  /** L5: each vent's neighbouring buildings (its clearance boxes). */
  private readonly neighbours = new WeakMap<SteamVent, Building[]>();
  private readonly tests = { tests: 0 };
  private readonly memo = new SteamDriftMemo();
  private drawn = 0;
  /** M3 quality tier: every Nth puff of a vent is drawn (1 = all). */
  private puffStride = 1;
  /** M3 quality tier: block-window radius (the budget stays sized for the max). */
  private radius = BLOCK_WINDOW_RADIUS;

  /**
   * `extraVents` (G1): vents another system owns — food-cart steam from
   * street-furniture.ts — appended AFTER this block's capped list. They do
   * not count against MAX_VENTS_PER_BLOCK; the provider caps its own at
   * `extraPerBlock` in its pure layout, and the buffer grows by exactly that.
   */
  constructor(
    buildingsByBlock: Map<number, Building[]>,
    seed: number,
    extraVents?: (bx: number, bz: number) => readonly SteamVent[],
    extraPerBlock = 0,
  ) {
    this.seed = seed;
    this.buildingsByBlock = buildingsByBlock;
    this.extraVents = extraVents;
    const budget =
      (2 * BLOCK_WINDOW_RADIUS + 1) ** 2 *
      (MAX_VENTS_PER_BLOCK + extraPerBlock) *
      PUFFS_PER_VENT;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(budget), 1);
    this.colors = new THREE.BufferAttribute(new Float32Array(budget * 4), 4);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("aSize", this.sizes);
    geometry.setAttribute("color", this.colors);
    geometry.setDrawRange(0, 0);
    this.material = new THREE.PointsMaterial({
      color: 0xffffff,
      vertexColors: true, // rgba: the tint and the life's alpha
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
          "attribute float aSize;\nvarying float vAbFade;\n#include <common>",
        )
        // L5: the size in metres, capped at MAX_FILL × the view distance,
        // then to pixels (scale = half the buffer height), clamped so a puff
        // under the camera cannot ask for a thousand-pixel sprite. Then the
        // soft fades: near the lens, and before the centre leaves the screen
        // (a point is culled whole when it does).
        .replace(
          "#include <logdepthbuf_vertex>",
          `float abD = max(-mvPosition.z, 1e-3);
gl_PointSize = clamp(min(aSize, ${MAX_FILL.toFixed(2)} * abD) * scale / abD, 1.0, 420.0);
vec2 abNdc = gl_Position.xy / max(gl_Position.w, 1e-3);
vAbFade = smoothstep(3.0, 3.0 + aSize, abD)
  * (1.0 - smoothstep(0.85, 1.0, max(abs(abNdc.x), abs(abNdc.y))));
#include <logdepthbuf_vertex>`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "varying float vAbFade;\n#include <common>",
        )
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.a *= vAbFade;",
        );
    };
    // Distinct key — onBeforeCompile patches silently collide without one.
    this.material.customProgramCacheKey = () => "ab-steam-l5";
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = RENDER_ORDER.steam;
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
      // G1: the one append point for other systems' vents (food carts).
      if (this.extraVents) vents = [...vents, ...this.extraVents(bx, bz)];
      this.byBlock.set(key, vents);
    }
    return vents;
  }

  /** O5: the block window and a vent's position and torus image, reused
   * every frame (no per-vent objects). */
  private readonly ventAt: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly ventImage: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly windowScratch: BlockIndex[] = [];

  /** L5: the buildings near `vent` (3×3 blocks, within NEIGHBOUR_REACH of
   * it) — the boxes its puffs keep clear of. Cached per vent. */
  private neighboursOf(vent: SteamVent): Building[] {
    let list = this.neighbours.get(vent);
    if (list) return list;
    list = [];
    const bx0 = Math.floor(vent.x / BLOCK_PITCH);
    const bz0 = Math.floor(vent.z / BLOCK_PITCH);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const bx = (((bx0 + i) % CITY_GRID) + CITY_GRID) % CITY_GRID;
        const bz = (((bz0 + j) % CITY_GRID) + CITY_GRID) % CITY_GRID;
        for (const b of this.buildingsByBlock.get(bx * 1000 + bz) ?? []) {
          const ex = Math.abs(wrapDeltaAxis(b.x, vent.x)) - b.width / 2;
          const ez = Math.abs(wrapDeltaAxis(b.z, vent.z)) - b.depth / 2;
          if (ex < NEIGHBOUR_REACH && ez < NEIGHBOUR_REACH) list.push(b);
        }
      }
    }
    this.neighbours.set(vent, list);
    return list;
  }

  /** Phase-only, so a missing clock falls back to local time (the signage
   * policy): a plume in the wrong part of its cycle is invisible, where
   * hiding every vent until the first snapshot would not be. `gate` is the
   * street life's altitude gate (street vents); `roofGate` (L5) the roof
   * plumes' own, far higher one (steamRoofGate). */
  update(cameraPos: Vec3, timeMs: number, gate: number, roofGate = gate): void {
    this.tests.tests = 0;
    if (gate <= 0 && roofGate <= 0) {
      this.points.visible = false;
      this.drawn = 0;
      return;
    }
    this.points.visible = true;
    const t = timeMs / 1000;
    const colors = this.colors.array as Float32Array;
    let i = 0;
    // P3: keep the cache to last frame's window (about to be refilled).
    pruneBlockCache(this.byBlock, this.windowScratch);
    for (const { bx, bz } of blockWindowInto(
      cameraPos,
      this.radius,
      this.windowScratch,
    )) {
      for (const vent of this.ventsFor(bx, bz)) {
        const k = vent.roof ? roofGate : gate;
        if (k <= 0) continue;
        if (vent.roof && !ventStands(vent)) continue; // D8: roof gone
        this.ventAt.x = vent.x;
        this.ventAt.z = vent.z;
        const base = nearestImageInto(this.ventImage, cameraPos, this.ventAt);
        const near = this.neighboursOf(vent);
        for (let j = 0; j < PUFFS_PER_VENT; j += this.puffStride) {
          const pose = puffPoseInto(vent, j, t, this.pose, this.memo);
          if (pose.alpha <= 0.002) continue;
          // Soft: gone before the sprite could reach a building box.
          const clear = clearanceAgainst(
            near,
            pose.pos.x,
            pose.pos.y,
            pose.pos.z,
            pose.size / 2,
            STEAM_PART_SOFT,
            this.tests,
          );
          const alpha = pose.alpha * k * clear;
          if (alpha <= 0.002) continue;
          this.positions.setXYZ(
            i,
            base.x + (pose.pos.x - vent.x),
            pose.pos.y,
            base.z + (pose.pos.z - vent.z),
          );
          this.sizes.setX(i, pose.size);
          // Sodium-warm low over the street, moon-white aloft.
          const warm = 1 - smooth(3, 14, pose.pos.y);
          colors[i * 4] =
            STEAM_WHITE[0] + (STEAM_WARM[0] - STEAM_WHITE[0]) * warm;
          colors[i * 4 + 1] =
            STEAM_WHITE[1] + (STEAM_WARM[1] - STEAM_WHITE[1]) * warm;
          colors[i * 4 + 2] =
            STEAM_WHITE[2] + (STEAM_WARM[2] - STEAM_WHITE[2]) * warm;
          colors[i * 4 + 3] = alpha;
          i++;
        }
      }
    }
    this.drawn = i;
    this.points.geometry.setDrawRange(0, i);
    uploadPrefix([this.positions, this.sizes, this.colors], i);
  }

  /** M3: the tier's share of each vent's puffs, and how far out it streams.
   * Counts only — the buffer and the material are untouched (O3 rule 1). */
  setQuality(tier: QualityTier): void {
    const p = QUALITY_PROFILES[tier];
    this.puffStride = Math.max(
      1,
      Math.round(1 / Math.max(p.steamDensity, 0.01)),
    );
    this.radius = Math.min(BLOCK_WINDOW_RADIUS, p.microRadius);
  }

  /** Puffs drawn last frame (perf + the altitude-gate acceptance check). */
  get count(): number {
    return this.drawn;
  }

  /** L5: building boxes the clearance fade tested last frame (perf). */
  get boxTests(): number {
    return this.tests.tests;
  }
}
