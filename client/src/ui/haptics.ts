// Haptics (U1): short vibrations for a hit marker, a kill, taking damage and
// dying. Android Chrome has the Vibration API; iOS Safari doesn't, so it is
// feature-detected and simply does nothing there. The host is injected
// (`navigator` in the game) — no navigator access at module top level, so
// this imports under node. Patterns are module constants: a buzz allocates
// nothing.

/** Hit marker pulse, ms. */
export const HAPTIC_HIT = 12;
/** Kill confirm pulse, ms. */
export const HAPTIC_KILL = 35;
/** Taking damage: buzz–gap–buzz, ms. */
export const HAPTIC_DAMAGE: number[] = [20, 40, 20];
/** Own death pulse, ms. */
export const HAPTIC_DEATH = 60;
/** At most one hit buzz per this many ms (the guns fire faster). */
export const HAPTIC_HIT_GAP_MS = 100;
/** At most one damage buzz per this many ms — a bot lands a round every
 * 100 ms, and back-to-back patterns would blur into one long rattle. */
export const HAPTIC_DAMAGE_GAP_MS = 250;

/** The slice of `navigator` haptics touch. */
export interface VibrateHost {
  vibrate?: (pattern: number | number[]) => boolean;
}

/** Whether `host` can vibrate at all (false on iOS and most desktops). */
export function canVibrate(host: VibrateHost | undefined): boolean {
  return typeof host?.vibrate === "function";
}

export class Haptics {
  private lastHitAt = Number.NEGATIVE_INFINITY;
  private lastDamageAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly host: VibrateHost | undefined,
    private on: boolean,
  ) {}

  /** The device can vibrate (the HAPTICS setting is hidden otherwise). */
  get available(): boolean {
    return canVibrate(this.host);
  }

  get enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean): void {
    this.on = on;
  }

  hit(nowMs: number): void {
    if (nowMs - this.lastHitAt < HAPTIC_HIT_GAP_MS) return;
    if (this.buzz(HAPTIC_HIT)) this.lastHitAt = nowMs;
  }

  kill(): void {
    this.buzz(HAPTIC_KILL);
  }

  damage(nowMs: number): void {
    if (nowMs - this.lastDamageAt < HAPTIC_DAMAGE_GAP_MS) return;
    if (this.buzz(HAPTIC_DAMAGE)) this.lastDamageAt = nowMs;
  }

  death(): void {
    this.buzz(HAPTIC_DEATH);
  }

  /** True when a vibration was handed to the device. */
  private buzz(pattern: number | number[]): boolean {
    if (!this.on || !this.host || typeof this.host.vibrate !== "function") {
      return false;
    }
    try {
      // Called as a method: vibrate needs `navigator` as its receiver.
      this.host.vibrate(pattern);
    } catch {
      // A browser that throws (no user gesture yet) just doesn't buzz.
    }
    return true;
  }
}
