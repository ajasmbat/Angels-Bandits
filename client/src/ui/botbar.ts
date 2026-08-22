// The shared bot-count control's state (ANGE-6STDNN), free of the DOM so it
// can be reasoned about on its own — ui/scoreboard.ts draws it, main.ts wires
// onClaim to the socket and applyServer to botsConfig.
//
// The rule that shapes everything here: the SERVER owns the value. A drag may
// preview locally while the pointer is down, because a bar that ignores the
// finger feels broken — but the instant it is released the display reverts to
// the last value the server confirmed. The server silently drops claims that
// break its per-player rate limit, so that snap-back is the only feedback a
// dropped claim gets, and it is enough: the bar visibly rebounds.

import { BOT_TARGET_MAX } from "@angels-bandits/common/constants";

/** Fastest a drag may claim, ms. Well under the server's accept window: the
 * in-between samples are disposable, the released value is not. */
const DRAG_CLAIM_MS = 300;

const clamp = (count: number): number =>
  Math.min(Math.max(Math.round(count), 0), BOT_TARGET_MAX);

export class BotBar {
  /** Last value the server confirmed — the room's truth. */
  private server: number;
  /** Where the finger is, while it is down. Null means "not dragging". */
  private drag: number | null = null;
  /** Who set the server's value, for the attribution line. */
  private setter: string | null = null;
  private lastClaimAt = Number.NEGATIVE_INFINITY;
  private lastClaimed: number | null = null;

  /** Send a claim to the server (main.ts hands this to the socket). */
  onClaim: ((count: number) => void) | null = null;

  constructor(initial: number) {
    this.server = clamp(initial);
  }

  /** The count to draw: the finger while dragging, else the server's value. */
  get displayed(): number {
    return this.drag ?? this.server;
  }

  /** The ticker/label line, or null before anyone has set the count. */
  get attribution(): string | null {
    return this.setter === null
      ? null
      : `${this.setter} set bots to ${this.server}`;
  }

  /** A botsConfig broadcast landed — including this player's own accepted
   * claim, which is the only way a claim is ever confirmed. */
  applyServer(count: number, byName: string): void {
    this.server = clamp(count);
    this.setter = byName;
  }

  /** The pointer moved to `count` with the button down. */
  dragTo(count: number, now: number): void {
    const value = clamp(count);
    this.drag = value;
    if (now - this.lastClaimAt >= DRAG_CLAIM_MS) this.claim(value, now);
  }

  /** The pointer came up: claim where it landed and hand the bar back to the
   * server until it answers. */
  release(now: number): void {
    const value = this.drag;
    this.drag = null;
    if (value !== null && value !== this.lastClaimed) this.claim(value, now);
  }

  private claim(count: number, now: number): void {
    this.lastClaimAt = now;
    this.lastClaimed = count;
    this.onClaim?.(count);
  }
}
