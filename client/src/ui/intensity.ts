// The shared enemy-intensity control's state (W1; ANGE-6STDNN's bot-count
// slider before it), free of the DOM so it can be reasoned about on its own —
// ui/scoreboard.ts draws it, main.ts wires onClaim to the socket and
// applyServer to intensityConfig. Its notches are the levels EASY, NORMAL,
// HARD and INSANE (0–3, common/src/waves.ts).
//
// The rule that shapes everything here: the SERVER owns the value. A drag may
// preview locally while the pointer is down, because a bar that ignores the
// finger feels broken — but the instant it is released the display reverts to
// the last value the server confirmed. The server silently drops claims that
// break its per-player rate limit, so that snap-back is the only feedback a
// dropped claim gets, and it is enough: the bar visibly rebounds.
//
// One drag makes exactly one claim, on release — the rate limit is why, and
// release() spells it out.

import { INTENSITY_MAX, INTENSITY_NAMES } from "@angels-bandits/common/waves";

const clamp = (level: number): number =>
  Math.min(Math.max(Math.round(level), 0), INTENSITY_MAX);

/** A level's name for the HUD (EASY … INSANE). */
export const intensityName = (level: number): string =>
  INTENSITY_NAMES[clamp(level)] ?? "";

export class IntensityBar {
  /** Last value the server confirmed — the room's truth. */
  private server: number;
  /** Where the finger is, while it is down. Null means "not dragging". */
  private drag: number | null = null;
  /** Who set the server's value, for the attribution line. */
  private setter: string | null = null;

  /** Send a claim to the server (main.ts hands this to the socket). */
  onClaim: ((level: number) => void) | null = null;

  constructor(initial: number) {
    this.server = clamp(initial);
  }

  /** The level to draw: the finger while dragging, else the server's value. */
  get displayed(): number {
    return this.drag ?? this.server;
  }

  /** The ticker/label line, or null before anyone has set the level. */
  get attribution(): string | null {
    return this.setter === null
      ? null
      : `${this.setter} set enemies to ${intensityName(this.server)}`;
  }

  /** An intensityConfig broadcast landed — including this player's own
   * accepted claim, the only way a claim is ever confirmed. */
  applyServer(level: number, byName: string): void {
    this.server = clamp(level);
    this.setter = byName;
  }

  /** W2: the room's level from a resume's welcome. A change made while we
   * were gone has no setter we heard of, so it carries no attribution. */
  resync(level: number): void {
    if (clamp(level) === this.server) return;
    this.server = clamp(level);
    this.setter = null;
  }

  /** The pointer moved to `level` with the button down. Preview only — see
   * release() for why nothing is claimed until the player lets go. */
  dragTo(level: number): void {
    this.drag = clamp(level);
  }

  /**
   * The pointer came up: claim where it landed, and hand the bar back to the
   * server until it answers.
   *
   * This is the ONLY claim a drag makes, and that is deliberate. The server
   * accepts one change per player per 3 s; a claim sent mid-drag would spend
   * that budget on a notch the player was merely passing over, and the value
   * they actually chose would be the one dropped — two-tab QA showed every
   * drag rebounding to whatever notch the grab happened to start on.
   *
   * A release onto the value the room already holds asks for nothing, so it
   * is not claimed: spending the rate limit on a no-op would block the next
   * real change. The comparison is against the SERVER's value rather than
   * this bar's own history, so putting a level back after someone else moved
   * it is always a fresh claim.
   */
  release(): void {
    const value = this.drag;
    this.drag = null;
    if (value !== null && value !== this.server) this.onClaim?.(value);
  }
}
