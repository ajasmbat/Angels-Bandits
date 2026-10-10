// J1 juice — the pure seam behind the carrier war's spectacle (same idiom as
// callouts.ts and quake.ts): no DOM, no THREE, no WebAudio, and nothing
// built per frame. main.ts feeds it the server's credit and the frame clock;
// the HUD, the explosions, the camera and the score read what it decides.
//
//  - Combos ride the SERVER's kill chain (`award.chain`, MedalLedger): the
//    client never re-times kills, so two clients that saw the same award
//    show the same DOUBLE / TRIPLE / MULTI.
//  - Slow-mo is an FX clock, not a game clock: it only ever re-times the
//    kill FX layer (render/fx.ts explosions and sparks). stepFlight, the
//    render clock (wrecks, movers, the kill-cam) and everything sent to the
//    server read wall time and never see it.
//  - Camera cues are look-weights the frame loop blends the DISPLAYED
//    camera by after the chase camera — steering reads chase.aimFrame, so a
//    cue can never take the stick.

import {
  WAVE_BREATHER,
  WAVE_LIVE,
  type WaveState,
} from "@angels-bandits/common/waves";
import type { Vec3 } from "@angels-bandits/common/world";

// --- Combos, medals and style points ---------------------------------------

/** A juice beat: a kill (with its combo) or a carrier-war moment. */
export type JuiceKind =
  | "kill"
  | "double"
  | "triple"
  | "multi"
  | "bomber"
  | "carrier"
  | "aa"
  | "wave";

/** A combo a kill chain earns. */
export type ComboKind = "double" | "triple" | "multi";
/** A carrier-war moment: a W2 bomber shot down mid-run, the carrier down,
 * a W3 AA nest finishing a plane we hit, a wave cleared. */
export type MomentKind = "bomber" | "carrier" | "aa" | "wave";

/** Style points each beat is worth (the popup's number — cosmetic, never
 * the kill-based scoreboard). MULTI is per kill past the third. */
export const STYLE_POINTS: Readonly<Record<JuiceKind, number>> = {
  kill: 100,
  double: 250,
  triple: 500,
  multi: 750,
  bomber: 300,
  carrier: 2500,
  aa: 150,
  wave: 750,
};

export const JUICE_LABEL: Readonly<Record<Exclude<JuiceKind, "kill">, string>> =
  {
    double: "DOUBLE KILL",
    triple: "TRIPLE KILL",
    multi: "MULTI KILL",
    bomber: "BOMBER STOPPED!",
    carrier: "CARRIER DOWN!",
    aa: "AA ASSIST",
    wave: "WAVE CLEARED",
  };

/** The combo a server kill chain earns: none below two (an older server
 * sends no chain at all, which is no combo either). */
export function comboOf(chain: number | undefined): ComboKind | null {
  if (chain === undefined || !Number.isFinite(chain) || chain < 2) return null;
  return chain === 2 ? "double" : chain === 3 ? "triple" : "multi";
}

/** The banner text for a combo: MULTI counts its kills. */
export function comboLabel(combo: ComboKind, chain: number): string {
  return combo === "multi"
    ? `${JUICE_LABEL.multi} ×${Math.floor(chain)}`
    : JUICE_LABEL[combo];
}

/** Style points for one own kill at server chain `chain`. */
export function killPoints(chain: number | undefined): number {
  const combo = comboOf(chain);
  if (combo === null) return STYLE_POINTS.kill;
  const n = combo === "multi" ? Math.floor(chain as number) - 3 : 1;
  return STYLE_POINTS.kill + STYLE_POINTS[combo] * n;
}

/** Beats that earn the slow-mo: multi-kills and the carrier kill. */
export function slowMoFor(kind: JuiceKind): boolean {
  return (
    kind === "double" ||
    kind === "triple" ||
    kind === "multi" ||
    kind === "carrier"
  );
}

/**
 * WAVE CLEARED is exactly the server's LIVE → BREATHER step into the next
 * wave (server/src/waves.ts: the last enemy down with the carrier still up).
 * LIVE → IDLE is never a clear: the carrier went down (that is CARRIER
 * DOWN, from `bossDown`), flew off, or the war was switched off.
 */
export function waveCleared(prev: WaveState, next: WaveState): boolean {
  return (
    prev.phase === WAVE_LIVE &&
    next.phase === WAVE_BREATHER &&
    next.wave === prev.wave + 1
  );
}

// --- Slow-mo: the FX clock ---------------------------------------------------

/** The FX layer's rate at the bottom of the dip. */
export const SLOWMO_RATE = 0.3;
/** Into the dip, held at the bottom, back out, ms (≈ 0.3 s of slow-mo). */
export const SLOWMO_IN_MS = 50;
export const SLOWMO_HOLD_MS = 300;
export const SLOWMO_OUT_MS = 200;
/** After the dip the FX layer runs this much fast until it has caught back
 * up with wall time — gentle, so the speed-up never reads. */
export const SLOWMO_CATCHUP = 1.25;

/** The dip's rate `ageMs` after its trigger (1 outside it). */
export function slowMoRate(ageMs: number): number {
  if (!(ageMs >= 0)) return 1;
  if (ageMs < SLOWMO_IN_MS) {
    return 1 + (SLOWMO_RATE - 1) * (ageMs / SLOWMO_IN_MS);
  }
  const out = ageMs - SLOWMO_IN_MS - SLOWMO_HOLD_MS;
  if (out < 0) return SLOWMO_RATE;
  if (out >= SLOWMO_OUT_MS) return 1;
  const u = out / SLOWMO_OUT_MS;
  return SLOWMO_RATE + (1 - SLOWMO_RATE) * u * u * (3 - 2 * u);
}

/**
 * The FX layer's clock: wall time minus a lag the slow-mo builds up and the
 * catch-up pays back. FX stamp their births with wall time as ever (some
 * with a future offset — a staggered chain of blasts) and map them through
 * toFx(), so a blast born mid-dip starts at its own beginning, not part-way
 * through. Disabled (reduced motion, a pinned QA clock, the kill-cam) it is
 * the identity: no lag, rate 1.
 */
export class FxClock {
  /** How far the FX layer is behind wall time, ms (≥ 0). */
  lag = 0;
  /** This frame's FX rate (QA). */
  rate = 1;
  private startAt = Number.NEGATIVE_INFINITY;
  private enabled = true;

  /** Off snaps straight back to wall time (no catch-up to watch). */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.reset();
  }

  /** Start a dip at wall time `now` (ignored while disabled). */
  trigger(now: number): void {
    if (this.enabled) this.startAt = now;
  }

  /** True while the dip itself runs (the HUD vignette, the audio duck). */
  dipping(now: number): boolean {
    return slowMoRate(now - this.startAt) < 1;
  }

  /** How deep the dip is right now, 0..1 (the audio duck's depth). */
  depth(now: number): number {
    return (1 - slowMoRate(now - this.startAt)) / (1 - SLOWMO_RATE);
  }

  /** Advance one frame of `rawMs` wall time ending at `now`; returns the
   * FX rate to scale this frame's FX dt by. */
  step(now: number, rawMs: number): number {
    let rate = slowMoRate(now - this.startAt);
    if (rate >= 1) rate = this.lag > 0 ? SLOWMO_CATCHUP : 1;
    this.lag += rawMs * (1 - rate);
    if (this.lag < 0) {
      // The last catch-up frame overshot: run it just fast enough.
      rate += this.lag / Math.max(rawMs, 1e-6);
      this.lag = 0;
    }
    this.rate = rate;
    return rate;
  }

  /** A wall-clock stamp on the FX clock. */
  toFx(wallMs: number): number {
    return wallMs - this.lag;
  }

  reset(): void {
    this.lag = 0;
    this.rate = 1;
    this.startAt = Number.NEGATIVE_INFINITY;
  }
}

// --- Camera cues ---------------------------------------------------------------

/** The carrier break-up cam, and the nudge toward an own kill's wreck. */
export type CueKind = "breakup" | "nudge";

/** The break-up cam's length and how far it turns the view (0..1 of the
 * way onto the falling carrier). */
export const BREAKUP_CAM_MS = 2600;
export const BREAKUP_CAM_PEAK = 0.85;
/** The wreck-spiral nudge: short and slight — a glance, not a takeover. */
export const NUDGE_MS = 900;
export const NUDGE_PEAK = 0.22;
/** Every cue eases in over this, and out (or off a cancel) over that, ms. */
export const CUE_IN_MS = 350;
export const CUE_OUT_MS = 450;
/** Below this altitude a cue is cancelled: the pilot needs the view, m. */
export const CUE_MIN_ALT = 60;

const smooth01 = (u: number): number => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
};

/** One cue's look-weight `age` ms in (0 outside it). */
export function cueWeight(age: number, durMs: number, peak: number): number {
  if (!(age >= 0) || age >= durMs) return 0;
  return (
    peak * smooth01(age / CUE_IN_MS) * smooth01((durMs - age) / CUE_OUT_MS)
  );
}

/**
 * The live camera cue (one at a time: the break-up cam outranks a nudge).
 * A cancel never snaps the view back — it fades from where it stands over
 * CUE_OUT_MS, so skipping is a smooth hand-back, not a jolt.
 */
export class CamCue {
  kind: CueKind | null = null;
  /** Why the last cue ended early (QA), or null. */
  cancelReason: string | null = null;
  private startAt = 0;
  private durMs = 0;
  private peak = 0;
  private cancelAt = Number.NEGATIVE_INFINITY;
  private cancelFrom = 0;

  start(kind: CueKind, now: number): void {
    if (kind === "nudge" && this.kind === "breakup" && this.weight(now) > 0) {
      return;
    }
    this.kind = kind;
    this.startAt = now;
    this.durMs = kind === "breakup" ? BREAKUP_CAM_MS : NUDGE_MS;
    this.peak = kind === "breakup" ? BREAKUP_CAM_PEAK : NUDGE_PEAK;
    this.cancelAt = Number.NEGATIVE_INFINITY;
    this.cancelReason = null;
  }

  /** End the live cue early (a fresh press, a hit, too low…). */
  cancel(now: number, reason: string): void {
    if (this.kind === null || this.cancelAt > Number.NEGATIVE_INFINITY) return;
    const w = this.weight(now);
    if (w <= 0) return;
    this.cancelFrom = w;
    this.cancelAt = now;
    this.cancelReason = reason;
  }

  /** The look-weight at `now`, 0..peak (0: no cue). */
  weight(now: number): number {
    if (this.kind === null) return 0;
    if (this.cancelAt > Number.NEGATIVE_INFINITY) {
      const u = (now - this.cancelAt) / CUE_OUT_MS;
      if (u >= 1) {
        this.kind = null;
        return 0;
      }
      return this.cancelFrom * (1 - smooth01(u));
    }
    const w = cueWeight(now - this.startAt, this.durMs, this.peak);
    if (w <= 0 && now - this.startAt >= this.durMs) this.kind = null;
    return w;
  }

  /** True while a cue is still running (not yet cancelled or over). */
  live(now: number): boolean {
    return (
      this.kind !== null &&
      this.cancelAt === Number.NEGATIVE_INFINITY &&
      now - this.startAt < this.durMs
    );
  }
}

/** A key press that skips a cue: fresh (not auto-repeat) and not a key the
 * pilot was already holding when the cue began. */
export function freshPress(
  repeat: boolean,
  code: string,
  heldAtStart: ReadonlySet<string>,
): boolean {
  return !repeat && !heldAtStart.has(code);
}

// --- Explosion shake -------------------------------------------------------------

/** Peak camera shake right at a blast of size 1, m, and its falloff. */
export const BLAST_SHAKE_PEAK = 1.6;
export const BLAST_SHAKE_RANGE_M = 520;
const BLAST_SHAKE_DECAY_MS = 360;
const BLAST_SHAKE_LIFE_MS = 1500;
/** Shake slots: the oldest is overwritten (a fixed ring, nothing grows). */
export const BLAST_SHAKE_SLOTS = 6;

/** The shake a blast of `size` (≈0.5 a pop … 2 the carrier) `distance` m
 * away leaves `ageMs` later, m — quadratic in closeness. */
export function blastShakeAmp(
  distance: number,
  ageMs: number,
  size: number,
): number {
  if (!(ageMs >= 0) || ageMs > BLAST_SHAKE_LIFE_MS) return 0;
  const range = BLAST_SHAKE_RANGE_M * Math.sqrt(Math.max(size, 0));
  if (!(distance < range)) return 0;
  const near = 1 - distance / range;
  return (
    BLAST_SHAKE_PEAK *
    size *
    near *
    near *
    Math.exp(-ageMs / BLAST_SHAKE_DECAY_MS)
  );
}

/** Recent blasts' shake, added onto the display camera's offset. */
export class ExplosionShake {
  private readonly amp = new Float64Array(BLAST_SHAKE_SLOTS);
  private readonly at = new Float64Array(BLAST_SHAKE_SLOTS).fill(
    Number.NEGATIVE_INFINITY,
  );
  private next = 0;

  /** A blast of `size` landed `distance` m from the camera at `now`. */
  add(distance: number, size: number, now: number): void {
    const a = blastShakeAmp(distance, 0, size);
    if (a <= 0) return;
    this.amp[this.next] = a;
    this.at[this.next] = now;
    this.next = (this.next + 1) % BLAST_SHAKE_SLOTS;
  }

  /** The summed shake amplitude at `now`, m. */
  level(now: number): number {
    let a = 0;
    for (let i = 0; i < BLAST_SHAKE_SLOTS; i++) {
      const age = now - (this.at[i] as number);
      if (age < 0 || age > BLAST_SHAKE_LIFE_MS) continue;
      a += (this.amp[i] as number) * Math.exp(-age / BLAST_SHAKE_DECAY_MS);
    }
    return a;
  }

  /** Add this frame's shake into `out` (display offset, m). */
  addInto(out: Vec3, now: number): void {
    const a = this.level(now);
    if (a <= 0) return;
    const t = now / 1000;
    out.x += (Math.sin(t * 57 + 0.9) + Math.sin(t * 33 + 2.2)) * 0.5 * a;
    out.y += (Math.sin(t * 49 + 0.2) + Math.sin(t * 27 + 1.4)) * 0.6 * a;
    out.z += (Math.sin(t * 43 + 1.7) + Math.sin(t * 29 + 0.6)) * 0.5 * a;
  }
}

/** The SCREEN SHAKE setting. */
export type ShakeSetting = "full" | "reduced" | "off";
export const SHAKE_SETTINGS: readonly ShakeSetting[] = [
  "full",
  "reduced",
  "off",
];

/** The scale every displayed-camera shake gets: reduced motion (or OFF)
 * takes it all away; REDUCED keeps a hint of it. */
export function shakeScale(s: ShakeSetting, reducedMotion: boolean): number {
  if (reducedMotion || s === "off") return 0;
  return s === "reduced" ? 0.35 : 1;
}
