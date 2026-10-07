// L3 Living windows (ANGE-GUFAK3): the facade's lit pattern moves over time.
// Offices go dark one by one and late workers switch on, a few windows glow
// with a flickering TV, silhouettes cross behind drawn blinds, and a cleaning
// crew's band of lit floors climbs one building per block at a time.
//
// Same seam as window-pattern.ts: ONE set of constants (LIVE), a TypeScript
// mirror of every decision the shader makes, and the GLSL emitters generated
// from those constants. Everything is a pure function of (building seed,
// window cell, live clock) — the clock is the server clock every client
// already shares, so all players see the same windows.
//
// CLOCK: the server clock is epoch milliseconds, far past what a 32-bit
// float can hold to the second. LiveClock reduces it, in f64, modulo
// LIVE.period before it reaches the shader. Every per-window period is
// periodUnit / n seconds, which divides LIVE.period exactly, and every
// bucket index is taken modulo (period / bucket), so the wrap from
// period − ε to 0 is just another bucket edge: no pop, ever.
//
// GRADUAL: every on/off is a smoothstep crossfade (LIVE.fade s for the
// volatile windows, LIVE.crewRamp / LIVE.crewSpeed s for the crew), and no
// window toggles more often than its period allows (≥ 48 s; the crew keeps a
// floor lit ~24 s). This layer only changes WHICH windows are lit, never how
// bright a lit one is: the TV tint sits below the WINDOW rung and
// silhouettes only darken, so the emissive peak is unchanged.

import type { Building } from "@angels-bandits/common/city";
import { CITY_GRID, mulberry32 } from "@angels-bandits/common/city";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import * as THREE from "three";
import type { FacadeArchetype } from "./archetypes";
import {
  abHash,
  facadeFor,
  glslFloat,
  isWindowLit,
  litProbability,
} from "./window-pattern";

/** The whole living-windows behaviour as data; the shader is generated from it. */
export const LIVE = {
  /** Live-clock wrap, seconds. A multiple of periodUnit. */
  period: 7200,
  /** Every per-window period is periodUnit / n s, n ∈ [nMin, nMin+nSpan). */
  periodUnit: 720,
  nMin: 5,
  nSpan: 11,
  /** Share of windows whose occupant comes and goes (re-rolls each period). */
  volatile: 0.2,
  /** Crossfade per toggle, seconds. */
  fade: 3,
  /** Share of windows with a TV on. */
  tvShare: 0.025,
  /** TV gain: base + slow scene level + two sines, all ≤ 2 Hz (no strobe). */
  tvBase: 0.55,
  tvScene: 0.2,
  /** Seconds per TV "scene" (a slow level change, crossfaded over 1 s). */
  tvSceneLength: 4,
  tvWobble: [
    [0.12, 0.9],
    [0.08, 1.7],
  ] as const,
  /** Silhouettes: one slot per window every silSlot s; a walker crosses in
   * silWalk s with probability silChance. Size as a share of the pane. */
  silSlot: 30,
  silChance: 0.12,
  silWalk: 6,
  silWidth: 0.3,
  silHeight: 0.8,
  /** How much a silhouette darkens the blind at its core. */
  silDark: 0.55,
  /** Cleaning crew: band height (m), climb speed (m/s), on/off ramp (m). */
  crewBand: 11,
  crewSpeed: 0.45,
  crewRamp: 2.5,
  /** Idle time between two buildings of one block, s. */
  crewGap: 20,
  /** Longest block cycle; buildings past it get no crew this cycle. */
  crewMaxCycle: 3600,
  /** Share of windows in the band the crew actually switches on. */
  crewLit: 0.85,
  /** Clock slew: the live clock runs at 1 ± slew × real time toward the
   * server clock, and snaps when it is more than `snap` seconds off. */
  slew: 0.1,
  snap: 5,
} as const;

/** TV glow colour, linear: a cool blue-white. */
export const TV_COLOR = new THREE.Color(0.35, 0.5, 1.0);

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);
const smooth01 = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
const modPos = (x: number, m: number) => ((x % m) + m) % m;

/** Server seconds → the shader's live clock in [0, LIVE.period). */
export const liveClockSeconds = (serverSec: number): number =>
  modPos(serverSec, LIVE.period);

/**
 * The live clock fed to the shader. Advances with real time and slews (rate
 * 1 ± LIVE.slew) toward the server clock, so an offset re-sync or a change in
 * interpolation delay never flips hundreds of windows in one frame. It snaps
 * on the first sync and when it is more than LIVE.snap s off (either way):
 * the only non-monotone case, and a rare one. Before the first snapshot it
 * holds at 0.
 */
export class LiveClock {
  private sec: number | null = null;
  private lastMs = 0;
  /** QA pin (seconds on the live clock), or null to follow the server. */
  pinned: number | null = null;

  /** `serverMs`: socket.renderTime(); `nowMs`: the frame's performance.now(). */
  update(serverMs: number | null, nowMs: number): number {
    const dt =
      this.sec === null ? 0 : Math.max(0, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    if (serverMs === null) {
      if (this.sec !== null) this.sec += dt;
    } else {
      const target = serverMs / 1000;
      if (this.sec === null || Math.abs(target - (this.sec + dt)) > LIVE.snap) {
        this.sec = target;
      } else {
        this.sec += dt;
        const max = LIVE.slew * dt;
        this.sec += Math.min(Math.max(target - this.sec, -max), max);
      }
    }
    if (this.pinned !== null) return liveClockSeconds(this.pinned);
    return this.sec === null ? 0 : liveClockSeconds(this.sec);
  }
}

// --- Slow on/off ----------------------------------------------------------

/** One window's schedule: does it come and go, how often, and its phase. */
export function windowCycle(
  seed: number,
  cellX: number,
  cellY: number,
): { volatile: boolean; period: number; phase: number; n: number } {
  const s = seed * 67;
  const n =
    LIVE.nMin + Math.floor(abHash(cellX + 11, cellY + 71, s) * LIVE.nSpan);
  const period = LIVE.periodUnit / n;
  return {
    volatile: abHash(cellX + 57, cellY + 13, s) < LIVE.volatile,
    period,
    phase: abHash(cellX + 23, cellY + 5, s) * period,
    n,
  };
}

/** Buckets per clock wrap for a window with this n (an exact integer). */
const bucketsPerWrap = (n: number) => (LIVE.period / LIVE.periodUnit) * n;

/** A volatile window's on/off draw for bucket k (k already wrapped). */
const bucketLit = (
  seed: number,
  cellX: number,
  cellY: number,
  k: number,
  p: number,
) => (abHash(cellX + k * 0.731 + 3.1, cellY + 19, seed * 71) <= p ? 1 : 0);

/**
 * Lit level of one window at live time t, in [0, 1] (mirror of the shader's
 * `liveLevel`). Steady windows keep the C3 decision; volatile ones re-roll
 * every period with the SAME clustered probability, crossfading over
 * LIVE.fade s — so the lit fraction never drifts from the C3 band.
 */
export function windowLitLevel(
  arch: FacadeArchetype,
  seed: number,
  cellX: number,
  cellY: number,
  t: number,
): number {
  const c = windowCycle(seed, cellX, cellY);
  if (!c.volatile) return isWindowLit(arch, seed, cellX, cellY) ? 1 : 0;
  const p = litProbability(arch, seed, cellX, cellY);
  const m = bucketsPerWrap(c.n);
  const q = (t + c.phase) / c.period;
  const k = Math.floor(q);
  const a = bucketLit(seed, cellX, cellY, modPos(k - 1, m), p);
  const b = bucketLit(seed, cellX, cellY, modPos(k, m), p);
  return a + (b - a) * smooth01(((q - k) * c.period) / LIVE.fade);
}

// --- TV glow ---------------------------------------------------------------

/** Does this window have a TV on? (independent of whether it is lit). */
export const isTvWindow = (
  seed: number,
  cellX: number,
  cellY: number,
): boolean => abHash(cellX + 61, cellY + 61, seed * 83) < LIVE.tvShare;

/** Peak TV gain the flicker can reach. */
export const TV_GAIN_MAX =
  LIVE.tvBase + LIVE.tvScene + LIVE.tvWobble.reduce((a, [amp]) => a + amp, 0);

/** TV brightness at live time t (mirror of `liveTvGain`), ≤ TV_GAIN_MAX. */
export function tvGain(
  seed: number,
  cellX: number,
  cellY: number,
  t: number,
): number {
  const s = seed * 83;
  const ph = abHash(cellX + 5, cellY + 29, s);
  const q = t / LIVE.tvSceneLength + ph;
  const k = Math.floor(q);
  const wrap = LIVE.period / LIVE.tvSceneLength;
  const a = abHash(cellX + modPos(k - 1, wrap) * 0.37, cellY + 47, s);
  const b = abHash(cellX + modPos(k, wrap) * 0.37, cellY + 47, s);
  const scene = a + (b - a) * smooth01((q - k) * LIVE.tvSceneLength);
  let g = LIVE.tvBase + LIVE.tvScene * scene;
  for (const [amp, hz] of LIVE.tvWobble) {
    g += amp * Math.sin(2 * Math.PI * (hz * t + ph));
  }
  return g;
}

// --- Silhouettes -------------------------------------------------------------

/** Does this window draw its blinds? (mirror of the shader's `blinds`). */
export const hasBlinds = (
  arch: FacadeArchetype,
  seed: number,
  cellX: number,
  cellY: number,
): boolean => abHash(cellX + 3, cellY + 3, seed * 29) <= facadeFor(arch).blinds;

/**
 * Brightness factor a passing silhouette puts on one point of a pane, in
 * [1 − LIVE.silDark, 1] — only ever darkens. (u, v) are pane-local in
 * [0, 1]; `blinds`/`lit` gate it to lit panes with their blinds drawn.
 */
export function silhouetteFactor(
  seed: number,
  cellX: number,
  cellY: number,
  t: number,
  u: number,
  v: number,
  blinds: boolean,
  lit: number,
): number {
  if (!blinds) return 1;
  const s = seed * 89;
  const q = t / LIVE.silSlot + abHash(cellX + 13, cellY + 37, s);
  const k = Math.floor(q);
  const slot = modPos(k, LIVE.period / LIVE.silSlot);
  if (abHash(cellX + slot * 0.913 + 7, cellY + 7, s) >= LIVE.silChance)
    return 1;
  const walk = ((q - k) * LIVE.silSlot) / LIVE.silWalk;
  if (walk >= 1) return 1;
  const w = LIVE.silWidth;
  const dir = abHash(cellX + 2, cellY + 17, s) < 0.5;
  const x = -w + (1 + 2 * w) * (dir ? walk : 1 - walk);
  return 1 - LIVE.silDark * figureMask(u - x, v) * clamp01(lit);
}

/** Soft person shape centred on dx = 0: torso box + head. */
function figureMask(dx: number, v: number): number {
  const w = LIVE.silWidth;
  const h = LIVE.silHeight;
  const soft = 0.06;
  const torso =
    (1 - smooth01((Math.abs(dx) - w * 0.5) / soft + 0.5)) *
    (1 - smooth01((v - h * 0.75) / soft + 0.5));
  const head =
    1 - smooth01((Math.hypot(dx, v - h * 0.88) - w * 0.3) / soft + 0.5);
  return clamp01(Math.max(torso, head));
}

// --- Cleaning crew -----------------------------------------------------------

/** One building's crew visit within its block's cycle, seconds. */
export interface CrewSlot {
  start: number;
  duration: number;
  cycle: number;
}

/** Divisors of LIVE.period, ascending — block cycles snap up to one. */
const PERIOD_DIVISORS = Array.from(
  { length: LIVE.period },
  (_, i) => i + 1,
).filter((d) => LIVE.period % d === 0);

/** A visit lasts until the band has climbed past the roof and ramped off. */
export const crewVisitSeconds = (height: number): number =>
  (height + LIVE.crewBand + LIVE.crewRamp) / LIVE.crewSpeed;

/**
 * The crew rota: per 200 m block, buildings in a seeded order, one visit at a
 * time with a gap between, skipping whatever does not fit LIVE.crewMaxCycle.
 * The cycle snaps up to a divisor of LIVE.period (seamless wrap) and each
 * block gets its own phase. Keyed from CANONICAL building positions and the
 * city seed only — stable across the torus seam and identical on every client.
 */
export function crewSchedule(
  buildings: readonly Building[],
  seed: number,
): Map<Building, CrewSlot> {
  const blocks = new Map<number, Building[]>();
  for (const b of buildings) {
    const bx = modPos(Math.floor(b.x / BLOCK_PITCH), CITY_GRID);
    const bz = modPos(Math.floor(b.z / BLOCK_PITCH), CITY_GRID);
    const key = bx * CITY_GRID + bz;
    const list = blocks.get(key);
    if (list) list.push(b);
    else blocks.set(key, [b]);
  }
  const out = new Map<Building, CrewSlot>();
  for (const [key, list] of blocks) {
    const rand = mulberry32(
      (seed ^ Math.imul(key + 1, 0x9e3779b1) ^ 0x4c337) >>> 0,
    );
    const order = list
      .map((b) => ({ b, r: rand() }))
      .sort((a, c) => a.r - c.r)
      .map((e) => e.b);
    const visits: { b: Building; start: number; duration: number }[] = [];
    let total = 0;
    for (const b of order) {
      const duration = crewVisitSeconds(b.height);
      if (total + duration + LIVE.crewGap > LIVE.crewMaxCycle) continue;
      visits.push({ b, start: total, duration });
      total += duration + LIVE.crewGap;
    }
    if (visits.length === 0) continue;
    const cycle = PERIOD_DIVISORS.find((d) => d >= total) ?? LIVE.period;
    const phase = rand() * cycle;
    for (const v of visits) {
      out.set(v.b, {
        start: modPos(v.start + phase, cycle),
        duration: v.duration,
        cycle,
      });
    }
  }
  return out;
}

/** Crew band head height above the street at live time t, or null between visits. */
export function crewHead(slot: CrewSlot, t: number): number | null {
  const into = modPos(t - slot.start, slot.cycle);
  return into < slot.duration ? into * LIVE.crewSpeed : null;
}

/**
 * Crew light on a window row whose centre stands `cellY` m above the street,
 * in [0, 1] (mirror of `liveCrew` before the per-window crewLit coin): ramps
 * on as the band head passes it, holds for the band, ramps off behind it.
 */
export function crewLevel(slot: CrewSlot, cellY: number, t: number): number {
  const head = crewHead(slot, t);
  if (head === null) return 0;
  const r = LIVE.crewRamp;
  return (
    smooth01((head - cellY) / r) *
    smooth01((cellY - head + LIVE.crewBand + r) / r)
  );
}

/** Does the crew switch this window on when the band reaches it? */
export const crewSwitchesOn = (
  seed: number,
  cellX: number,
  cellY: number,
): boolean => abHash(cellX + 43, cellY + 43, seed * 79) < LIVE.crewLit;

// --- GLSL emitters -------------------------------------------------------------

/** Fragment pars: the live clock and the per-instance crew slot. */
export function livingParsGlsl(): string {
  return /* glsl */ `
uniform float uLiveTime;
varying vec4 vCrew;
float liveSmooth(float x) { return smoothstep(0.0, 1.0, x); }
`;
}

/**
 * Emitted right after the C3 lit decision (`lit`, `pLit`, `winH` in scope):
 * reassigns `lit` to the crossfaded level, then lifts it under the crew band.
 */
export function livingLitGlsl(): string {
  const u = LIVE;
  return /* glsl */ `
// --- L3 living windows: slow on/off (living-windows.ts) ---
float liveN = ${glslFloat(u.nMin)} + floor(abHash(winCell + vec2(11.0, 71.0), vBSeed * 67.0) * ${glslFloat(u.nSpan)});
if (abHash(winCell + vec2(57.0, 13.0), vBSeed * 67.0) < ${glslFloat(u.volatile)}) {
  float livePeriod = ${glslFloat(u.periodUnit)} / liveN;
  float liveWrap = ${glslFloat(u.period / u.periodUnit)} * liveN;
  float liveQ = (uLiveTime + abHash(winCell + vec2(23.0, 5.0), vBSeed * 67.0) * livePeriod) / livePeriod;
  float liveK = floor(liveQ);
  float liveA = step(abHash(vec2(winCell.x + mod(liveK - 1.0, liveWrap) * 0.731 + 3.1, winCell.y + 19.0), vBSeed * 71.0), pLit);
  float liveB = step(abHash(vec2(winCell.x + mod(liveK, liveWrap) * 0.731 + 3.1, winCell.y + 19.0), vBSeed * 71.0), pLit);
  lit = mix(liveA, liveB, liveSmooth((liveQ - liveK) * livePeriod / ${glslFloat(u.fade)})) * facade;
}
// Cleaning crew: a band of floors climbing this building during its visit.
// Rows are the tier's own window rows, measured from the street.
float liveInto = mod(uLiveTime - vCrew.x, max(vCrew.z, 1.0));
if (vCrew.z > 0.5 && liveInto < vCrew.y) {
  float liveCrewHead = liveInto * ${glslFloat(u.crewSpeed)};
  float liveRowY = vWorldY - vMeters.y + (winCell.y + 0.5) * winPitch.y;
  float liveCrew = liveSmooth((liveCrewHead - liveRowY) / ${glslFloat(u.crewRamp)})
    * liveSmooth((liveRowY - liveCrewHead + ${glslFloat(u.crewBand + u.crewRamp)}) / ${glslFloat(u.crewRamp)})
    * step(abHash(winCell + 43.0, vBSeed * 79.0), ${glslFloat(u.crewLit)});
  lit = max(lit, liveCrew * facade);
}
`;
}

/** Emitted right after `winColor` is chosen: TV windows swap to a flickering
 * cool glow (peak below the WINDOW rung — see TV_GAIN_MAX). */
export function livingColorGlsl(tv: string): string {
  const u = LIVE;
  const wobble = u.tvWobble
    .map(
      ([amp, hz]) =>
        ` + ${glslFloat(amp)} * sin(6.2831853 * (${glslFloat(hz)} * uLiveTime + liveTvPh))`,
    )
    .join("");
  return /* glsl */ `
// --- L3 TV glow ---
if (abHash(winCell + 61.0, vBSeed * 83.0) < ${glslFloat(u.tvShare)}) {
  float liveTvPh = abHash(winCell + vec2(5.0, 29.0), vBSeed * 83.0);
  float liveSq = uLiveTime / ${glslFloat(u.tvSceneLength)} + liveTvPh;
  float liveSk = floor(liveSq);
  float liveSw = ${glslFloat(u.period / u.tvSceneLength)};
  float liveScene = mix(
    abHash(vec2(winCell.x + mod(liveSk - 1.0, liveSw) * 0.37, winCell.y + 47.0), vBSeed * 83.0),
    abHash(vec2(winCell.x + mod(liveSk, liveSw) * 0.37, winCell.y + 47.0), vBSeed * 83.0),
    liveSmooth((liveSq - liveSk) * ${glslFloat(u.tvSceneLength)}));
  winColor = ${tv} * (${glslFloat(u.tvBase)} + ${glslFloat(u.tvScene)} * liveScene${wobble});
}
`;
}

/** Emitted right after `litWindow`: a silhouette crossing a lit blind. Only
 * darkens; fades out once a pane is a few pixels wide (no shimmer). */
export function livingShadeGlsl(): string {
  const u = LIVE;
  return /* glsl */ `
// --- L3 silhouettes behind drawn blinds ---
float liveSq2 = uLiveTime / ${glslFloat(u.silSlot)} + abHash(winCell + vec2(13.0, 37.0), vBSeed * 89.0);
float liveSlot = floor(liveSq2);
float liveWalk = (liveSq2 - liveSlot) * ${glslFloat(u.silSlot / u.silWalk)};
if (blinds * lit > 0.0 && liveWalk < 1.0
    && abHash(vec2(winCell.x + mod(liveSlot, ${glslFloat(u.period / u.silSlot)}) * 0.913 + 7.0, winCell.y + 7.0), vBSeed * 89.0) < ${glslFloat(u.silChance)}) {
  float liveDir = step(0.5, abHash(winCell + vec2(2.0, 17.0), vBSeed * 89.0));
  float liveX = ${glslFloat(-u.silWidth)} + ${glslFloat(1 + 2 * u.silWidth)} * mix(liveWalk, 1.0 - liveWalk, liveDir);
  vec2 liveUV = (winF - paneLo) / max(winPane, vec2(1e-3));
  float liveDx = liveUV.x - liveX;
  float liveTorso = (1.0 - liveSmooth((abs(liveDx) - ${glslFloat(u.silWidth * 0.5)}) / 0.06 + 0.5))
    * (1.0 - liveSmooth((liveUV.y - ${glslFloat(u.silHeight * 0.75)}) / 0.06 + 0.5));
  float liveFigHead = 1.0 - liveSmooth((length(vec2(liveDx, liveUV.y - ${glslFloat(u.silHeight * 0.88)})) - ${glslFloat(u.silWidth * 0.3)}) / 0.06 + 0.5);
  float liveFig = clamp(max(liveTorso, liveFigHead), 0.0, 1.0)
    * abDetail(winPitch.x * winPane.x * 0.25, rPix) * clamp(lit, 0.0, 1.0);
  litWindow *= 1.0 - ${glslFloat(u.silDark)} * liveFig;
}
`;
}
