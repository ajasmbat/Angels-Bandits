// Deterministic firework schedule, shared verbatim by client and server —
// the storm's strikesInWindow idiom, applied to spectacle instead of danger.
// burstsInWindow is a pure function of (seed, time window): every client
// computes IDENTICAL bursts from the synced snapshot clock, so a firework is
// never streamed and two tabs see the same burst at the same instant.
// No Math.random anywhere.
//
// Fireworks are particles only — no collision, by the L2 design rule: they
// never look solid, so they never need to be. Brightness comes from count and
// hue, never from a new emissive rung; EMISSIVE_TRACER stays the top rung so
// a burst can never wash out the tracers a fight is read by.
//
// Shape: time is cut into hashed buckets of the cadence band's midpoint, one
// burst per bucket at a seeded 0..jitter offset, so consecutive bursts are
// always inside the band and any bucket is addressable in O(1). Bursts land
// over the hand-placed plaza blocks — the city's open ground, which is where
// you would actually fire them from.

import { PLAZA_BLOCKS, mulberry32 } from "./city/index";
import {
  BLOCK_PITCH,
  FIREWORK_ALT_MAX,
  FIREWORK_ALT_MIN,
  FIREWORK_INTERVAL_MAX_MS,
  FIREWORK_INTERVAL_MIN_MS,
} from "./constants";
import { canonicalize } from "./world/index";

/** One scheduled burst. `x`/`z` are canonical in [0, WORLD_SIZE). */
export interface Burst {
  timeMs: number;
  x: number;
  y: number;
  z: number;
  /** Seeded hue in [0, 1) — the client picks a palette entry from it. */
  hue: number;
}

/** Bucket length = the band's midpoint; offset jitter = its half-width, so
 * the gap between bursts n and n+1 stays inside the band by construction. */
const BUCKET_MS = (FIREWORK_INTERVAL_MIN_MS + FIREWORK_INTERVAL_MAX_MS) / 2;
const JITTER_MS = (FIREWORK_INTERVAL_MAX_MS - FIREWORK_INTERVAL_MIN_MS) / 2;

/** How far off a plaza's center a burst may drift, m. */
const SPREAD = BLOCK_PITCH / 2;

/**
 * Per-bucket PRNG stream. Salted with a constant of its own: the storm uses
 * mulberry32((seed ^ imul(n, 0x9e3779b9)) >>> 0) for ITS buckets, and both
 * systems are handed the same world seed — so without the salt bucket n would
 * draw an identical stream in both and the fireworks would rhyme with the
 * lightning. Same trick storm.ts already uses to separate its own two streams.
 */
const bucketRand = (seed: number, n: number): (() => number) =>
  mulberry32((seed ^ 0x5f356495 ^ Math.imul(n, 0x9e3779b9)) >>> 0);

/**
 * All bursts scheduled in the half-open window [tStartMs, tEndMs), sorted by
 * time. Pure and deterministic for a (seed, window) — abutting windows
 * partition the timeline with no burst repeated or skipped, which is what
 * lets a client poll [lastPoll, now) every frame. Times are the server
 * snapshot clock (epoch ms, non-negative).
 */
export function burstsInWindow(
  seed: number,
  tStartMs: number,
  tEndMs: number,
): Burst[] {
  const bursts: Burst[] = [];
  if (PLAZA_BLOCKS.length === 0) return bursts;
  const first = Math.max(0, Math.floor((tStartMs - JITTER_MS) / BUCKET_MS));
  for (let n = first; n * BUCKET_MS < tEndMs; n++) {
    const rand = bucketRand(seed, n);
    const timeMs = n * BUCKET_MS + rand() * JITTER_MS;
    if (timeMs < tStartMs || timeMs >= tEndMs) continue;

    const plaza = PLAZA_BLOCKS[Math.floor(rand() * PLAZA_BLOCKS.length)];
    if (!plaza) continue;
    const p = canonicalize({
      x: plaza[0] * BLOCK_PITCH + BLOCK_PITCH / 2 + (rand() - 0.5) * SPREAD,
      y: 0,
      z: plaza[1] * BLOCK_PITCH + BLOCK_PITCH / 2 + (rand() - 0.5) * SPREAD,
    });
    bursts.push({
      timeMs,
      x: p.x,
      y: FIREWORK_ALT_MIN + rand() * (FIREWORK_ALT_MAX - FIREWORK_ALT_MIN),
      z: p.z,
      hue: rand(),
    });
  }
  return bursts;
}
