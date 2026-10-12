// L7 Inferno — the room's BURN LEVEL, the shared, pure half. As the carrier
// war wrecks the city it should read less like reference 1 (the city at
// peace) and more like reference 2 (the city on fire); one number, 0..1,
// says how far along that road the room is, and every client draws the
// same apocalypse from it (client/src/render/inferno.ts).
//
// The SERVER owns it (server/src/index.ts burnFor): each tick it steps a
// BurnModel with the room's gone share (destroyed + fallen chunks over the
// city's chunks) and the chunks that went since the last tick, and sends
// the encoded level whenever it moves (`burn`, plus the welcome). Clients
// never compute it — they only read it, so a late joiner and a veteran of
// the fight see the same fire.
//
// The shape:
//   - the BASE follows the gone share. The destruction caps (DESTROY_CAP,
//     GONE_HOLD_SHARE ≈ 0.18) keep that share small, so it is normalised to
//     BURN_FULL_SHARE rather than to 1: a city a sixth gone is ablaze.
//   - HEAT is the recent destruction — every newly gone chunk adds one, and
//     it cools with HEAT_TAU_MS — so a heavy raid flares the fire before
//     the wreckage adds up, and a quiet spell lets it die back to the base.
//   - the LEVEL chases that target, fast up (BURN_RISE_TAU_MS) and slowly
//     down (BURN_FALL_TAU_MS): rebuilds lower the gone share and the city
//     cools over a couple of minutes, never in a frame.
//
// Purely cosmetic: nothing here touches CityDamage, so C2's fires, W1's
// waves and every other gameplay system run exactly as before.
//
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/burn".

/** The gone share at which the base reaches its full BURN_BASE_MAX. */
export const BURN_FULL_SHARE = 0.15;
/** The base's ceiling — the rest of the range is the heat's. */
export const BURN_BASE_MAX = 0.8;
/** The heat's ceiling, and the chunks of fresh destruction that buy ~63 % of it. */
export const BURN_HEAT_MAX = 0.35;
export const BURN_HEAT_K = 60;
/** Heat cools with this time constant, ms. */
export const HEAT_TAU_MS = 45_000;
/** The level rises toward its target with this time constant, ms … */
export const BURN_RISE_TAU_MS = 6000;
/** … and falls (rebuilds, a quiet sky) with this one, ms. */
export const BURN_FALL_TAU_MS = 120_000;
/** The wire's resolution: the level as an integer 0..BURN_STEPS. */
export const BURN_STEPS = 100;
/** The server sends a changed level at most this often, ms. */
export const BURN_SEND_MS = 500;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/** The level the room is heading for, from its gone share and its heat. */
export function burnTarget(goneShare: number, heat: number): number {
  const base =
    BURN_BASE_MAX * Math.min(1, Math.max(0, goneShare) / BURN_FULL_SHARE);
  const flare =
    BURN_HEAT_MAX * (1 - Math.exp(-Math.max(0, heat) / BURN_HEAT_K));
  // Clamped: fallen chunks and D5 demolitions run past DESTROY_CAP.
  return clamp01(base + flare);
}

/** One room's burn: its level and its heat, stepped once per server tick. */
export class BurnModel {
  level = 0;
  heat = 0;

  /**
   * Advance `dtMs`: `goneShare` is the room's (destroyed + fallen) / chunks
   * now, `newlyGone` the chunks that went since the last step (never the
   * net change — a rebuild must not cancel a fresh break).
   */
  step(dtMs: number, goneShare: number, newlyGone: number): number {
    const dt = Math.max(0, dtMs);
    this.heat =
      this.heat * Math.exp(-dt / HEAT_TAU_MS) + Math.max(0, newlyGone);
    const target = burnTarget(goneShare, this.heat);
    const tau = target > this.level ? BURN_RISE_TAU_MS : BURN_FALL_TAU_MS;
    this.level += (target - this.level) * (1 - Math.exp(-dt / tau));
    this.level = clamp01(this.level);
    return this.level;
  }

  reset(): void {
    this.level = 0;
    this.heat = 0;
  }
}

/** The level on the wire: an integer 0..BURN_STEPS. */
export const encodeBurn = (level: number): number =>
  Math.round(clamp01(level) * BURN_STEPS);

/** The wire's level back to 0..1; anything malformed — or absent, from a
 * server that predates L7 — is a city not burning. */
export function decodeBurn(w: unknown): number {
  if (typeof w !== "number" || !Number.isFinite(w)) return 0;
  return clamp01(w / BURN_STEPS);
}
