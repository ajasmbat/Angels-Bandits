// Settings (M6, Mobile Playable): the pure half of the settings panel — what
// is stored, how it is clamped, how the resolution scale caps O3's scaler,
// when the panel is open, and the level-hold autopilot it flies while open.
// No DOM here (ui/settings-panel.ts is the thin wiring), so it all runs in a
// node env. The settings that already had a home keep it — `ab-quality`
// (O3), `ab-touch-sens` (M1), `ab-aim-mode` (F1), `ab-radio-voice` — and
// only the new values live under SETTINGS_KEY.

import { BUILDING_MAX_HEIGHT } from "@angels-bandits/common/constants";
import type { FlightInput } from "@angels-bandits/common/flight";
import { AUTO_THROTTLE } from "../game/flight-input";
import type { ResolutionLimits } from "../render/resolution";

/** localStorage key for the values below (same `ab-` prefix as the rest). */
export const SETTINGS_KEY = "ab-settings";
/** Bumped when the stored shape changes; a mismatch reads as defaults. */
export const SETTINGS_VERSION = 1;

/** Resolution scale range: a share of the tier's pixel-ratio ceiling. */
export const RES_SCALE_MIN = 0.5;
export const RES_SCALE_MAX = 1;

export interface Settings {
  /** Share of the quality tier's pixel-ratio ceiling the scaler may use. */
  resScale: number;
  /** Slider positions 0..1 (the gain is `volumeGain` of these). */
  master: number;
  engine: number;
  voice: number;
  /** U1 haptics: on/off as the player chose, or null = the device default
   * (on for a coarse pointer), resolved at boot and never written back. */
  haptics: boolean | null;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  resScale: 1,
  master: 1,
  engine: 1,
  voice: 1,
  haptics: null,
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** A finite number clamped into range, or the fallback for anything else. */
function num(raw: unknown, lo: number, hi: number, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? clamp(raw, lo, hi)
    : fallback;
}

/** Any value (parsed JSON, a partial update) → a valid Settings. */
export function clampSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const d = DEFAULT_SETTINGS;
  return {
    resScale: num(o.resScale, RES_SCALE_MIN, RES_SCALE_MAX, d.resScale),
    master: num(o.master, 0, 1, d.master),
    engine: num(o.engine, 0, 1, d.engine),
    voice: num(o.voice, 0, 1, d.voice),
    haptics: typeof o.haptics === "boolean" ? o.haptics : d.haptics,
  };
}

/** The slice of Storage settings touch. */
export interface SettingsStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** Stored settings; defaults when absent, junk, another version or blocked. */
export function loadSettings(store: SettingsStore | undefined): Settings {
  try {
    const raw = store?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as { v?: unknown };
    if (parsed?.v !== SETTINGS_VERSION) return { ...DEFAULT_SETTINGS };
    return clampSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Blocked storage swallows the write: the values still apply this visit. */
export function saveSettings(
  store: SettingsStore | undefined,
  s: Settings,
): void {
  try {
    store?.setItem(
      SETTINGS_KEY,
      JSON.stringify({ v: SETTINGS_VERSION, ...clampSettings(s) }),
    );
  } catch {
    // Private mode / blocked storage: nothing to do.
  }
}

/** Slider position → gain. Squared: loudness is perceived roughly
 * logarithmically, so a linear gain crams the useful range into the top. */
export function volumeGain(position: number): number {
  const p = clamp(position, 0, 1);
  return p * p;
}

/**
 * The resolution scale on top of O3's limits: the ceiling (already capped by
 * the tier and any thermal level) shrinks by `scale`, and the floor never
 * sits above it, so the scaler always has a valid range.
 */
export function scaleLimits(
  limits: ResolutionLimits,
  scale: number,
): ResolutionLimits {
  const ceiling = limits.ceiling * clamp(scale, RES_SCALE_MIN, RES_SCALE_MAX);
  return { floor: Math.min(limits.floor, ceiling), ceiling };
}

// --- When the panel is open ------------------------------------------------
//
// Portrait on a coarse primary pointer (M2/M5's touch rule) forces it open:
// a phone held upright is a settings screen, not a cockpit. Everywhere else
// it opens by hand (the gear, or Esc). Rotating to landscape closes it
// either way — "rotate back to fly".

export interface PanelEnv {
  /** Coarse primary pointer (`coarsePointer()`): a phone or tablet. */
  touch: boolean;
  portrait: boolean;
}

export type PanelEvent = "toggle" | "close" | "landscape";

/** Portrait on a phone holds the panel open whatever the manual state. */
export function portraitForced(env: PanelEnv): boolean {
  return env.touch && env.portrait;
}

export function panelOpen(manual: boolean, env: PanelEnv): boolean {
  return manual || portraitForced(env);
}

/** The manual (gear / Esc / ✕) half of the state after an event. While
 * portrait forces the panel, toggling and closing change nothing. */
export function nextManual(
  manual: boolean,
  event: PanelEvent,
  env: PanelEnv,
): boolean {
  if (event === "landscape") return false;
  if (portraitForced(env)) return manual;
  return event === "toggle" ? !manual : false;
}

// --- Level-hold autopilot ---------------------------------------------------
//
// What flies the plane while the panel is open: wings level (zero turn and
// roll — the bank spring rolls out on its own), throttle full, and a pitch
// controller that climbs out of the skyline before it levels off. The world
// is a torus, so there is no edge to turn away from; climbing above the
// tallest roof is the obstacle answer. It does not steer round a wall dead
// ahead at street level — F5's corner manager still brakes for one.

/** Below this the autopilot climbs: the tallest roof plus a margin (also
 * clears the 250 m landmarks). */
export const AUTOPILOT_SAFE_ALT = BUILDING_MAX_HEIGHT + 40;
/** Climb attitude below AUTOPILOT_SAFE_ALT, rad (15°). */
export const AUTOPILOT_CLIMB = (15 * Math.PI) / 180;
/** Height over which the climb eases to level as it nears the safe altitude. */
const AUTOPILOT_EASE_M = 40;
/** Pitch command per radian of attitude error, and its clamp. */
const AUTOPILOT_GAIN = 3;
const AUTOPILOT_MAX_PITCH = 0.6;

/** The autopilot's command for this frame. Guns are never part of it. */
export function autopilotInput(pitch: number, altitude: number): FlightInput {
  const below = clamp((AUTOPILOT_SAFE_ALT - altitude) / AUTOPILOT_EASE_M, 0, 1);
  const target = AUTOPILOT_CLIMB * below;
  return {
    turn: 0,
    roll: 0,
    pitch: clamp(
      (target - pitch) * AUTOPILOT_GAIN,
      -AUTOPILOT_MAX_PITCH,
      AUTOPILOT_MAX_PITCH,
    ),
    throttle: AUTO_THROTTLE,
  };
}
