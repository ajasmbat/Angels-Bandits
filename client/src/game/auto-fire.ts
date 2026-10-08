// Auto-fire (M8) — the pure seam. A thumb can't hold FIRE and fly the
// throttle at once, so with AUTO FIRE on the guns pull themselves while the
// lead computer reports a firing solution (ui/lead.ts: strict, and never on
// a spawn-protected target). It only drives a trigger — hits stay the
// shooter's client's call, server-validated, exactly as a click's. A short
// minimum burst and a release delay keep a solution flickering at its
// threshold from stuttering. Injected clock, written in place: no
// allocation per frame. CLIENT-ONLY.

/** Once pulled, the trigger stays down at least this long, ms… */
export const AUTO_FIRE_MIN_MS = 200;
/** …and until this long after the solution is lost, ms. */
export const AUTO_FIRE_RELEASE_MS = 150;

export interface AutoFireState {
  /** The auto trigger is down. */
  firing: boolean;
  /** When it was pulled, ms. */
  since: number;
  /** When the solution was lost while firing, ms; NaN while it holds. */
  lostAt: number;
}

export function createAutoFire(): AutoFireState {
  return { firing: false, since: 0, lostAt: Number.NaN };
}

/** One frame's view of the fight. */
export interface AutoFireInput {
  /** The AUTO FIRE setting. */
  enabled: boolean;
  /** Alive, flying (not dead, not in the settings panel, not free-looking —
   * the guns are blocked there anyway). */
  flying: boolean;
  /** The lead computer has a firing solution. */
  solution: boolean;
  /** The guns are overheat-locked. */
  locked: boolean;
  /** Our own spawn protection is up: firing would spend it, which only a
   * press of FIRE may do. */
  protectedSelf: boolean;
}

/**
 * Advance to `now` (ms) and return whether the auto trigger is down. Losing
 * eligibility (off, not flying, locked, protected) releases at once, over
 * the minimum burst; losing the solution releases AUTO_FIRE_RELEASE_MS
 * later, but never inside the first AUTO_FIRE_MIN_MS.
 */
export function stepAutoFire(
  s: AutoFireState,
  i: AutoFireInput,
  now: number,
): boolean {
  if (!i.enabled || !i.flying || i.locked || i.protectedSelf) {
    s.firing = false;
    s.lostAt = Number.NaN;
    return false;
  }
  if (i.solution) {
    if (!s.firing) {
      s.firing = true;
      s.since = now;
    }
    s.lostAt = Number.NaN;
    return true;
  }
  if (!s.firing) return false;
  if (Number.isNaN(s.lostAt)) s.lostAt = now;
  if (
    now - s.lostAt >= AUTO_FIRE_RELEASE_MS &&
    now - s.since >= AUTO_FIRE_MIN_MS
  ) {
    s.firing = false;
    s.lostAt = Number.NaN;
  }
  return s.firing;
}
