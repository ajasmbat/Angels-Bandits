// Boost energy model (F2) — pure and shared, like the gun heat in combat.ts:
// the client's SPACE key and gauge and the server's mirror (server/src/
// index.ts) step the SAME model from the same constants, so what the gauge
// shows and what the server will accept can only drift by edge-arrival
// jitter (the server absorbs that with BOOST_VALIDATION_SLACK, not a second
// model).
//
// Energy is a 0..1 gauge. A burn costs BOOST_START_COST up front and then
// drains BOOST_DRAIN_RATE per second until released or empty; after a burn
// ends, recharge waits BOOST_RECHARGE_DELAY_MS and then refills at
// BOOST_RECHARGE_RATE. Everything is a function of wall-clock edges, so the
// whole history is reproducible from the (start, stop) timestamps alone.
//
// FL1: the gauge's rates, delay and start rule and the speeds come from a
// FlightTuning
// (trailing `tuning = DEFAULT_TUNING`); the server's mirror never passes one.

import { DEFAULT_TUNING, type FlightTuning } from "./tuning";

export interface Boost {
  /** Energy 0..1 (the server's slack lets it dip to −slack before empty). */
  energy: number;
  /** True while burning. */
  active: boolean;
  /** Timestamp energy was last advanced to, ms. */
  at: number;
  /** When the last burn ended (release or empty), ms. −Infinity before any. */
  endedAt: number;
}

export function createBoost(now = 0): Boost {
  return {
    energy: 1,
    active: false,
    at: now,
    endedAt: Number.NEGATIVE_INFINITY,
  };
}

/**
 * Energy advanced to `now`. A burn that runs dry on the way ends at the exact
 * empty instant (energy −slack), and recharge is timed from there — so the
 * server's mirror auto-ends a burn whose stop edge never came.
 */
export function boostLevel(
  b: Boost,
  now: number,
  slack = 0,
  tuning: Readonly<FlightTuning> = DEFAULT_TUNING,
): Boost {
  if (now <= b.at) return b;
  if (b.active) {
    const drain = tuning.boostDrainRate;
    const floor = -slack;
    const energy = b.energy - (drain * (now - b.at)) / 1000;
    if (energy > floor) return { ...b, energy, at: now };
    const emptyAt = b.at + (Math.max(0, b.energy - floor) / drain) * 1000;
    return boostLevel(
      { energy: floor, active: false, at: emptyAt, endedAt: emptyAt },
      now,
      slack,
      tuning,
    );
  }
  const from = Math.max(b.at, b.endedAt + tuning.boostRechargeDelay);
  const energy = Math.min(
    1,
    b.energy + (tuning.boostRechargeRate * Math.max(0, now - from)) / 1000,
  );
  return { ...b, energy, at: now };
}

/** May a burn start right now? Level first — pass boostLevel output. */
export function canBoost(
  b: Boost,
  slack = 0,
  tuning: Readonly<FlightTuning> = DEFAULT_TUNING,
): boolean {
  return !b.active && b.energy >= tuning.boostMinStart - slack;
}

/** Start a burn at `now` if the energy allows; a start while burning (or
 * refused) just returns the levelled state. */
export function startBoost(
  b: Boost,
  now: number,
  slack = 0,
  tuning: Readonly<FlightTuning> = DEFAULT_TUNING,
): Boost {
  const l = boostLevel(b, now, slack, tuning);
  if (!canBoost(l, slack, tuning)) return l;
  return { ...l, active: true, energy: l.energy - tuning.boostStartCost };
}

/** End the burn at `now`. A stop while not burning is a no-op, so a late or
 * duplicate stop edge can never push the recharge delay back. */
export function stopBoost(
  b: Boost,
  now: number,
  slack = 0,
  tuning: Readonly<FlightTuning> = DEFAULT_TUNING,
): Boost {
  const l = boostLevel(b, now, slack, tuning);
  return l.active ? { ...l, active: false, endedAt: now } : l;
}

/**
 * The fastest legal airspeed at any instant from `since` up to the state's
 * own `at`, m/s. Pass a state levelled to now. Burning (or a burn that ended
 * at or after `since`) allows BOOST_MAX_SPEED; after that the post-burn tail
 * is the flight model's own decay at SPEED_RESPONSE, an envelope that depends
 * only on the time since the burn ended — the client clamps to it, the
 * server validates against it.
 */
export function boostSpeedCap(
  b: Boost,
  since: number,
  tuning: Readonly<FlightTuning> = DEFAULT_TUNING,
): number {
  const { maxSpeed, boostMaxSpeed } = tuning;
  if (b.active || b.endedAt >= since) return boostMaxSpeed;
  const t = (since - b.endedAt) / 1000;
  return (
    maxSpeed + (boostMaxSpeed - maxSpeed) * Math.exp(-tuning.speedResponse * t)
  );
}
