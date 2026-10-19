// SKY1 Infinite sky: the cosmetic armada, the distant dogfights and the
// flak under them — the COSMETIC layer of the Infinite War's three-layer
// illusion (real → cosmetic → painted). Pure schedules of (seed, synced
// server clock) in the skytraffic idiom: nothing on the wire, no
// Math.random, no per-object CPU work. The renderer (client/src/render/
// sky-armada.ts) evaluates exactly this in its vertex shaders, slot by
// slot (gl_InstanceID), and this file is the CPU mirror its tests pin.
//
// WHERE. Every slot lives on a torus WINDOW round the camera: its
// horizontal position is `base + vel · t` taken mod the window, relative
// to the camera's unwrapped offset (L2's FAR_ORIGIN, a CloudOffset kept mod
// SKY_PERIOD, which both windows divide). The window is wider than twice
// the farthest anything is drawn, so a slot that wraps is invisible on both
// sides of its edge — nothing pops — and no slot is ever seen twice.
//
// WHEN. The synced clock is folded into one loop of SKY_LOOP_S seconds
// before it reaches a shader (float32 cannot hold epoch seconds). Every
// motion closes over the loop: velocities are whole lattice steps
// (window / loop per step), angular rates whole turns per loop and every
// cycle a whole number of cycles per loop — so the fold never jumps.
//
// HOW FAR. Everything is drawn in L2's far shell (just inside the fog
// limit; far-skyline.ts) at its exact screen position, and its visibility
// is exactly 0 nearer than SKY_INNER (> FOG_DISTANCE, past the camera's
// far plane): the cosmetic layer is only ever seen beyond every real
// object of its kind, and can never be flown into. As the camera closes
// on one it dissolves into the haze, as L2's far towers do.
//
// Determinism across clients: (seed, synced time, the unwrapped origin) —
// the origin is the canonical position after any cut, the far skyline's
// own contract.

import { CLOUD_BASE, FOG_DISTANCE, WORLD_SIZE } from "./constants";

/** The unwrapped camera offset's period, m — L2's FAR_PERIOD. */
export const SKY_PERIOD = 32 * WORLD_SIZE;
/** One loop of the cosmetic clock, s. */
export const SKY_LOOP_S = 3600;
/** The ships' torus window, m (divides SKY_PERIOD). */
export const SHIP_WINDOW = 12800;
/** The dogfights' (and their flak's) window, m (divides SKY_PERIOD). */
export const PLANE_WINDOW = 6400;
/** One lattice velocity step, m/s: one window per loop. */
export const SHIP_STEP = SHIP_WINDOW / SKY_LOOP_S;
export const PLANE_STEP = PLANE_WINDOW / SKY_LOOP_S;

/** Most slots any tier draws. */
export const SHIP_SLOTS = 640;
export const GROUP_SLOTS = 120;
export const GROUP_SIZE_MAX = 4;
export const FLAK_SLOTS = 160;

/** Nothing cosmetic is visible nearer than this (true distance), m. */
export const SKY_INNER = 900;
/** Ships: invisible below [0], full by [1] (distance to the hull). */
export const SHIP_FADE_IN = [950, 1500] as const;
/** Planes and their fire: the same, nearer. */
export const PLANE_FADE_IN = [SKY_INNER, 1150] as const;
/** Width of the outer fade below a tier's radius, m. */
export const SKY_OUTER_FADE = 1200;
/** Largest radius on any tier, m — under half of each window, less the
 * reach of anything a slot carries (a hull, a dogfight's curve, a fall). */
export const SHIP_RADIUS_MAX = 5200;
export const PLANE_RADIUS_MAX = 2800;
/** The far haze: peak share of a thing's own colour over the fog, and its
 * e-folding length past the fog limit, m (L2's far city uses 0.7 / 4000). */
export const SKY_VIS = 0.72;
export const SKY_HAZE = 3600;

/** The hull: BOSS_PROFILE (254 m) scaled into [min, min + span]. */
export const SHIP_SCALE_MIN = 0.35;
export const SHIP_SCALE_SPAN = 0.4;
/** BOSS_PROFILE's half length, m (its stations run −128..126). */
export const SHIP_HALF_LEN = 128;
/** Altitude bands (cruise centre, m) of the three parallax layers — all
 * under the cloud deck with the widest hull (21 m × the largest scale).
 * K1: down with the deck and the real fleet — the low layer cruises the
 * far avenues among the far towers, the middle one the far rooftops, the
 * top one just under the storm — so the real fleet's street and rooftop
 * bands (common/src/boss.ts, ≈ 94–396 m) sit inside the armada's. T1: the
 * real fleet now cruises the avenues (86–176 m), orbits and threads among
 * the supertalls (241–355 m) — the layers follow it down among the far
 * towers, which rise past all three into the deck. */
export const SHIP_LAYERS: readonly (readonly [number, number])[] = [
  [100, 180],
  [240, 320],
  [330, CLOUD_BASE - 30],
];
/** Each layer's two drift vectors, in lattice steps: the armada moves as
 * one front, the layers at different speeds (the parallax). */
export const SHIP_DRIFT: readonly (readonly [
  number,
  number,
  number,
  number,
])[] = [
  [3, 1, 2, 1],
  [2, 1, 3, 2],
  [1, 1, 2, 1],
];
/** The burning ships: a cycle per slot, the share that burns in one, when
 * it catches fire (s into the cycle, + up to the span), how long it burns
 * before it falls, its fall acceleration, and how a slot's next ship
 * emerges from the cloud base after a fall (rise, m; fade, s). */
export const SHIP_CYCLE_S = 120;
export const SHIP_BURN_SHARE = 0.07;
export const SHIP_IGNITE_S = 10;
export const SHIP_IGNITE_SPAN_S = 40;
export const SHIP_BURN_HOLD_S = 8;
export const SHIP_FALL_G = 0.9;
export const SHIP_EMERGE_RISE = 70;
export const SHIP_EMERGE_S = 15;
export const SHIP_EMERGE_FADE_S = 8;

/** Dogfights: altitude band, curve radius band, angular rate (whole turns
 * per loop), the chasers' lag along the curve (rad), and bob height. K1:
 * down into the far skyline, under the lowered deck. */
export const GROUP_ALT = [120, CLOUD_BASE - 60] as const;
export const GROUP_R = [90, 200] as const;
export const GROUP_TURNS = [150, 277] as const;
export const GROUP_LAG = 0.42;
export const GROUP_BOB = [15, 50] as const;
/** A dogfight's kill cycle: its length, the share of cycles in which the
 * hunted plane is shot down, when (s, + span), its fall, and how its
 * replacement dives out of the deck in the next cycle. */
export const GROUP_CYCLE_S = 40;
export const GROUP_KILL_SHARE = 0.3;
export const GROUP_HIT_S = 8;
export const GROUP_HIT_SPAN_S = 14;
export const GROUP_FALL_G = 5;
export const GROUP_EMERGE_RISE = 200;
export const GROUP_EMERGE_S = 6;
export const GROUP_EMERGE_FADE_S = 4;
/** Gun bursts: turns per loop of the burst cycle, and the firing share. */
export const GROUP_BURST_TURNS = 1385;
export const GROUP_BURST_SHARE = 0.35;

/** Flak: bursts per loop range, and where a burst sits from its ship. */
export const FLAK_TURNS = [700, 1211] as const;
export const FLAK_SIDE = [60, 220] as const;
export const FLAK_BELOW = [30, 140] as const;

// --- Hash ---------------------------------------------------------------------

/** L2's integer hash (far-skyline abFarHash), GLSL `abSkyHash` line for
 * line: (uint, uint) → uint. */
export function skyHash(x: number, y: number): number {
  const qx = Math.imul(x >>> 0, 1597334673) >>> 0;
  const qy = Math.imul(y >>> 0, 3812015801 | 0) >>> 0;
  let n = Math.imul((qx ^ qy) >>> 0, 1597334673) >>> 0;
  n = (n ^ (n >>> 15)) >>> 0;
  n = Math.imul(n, 2246822519 | 0) >>> 0;
  return (n ^ (n >>> 13)) >>> 0;
}
/** 16 bits of `h` from `shift`, 0..1. */
const u16 = (h: number, shift: number): number =>
  ((h >>> shift) & 0xffff) / 65535;
/** 8 bits of `h` from `shift`, 0..1. */
const u8 = (h: number, shift: number): number => ((h >>> shift) & 0xff) / 255;

/** The seed as the shaders take it: 16 bits (a float uniform is exact). */
export function skySeed(seed: number): number {
  return skyHash(seed >>> 0, 0x534b5931) & 0xffff;
}

/** The synced clock (ms) folded into the loop, s. */
export function skyLoopTime(serverMs: number): number {
  const t = (serverMs / 1000) % SKY_LOOP_S;
  return t < 0 ? t + SKY_LOOP_S : t;
}

const mod = (a: number, m: number): number => ((a % m) + m) % m;
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** `p` relative to the origin `o` on a window of side `w`, in [−w/2, w/2). */
const wrapRel = (p: number, o: number, w: number): number =>
  mod(p - o + w / 2, w) - w / 2;

/**
 * The far haze at true radial distance `d` with the tier's outer radius
 * `outer`: the share of a cosmetic thing's own colour (or light) that shows
 * over the fog. 0 nearer than `fadeIn[0]`, rising to full by `fadeIn[1]`,
 * then thinning exponentially and gone by `outer`. The GLSL `abSkyVis`.
 */
export function skyVis(
  d: number,
  outer: number,
  fadeIn: readonly [number, number],
): number {
  const near = smooth(fadeIn[0], fadeIn[1], d);
  const haze = SKY_VIS * Math.exp(-(d - FOG_DISTANCE) / SKY_HAZE);
  const far = 1 - smooth(outer - SKY_OUTER_FADE, outer, d);
  return near * haze * far;
}

// --- Ships --------------------------------------------------------------------

/** A ship's pose, camera-relative in x/z (m), absolute altitude y (m). */
export interface ShipPose {
  x: number;
  y: number;
  z: number;
  /** Heading in XZ, rad (atan2(vz, vx): the hull's +X along it). */
  yaw: number;
  /** Nose-down pitch while falling, rad (≤ 0). */
  pitch: number;
  /** Hull scale (× BOSS_PROFILE). */
  scale: number;
  /** Fire, 0..1 (0: not burning). */
  burn: number;
  /** The emergence fade after a predecessor's fall, 0..1 (1: none). */
  fade: number;
}

export const newShipPose = (): ShipPose => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  scale: 1,
  burn: 0,
  fade: 1,
});

/** Whether slot `i`'s ship burns in cycle `c` (mod the cycles per loop). */
function shipBurns(h2: number, c: number): number {
  const hb = skyHash(h2, mod(c, SKY_LOOP_S / SHIP_CYCLE_S));
  return u8(hb, 0) < SHIP_BURN_SHARE ? hb : -1;
}

/**
 * Ship slot `i` at loop time `t` (s), relative to the unwrapped origin
 * (ox, oz). The GLSL `abShipPose`, step for step.
 */
export function shipPoseInto(
  seed16: number,
  i: number,
  t: number,
  ox: number,
  oz: number,
  out: ShipPose,
): ShipPose {
  const h0 = skyHash(i, seed16);
  const h1 = skyHash(h0, 0x51a7);
  const h2 = skyHash(h1, 0x2b3d);
  const l = h1 & 3;
  const layer = l === 3 ? 1 : l;
  const band = SHIP_LAYERS[layer] as readonly [number, number];
  const drift = SHIP_DRIFT[layer] as readonly [number, number, number, number];
  const alt = band[0] + u8(h1, 8) * (band[1] - band[0]);
  const v2 = ((h1 >>> 4) & 1) === 1;
  const kx = v2 ? drift[2] : drift[0];
  const kz = v2 ? drift[3] : drift[1];
  // An eighth of each layer flies the front's opposite way (h1 bits 5–7)
  // — the enemy's armada, crossing.
  const sgn = ((h1 >>> 5) & 7) === 0 ? -1 : 1;
  const vx = sgn * kx * SHIP_STEP;
  const vz = sgn * kz * SHIP_STEP;
  out.x = wrapRel(u16(h0, 0) * SHIP_WINDOW + vx * t, ox, SHIP_WINDOW);
  out.z = wrapRel(u16(h0, 16) * SHIP_WINDOW + vz * t, oz, SHIP_WINDOW);
  out.scale = SHIP_SCALE_MIN + SHIP_SCALE_SPAN * u8(h1, 16);
  out.yaw = Math.atan2(vz, vx);
  out.y = alt;
  out.pitch = 0;
  out.burn = 0;
  out.fade = 1;
  // The burn cycle: this cycle's fire and fall, the last one's emergence.
  const ct = t + u8(h2, 0) * SHIP_CYCLE_S;
  const c = Math.floor(ct / SHIP_CYCLE_S);
  const tau = ct - c * SHIP_CYCLE_S;
  const hb = shipBurns(h2, c);
  if (hb >= 0) {
    const ignite = SHIP_IGNITE_S + u8(hb, 8) * SHIP_IGNITE_SPAN_S;
    const s = tau - ignite;
    if (s > 0) {
      out.burn = Math.min(1, s / 3);
      const fall = Math.max(0, s - SHIP_BURN_HOLD_S);
      out.y -= 0.5 * SHIP_FALL_G * fall * fall;
      out.pitch = -Math.min(0.02 * fall, 0.5);
    }
  }
  if (shipBurns(h2, c - 1) >= 0) {
    out.y += SHIP_EMERGE_RISE * (1 - smooth(0, SHIP_EMERGE_S, tau));
    out.fade = smooth(0, SHIP_EMERGE_FADE_S, tau);
  }
  return out;
}

/** The ship's visibility: the far haze by the distance to its hull, the
 * emergence fade. From the camera at height `camY` (rel x/z in the pose). */
export function shipVis(p: ShipPose, camY: number, outer: number): number {
  const d = Math.hypot(p.x, p.y - camY, p.z);
  const dn = Math.max(d - SHIP_HALF_LEN * p.scale, 0);
  // A fallen hull is gone once it is under the street (the far city's
  // carpet hides it there anyway).
  if (p.y + 30 * p.scale < 0) return 0;
  return skyVis(dn, outer, SHIP_FADE_IN) * p.fade;
}

// --- Dogfights ----------------------------------------------------------------

/** One plane of a dogfight: camera-relative x/z, absolute y (m). */
export interface PlanePose {
  x: number;
  y: number;
  z: number;
  /** Velocity direction (unit), for the nose, the tracers and the smoke. */
  dx: number;
  dy: number;
  dz: number;
  /** Bank, rad (+: right wing down). */
  bank: number;
  /** Whether this member is in the group (the group has 2..4). */
  present: boolean;
  /** Fire, 0..1 (the hunted plane, shot down). */
  burn: number;
  /** Seconds since it was hit (< 0: not hit this cycle). */
  hitAge: number;
  /** Emergence fade after a predecessor's fall, 0..1. */
  fade: number;
  /** Whether it is firing now (chasers, while the hunted one flies). */
  firing: boolean;
}

export const newPlanePose = (): PlanePose => ({
  x: 0,
  y: 0,
  z: 0,
  dx: 1,
  dy: 0,
  dz: 0,
  bank: 0,
  present: false,
  burn: 0,
  hitAge: -1,
  fade: 1,
  firing: false,
});

/** The kill hash of group cycle `c`, or −1 when nobody is shot down. */
function groupKill(h2: number, c: number): number {
  const hb = skyHash(h2 ^ 0x6b11, mod(c, SKY_LOOP_S / GROUP_CYCLE_S));
  return u8(hb, 0) < GROUP_KILL_SHARE ? hb : -1;
}

const TAU = Math.PI * 2;

/** Curve position (x, z) and its θ-derivatives for kind `k` (0 circle,
 * 1 figure-eight) at angle `th`, radius `r`. */
function curve(
  k: number,
  r: number,
  th: number,
  o: { x: number; z: number; vx: number; vz: number; ax: number; az: number },
): void {
  const s = Math.sin(th);
  const c = Math.cos(th);
  if (k === 0) {
    o.x = r * c;
    o.z = r * s;
    o.vx = -r * s;
    o.vz = r * c;
    o.ax = -r * c;
    o.az = -r * s;
  } else {
    o.x = r * s;
    o.z = r * s * c;
    o.vx = r * c;
    o.vz = r * (c * c - s * s);
    o.ax = -r * s;
    o.az = -4 * r * s * c;
  }
}
const cv = { x: 0, z: 0, vx: 0, vz: 0, ax: 0, az: 0 };

/**
 * Member `m` of dogfight group `g` at loop time `t` (s), relative to the
 * unwrapped origin. Member 0 is hunted; the others chase it along the same
 * curve, `m · GROUP_LAG` behind, and fire bursts at it. The GLSL
 * `abPlanePose`, step for step.
 */
export function planePoseInto(
  seed16: number,
  g: number,
  m: number,
  t: number,
  ox: number,
  oz: number,
  out: PlanePose,
): PlanePose {
  const h0 = skyHash(g, seed16 ^ 0xd06f);
  const h1 = skyHash(h0, 0x6f1d);
  const h2 = skyHash(h1, 0x3c5a);
  const size = 2 + (((h1 >>> 6) & 3) % 3);
  out.present = m < size;
  const kx = (h1 & 7) - 3;
  const kz = ((h1 >>> 3) & 7) - 3;
  // The group's centre, unwrapped: each plane is wrapped on its own at
  // the end, so only a plane at the window's edge ever wraps.
  const cx = u16(h0, 0) * PLANE_WINDOW + kx * PLANE_STEP * t;
  const cz = u16(h0, 16) * PLANE_WINDOW + kz * PLANE_STEP * t;
  const alt = GROUP_ALT[0] + u8(h1, 8) * (GROUP_ALT[1] - GROUP_ALT[0]);
  const kind = (h1 >>> 20) & 1;
  const r =
    GROUP_R[0] + u8(h1, 24) * (GROUP_R[1] - GROUP_R[0]) + (m >= 2 ? 12 : 0);
  const turns = GROUP_TURNS[0] + (h2 & 127);
  const dir = ((h2 >>> 7) & 1) === 1 ? 1 : -1;
  const w = (dir * TAU * turns) / SKY_LOOP_S;
  const bob = GROUP_BOB[0] + u8(h2, 16) * (GROUP_BOB[1] - GROUP_BOB[0]);
  // The angle, folded per turn so float32 keeps its precision.
  const cyc = mod((turns * t) / SKY_LOOP_S + u8(h2, 8), 1);
  const th = dir * TAU * cyc - m * GROUP_LAG * dir;
  curve(kind, r, th, cv);
  let x = cx + cv.x;
  let z = cz + cv.z;
  let y = alt + bob * Math.sin(th + m);
  let vx = cv.vx * w;
  let vz = cv.vz * w;
  let vy = bob * Math.cos(th + m) * w;
  // Bank from the lateral acceleration (a coordinated turn).
  const ax = cv.ax * w * w;
  const az = cv.az * w * w;
  const vh = Math.max(Math.hypot(vx, vz), 1);
  const lat = (vx * az - vz * ax) / vh;
  out.bank = Math.atan(lat / 9.8);
  out.burn = 0;
  out.hitAge = -1;
  out.fade = 1;
  // The kill cycle.
  const ct = t + u8(h2, 24) * GROUP_CYCLE_S;
  const c = Math.floor(ct / GROUP_CYCLE_S);
  const tau = ct - c * GROUP_CYCLE_S;
  const hb = groupKill(h2, c);
  const hit = hb >= 0 ? GROUP_HIT_S + u8(hb, 8) * GROUP_HIT_SPAN_S : 1e9;
  out.firing =
    m > 0 &&
    out.present &&
    tau < hit + 1 &&
    mod((GROUP_BURST_TURNS * t) / SKY_LOOP_S + m * 0.37 + u8(h0, 8), 1) <
      GROUP_BURST_SHARE;
  if (m === 0 && hb >= 0 && tau > hit) {
    // Shot down: off the curve along its last heading, spiralling, falling.
    const s = tau - hit;
    const glide = 3 * (1 - Math.exp(-s / 3));
    const sp = 22 * Math.min(1, s / 2);
    x += vx * glide + sp * Math.cos(2.2 * s);
    z += vz * glide + sp * Math.sin(2.2 * s);
    y -= 0.5 * GROUP_FALL_G * s * s;
    vx *= Math.exp(-s / 3);
    vz *= Math.exp(-s / 3);
    vy = -GROUP_FALL_G * s - 5;
    out.bank = 2.2 * s;
    out.burn = Math.min(1, s / 0.6);
    out.hitAge = s;
  }
  if (m === 0 && groupKill(h2, c - 1) >= 0) {
    y += GROUP_EMERGE_RISE * (1 - smooth(0, GROUP_EMERGE_S, tau));
    out.fade = smooth(0, GROUP_EMERGE_FADE_S, tau);
  }
  const vl = Math.max(Math.hypot(vx, vy, vz), 1e-3);
  out.x = wrapRel(x, ox, PLANE_WINDOW);
  out.y = y;
  out.z = wrapRel(z, oz, PLANE_WINDOW);
  out.dx = vx / vl;
  out.dy = vy / vl;
  out.dz = vz / vl;
  return out;
}

/** A plane's visibility from the camera at height `camY`. */
export function planeVis(p: PlanePose, camY: number, outer: number): number {
  if (!p.present || p.y < 0) return 0;
  const d = Math.hypot(p.x, p.y - camY, p.z);
  return skyVis(d, outer, PLANE_FADE_IN) * p.fade;
}

// --- Flak ---------------------------------------------------------------------

/** One flak burst: camera-relative x/z, absolute y, age in its cycle (s). */
export interface FlakPose {
  x: number;
  y: number;
  z: number;
  age: number;
  /** Its cycle length, s. */
  period: number;
}

export const newFlakPose = (): FlakPose => ({
  x: 0,
  y: 0,
  z: 0,
  age: 0,
  period: 1,
});

/** Flak slot `f` bursts round ship slot `flakShip(f)`, below its layer. */
export const flakShip = (f: number): number => (f * 4 + 1) % SHIP_SLOTS;

const shipScratch = newShipPose();

/**
 * Flak slot `f`'s current burst at loop time `t`: a fresh spot beside and
 * below its ship each cycle. The GLSL `abFlakPose`.
 */
export function flakPoseInto(
  seed16: number,
  f: number,
  t: number,
  ox: number,
  oz: number,
  out: FlakPose,
): FlakPose {
  const h = skyHash(f, seed16 ^ 0xf1a4);
  const turns = FLAK_TURNS[0] + (h & 511);
  const cyc = (turns * t) / SKY_LOOP_S + u8(h, 9);
  const c = Math.floor(cyc);
  out.period = SKY_LOOP_S / turns;
  out.age = (cyc - c) * out.period;
  const hc = skyHash(h, mod(c, turns));
  const ship = shipPoseInto(seed16, flakShip(f), t, ox, oz, shipScratch);
  const a = u8(hc, 0) * TAU;
  const side = FLAK_SIDE[0] + u8(hc, 8) * (FLAK_SIDE[1] - FLAK_SIDE[0]);
  out.x = ship.x + side * Math.cos(a);
  out.z = ship.z + side * Math.sin(a);
  out.y =
    Math.min(ship.y, CLOUD_BASE - 40) -
    (FLAK_BELOW[0] + u8(hc, 16) * (FLAK_BELOW[1] - FLAK_BELOW[0]));
  return out;
}
