// The hidden death ceiling (ST1) — pure bookkeeping like combat.ts: no
// sockets, no clocks of its own (observe takes `now`), unit-testable. Tracks
// each plane's CONTINUOUS time above STORM_KILL_ALT; STORM_GRACE_MS of it
// earns a kill bolt, and dipping below resets the timer. index.ts feeds it
// every living member's on-record altitude (humans from validated poses,
// bots from the sim) and settles returned kills through Combat.
//
// Named constraint from the human: NOTHING here warns the pilot. No message,
// no countdown, no state on the wire — the rule is discovered, not announced.

import {
  STORM_GRACE_MS,
  STORM_KILL_ALT,
} from "@angels-bandits/common/constants";

export class StormCeiling {
  /** When each plane's current stretch above the ceiling began, ms. */
  private readonly aboveSince = new Map<string, number>();

  /**
   * Feed one living plane's altitude at `now`. Returns `"kill"` exactly once
   * per expired grace (the timer re-arms, so a missed settlement can't
   * double-kill); the caller executes the death through Combat.
   */
  observe(id: string, altitudeY: number, now: number): "kill" | null {
    if (altitudeY <= STORM_KILL_ALT) {
      this.aboveSince.delete(id);
      return null;
    }
    const since = this.aboveSince.get(id);
    if (since === undefined) {
      this.aboveSince.set(id, now);
      return null;
    }
    if (now - since < STORM_GRACE_MS) return null;
    this.aboveSince.set(id, now);
    return "kill";
  }

  /** Drop a plane's timer (it left the room or was despawned). */
  forget(id: string): void {
    this.aboveSince.delete(id);
  }
}
