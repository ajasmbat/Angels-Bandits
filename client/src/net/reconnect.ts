// The reconnect schedule (W2), pure so it can be tested without a socket:
// exponential backoff from RECONNECT_BASE_MS, capped at RECONNECT_MAX_MS, for
// as long as the server could still hold the dropped session — past the
// resume window a resume can only come back as a fresh player, so the client
// stops and shows SIGNAL LOST instead.

import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RESUME_WINDOW_MS,
} from "@angels-bandits/common/constants";

/**
 * How long to wait before reconnect attempt `attempt` (0-based), ms, given
 * `sinceDropMs` already elapsed since the socket dropped — or null when that
 * attempt would start after the resume window and it is time to give up.
 */
export function reconnectDelayMs(
  attempt: number,
  sinceDropMs: number,
  windowMs = RESUME_WINDOW_MS,
): number | null {
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return sinceDropMs + delay < windowMs ? delay : null;
}
