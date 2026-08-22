// Deterministic storm schedule, shared verbatim by client and server — the
// city-generation trick applied to weather. strikesInWindow is a pure
// function of (seed, time window): both sides compute IDENTICAL strikes from
// the synced snapshot clock, so nothing about the storm is ever streamed.
// No Math.random anywhere; changing the draw order or the hash is a
// client/server protocol break, exactly like generateCity.
//
// Shape (Concept D, human-approved "rods over a marching front"): time is cut
// into hashed buckets of the cadence band's midpoint, one strike per bucket
// at a seeded 0..jitter offset — consecutive strikes are always 8–15 s apart,
// and any bucket is addressable in O(1) (no walking from epoch zero).
// Positions march a seeded per-epoch Fisher–Yates permutation of the 4×4
// 500 m cell grid, so every corner of the map is struck once per 16 strikes —
// no clusters, no quiet corners (ST2's reveal pings sweep the whole city).
// A strike whose cell contains one of the four landmark supertalls snaps to
// that tower's roof: the 250 m towers are the city's lightning rods.

import { LANDMARK_BLOCKS, mulberry32 } from "./city/index";
import {
  BLOCK_PITCH,
  STORM_CELL_SIZE,
  STORM_ROD_RADIUS,
  STRIKE_INTERVAL_MAX_MS,
  STRIKE_INTERVAL_MIN_MS,
  WORLD_SIZE,
} from "./constants";
import { canonicalize } from "./world/index";

/** One scheduled strike. `x`/`z` are canonical in [0, WORLD_SIZE). */
export interface Strike {
  timeMs: number;
  x: number;
  z: number;
}

/** Bucket length = the band's midpoint; offset jitter = the band's half-width.
 * Gap between strikes n and n+1 is BUCKET + (offset(n+1) − offset(n)), so the
 * cadence band holds by construction. */
const BUCKET_MS = (STRIKE_INTERVAL_MIN_MS + STRIKE_INTERVAL_MAX_MS) / 2;
const JITTER_MS = (STRIKE_INTERVAL_MAX_MS - STRIKE_INTERVAL_MIN_MS) / 2;

/** Coverage grid: 4×4 cells of STORM_CELL_SIZE; one epoch = one full sweep. */
const GRID = WORLD_SIZE / STORM_CELL_SIZE;
const CELLS = GRID * GRID;

/** Landmark supertall centers, keyed by the coverage cell that contains them
 * (each 200 m landmark block sits inside one 500 m cell). */
const RODS = new Map(
  LANDMARK_BLOCKS.map(([bx, bz]) => {
    const x = bx * BLOCK_PITCH + BLOCK_PITCH / 2;
    const z = bz * BLOCK_PITCH + BLOCK_PITCH / 2;
    const cell =
      Math.floor(z / STORM_CELL_SIZE) * GRID + Math.floor(x / STORM_CELL_SIZE);
    return [cell, { x, z }] as const;
  }),
);

/** Per-bucket PRNG stream — random access by bucket index, like per-room bot
 * seeds: golden-ratio hash of the index into the world seed. */
const bucketRand = (seed: number, n: number): (() => number) =>
  mulberry32((seed ^ Math.imul(n, 0x9e3779b9)) >>> 0);

/** The coverage cell bucket `n` strikes: position n-mod-16 of its epoch's
 * seeded permutation (Fisher–Yates over the 16 cells). */
function cellOf(seed: number, n: number): number {
  const epoch = Math.floor(n / CELLS);
  const rand = mulberry32(
    (seed ^ 0x51ed270b ^ Math.imul(epoch, 0x9e3779b9)) >>> 0,
  );
  const perm = Array.from({ length: CELLS }, (_, i) => i);
  for (let i = CELLS - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = perm[i] ?? 0;
    perm[i] = perm[j] ?? 0;
    perm[j] = tmp;
  }
  return perm[n % CELLS] ?? 0;
}

/**
 * All strikes scheduled in the half-open window [tStartMs, tEndMs), sorted by
 * time. Pure and deterministic for a (seed, window) — abutting windows
 * partition the timeline with no strike repeated or skipped. Times are the
 * server snapshot clock (epoch ms, non-negative).
 */
export function strikesInWindow(
  seed: number,
  tStartMs: number,
  tEndMs: number,
): Strike[] {
  const strikes: Strike[] = [];
  const first = Math.max(0, Math.floor((tStartMs - JITTER_MS) / BUCKET_MS));
  for (let n = first; n * BUCKET_MS < tEndMs; n++) {
    const rand = bucketRand(seed, n);
    const timeMs = n * BUCKET_MS + rand() * JITTER_MS;
    if (timeMs < tStartMs || timeMs >= tEndMs) continue;

    const cell = cellOf(seed, n);
    const rod = RODS.get(cell);
    if (rod) {
      // Lightning rod: land within STORM_ROD_RADIUS of the tower's center.
      const angle = rand() * Math.PI * 2;
      const r = rand() * STORM_ROD_RADIUS;
      const p = canonicalize({
        x: rod.x + Math.cos(angle) * r,
        y: 0,
        z: rod.z + Math.sin(angle) * r,
      });
      strikes.push({ timeMs, x: p.x, z: p.z });
    } else {
      strikes.push({
        timeMs,
        x: (cell % GRID) * STORM_CELL_SIZE + rand() * STORM_CELL_SIZE,
        z: Math.floor(cell / GRID) * STORM_CELL_SIZE + rand() * STORM_CELL_SIZE,
      });
    }
  }
  return strikes;
}
