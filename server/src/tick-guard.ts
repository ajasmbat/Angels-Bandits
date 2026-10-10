// A2: containment for the server's scheduled work. Unlike ./guards (shape
// checks on untrusted frames), this is about OUR code throwing: the tick runs
// off a bare setTimeout, where an uncaught throw ends the process.

/**
 * A2: run one scheduled step and contain what it throws. The tick runs off a
 * bare `setTimeout`, so a throw from any room's step was uncaught and took
 * the process (every room) down; and since a fault that throws once per tick
 * throws 20 times a second, the log is rate-limited: the first failure, then
 * at most one line per `windowMs` carrying how many were folded into it.
 * Returns false when `step` threw.
 */
export function createGuard(
  label: string,
  log: (line: string, err: unknown) => void = console.error,
  windowMs = 10000,
): (step: () => void, now: number) => boolean {
  let loggedAt = Number.NEGATIVE_INFINITY;
  let folded = 0;
  return (step, now) => {
    try {
      step();
      return true;
    } catch (err) {
      if (now - loggedAt >= windowMs) {
        const more = folded > 0 ? ` (+${folded} since the last report)` : "";
        log(`${label} failed${more}:`, err);
        loggedAt = now;
        folded = 0;
      } else folded++;
      return false;
    }
  };
}
