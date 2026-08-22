// ST2 client storm: the pure storm-clock seam. Everything here is a pure
// function of (strikes from the shared schedule, snapshot poses, the synced
// clock) — no THREE, no WebAudio, no DOM. The renderer/audio/UI adapters
// consume these outputs, so the torus math and timing are testable without a
// GPU, exactly like the traffic and freelook seams.

import { mulberry32 } from "@angels-bandits/common/city";
import {
  CLOUD_BASE,
  STORM_KILL_ALT,
  STORM_REVEAL_MS,
  STORM_REVEAL_RADIUS,
} from "@angels-bandits/common/constants";
import { type Strike, strikesInWindow } from "@angels-bandits/common/storm";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";

/** Speed of sound, m/s — thunder trails the flash by wrapDistance / this. */
const SOUND_SPEED_MPS = 340;
/** Thunder is inaudible past this torus distance, m (< the 1414 m max). */
const THUNDER_RANGE = 1400;

/**
 * The planes a strike reveals: horizontal torus distance within
 * STORM_REVEAL_RADIUS. Altitude is deliberately ignored — the bolt is a
 * full-height column, so height never hides you from the storm's radar.
 */
export function revealedPlanes<T extends { pos: Vec3 }>(
  strike: Strike,
  planes: readonly T[],
): T[] {
  return planes.filter(
    (p) =>
      wrapDistance({ x: strike.x, y: p.pos.y, z: strike.z }, p.pos) <=
      STORM_REVEAL_RADIUS,
  );
}

/** Reveal intensity 1 → 0 over STORM_REVEAL_MS from the strike moment. */
export function revealLevel(struckAtMs: number, nowMs: number): number {
  const age = nowMs - struckAtMs;
  if (age < 0 || age >= STORM_REVEAL_MS) return 0;
  return 1 - age / STORM_REVEAL_MS;
}

/** Milliseconds between a strike's flash and its thunder at `listener` —
 * the shortest torus path from the strike's ground point, at 340 m/s. */
export function thunderDelayMs(strike: Strike, listener: Vec3): number {
  const dist = wrapDistance({ x: strike.x, y: 0, z: strike.z }, listener);
  return (dist / SOUND_SPEED_MPS) * 1000;
}

/** Thunder loudness 0..1: full overhead, gone past THUNDER_RANGE. */
export function thunderGain(distM: number): number {
  return Math.max(0, 1 - distM / THUNDER_RANGE);
}

/** Peak per-axis turbulence displacement at full ramp, m. Worst-case 3-axis
 * magnitude √(1.8² + 1.44² + 1.8²) ≈ 2.93 stays under the 3 m readability cap. */
const SHAKE_MAX = 1.8;
/** Base turbulence frequency scale (Neon Vein: medium sway, low frequency). */
const SHAKE_FREQ = 0.9;

/**
 * Visual-only turbulence displacement while inside the cloud deck: layered
 * sines of the clock, amplitude ramping from CLOUD_BASE up to full at
 * STORM_KILL_ALT. Pure of (time, altitude) — it never reads or writes flight
 * state, so the streamed pose is untouched by construction.
 */
/**
 * Frame-by-frame strike consumer: polls the shared schedule over abutting
 * half-open [last, now) windows on the synced snapshot clock, per the ST1
 * contract — every scheduled strike is delivered exactly once, and the first
 * tick only primes (no replay of strikes from before we joined).
 */
export class StrikeFeed {
  private lastT: number | null = null;

  constructor(private readonly seed: number) {}

  poll(nowServerMs: number | null): Strike[] {
    if (nowServerMs === null) return [];
    if (this.lastT === null || nowServerMs < this.lastT) {
      this.lastT = nowServerMs; // prime (or clock stepped backward — resync)
      return [];
    }
    const strikes = strikesInWindow(this.seed, this.lastT, nowServerMs);
    this.lastT = nowServerMs;
    return strikes;
  }
}

/** Bolt origin height above the deck, m — the channel starts in the cloud. */
const BOLT_TOP_Y = CLOUD_BASE + 40;
/** Midpoint-displacement iterations: 2^5 = 32 segments on the main channel. */
const BOLT_ITERATIONS = 5;
/** Horizontal wander per unit of remaining segment length (Neon Vein jag). */
const BOLT_JAG = 0.2;
/** Side branches per bolt (Neon Vein: 3). */
const BOLT_BRANCH_COUNT = 3;

/** Per-strike PRNG: the strike's schedule slot is already unique, so its
 * time and cell hash to a stable per-bolt stream on every client. */
const strikeRand = (strike: Strike, salt: number): (() => number) =>
  mulberry32(
    (Math.imul(strike.timeMs & 0xffffffff, 0x9e3779b9) ^
      Math.imul(strike.x * 8 + salt, 0x85ebca6b) ^
      Math.imul(strike.z * 8, 0xc2b2ae35)) >>>
      0,
  );

/** Midpoint-displacement polyline between two local points. */
function displace(
  from: Vec3,
  to: Vec3,
  jag: number,
  rand: () => number,
): Vec3[] {
  let pts = [from, to];
  for (let it = 0; it < BOLT_ITERATIONS; it++) {
    const next: Vec3[] = [pts[0] as Vec3];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as Vec3;
      const b = pts[i] as Vec3;
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      next.push(
        {
          x: (a.x + b.x) / 2 + (rand() - 0.5) * len * jag,
          y: (a.y + b.y) / 2 + (rand() - 0.5) * len * jag * 0.35,
          z: (a.z + b.z) / 2 + (rand() - 0.5) * len * jag,
        },
        b,
      );
    }
    pts = next;
  }
  return pts;
}

/**
 * The main lightning channel for a strike, as OFFSETS from the strike's
 * ground anchor: from inside the cloud deck down to (0, topY, 0) — the
 * renderer places the whole thing at the strike's nearest torus image.
 * Deterministic per strike, so every client draws the identical bolt.
 */
export function boltPolyline(strike: Strike, topY: number): Vec3[] {
  const rand = strikeRand(strike, 1);
  const from = {
    x: (rand() - 0.5) * 110,
    y: BOLT_TOP_Y,
    z: (rand() - 0.5) * 110,
  };
  return displace(from, { x: 0, y: topY, z: 0 }, BOLT_JAG, rand);
}

/** Side branches: thin forks hung off points of the main channel, angling
 * down and out. Same determinism contract as the main channel. */
export function boltBranches(strike: Strike, main: readonly Vec3[]): Vec3[][] {
  const rand = strikeRand(strike, 2);
  const branches: Vec3[][] = [];
  for (let b = 0; b < BOLT_BRANCH_COUNT; b++) {
    const root = main[4 + Math.floor(rand() * main.length * 0.6)];
    if (!root) continue;
    const end = {
      x: root.x + (rand() - 0.5) * 160,
      y: root.y - 40 - rand() * 110,
      z: root.z + (rand() - 0.5) * 160,
    };
    branches.push(displace(root, end, BOLT_JAG * 1.4, rand));
  }
  return branches;
}

export function turbulenceOffset(tMs: number, altitude: number): Vec3 {
  if (altitude <= CLOUD_BASE) return { x: 0, y: 0, z: 0 };
  const ramp = Math.min(
    1,
    (altitude - CLOUD_BASE) / (STORM_KILL_ALT - CLOUD_BASE),
  );
  const a = (SHAKE_MAX / 2) * ramp; // two sines per axis → peak = 2a
  const t = (tMs / 1000) * SHAKE_FREQ;
  return {
    x: (Math.sin(t * 13) + Math.sin(t * 7.3 + 1.7)) * a,
    y: (Math.sin(t * 11 + 0.9) + Math.sin(t * 17)) * a * 0.8,
    z: (Math.sin(t * 15 + 2.4) + Math.sin(t * 6.1)) * a,
  };
}
