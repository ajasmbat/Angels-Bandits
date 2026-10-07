// Bird scatter (L9): a flock bursts away from a plane that screams past
// within SCATTER_RADIUS of its centre, wheels round, and eases back into its
// wheel by SCATTER_SETTLE_S. Pure functions, no THREE — birds.ts applies them.
//
// A PER-CLIENT COSMETIC. The flock itself is a pure function of (seed,
// server clock), identical everywhere; the scatter reacts to the planes THIS
// client sees (its own predicted plane plus interpolated remotes), so two
// clients can disagree by a frame or two about when a flock spooked, and a
// late joiner never sees a scatter that ended before it arrived. Given the
// same plane samples the result is deterministic — the tested contract.
// Birds stay non-collidable either way, so nothing about play depends on it.

import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

/** A plane this close to a flock's centre spooks it, m. */
export const SCATTER_RADIUS = 60;
/** A spooked flock is back in its wheel this long after the trigger, s. */
export const SCATTER_SETTLE_S = 12;
/** A fresh fly-by re-spooks a flock no sooner than this after the last, s. */
export const SCATTER_RETRIGGER_S = 2.5;
/** The burst's rise time constant, s: birds are at full flight in ~1 s. */
const RISE_S = 0.35;
/** The burst holds until HOLD_S, then eases home by SCATTER_SETTLE_S. */
const HOLD_S = 3;
/** How far a bird bursts out, and how high, m (per-bird spread on top). */
const BURST_OUT = 40;
const BURST_OUT_SPREAD = 28;
const BURST_UP = 10;
const BURST_UP_SPREAD = 16;
/** Burst fan around the away direction, rad (±). */
const BURST_FAN = 1.25;
/** How fast the scattered flock wheels round while it is out, rad/s. */
const WHEEL_RATE = 0.55;

/** One spooking of one flock. */
export interface Scatter {
  /** Server time of the trigger, ms. */
  t0: number;
  /** Unit horizontal direction from the plane to the flock at the trigger:
   * the way the birds burst. */
  ax: number;
  az: number;
  /** The scatter this one interrupted, faded out as this one rises so a
   * second fly-by redirects the birds without a pop. Never chained deeper. */
  carry: Scatter | null;
}

/** A deterministic 0..1 per (flock, bird, salt). */
const hash01 = (flockId: number, bird: number, salt: number): number =>
  ((bird * 7919 + flockId * 104729 + salt * 1299709) % 997) / 997;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 0..1: how far into the burst the birds are at `s` seconds. */
const rise = (s: number): number => 1 - Math.exp(-s / RISE_S);

/** 0..1 burst envelope: up fast, hold, ease home; zero outside [0, settle). */
function envelope(s: number): number {
  if (s <= 0 || s >= SCATTER_SETTLE_S) return 0;
  return rise(s) * (1 - smoothstep(HOLD_S, SCATTER_SETTLE_S, s));
}

/**
 * The flock's scatter after this frame. `center` is the flock centre (any
 * torus image), `planes` every plane this client sees, `prev` last frame's
 * result. Returns `prev` itself when nothing changes, so a caller can keep it
 * without allocating; a new object only on a trigger.
 */
export function nextScatter(
  center: Vec3,
  serverTimeMs: number,
  planes: readonly Vec3[],
  prev: Scatter | null,
): Scatter | null {
  // A clock that stepped backwards (resync) invalidates the old trigger.
  let last = prev !== null && serverTimeMs < prev.t0 ? null : prev;
  const since =
    last === null ? Number.POSITIVE_INFINITY : serverTimeMs - last.t0;
  if (since >= SCATTER_SETTLE_S * 1000) last = null;
  if (since < SCATTER_RETRIGGER_S * 1000) return last;
  const r2 = SCATTER_RADIUS * SCATTER_RADIUS;
  for (const plane of planes) {
    const d = wrapDelta(plane, center);
    if (d.x * d.x + d.y * d.y + d.z * d.z > r2) continue;
    const h = Math.hypot(d.x, d.z);
    return {
      t0: serverTimeMs,
      // Straight overhead: no horizontal "away" — burst along +x.
      ax: h > 1e-6 ? d.x / h : 1,
      az: h > 1e-6 ? d.z / h : 0,
      carry: last === null ? null : { ...last, carry: null },
    };
  }
  return last;
}

/**
 * Bird `bird` of flock `flockId`'s displacement from its wheel position at
 * `serverTimeMs`, written to `out` (m). Zero before the trigger and once the
 * flock has resettled.
 */
export function scatterOffset(
  flockId: number,
  bird: number,
  serverTimeMs: number,
  scatter: Scatter | null,
  out: Vec3,
): Vec3 {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  addBurst(flockId, bird, serverTimeMs, scatter, 1, out);
  return out;
}

function addBurst(
  flockId: number,
  bird: number,
  serverTimeMs: number,
  scatter: Scatter | null,
  weight: number,
  out: Vec3,
): void {
  if (scatter === null || weight <= 0) return;
  const s = (serverTimeMs - scatter.t0) / 1000;
  if (s < 0) return;
  const e = envelope(s) * weight;
  if (e > 0) {
    const spin = hash01(flockId, bird, 1) < 0.5 ? -1 : 1;
    // Fan out around the away direction, then wheel round as the burst ages.
    const fan = (hash01(flockId, bird, 2) * 2 - 1) * BURST_FAN;
    const wheel = spin * WHEEL_RATE * s;
    const base = Math.atan2(scatter.az, scatter.ax);
    const a = base + fan + wheel;
    const out1 = BURST_OUT + BURST_OUT_SPREAD * hash01(flockId, bird, 3);
    const up = BURST_UP + BURST_UP_SPREAD * hash01(flockId, bird, 4);
    out.x += Math.cos(a) * out1 * e;
    out.y += up * e;
    out.z += Math.sin(a) * out1 * e;
  }
  // The interrupted scatter fades out exactly as this one rises: continuous
  // at the trigger, negligible (< 0.1 %) by the next allowed re-trigger.
  addBurst(
    flockId,
    bird,
    serverTimeMs,
    scatter.carry,
    weight * (1 - rise(s)),
    out,
  );
}
