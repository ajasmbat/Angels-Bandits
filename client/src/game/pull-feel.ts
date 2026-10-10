// F10 hard-pull feel — the pure seam behind the HUD g-meter and the
// airframe's creak. The g itself is measured off the flown path by the
// Flight Lab's FlightMeter (lab/meter.ts): a bank-and-pull reads ~4–6 g,
// cruise 1 g. Same split as everything else: main.ts is the thin adapter.

/** The g-meter shows from this load factor, g… */
export const G_SHOW = 2.5;
/** …at full opacity from this one. */
export const G_FULL = 5;
/** The creak/whoosh fires as the pull climbs through this, g, and re-arms
 * once it has eased back under G_REARM (no chatter at the edge). */
export const G_CREAK = 4;
export const G_REARM = 3;

/** The g-meter's readout ("4.2G") and opacity for load factor `g`, or
 * null when it hides (an ordinary turn). */
export function gMeterView(
  g: number,
): { text: string; opacity: number } | null {
  if (!(g >= G_SHOW)) return null;
  const k = Math.min(1, (g - G_SHOW) / (G_FULL - G_SHOW));
  return { text: `${g.toFixed(1)}G`, opacity: 0.45 + 0.55 * k };
}

export interface PullCue {
  armed: boolean;
}

export function createPullCue(): PullCue {
  return { armed: true };
}

/** Whether this frame's `g` should fire the creak (once per hard pull). */
export function stepPullCue(s: PullCue, g: number): boolean {
  if (s.armed && g >= G_CREAK) {
    s.armed = false;
    return true;
  }
  if (!s.armed && g < G_REARM) s.armed = true;
  return false;
}
