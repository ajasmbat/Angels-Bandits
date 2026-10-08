// Animated signage schedule (L7) — the pure seam behind the moving neon:
// which sign runs which animation, the shared shader clock, the rare broken
// tube's stutter schedule and its buzz falloff. No THREE in here. Everything
// derives from (world seed, sign index in the deterministic signageFor()
// order) and the synced server clock, so every client sees the same ticker
// letters crawl past and the same tube fail at the same instant.
//
// signage-shader.ts interpolates the constants below straight into its GLSL,
// and the gain helpers here mirror what the shader computes — so the tests
// that pin "peak stays on the SIGN rung" test the numbers the GPU runs.

import { mulberry32 } from "@angels-bandits/common/city";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import type { PaletteColor, SignPlacement } from "./signage";

// --- Animation kinds (the shader switches on these; keep them small ints) ---
export const ANIM_STATIC = 0;
/** Marquee: the glyph stack scrolls upward inside the fixed neon frame. */
export const ANIM_GLYPH_TICKER = 1;
/** Marquee: a ring of bulbs around the frame chases in thirds. */
export const ANIM_CHASE = 2;
/** Billboard: procedural "video" cutting between three programmes. */
export const ANIM_VIDEO = 3;
/** Storefront strip: a scrolling LED dot-matrix ticker. */
export const ANIM_LED_TICKER = 4;

/**
 * The shader clock wraps every SIGN_LOOP_S seconds (keeps a highp float far
 * from precision trouble). Every period below divides it exactly, so the
 * wrap is invisible: the frame at t = L is the frame at t = 0.
 */
export const SIGN_LOOP_S = 240;

// --- Per-kind shares (of their own sign kind) ---
const MARQUEE_TICKER_SHARE = 0.3;
const MARQUEE_CHASE_SHARE = 0.3;
const BILLBOARD_VIDEO_SHARE = 0.8;
const STRIP_TICKER_SHARE = 0.3;

// --- Glyph ticker (marquees) ---
/** Inner-frame scroll cycles per loop: one glyph-stack height per 6–10 s. */
const GLYPH_CYCLES_MIN = 24;
const GLYPH_CYCLES_MAX = 40;

// --- Chasing bulbs (marquees) ---
/** Chase steps per loop → 2–4 steps/s (each bulb lights every third step).
 * Always a multiple of 3, so the lit third is the same at t = L as t = 0. */
const CHASE_THIRDS_MIN = 160;
const CHASE_THIRDS_MAX = 320;
/** Bulb ring brightness, of the sign's own tint. */
export const CHASE_ON = 1;
export const CHASE_OFF = 0.22;
/** Dark band between bulbs on the ring. */
export const CHASE_GAP = 0.1;
/** Bulb spacing along the ring and bulb radius, meters. */
export const CHASE_SPACING_M = 0.38;
export const CHASE_RADIUS_M = 0.12;

// --- LED ticker (strips) ---
/** One message repeats every this many dot columns (4 columns per glyph). */
export const LED_MESSAGE_COLS = 96;
/** Message cycles per loop → 0.4–0.8 messages/s ≈ 4.5–9 m/s of crawl. */
const LED_CYCLES_MIN = 20;
const LED_CYCLES_MAX = 40;
/** Dot rows over the strip's height (the 3×5 fake glyphs fill them). */
export const LED_ROWS = 5;
export const LED_LIT = 1;
export const LED_UNLIT = 0.16;
export const LED_BACKING = 0.05;
/** Dot radius, of the cell pitch. */
export const LED_DOT_R = 0.36;
/** The panel's average — what the far fade blends to once a dot is smaller
 * than a pixel (no shimmer, no moiré): ~45% of the fake-glyph dots lit,
 * dots covering πr² of each cell, backing between them. */
const LED_DOT_AREA = Math.PI * LED_DOT_R * LED_DOT_R;
export const LED_MEAN =
  LED_DOT_AREA * (0.45 * LED_LIT + 0.55 * LED_UNLIT) +
  (1 - LED_DOT_AREA) * LED_BACKING;

// --- Video billboards ---
/** Hard cuts between programmes every this many seconds (≥ 8 s apart, so a
 * cut never reads as a flicker). Each fits the loop a multiple-of-3 times,
 * so the three-programme rotation is on the same programme at t = L. */
export const VIDEO_CUT_S = [8, 10, 16, 20] as const;
/** Colour-field band drift period, seconds. */
export const VIDEO_FIELD_S = 8;
/** Product spin period, seconds. */
export const VIDEO_SPIN_S = 4;
/** Slow-pan ping-pong period, seconds. */
export const VIDEO_PAN_S = 24;
/** Background level behind the spinning product. */
export const VIDEO_BACKDROP = 0.22;
/** Darkest a colour field band gets, of the tint. */
export const VIDEO_FIELD_FLOOR = 0.55;

// --- Broken neon ---
/** Broken tubes: this share of ALL signs (marquees + billboards + strips),
 * drawn only from the neon kinds (marquees, strips), rank-picked so the
 * count is exact rather than a hash-threshold average. */
export const BROKEN_SHARE = 0.015;
/** Hard ceiling the ticket promises — BROKEN_SHARE stays under it. */
export const BROKEN_SHARE_MAX = 0.02;
/** Stutter schedule: at most one burst per slot. */
export const STUTTER_SLOT_MS = 30_000;
/** A burst starts within the slot's first STUTTER_WINDOW_MS … */
export const STUTTER_WINDOW_MS = 8_500;
/** … and lasts at most this long, so it ends by 10 s into the slot and the
 * next one cannot start before 30 s: ≥ 20 s between bursts by construction. */
export const STUTTER_BURST_MAX_MS = 1_500;
export const STUTTER_BURST_MIN_MS = 600;
/** Share of slots that carry a burst ("occasionally" — O5 made it rarer:
 * at 0.45 a busy street always had one tube mid-stutter in view). */
export const STUTTER_CHANCE = 0.3;
/** Inside a burst the tube dips to this, never to black … */
export const STUTTER_DIP = 0.35;
/** … in dips of this length, no faster than 3 per second (photosensitivity
 * guidance: ≤ 3 flashes/s), so it reads as a failing tube, not a bug. */
export const STUTTER_FLASH_MS = 1000 / 3;
/** Share of each flash period spent dipped. */
const STUTTER_DUTY = 0.5;

/**
 * The dip `into` ms after a burst started: a raised-cosine trough over the
 * first STUTTER_DUTY of each flash period, down to STUTTER_DIP and back, 1
 * for the rest. O5: the dips used to be a square wave — a whole-tube step
 * between two frames, which reads as render flicker rather than a failing
 * tube. Same depth, same ≤ 3 dips per second, no hard edge.
 */
function stutterDip(into: number): number {
  const phase = (into % STUTTER_FLASH_MS) / STUTTER_FLASH_MS;
  if (phase >= STUTTER_DUTY) return 1;
  const w = Math.sin((Math.PI * phase) / STUTTER_DUTY);
  return 1 - (1 - STUTTER_DIP) * w * w;
}

/** Buzz audible inside this torus distance, meters. */
export const BUZZ_RANGE_M = 45;
/** Hum level between bursts, of the in-burst crackle. */
export const BUZZ_HUM = 0.3;

/** One sign's animation, packed for the per-instance `aAnim` attribute. */
export interface SignAnim {
  kind: number;
  /** Integer cycles per loop (ticker/chase/LED) or the cut length in s
   * (video). */
  rate: number;
  /** 0..1 phase offset. */
  phase: number;
  /** Kind-specific: LED message seed, or the video's second palette index. */
  variant: number;
  /** Index into the broken-tube stutter array, −1 when healthy. */
  brokenSlot: number;
}

export interface SignageAnimation {
  marquees: SignAnim[];
  billboards: SignAnim[];
  strips: SignAnim[];
  /** Per broken slot: its stutter seed and the sign it lives on. */
  broken: { seed: number; kind: "marquee" | "strip"; index: number }[];
}

/** Salted stream for one sign kind (salts keep kinds independent). */
const SALT_MARQUEE = 0x4c37a1;
const SALT_BILLBOARD = 0x4c37b2;
const SALT_STRIP = 0x4c37c3;
const SALT_BROKEN = 0x4c37d4;

const intIn = (r: number, lo: number, hi: number): number =>
  lo + Math.floor(r * (hi - lo + 1));

/**
 * Deterministic animation for the city's signs, given in the Signage
 * renderer's order (signageFor() over the building list). The PRNG streams
 * are seeded from the world seed and walk the lists in order, so the sign at
 * index i is the same sign with the same animation on every client.
 */
export function signAnimations(
  marquees: readonly SignPlacement[],
  billboards: readonly SignPlacement[],
  strips: readonly SignPlacement[],
  seed: number,
): SignageAnimation {
  const rm = mulberry32((seed ^ SALT_MARQUEE) >>> 0);
  const outMarquees = marquees.map((): SignAnim => {
    const pick = rm();
    const phase = rm();
    if (pick < MARQUEE_TICKER_SHARE) {
      return {
        kind: ANIM_GLYPH_TICKER,
        rate: intIn(rm(), GLYPH_CYCLES_MIN, GLYPH_CYCLES_MAX),
        phase,
        variant: 0,
        brokenSlot: -1,
      };
    }
    if (pick < MARQUEE_TICKER_SHARE + MARQUEE_CHASE_SHARE) {
      return {
        kind: ANIM_CHASE,
        rate: 3 * intIn(rm(), CHASE_THIRDS_MIN, CHASE_THIRDS_MAX),
        phase,
        variant: 0,
        brokenSlot: -1,
      };
    }
    return { kind: ANIM_STATIC, rate: 0, phase, variant: 0, brokenSlot: -1 };
  });

  const rb = mulberry32((seed ^ SALT_BILLBOARD) >>> 0);
  const outBillboards = billboards.map((b): SignAnim => {
    const pick = rb();
    const phase = rb();
    const cut = VIDEO_CUT_S[Math.floor(rb() * VIDEO_CUT_S.length)] as number;
    // Second colour-field hue: any palette entry but the sign's own.
    const other = (b.paletteIndex + 1 + Math.floor(rb() * 4)) % 5;
    if (pick < BILLBOARD_VIDEO_SHARE) {
      return {
        kind: ANIM_VIDEO,
        rate: cut,
        phase,
        variant: other,
        brokenSlot: -1,
      };
    }
    return { kind: ANIM_STATIC, rate: 0, phase, variant: 0, brokenSlot: -1 };
  });

  const rs = mulberry32((seed ^ SALT_STRIP) >>> 0);
  const outStrips = strips.map((): SignAnim => {
    const pick = rs();
    const phase = rs();
    const message = Math.floor(rs() * 256);
    if (pick < STRIP_TICKER_SHARE) {
      return {
        kind: ANIM_LED_TICKER,
        rate: intIn(rs(), LED_CYCLES_MIN, LED_CYCLES_MAX),
        phase,
        variant: message,
        brokenSlot: -1,
      };
    }
    return { kind: ANIM_STATIC, rate: 0, phase, variant: 0, brokenSlot: -1 };
  });

  // Broken tubes: rank every neon sign by a salted draw, take the exact count.
  const rk = mulberry32((seed ^ SALT_BROKEN) >>> 0);
  const candidates = [
    ...marquees.map((_, index) => ({ kind: "marquee" as const, index })),
    ...strips.map((_, index) => ({ kind: "strip" as const, index })),
  ].map((c) => ({ ...c, key: rk() }));
  candidates.sort((a, b) => a.key - b.key);
  const total = marquees.length + billboards.length + strips.length;
  const count = Math.min(candidates.length, Math.floor(total * BROKEN_SHARE));
  const broken = candidates.slice(0, count).map((c, slot) => {
    const anims = c.kind === "marquee" ? outMarquees : outStrips;
    (anims[c.index] as SignAnim).brokenSlot = slot;
    return {
      seed: (seed ^ Math.imul(slot + 1, 0x9e3779b9) ^ SALT_BROKEN) >>> 0,
      kind: c.kind,
      index: c.index,
    };
  });

  return {
    marquees: outMarquees,
    billboards: outBillboards,
    strips: outStrips,
    broken,
  };
}

// --- The shader clock and its CPU mirrors ---

/** Synced ms → the shader's wrapped seconds, [0, SIGN_LOOP_S). */
export function signClock(ms: number): number {
  const loopMs = SIGN_LOOP_S * 1000;
  return (((ms % loopMs) + loopMs) % loopMs) / 1000;
}

/** Glyph ticker: scroll fraction of the inner frame, [0, 1). */
export function glyphScroll(a: SignAnim, t: number): number {
  const x = (t / SIGN_LOOP_S) * a.rate + a.phase;
  return x - Math.floor(x);
}

/** Chase: the integer step the bulb ring is on (bulb b is lit when
 * (b + step) mod 3 == 0). */
export function chaseStep(a: SignAnim, t: number): number {
  return Math.floor((t / SIGN_LOOP_S) * a.rate + a.phase * 3);
}

/** LED ticker: scroll offset in dot columns, [0, LED_MESSAGE_COLS). */
export function ledScroll(a: SignAnim, t: number): number {
  const x = (t / SIGN_LOOP_S) * a.rate + a.phase;
  return (x - Math.floor(x)) * LED_MESSAGE_COLS;
}

/** Video: which programme is on (0 fields, 1 spin, 2 pan). */
export function videoMode(a: SignAnim, t: number): number {
  return ((Math.floor(t / a.rate + a.phase * 3) % 3) + 3) % 3;
}

/** Bulb brightness on the chase ring, of the sign tint. */
export const chaseGain = (bulb: number, step: number): number =>
  (((bulb + step) % 3) + 3) % 3 === 0 ? CHASE_ON : CHASE_OFF;

/** LED brightness: `dot` is the dot coverage 0..1 (backing → dot), `lit`
 * whether the dot is on, `fade` the far blend toward the mean (0 = full
 * detail, 1 = sub-pixel dots). */
export const ledGain = (lit: boolean, dot: number, fade: number): number => {
  const near = LED_BACKING + ((lit ? LED_LIT : LED_UNLIT) - LED_BACKING) * dot;
  return near * (1 - fade) + LED_MEAN * fade;
};

/** Colour-field band brightness at band coordinate x (any real). */
export const fieldGain = (x: number): number =>
  VIDEO_FIELD_FLOOR +
  (1 - VIDEO_FIELD_FLOOR) * (0.5 + 0.5 * Math.sin(x * 2 * Math.PI));

/** Spinning product's face shade at time t, s: brightest face-on. */
export const spinGain = (t: number): number =>
  0.45 + 0.55 * Math.abs(Math.cos((t / VIDEO_SPIN_S) * 2 * Math.PI));

// --- Broken-tube stutter ---

/** The burst (if any) in stutter slot `slot`, ms from the slot start. */
export function burstIn(
  seed: number,
  slot: number,
): { start: number; duration: number } | null {
  const r = mulberry32((seed ^ Math.imul(slot, 0x85ebca6b)) >>> 0);
  if (r() >= STUTTER_CHANCE) return null;
  return {
    start: Math.floor(r() * STUTTER_WINDOW_MS),
    duration:
      STUTTER_BURST_MIN_MS +
      Math.floor(r() * (STUTTER_BURST_MAX_MS - STUTTER_BURST_MIN_MS)),
  };
}

/** Broken tube's brightness multiplier at synced `ms`: 1 outside a burst;
 * inside one, a smooth trough to STUTTER_DIP over the first half of each
 * ≤ 3 Hz flash period (stutterDip). */
export function stutterAt(seed: number, ms: number): number {
  const slot = Math.floor(ms / STUTTER_SLOT_MS);
  const burst = burstIn(seed, slot);
  if (!burst) return 1;
  const into = ms - slot * STUTTER_SLOT_MS - burst.start;
  if (into < 0 || into >= burst.duration) return 1;
  return stutterDip(into);
}

/** Is the tube inside a burst at `ms` (drives the louder buzz)? */
export function inBurst(seed: number, ms: number): boolean {
  const slot = Math.floor(ms / STUTTER_SLOT_MS);
  const burst = burstIn(seed, slot);
  if (!burst) return false;
  const into = ms - slot * STUTTER_SLOT_MS - burst.start;
  return into >= 0 && into < burst.duration;
}

/** Buzz loudness 0..1 at torus distance `d` meters: quadratic falloff,
 * silent at and beyond BUZZ_RANGE_M. */
export function buzzLevel(d: number): number {
  if (!(d < BUZZ_RANGE_M)) return 0;
  const k = 1 - Math.max(0, d) / BUZZ_RANGE_M;
  return k * k;
}

/** Rec. 709 luminance — the ladder's measure (same as emissive.ts). */
const luma = (c: PaletteColor): number =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** The palette lifted to `rung` luminance — what the video colour fields
 * mix between. A mix of two colours of equal luminance has that luminance,
 * so a field never climbs off the rung. */
export function rungPalette(
  palette: readonly PaletteColor[],
  rung: number,
): PaletteColor[] {
  return palette.map((c) => {
    const k = rung / luma(c);
    return { r: c.r * k, g: c.g * k, b: c.b * k };
  });
}

/** What Signage.buzz() hands main: the nearest broken tube and its level. */
export interface NeonBuzz {
  /** Canonical tube center (the listener's spatialize() wraps it). */
  pos: Vec3;
  /** 0..1 loudness, distance falloff × hum/crackle. */
  gain: number;
}

/**
 * The broken tubes at runtime: per-frame stutter levels for the shader's
 * uniform array, and the buzz source. Bursts are cached per slot so a frame
 * costs no PRNG construction (one per tube every 30 s).
 */
export class BrokenNeon {
  private readonly seeds: number[];
  private readonly centers: Vec3[];
  private readonly slot: number[];
  private readonly start: number[];
  private readonly duration: number[];
  private readonly result: NeonBuzz = { pos: { x: 0, y: 0, z: 0 }, gain: 0 };

  constructor(tubes: readonly { seed: number; center: Vec3 }[]) {
    this.seeds = tubes.map((t) => t.seed);
    this.centers = tubes.map((t) => t.center);
    this.slot = tubes.map(() => Number.NaN);
    this.start = tubes.map(() => 0);
    this.duration = tubes.map(() => 0);
  }

  get count(): number {
    return this.seeds.length;
  }

  /** Refresh tube i's cached burst for `ms`'s slot; ms into it, or −1. */
  private into(i: number, ms: number): number {
    const slot = Math.floor(ms / STUTTER_SLOT_MS);
    if (this.slot[i] !== slot) {
      const burst = burstIn(this.seeds[i] as number, slot);
      this.slot[i] = slot;
      this.start[i] = burst ? burst.start : 0;
      this.duration[i] = burst ? burst.duration : 0;
    }
    const into = ms - slot * STUTTER_SLOT_MS - (this.start[i] as number);
    return into >= 0 && into < (this.duration[i] as number) ? into : -1;
  }

  /** Tube i's brightness multiplier at `ms` — identical to stutterAt(). */
  level(i: number, ms: number): number {
    const into = this.into(i, ms);
    if (into < 0) return 1;
    return stutterDip(into);
  }

  /** Nearest tube to the listener (torus distance) and its buzz level. The
   * returned object is reused every call. */
  buzz(listener: Vec3, ms: number): NeonBuzz {
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.centers.length; i++) {
      const d = wrapDelta(listener, this.centers[i] as Vec3);
      const dist = Math.hypot(d.x, d.y, d.z);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    }
    this.result.gain = 0;
    if (best < 0) return this.result;
    const c = this.centers[best] as Vec3;
    this.result.pos.x = c.x;
    this.result.pos.y = c.y;
    this.result.pos.z = c.z;
    const near = buzzLevel(bestD);
    if (near <= 0) return this.result;
    const lvl = this.level(best, ms);
    const burst = this.into(best, ms) >= 0;
    // Hum between bursts; crackle through the burst, peaking on the dips.
    this.result.gain =
      near * (burst ? 0.6 + (0.4 * (1 - lvl)) / (1 - STUTTER_DIP) : BUZZ_HUM);
    return this.result;
  }

  /** QA: each tube's center and the start of its next burst at or after
   * `fromMs` (synced ms), searching the next hour of slots. */
  nextBursts(fromMs: number): { center: Vec3; at: number; ms: number }[] {
    return this.seeds.map((seed, i) => {
      const first = Math.floor(fromMs / STUTTER_SLOT_MS);
      for (let s = first; s < first + 120; s++) {
        const b = burstIn(seed, s);
        const at = s * STUTTER_SLOT_MS + (b?.start ?? 0);
        if (b && at + b.duration > fromMs) {
          return { center: this.centers[i] as Vec3, at, ms: b.duration };
        }
      }
      return { center: this.centers[i] as Vec3, at: -1, ms: 0 };
    });
  }
}
