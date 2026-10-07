// Graphics quality tiers (O3). One table says what every Living City feature
// does on High, Medium and Low; main.ts hands the chosen tier to each
// module's `setQuality` and caps the adaptive resolution scaler with it.
//
// Two rules every tier obeys, and the reason the table is shaped like this:
//
//  1. A tier switch never compiles a shader. Tiers only flip `.visible`,
//     instance/draw counts and uniforms — never a material, a `#define` or
//     an object added to the scene later. O2 pre-warms every program at
//     boot, so a switch mid-fight costs nothing, and Auto can step down
//     without the very hitch it is stepping down to avoid.
//  2. Visibility parity. Fog, haze, the storm (bolts, flash, reveals), the
//     cloud deck and every SOLID thing (buildings, movers, the train and its
//     viaduct, bridges, boats, trees) are identical on every tier, so a Low
//     player never sees further or through anything a High player cannot.
//     Rain streaks are near-field dressing; the weather's haze is the
//     visibility mechanism and it does not change.
//
// The resolution scaler (resolution.ts) stays the first line of defence: it
// trades pixels for frame time within a tier's ceiling. The Auto tier logic
// sits ABOVE it and only acts once the scaler has already given up most of
// its pixels and frames still miss — then it trades features instead.

import {
  FRAME_BUDGET_MS,
  MISS_SHARE,
  type ResolutionLimits,
  defaultLimits,
} from "./resolution";

export type QualityTier = "high" | "medium" | "low";
/** What the player picks: a fixed tier, or Auto (starts High, steps down). */
export type QualitySetting = "auto" | QualityTier;

/** The G key and the HUD entry cycle through these, in this order. */
export const QUALITY_SETTINGS: readonly QualitySetting[] = [
  "auto",
  "high",
  "medium",
  "low",
];
/** What ships: Auto. On a machine that holds 60 fps it never leaves High. */
export const DEFAULT_QUALITY: QualitySetting = "auto";
/** Cycles the setting (the HUD entry does the same on click). */
export const QUALITY_KEY = "KeyG";
/** localStorage key for the player's pick (a `?quality=` URL wins over it). */
export const QUALITY_STORAGE_KEY = "ab-quality";

/** Per-tier knobs. 1 = full, 0 = off, in between = reduced. */
export interface QualityProfile {
  /** Ceiling on the adaptive pixel ratio (the panel's own ceiling still applies). */
  maxPixelRatio: number;
  /** L4 rain streaks drawn, share of the full count. */
  rainDensity: number;
  /** L1 micro tier: share of pedestrians kept (scales the altitude gate's thinning). */
  crowdDensity: number;
  /** L1 reactive city: share of each kill-site smoke column's puffs. */
  smokeColumns: number;
  /** L3 living windows: TV flicker, silhouettes, slow on/off, cleaning crew. */
  livingWindows: boolean;
  /** L6 headlight cones (the additive volumes). The ground pools stay on. */
  headlightCones: boolean;
  /** L7 the coloured light each sign spills onto the street. */
  signSpill: boolean;
  /** L8 rooftop string lights (the party/pool props stay). */
  rooftopLights: boolean;
  /** L9 crowns sway in the shared wind. */
  treeSway: boolean;
  /** L9 fountain spray, share of particles. */
  fountains: number;
  /** L9 birds drawn per flock, share. */
  birds: number;
  /** L10 airliner contrail length, share. */
  contrails: number;
  /** L13 fire escapes, balconies, AC units, scaffolding. */
  facadeDetail: boolean;
}

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: {
    maxPixelRatio: 2,
    rainDensity: 1,
    crowdDensity: 1,
    smokeColumns: 1,
    livingWindows: true,
    headlightCones: true,
    signSpill: true,
    rooftopLights: true,
    treeSway: true,
    fountains: 1,
    birds: 1,
    contrails: 1,
    facadeDetail: true,
  },
  medium: {
    maxPixelRatio: 1.5,
    rainDensity: 0.5,
    crowdDensity: 0.7,
    smokeColumns: 1,
    livingWindows: true,
    headlightCones: true,
    signSpill: true,
    rooftopLights: true,
    treeSway: true,
    fountains: 0.5,
    birds: 1,
    contrails: 1,
    facadeDetail: true,
  },
  low: {
    maxPixelRatio: 1,
    rainDensity: 0.35,
    crowdDensity: 0.4,
    smokeColumns: 0.5,
    livingWindows: false,
    headlightCones: false,
    signSpill: false,
    rooftopLights: false,
    treeSway: false,
    fountains: 0,
    birds: 0.5,
    contrails: 0.5,
    facadeDetail: false,
  },
};

type Behaviour = "full" | "reduced" | "off";

/**
 * Every Living City feature, per tier — the contract the PR and README
 * quote. Features that are "full" on every tier say why: they are solid
 * (the crash check and the camera arm collide with them), audio, or cost
 * nothing on the GPU worth trading.
 */
export const FEATURE_TIERS: readonly {
  feature: string;
  high: Behaviour;
  medium: Behaviour;
  low: Behaviour;
  note: string;
}[] = [
  {
    feature: "L1 reactive city — alarms, lit windows, responders",
    high: "full",
    medium: "full",
    low: "full",
    note: "gameplay-adjacent (kill sites); CPU only",
  },
  {
    feature: "L1 reactive city — smoke columns",
    high: "full",
    medium: "full",
    low: "reduced",
    note: "half the puffs per column",
  },
  {
    feature: "L1 street life — pedestrians",
    high: "full",
    medium: "reduced",
    low: "reduced",
    note: "70 % / 40 % of the crowd",
  },
  {
    feature: "L1 street life — steam, signals, sparks",
    high: "full",
    medium: "full",
    low: "full",
    note: "already altitude-gated",
  },
  {
    feature: "L2 city soundscape",
    high: "full",
    medium: "full",
    low: "full",
    note: "audio, no GPU cost",
  },
  {
    feature: "L3 living windows",
    high: "full",
    medium: "full",
    low: "off",
    note: "uniform guard: static window grid",
  },
  {
    feature: "L4 rain streaks",
    high: "full",
    medium: "reduced",
    low: "reduced",
    note: "50 % / 35 % of the streaks; haze unchanged",
  },
  {
    feature: "L4 wet streets, puddles",
    high: "full",
    medium: "full",
    low: "full",
    note: "uniform-only",
  },
  {
    feature: "L5 elevated train + viaduct",
    high: "full",
    medium: "full",
    low: "full",
    note: "solid",
  },
  {
    feature: "L6 traffic (cars, buses, responders)",
    high: "full",
    medium: "full",
    low: "full",
    note: "feeds audio and reactions; one instanced draw",
  },
  {
    feature: "L6 headlight cones",
    high: "full",
    medium: "full",
    low: "off",
    note: "additive fill; the ground pools stay",
  },
  {
    feature: "L7 signage animation",
    high: "full",
    medium: "full",
    low: "full",
    note: "uniform clock",
  },
  {
    feature: "L7 sign light spill",
    high: "full",
    medium: "full",
    low: "off",
    note: "additive ground decals",
  },
  {
    feature: "L8 rooftop props (pools, fans, flags)",
    high: "full",
    medium: "full",
    low: "full",
    note: "one merged mesh",
  },
  {
    feature: "L8 rooftop string lights",
    high: "full",
    medium: "full",
    low: "off",
    note: "point sprites",
  },
  {
    feature: "L9 tree sway",
    high: "full",
    medium: "full",
    low: "off",
    note: "crowns hold still",
  },
  {
    feature: "L9 fountains",
    high: "full",
    medium: "reduced",
    low: "off",
    note: "half the spray / none",
  },
  {
    feature: "L9 birds",
    high: "full",
    medium: "full",
    low: "reduced",
    note: "half of each flock",
  },
  {
    feature: "L10 airliners",
    high: "full",
    medium: "full",
    low: "reduced",
    note: "contrails half as long",
  },
  {
    feature: "L10 news helicopter, drone shows",
    high: "full",
    medium: "full",
    low: "full",
    note: "solid mover / shared light cloud",
  },
  {
    feature: "L11 river, bridges, boats",
    high: "full",
    medium: "full",
    low: "full",
    note: "solid",
  },
  {
    feature: "L12 sky cycle",
    high: "full",
    medium: "full",
    low: "full",
    note: "uniforms only",
  },
  {
    feature: "L13 facade detail",
    high: "full",
    medium: "full",
    low: "off",
    note: "not solid; dressing only",
  },
];

/**
 * The adaptive scaler's limits under a tier: the panel's own limits with the
 * ceiling capped at the tier's `maxPixelRatio`. A pinned `?res=` ignores
 * this on purpose — a pinned ratio is a QA instrument, and it must draw
 * exactly what it says or the harness compares two different workloads.
 */
export function qualityLimits(
  devicePixelRatio: number,
  tier: QualityTier,
): ResolutionLimits {
  const panel = defaultLimits(devicePixelRatio);
  const ceiling = Math.min(panel.ceiling, QUALITY_PROFILES[tier].maxPixelRatio);
  return { floor: Math.min(panel.floor, ceiling), ceiling };
}

/** A `?quality=` / localStorage value, or null when absent or junk. */
export function parseQualitySetting(
  raw: string | null | undefined,
): QualitySetting | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  return (QUALITY_SETTINGS as readonly string[]).includes(v)
    ? (v as QualitySetting)
    : null;
}

/** The next setting in the G / menu cycle. */
export function nextQualitySetting(s: QualitySetting): QualitySetting {
  const i = QUALITY_SETTINGS.indexOf(s);
  return QUALITY_SETTINGS[(i + 1) % QUALITY_SETTINGS.length] as QualitySetting;
}

/** The tier one step cheaper, or null at the bottom. */
export function tierBelow(t: QualityTier): QualityTier | null {
  return t === "high" ? "medium" : t === "medium" ? "low" : null;
}

// --- Auto ------------------------------------------------------------------
//
// Auto starts at High and only ever steps DOWN. Stepping up would mean
// probing a tier we already know misses, and a feature popping back in is
// far more visible than one resolution rung; a player who wants it back
// picks a tier by hand.
//
// The evidence is the scaler's own: the share of missed frames over its
// window. But a miss only counts as PRESSURE once pixels can no longer fix
// it — either the scaler is already at or below AUTO_RATIO_GATE, or the
// frame is CPU-BOUND: the window's median JS cost BEFORE the render call
// (sim, streaming, instance packing — measured for free with
// performance.now()) is already most of the budget, so no resolution rung
// can bring it under. The render call itself is deliberately NOT timed: a
// driver may block inside it waiting on the GPU, which would make a
// GPU-bound frame read as CPU-bound — exactly backwards.
// The second test is what stops a CPU-bound machine from walking four
// useless resolution rungs before it sheds a single feature. After a drop
// main.ts keeps the scaler's current ratio but clears its latch, so the
// cheaper tier earns its pixels back rung by rung — the player does not stay
// blurry AND reduced while the latch slowly relaxes, and does not re-walk
// the rungs that just missed either.
//
// What does NOT count, because none of it is the machine's steady state:
// a hidden tab, the first frames back from one, death/respawn, a resize, a
// teleport. main.ts calls `interruptAutoQuality` on each, which restarts the
// unbroken-pressure clock. A single GC pause or alt-tab spike can never
// drop a tier: it takes AUTO_PRESSURE_MS of back-to-back bad windows.

/** The scaler ratio at or below which a miss is evidence against the tier. */
export const AUTO_RATIO_GATE = 1;
/**
 * Median pre-render JS cost, as a share of FRAME_BUDGET_MS, at or above
 * which a window is CPU-bound. Pixels do not enter that number at all, so
 * one this close to the budget cannot be rescued by drawing fewer of them.
 */
export const AUTO_CPU_BOUND = 0.8;
/** Unbroken pressure required before Auto drops a tier, ms. */
export const AUTO_PRESSURE_MS = 3000;
/** After a drop, how long the new tier is left alone to settle, ms. */
export const AUTO_SETTLE_MS = 5000;

export interface AutoQualityState {
  tier: QualityTier;
  /** Clock of the first tick of the current unbroken pressure run, or null. */
  pressureSince: number | null;
  /** Clock of the last drop (or of the start) — the settle window. */
  changedAt: number;
}

export function createAutoQuality(now: number): AutoQualityState {
  return { tier: "high", pressureSince: null, changedAt: now };
}

/** A transient (hidden tab, death, resize, teleport): forget the pressure run. */
export function interruptAutoQuality(s: AutoQualityState): AutoQualityState {
  return s.pressureSince === null ? s : { ...s, pressureSince: null };
}

/**
 * One Auto tick. `missShare` is the scaler window's share of missed frames,
 * `ratio` the scaler's current pixel ratio and `cpuMs` the window's median
 * pre-render JS cost. Compare `tier`, not object identity, to decide
 * whether anything needs re-applying.
 */
export function stepAutoQuality(
  s: AutoQualityState,
  missShare: number,
  ratio: number,
  cpuMs: number,
  now: number,
): AutoQualityState {
  const pixelsCannotHelp =
    ratio <= AUTO_RATIO_GATE || cpuMs >= FRAME_BUDGET_MS * AUTO_CPU_BOUND;
  const pressured = missShare >= MISS_SHARE && pixelsCannotHelp;
  if (!pressured) return interruptAutoQuality(s);
  if (now - s.changedAt < AUTO_SETTLE_MS) return interruptAutoQuality(s);
  const since = s.pressureSince ?? now;
  if (now - since < AUTO_PRESSURE_MS) {
    return s.pressureSince === null ? { ...s, pressureSince: since } : s;
  }
  const below = tierBelow(s.tier);
  if (below === null) return s;
  return { tier: below, pressureSince: null, changedAt: now };
}
