// Torus world math — the ONLY exported vector API for inter-entity math.
//
// PROJECT INVARIANT: raw position subtraction between entities is banned
// everywhere outside common/src/world/. Aiming, hit checks, markers, minimap,
// audio panning, server range validation, interpolation, spawn selection —
// all of it goes through this module (wrapDelta and friends), or the torus
// seam becomes visible as bugs.
//
// The world is a square torus of side WORLD_SIZE: X and Z wrap modulo
// WORLD_SIZE; Y (altitude) is linear and never wraps.

import { WORLD_SIZE } from "../constants";

/** A point or vector in world space. Canonical positions have x/z in [0, WORLD_SIZE). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const wrapAxis = (v: number): number =>
  ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

/** Map a position's x/z into canonical [0, WORLD_SIZE) coordinates. Y is untouched. */
export function canonicalize(p: Vec3): Vec3 {
  return { x: wrapAxis(p.x), y: p.y, z: wrapAxis(p.z) };
}

const wrapDeltaAxis = (from: number, to: number): number => {
  const raw = wrapAxis(to) - wrapAxis(from); // in (-WORLD_SIZE, WORLD_SIZE)
  if (raw > WORLD_SIZE / 2) return raw - WORLD_SIZE;
  if (raw < -WORLD_SIZE / 2) return raw + WORLD_SIZE;
  return raw;
};

/**
 * Shortest vector on the torus, pointing FROM `from` TOWARD `to`:
 * canonicalize(from + wrapDelta(from, to)) === canonicalize(to).
 * X/Z components are in [-WORLD_SIZE/2, WORLD_SIZE/2]; Y is a plain difference.
 */
export function wrapDelta(from: Vec3, to: Vec3): Vec3 {
  return {
    x: wrapDeltaAxis(from.x, to.x),
    y: to.y - from.y,
    z: wrapDeltaAxis(from.z, to.z),
  };
}

/** Euclidean length of the shortest torus vector between `a` and `b` (altitude included). */
export function wrapDistance(a: Vec3, b: Vec3): number {
  const d = wrapDelta(a, b);
  return Math.hypot(d.x, d.y, d.z);
}

/**
 * Interpolate from `a` toward `b` along the shortest torus path.
 * The result is canonicalized; Y interpolates linearly. Used for seam-safe
 * remote-plane interpolation (t in [0, 1] between snapshots).
 */
export function wrapLerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const d = wrapDelta(a, b);
  return canonicalize({ x: a.x + d.x * t, y: a.y + d.y * t, z: a.z + d.z * t });
}
