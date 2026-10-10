// L1 reactive city: the city answers the dogfight. Gunfire and explosions
// near buildings set off car alarms (hazard flashers, flashing signals) and
// wake dark windows that go dark again over ~30 s; every death leaves a smoke
// column for ~60 s and pulls a police car and an ambulance in along the
// streets; low passes scatter the sidewalk crowd; rooftop searchlights swing
// toward planes in range.
//
// DETERMINISM. Everything here is a pure function of server-broadcast data:
// the `cityEvent` list (accepted and coalesced on the SERVER — see
// common/src/cityevents.ts — and replayed in the welcome for late joiners),
// snapshot entries (low passes, the own plane), and the synced server clock.
// No Math.random, no per-client integration state, so two tabs agree.
//
// Same pure-seam / renderer split as traffic.ts and pedestrians.ts: the
// THREE-free functions at the top are the tested seam; `CityReactor` at the
// bottom is the thin renderer half (one Points draw call for every smoke
// column; everything else rides meshes and shaders that already exist).

import { type Building, mulberry32, solids } from "@angels-bandits/common/city";
import { structureCovers } from "@angels-bandits/common/city/roof-structures";
import {
  LANE_CENTERS,
  nearestStreet,
  nextIntersection,
} from "@angels-bandits/common/city/street";
import {
  ALARM_LIFE_MS,
  type CityEvent,
  SMOKE_LIFE_MS,
  isBlastEvent,
} from "@angels-bandits/common/cityevents";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import type { SnapshotMsg } from "@angels-bandits/common/protocol";
import {
  type Vec3,
  wrapDeltaAxis,
  wrapLerp,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";
import { nearestImage, uploadPrefix } from "./wrapPlacement";

// --- Tuning ---------------------------------------------------------------

/** Windows within this distance of an event can wake, meters. Mirrored into
 * the building shader's GLSL block (WAKE_GLSL) — one constant, two readers. */
export const WAKE_RADIUS = 110;
/** Cars and signals within this distance of an event flash, meters. */
export const ALARM_RADIUS = 90;
/** Wake sources the building shader holds (uniform array length). */
export const MAX_WAKES = 8;
/** Smoke columns drawn at once (the most recent deaths). */
export const MAX_SMOKES = 8;
/** Death sites with responders at once (the most recent deaths). */
export const MAX_RESPONDER_SITES = 4;
/** One police car and one ambulance per site. */
export const RESPONDERS_PER_SITE = 2;
export const MAX_RESPONDERS = MAX_RESPONDER_SITES * RESPONDERS_PER_SITE;
/** Responders leave at least this long after the event, ms (a dispatcher's
 * beat; each vehicle adds a seeded 0–800 ms on top). */
export const DISPATCH_DELAY_MS = 1500;
/** Responder road speed, m/s — quicker than traffic (8–14 m/s). */
export const RESPONDER_SPEED = 22;
/** How far either side of the scene the two vehicles park, meters. */
const PARK_OFFSET = 8;
/** Hazard / alarm-signal blink half-period, ms (1.5 Hz). */
export const ALARM_BLINK_MS = 333;
/** A window/alarm source counts as "ringing" above this strength. */
const ALARM_MIN_STRENGTH = 0.12;

/** A plane below this altitude is a low pass over the sidewalks, meters. */
export const LOW_PASS_ALT = 45;
/** One low pass per plane per bucket of server time, ms. */
export const LOW_PASS_BUCKET_MS = 500;
/** Pedestrians within this distance of a low pass run, meters. */
export const SCATTER_RADIUS = 32;
/** How far along the sidewalk a scattered walker runs, meters. */
export const SCATTER_RUN = 9;
/** Run out over this long, ms… */
const SCATTER_OUT_MS = 2500;
/** …hold, then drift back by this age, ms (the scatter's whole life). */
const SCATTER_HOLD_MS = 4000;
export const SCATTER_LIFE_MS = 10_000;
/** Low passes held for scatter at once. */
export const MAX_PASSES = 16;

/** Searchlights track planes inside this range of the lamp, meters. */
export const TRACK_RANGE = 250;
/** Full tracking weight inside this range, meters. */
const TRACK_FULL = 150;
/** Tracked beams never dip below this much "up" (they stand on roofs). */
const TRACK_MIN_UP = 0.12;

// --- Pure seam: events → active reactions ---------------------------------

/** A city event plus what is derived from it once, at ingest. */
export interface PreparedEvent {
  ev: CityEvent;
  /** Height the smoke column rises from: the solid top under the point. */
  base: number;
  /** D8: the building under the point (-1 over a street) and its damage
   * version when `base` was taken — a collapse under a burning wreck drops
   * its column to what still stands instead of leaving it in the air. */
  under: number;
  underVersion: number;
  /** Responder routes (deaths only), precomputed — never per frame. */
  routes: ResponderRoute[];
}

/** A window/alarm source at one instant. */
export interface WakeSource {
  x: number;
  y: number;
  z: number;
  /** 0..1: ramps in over ~1 s, fades out across ALARM_LIFE_MS. */
  strength: number;
}

/** A smoke column at one instant. */
export interface SmokeSite {
  x: number;
  base: number;
  z: number;
  /** Event time (seeds the puffs) and age, ms. */
  t: number;
  age: number;
}

/** A responder at one instant: canonical ground position + heading. */
export interface ResponderPose {
  kind: "police" | "ambulance";
  x: number;
  z: number;
  yaw: number;
}

/** Everything the city is doing at one instant. Fixed-size pools + counts so
 * the frame path writes in place (cityReactionsInto) and allocates nothing. */
export interface CityReactions {
  wakes: WakeSource[];
  wakeCount: number;
  smokes: SmokeSite[];
  smokeCount: number;
  responders: ResponderPose[];
  responderCount: number;
  /** Server time these were evaluated at (drives blink phases). */
  timeMs: number;
}

export function createReactions(): CityReactions {
  return {
    wakes: Array.from({ length: MAX_WAKES }, () => ({
      x: 0,
      y: 0,
      z: 0,
      strength: 0,
    })),
    wakeCount: 0,
    smokes: Array.from({ length: MAX_SMOKES }, () => ({
      x: 0,
      base: 0,
      z: 0,
      t: 0,
      age: 0,
    })),
    smokeCount: 0,
    responders: Array.from({ length: MAX_RESPONDERS }, () => ({
      kind: "police" as const,
      x: 0,
      z: 0,
      yaw: 0,
    })),
    responderCount: 0,
    timeMs: 0,
  };
}

/** Total order on events: server time, then position, then kind. Every
 * client sorts the same list the same way, whatever order it arrived in —
 * which is what makes "keep the most recent N" agree across tabs. */
export function compareEvents(a: CityEvent, b: CityEvent): number {
  return (
    a.t - b.t ||
    a.x - b.x ||
    a.z - b.z ||
    a.y - b.y ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
  );
}

/** Window/alarm strength of a source `age` ms old: ramps in over ~1.2 s,
 * holds, then fades out over the back 80% of ALARM_LIFE_MS. 0 outside. */
export function wakeStrength(age: number): number {
  if (age < 0 || age >= ALARM_LIFE_MS) return 0;
  const up = Math.min(1, age / 1200);
  const u = (age - 0.2 * ALARM_LIFE_MS) / (0.8 * ALARM_LIFE_MS);
  const k = Math.min(1, Math.max(0, u));
  return up * (1 - k * k * (3 - 2 * k));
}

/** How strongly a source of `strength` wakes a window `dist` m away — the
 * TS mirror of WAKE_GLSL's falloff. Exactly 0 at dist ≥ WAKE_RADIUS. */
export function wakeAt(strength: number, dist: number): number {
  const lo = WAKE_RADIUS * 0.35;
  if (dist >= WAKE_RADIUS) return 0;
  if (dist <= lo) return strength;
  const k = (dist - lo) / (WAKE_RADIUS - lo);
  return strength * (1 - k * k * (3 - 2 * k));
}

/**
 * Evaluate every reaction at server time `timeMs` into `out` (allocation-
 * free). `events` must be sorted by compareEvents (CityReactor keeps it so).
 * Caps keep the MOST RECENT events — newest first by that total order — so
 * every client evicts the same ones.
 */
export function cityReactionsInto(
  out: CityReactions,
  events: readonly PreparedEvent[],
  timeMs: number,
): CityReactions {
  out.wakeCount = 0;
  out.smokeCount = 0;
  out.responderCount = 0;
  out.timeMs = timeMs;
  let sites = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i] as PreparedEvent;
    const { ev } = p;
    const age = timeMs - ev.t;
    if (age < 0) continue; // not yet, on this client's render clock
    if (age >= SMOKE_LIFE_MS) break; // sorted: everything older is over too
    if (age < ALARM_LIFE_MS && out.wakeCount < MAX_WAKES) {
      const w = out.wakes[out.wakeCount++] as WakeSource;
      w.x = ev.x;
      w.y = ev.y;
      w.z = ev.z;
      w.strength = wakeStrength(age);
    }
    if (!isBlastEvent(ev)) continue;
    if (out.smokeCount < MAX_SMOKES) {
      const s = out.smokes[out.smokeCount++] as SmokeSite;
      s.x = ev.x;
      s.base = p.base;
      s.z = ev.z;
      s.t = ev.t;
      s.age = age;
    }
    if (sites < MAX_RESPONDER_SITES) {
      sites++;
      for (const route of p.routes) {
        const r = out.responders[out.responderCount] as ResponderPose;
        if (responderPoseInto(route, age, r)) out.responderCount++;
      }
    }
  }
  return out;
}

/** Allocating form over raw events — for tests and QA, never per frame. */
export function cityReactions(
  events: readonly CityEvent[],
  timeMs: number,
  buildings: readonly Building[] = [],
): CityReactions {
  const prepared = [...events]
    .sort(compareEvents)
    .map((ev) => prepareEvent(ev, buildings));
  return cityReactionsInto(createReactions(), prepared, timeMs);
}

/** Derive an event's static parts once: smoke base and responder routes. */
export function prepareEvent(
  ev: CityEvent,
  buildings: readonly Building[],
): PreparedEvent {
  const under = isBlastEvent(ev) ? buildingUnder(buildings, ev.x, ev.z) : -1;
  return {
    ev,
    base: isBlastEvent(ev) ? smokeBase(buildings, ev.x, ev.y, ev.z) : 0,
    under,
    underVersion: buildings[under]?.damage?.version ?? 0,
    routes: isBlastEvent(ev)
      ? [responderRoute(ev, "police"), responderRoute(ev, "ambulance")]
      : [],
  };
}

/** The index of the building whose footprint holds (x, z), or -1. */
export function buildingUnder(
  buildings: readonly Building[],
  x: number,
  z: number,
): number {
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i] as Building;
    if (
      Math.abs(wrapDeltaAxis(b.x, x)) <= b.width / 2 &&
      Math.abs(wrapDeltaAxis(b.z, z)) <= b.depth / 2
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Where a death's smoke rises from: the highest SOLID top at or below the
 * point (holes respected — a crash inside a tunnel smokes from the tunnel
 * floor, not the roof), else the street. A mid-air kill over a street smokes
 * from the street the wreck fell into.
 */
export function smokeBase(
  buildings: readonly Building[],
  x: number,
  y: number,
  z: number,
): number {
  let base = 0;
  for (const b of buildings) {
    const dx = wrapDeltaAxis(b.x, x);
    const dz = wrapDeltaAxis(b.z, z);
    if (Math.abs(dx) > b.width / 2 || Math.abs(dz) > b.depth / 2) continue;
    for (const s of solids(b)) {
      if (
        Math.abs(dx - s.dx) > s.width / 2 ||
        Math.abs(dz - s.dz) > s.depth / 2
      ) {
        continue;
      }
      const top = s.baseY + s.height;
      if (top <= y + 1 && top > base) base = top;
    }
    // R2: a wreck on a penthouse or tank smokes from its top.
    for (const s of b.roof ?? []) {
      if (!structureCovers(s, dx, dz, 0)) continue;
      const top = s.baseY + s.height;
      if (top <= y + 1 && top > base) base = top;
    }
  }
  return base;
}

// --- Responders: routes along the street lattice --------------------------

/** One responder's drive: a two-leg polyline in a local, UNWRAPPED frame
 * around the scene (so a seam-side scene is one straight line, not two
 * pieces), plus when it leaves. */
export interface ResponderRoute {
  kind: "police" | "ambulance";
  /** [start, corner, stop] as unwrapped world xz. */
  pts: { x: number; z: number }[];
  /** Cumulative distance at each point. */
  dist: number[];
  /** How long after the event it sets off, ms. */
  departAfter: number;
}

/** Right-hand lane offset off a centerline for travel along `axis` in `dir`
 * — the traffic.ts lane convention (trafficLanes), so responders drive in
 * the same lanes as the cars. */
const laneOffset = (axis: "x" | "z", dir: number): number => {
  const [minus, plus] = LANE_CENTERS;
  if (axis === "z") return dir > 0 ? plus : minus;
  return dir > 0 ? minus : plus;
};

/** Per-event PRNG stream, salted per responder: a function of the event's
 * server time and position only — every client draws the same. */
const eventRand = (ev: CityEvent, salt: number): (() => number) =>
  mulberry32(
    (Math.floor(ev.t) ^
      Math.imul(Math.round(ev.x) + 1, 73856093) ^
      Math.imul(Math.round(ev.z) + 1, 19349663) ^
      Math.imul(salt, 0x9e3779b9)) >>>
      0,
  );

/**
 * The route a responder drives to the scene of `ev`. The scene street is the
 * street nearest the site; the police car comes in from the intersection on
 * its +side, the ambulance from the −side, each turning onto the scene street
 * from a cross street one block out (which side of it: seeded). Every point
 * sits on a lane line, so the whole drive stays on the roadway.
 */
export function responderRoute(
  ev: CityEvent,
  kind: "police" | "ambulance",
): ResponderRoute {
  const site = { x: ev.x, y: 0, z: ev.z };
  const street = nearestStreet(site);
  const along = street.axis === "x" ? ev.x : ev.z;
  const cross = street.axis === "x" ? ev.z : ev.x;
  /** Which side of the scene this responder approaches from. */
  const sigma = kind === "police" ? 1 : -1;
  const rand = eventRand(ev, kind === "police" ? 11 : 23);
  /** Which side of the scene street its cross street comes in from. */
  const tau = rand() < 0.5 ? -1 : 1;
  const corner = nextIntersection(site, street, sigma as 1 | -1);
  const cornerAlong =
    along + wrapDeltaAxis(along, street.axis === "x" ? corner.x : corner.z);
  const center = cross + wrapDeltaAxis(cross, street.centerline);
  const perp = street.axis === "x" ? "z" : "x";
  // Lane on the scene street, travelling back toward the scene (−sigma).
  const laneScene = center + laneOffset(street.axis, -sigma);
  // Lane on the cross street, travelling toward the scene street (−tau).
  const lanePerp = cornerAlong + laneOffset(perp, -tau);
  let stopAlong = along + sigma * PARK_OFFSET;
  // Never park past the turn (a scene right at an intersection).
  stopAlong =
    sigma > 0 ? Math.min(stopAlong, lanePerp) : Math.max(stopAlong, lanePerp);
  const at = (a: number, c: number) =>
    street.axis === "x" ? { x: a, z: c } : { x: c, z: a };
  const pts = [
    at(lanePerp, laneScene + tau * BLOCK_PITCH),
    at(lanePerp, laneScene),
    at(stopAlong, laneScene),
  ];
  const dist = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { x: number; z: number };
    const b = pts[i] as { x: number; z: number };
    dist.push((dist[i - 1] as number) + Math.hypot(b.x - a.x, b.z - a.z));
  }
  return {
    kind,
    pts,
    dist,
    departAfter: DISPATCH_DELAY_MS + rand() * 800,
  };
}

const wrapCoord = (v: number): number =>
  ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

/**
 * Where `route`'s vehicle is `age` ms after its event, written into `out`
 * (canonical). False before it sets off — nothing to draw yet. Arrived
 * vehicles stay parked at the scene, light bar going, until the reaction
 * expires.
 */
export function responderPoseInto(
  route: ResponderRoute,
  age: number,
  out: ResponderPose,
): boolean {
  const driving = age - route.departAfter;
  if (driving < 0) return false;
  const total = route.dist[route.dist.length - 1] as number;
  const s = Math.min(total, (driving / 1000) * RESPONDER_SPEED);
  let seg = 1;
  while (seg < route.dist.length - 1 && (route.dist[seg] as number) < s) seg++;
  const a = route.pts[seg - 1] as { x: number; z: number };
  const b = route.pts[seg] as { x: number; z: number };
  const d0 = route.dist[seg - 1] as number;
  const len = (route.dist[seg] as number) - d0;
  const k = len > 1e-6 ? (s - d0) / len : 1;
  out.kind = route.kind;
  out.x = wrapCoord(a.x + (b.x - a.x) * k);
  out.z = wrapCoord(a.z + (b.z - a.z) * k);
  // Heading of the current leg (forward is −Z at yaw 0, the plane
  // convention); a zero-length leg keeps the previous leg's heading.
  let hx = b.x - a.x;
  let hz = b.z - a.z;
  if (Math.hypot(hx, hz) < 1e-6 && seg > 1) {
    const p = route.pts[seg - 2] as { x: number; z: number };
    hx = a.x - p.x;
    hz = a.z - p.z;
  }
  out.yaw = Math.atan2(-hx, -hz);
  return true;
}

// --- Alarms, scatter and tracking (pure helpers) --------------------------

/** Is a hazard/alarm-signal at (x, z) ringing in `r`? (Any source within
 * ALARM_RADIUS above ALARM_MIN_STRENGTH.) Allocation-free. */
export function alarmed(r: CityReactions, x: number, z: number): boolean {
  for (let i = 0; i < r.wakeCount; i++) {
    const w = r.wakes[i] as WakeSource;
    if (w.strength < ALARM_MIN_STRENGTH) continue;
    const dx = wrapDeltaAxis(w.x, x);
    if (Math.abs(dx) > ALARM_RADIUS) continue;
    const dz = wrapDeltaAxis(w.z, z);
    if (dx * dx + dz * dz <= ALARM_RADIUS * ALARM_RADIUS) return true;
  }
  return false;
}

/** The blink phase every alarm shares (server time → same beat on every
 * client): true on the lit half. */
export const alarmBlinkOn = (timeMs: number): boolean =>
  Math.floor(timeMs / ALARM_BLINK_MS) % 2 === 0;

/** A low pass over the sidewalks (snapshot-derived). */
export interface LowPass {
  x: number;
  z: number;
  t: number;
}

/** A1: a plane passing near the buildings (snapshot-derived, like LowPass,
 * but with its height): what crowds look up at and pigeons flutter from. */
export interface NearPass extends LowPass {
  y: number;
}
/** A plane below this altitude is recorded as a near pass, meters. */
export const NEAR_PASS_ALT = 280;
/** Near passes are kept this long, ms (the longest reaction they drive). */
export const NEAR_PASS_LIFE_MS = 14_000;
/** Near passes held at once (12 planes × 2/s × 14 s, with room). */
export const MAX_NEAR_PASSES = 400;

/** How far along the sidewalk a scattered walker has run `age` ms after a
 * pass, as a 0..1 fraction of SCATTER_RUN: out fast, hold, drift back. */
export function scatterProfile(age: number): number {
  if (age < 0 || age >= SCATTER_LIFE_MS) return 0;
  if (age < SCATTER_OUT_MS) {
    const k = age / SCATTER_OUT_MS;
    return 1 - (1 - k) * (1 - k);
  }
  if (age < SCATTER_HOLD_MS) return 1;
  const k = (age - SCATTER_HOLD_MS) / (SCATTER_LIFE_MS - SCATTER_HOLD_MS);
  return 1 - k * k * (3 - 2 * k);
}

/**
 * Signed shift along the sidewalk ring for a walker at (x, z) whose ring
 * tangent (+s direction) is (tx, tz): away from every pass within
 * SCATTER_RADIUS, nearer passes pushing harder. 0 outside every radius.
 */
export function scatterShift(
  passes: readonly LowPass[],
  count: number,
  x: number,
  z: number,
  tx: number,
  tz: number,
  timeMs: number,
): number {
  let shift = 0;
  for (let i = 0; i < count; i++) {
    const p = passes[i] as LowPass;
    const prof = scatterProfile(timeMs - p.t);
    if (prof === 0) continue;
    const dx = wrapDeltaAxis(p.x, x);
    if (Math.abs(dx) >= SCATTER_RADIUS) continue;
    const dz = wrapDeltaAxis(p.z, z);
    const d = Math.hypot(dx, dz);
    if (d >= SCATTER_RADIUS) continue;
    const away = dx * tx + dz * tz;
    const sign = away >= 0 ? 1 : -1;
    const near = 1 - (d / SCATTER_RADIUS) * 0.5;
    shift += sign * SCATTER_RUN * near * prof;
  }
  const cap = SCATTER_RUN * 1.5;
  return Math.max(-cap, Math.min(cap, shift));
}

/**
 * A rooftop beam's direction, biased toward planes within TRACK_RANGE of
 * the lamp. Every plane in range pulls with a CONTINUOUS distance weight
 * (no "nearest plane" pick), so two planes trading places never pops the
 * beam. Written into `out` (unit, pointing up at least TRACK_MIN_UP).
 */
export function trackPlanesInto(
  lamp: Vec3,
  sweep: Vec3,
  planes: readonly Vec3[],
  out: Vec3,
): Vec3 {
  let tx = 0;
  let ty = 0;
  let tz = 0;
  let wSum = 0;
  for (const p of planes) {
    const dx = wrapDeltaAxis(lamp.x, p.x);
    const dz = wrapDeltaAxis(lamp.z, p.z);
    const dy = p.y - lamp.y;
    const d = Math.hypot(dx, dy, dz);
    if (d >= TRACK_RANGE || d < 1e-3) continue;
    const k = Math.min(1, (TRACK_RANGE - d) / (TRACK_RANGE - TRACK_FULL));
    const w = k * k * (3 - 2 * k);
    tx += (dx / d) * w;
    ty += (dy / d) * w;
    tz += (dz / d) * w;
    wSum += w;
  }
  const tl = Math.hypot(tx, ty, tz);
  const blend = tl > 1e-3 ? Math.min(1, wSum) : 0;
  let x = sweep.x * (1 - blend);
  let y = sweep.y * (1 - blend);
  let z = sweep.z * (1 - blend);
  if (blend > 0) {
    x += (tx / tl) * blend;
    y += (ty / tl) * blend;
    z += (tz / tl) * blend;
  }
  y = Math.max(y, TRACK_MIN_UP * Math.hypot(x, z));
  const len = Math.hypot(x, y, z) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  return out;
}

// --- Window wake: the building shader's separate block --------------------

/** Shared uniform the building shader reads: xyz = render-space (nearest
 * image) source position, w = strength (0 = off). Written by CityReactor. */
export const windowWakeUniform: { value: THREE.Vector4[] } = {
  value: Array.from({ length: MAX_WAKES }, () => new THREE.Vector4()),
};

/** A1: how many of uWake's slots are live this frame (the rest have w = 0),
 * so every facade pixel stops there instead of reading all MAX_WAKES. */
export const windowWakeCountUniform: { value: number } = { value: 0 };

/** Uniform declarations for the building fragment pars. */
export const WAKE_PARS_GLSL = `uniform vec4 uWake[${MAX_WAKES}];\nuniform int uWakeCount;\n`;

/**
 * L1 window wake, spliced AFTER windowEmissiveGlsl (it reads that block's
 * `pane`, `lit`, `facade`, `winCell`, `litWindow`, `ao` and adds to
 * `windowGlow`). A dark pane near a source turns on when the source's
 * strength × falloff beats the pane's own hash — so as the strength decays
 * windows go dark one by one, not all at once. It reuses `litWindow` at the
 * WINDOW rung, so a woken window is exactly as bright as any lit one. The
 * delta is torus-wrapped on xz in case a source and a facade sit in images
 * a world apart.
 */
export function wakeWindowGlsl(intensity: string): string {
  const R = WAKE_RADIUS.toFixed(1);
  const lo = (WAKE_RADIUS * 0.35).toFixed(1);
  const S = WORLD_SIZE.toFixed(1);
  return /* glsl */ `
// --- L1 reactive city: windows woken by nearby gunfire / explosions ---
float wakeK = 0.0;
for (int wi = 0; wi < ${MAX_WAKES}; wi++) {
  if (wi >= uWakeCount) break;
  vec4 wk = uWake[wi];
  if (wk.w <= 0.0) continue;
  vec3 wakeD = vBWorldPos - wk.xyz;
  wakeD.xz -= ${S} * floor(wakeD.xz / ${S} + 0.5);
  wakeK = max(wakeK, wk.w * (1.0 - smoothstep(${lo}, ${R}, length(wakeD))));
}
float wakeH = abHash(winCell + 57.0, vBSeed * 37.0);
float woke = pane * (1.0 - lit) * facade * step(wakeH, wakeK * 0.8);
windowGlow += woke * litWindow * ${intensity} * ao;
`;
}

// --- Renderer -------------------------------------------------------------

/** Puffs per smoke column. */
export const PUFFS = 36;
/** Seconds for one puff to rise the full column. */
const PUFF_RISE_S = 9;
/** Column height a puff reaches, meters. */
const COLUMN_HEIGHT = 95;
/** The column leans downwind by this much at the top, meters. */
const WIND_LEAN = { x: 26, z: 11 } as const;
/** Puff sprite size ramp, meters. */
const PUFF_MIN = 9;
const PUFF_MAX = 24;
/** City-lit grey: at night a smoke column reads by the street light it
 * catches, so it is LIGHTER than the dark sky and asphalt it rises over
 * (a near-black column vanishes against both). Not a light source: linear
 * luminance ~0.14, far under the 0.72 bloom threshold. */
export const COLUMN_COLOR = 0x6c6569;
const COLUMN_OPACITY = 0.78;
/** Hard cap on the projected sprite, px — GL point sizes clamp anyway, and a
 * consistent cap reads better than each driver's own limit. */
const MAX_POINT_PX = 256;

/** Where puff `i` of a column is, `age` ms in: rise fraction u in [0, 1),
 * or −1 when that puff is not in the air (before emission, after the end). */
export function puffPhase(age: number, i: number, seedT: number): number {
  const period = PUFF_RISE_S * 1000;
  const offset = (i + (((seedT % 9973) * 0.618 + i * 0.37) % 1)) / PUFFS;
  const u = (age / period + offset) % 1;
  const born = age - u * period;
  // Emitted only between the event and LIFE − rise time, so the column
  // builds up from the ground and the last puffs top out at LIFE.
  if (born < 0 || born > SMOKE_LIFE_MS - period) return -1;
  return u;
}

/** Hash of a puff's lateral wobble, −1..1 (deterministic per puff). */
const puffJitter = (i: number, k: number): number => {
  const h = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
};

/**
 * The renderer half: holds the prepared event log, re-evaluates the pure
 * schedule each frame into a reused pool, draws every smoke column in ONE
 * Points, feeds the window-wake uniform, and hands out the views the other
 * renderers (traffic, signals, pedestrians, searchlights) consume.
 */
export class CityReactor {
  readonly points: THREE.Points;
  readonly reactions = createReactions();
  private readonly buildings: readonly Building[];
  private events: PreparedEvent[] = [];
  private readonly passes: LowPass[] = [];
  private readonly nearList: NearPass[] = [];
  /** Last low-pass bucket recorded per plane (one pass per bucket). */
  private readonly passBucket = new Map<string, number>();
  private readonly selfTrack: { t: number; pos: Vec3 }[] = [];
  private readonly positions: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  private drawnPuffs = 0;
  /** O3 quality tier: every Nth puff of a column is drawn (1 = all). */
  private puffStride = 1;

  constructor(buildings: readonly Building[]) {
    this.buildings = buildings;
    const budget = MAX_SMOKES * PUFFS;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(budget), 1);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.sizes.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("aSize", this.sizes);
    geometry.setDrawRange(0, 0);
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(32, 32, 3, 32, 32, 32);
      g.addColorStop(0, "rgba(255,255,255,0.85)");
      g.addColorStop(0.55, "rgba(255,255,255,0.35)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }
    const material = new THREE.PointsMaterial({
      color: COLUMN_COLOR,
      map: new THREE.CanvasTexture(canvas),
      size: 1, // per-point aSize carries the real size
      transparent: true,
      opacity: COLUMN_OPACITY,
      depthWrite: false,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "attribute float aSize;\n#include <common>",
        )
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;")
        .replace(
          "#include <fog_vertex>",
          `#include <fog_vertex>\ngl_PointSize = min(gl_PointSize, ${MAX_POINT_PX.toFixed(1)});`,
        );
    };
    // Distinct key: textually similar patches collide without one (V3).
    material.customProgramCacheKey = () => "ab-reaction-smoke";
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = RENDER_ORDER.smokeColumns;
  }

  /** Add server city events (live broadcast or the welcome replay). Keeps
   * the log sorted by compareEvents and drops exact duplicates. */
  ingest(events: readonly CityEvent[]): void {
    for (const ev of events) {
      if (this.events.some((p) => compareEvents(p.ev, ev) === 0)) continue;
      this.events.push(prepareEvent(ev, this.buildings));
    }
    this.events.sort((a, b) => compareEvents(a.ev, b.ev));
  }

  /**
   * Snapshot hook: low passes (every plane — self included — under
   * LOW_PASS_ALT, one per plane per LOW_PASS_BUCKET_MS of SERVER time, so
   * every client records the same passes) and the own plane's on-record
   * track (for searchlights, which must not use the local flight pos).
   */
  observeSnapshot(snap: SnapshotMsg, selfId: string): void {
    for (const p of snap.players) {
      if (p.id === selfId) {
        this.selfTrack.push({ t: snap.time, pos: { ...p.pose.pos } });
        if (this.selfTrack.length > 8) this.selfTrack.shift();
      }
      if (p.pose.pos.y >= NEAR_PASS_ALT) continue;
      const bucket = Math.floor(snap.time / LOW_PASS_BUCKET_MS);
      if (this.passBucket.get(p.id) === bucket) continue;
      this.passBucket.set(p.id, bucket);
      const { x, y, z } = p.pose.pos;
      // A1: same buckets, a higher ceiling — the near list carries height.
      this.nearList.push({ x, y, z, t: snap.time });
      if (y >= LOW_PASS_ALT) continue;
      this.passes.push({ x, z, t: snap.time });
    }
    while (
      this.nearList.length > MAX_NEAR_PASSES ||
      (this.nearList[0] && snap.time - this.nearList[0].t > NEAR_PASS_LIFE_MS)
    ) {
      this.nearList.shift();
    }
    // Old passes are over; bound the set by the same horizon.
    while (
      this.passes.length > MAX_PASSES ||
      (this.passes[0] && snap.time - this.passes[0].t > SCATTER_LIFE_MS)
    ) {
      this.passes.shift();
    }
  }

  /** The own plane on record at server time `t` (interpolated between its
   * snapshot samples), or null when there is no track around `t`. */
  selfAt(t: number): Vec3 | null {
    const track = this.selfTrack;
    for (let i = track.length - 1; i > 0; i--) {
      const b = track[i] as { t: number; pos: Vec3 };
      const a = track[i - 1] as { t: number; pos: Vec3 };
      if (a.t <= t && t <= b.t) {
        return wrapLerp(a.pos, b.pos, (t - a.t) / Math.max(1, b.t - a.t));
      }
    }
    return null;
  }

  /** Respawn / death: the on-record track jumps, forget it. */
  clearSelfTrack(): void {
    this.selfTrack.length = 0;
  }

  /** A1: near passes (any plane under NEAR_PASS_ALT), oldest first. */
  get nearPasses(): readonly NearPass[] {
    return this.nearList;
  }

  /** Low passes still scattering, for the pedestrian renderer. */
  get lowPasses(): readonly LowPass[] {
    return this.passes;
  }

  /** Puffs drawn last frame (perf report). */
  get puffCount(): number {
    return this.drawnPuffs;
  }

  /** QA: the drawn smoke as the GPU sees it — visibility, draw count, and
   * the first puff's render-space position and sprite size. */
  get smokeDebug(): {
    visible: boolean;
    drawn: number;
    first: { x: number; y: number; z: number; size: number } | null;
  } {
    return {
      visible: this.points.visible,
      drawn: this.points.geometry.drawRange.count,
      first:
        this.drawnPuffs > 0
          ? {
              x: this.positions.getX(0),
              y: this.positions.getY(0),
              z: this.positions.getZ(0),
              size: this.sizes.getX(0),
            }
          : null,
    };
  }

  /** Raw events still in the log (QA). */
  get eventList(): CityEvent[] {
    return this.events.map((p) => ({ ...p.ev }));
  }

  /**
   * Evaluate the schedule at server time `serverTimeMs` (null = no clock:
   * nothing reacts), place the smoke around the viewer, and write the wake
   * uniform. Returns the shared reactions view for the other renderers.
   */
  update(cameraPos: Vec3, serverTimeMs: number | null): CityReactions {
    const r = this.reactions;
    if (serverTimeMs === null) {
      r.wakeCount = 0;
      r.smokeCount = 0;
      r.responderCount = 0;
    } else {
      // Prune what no reaction needs any more (sorted → a prefix).
      let drop = 0;
      while (
        drop < this.events.length &&
        serverTimeMs - (this.events[drop] as PreparedEvent).ev.t >=
          SMOKE_LIFE_MS
      ) {
        drop++;
      }
      if (drop > 0) this.events.splice(0, drop);
      // D8: the ground under a column moved (a collapse, a rebuild) — take
      // its base again from what stands now (live solids and roof).
      for (const p of this.events) {
        if (p.under < 0) continue;
        const v = this.buildings[p.under]?.damage?.version ?? 0;
        if (v === p.underVersion) continue;
        p.underVersion = v;
        p.base = smokeBase(this.buildings, p.ev.x, p.ev.y, p.ev.z);
      }
      cityReactionsInto(r, this.events, serverTimeMs);
    }
    // Window wake uniform, render space (the facade's own frame).
    const wake = windowWakeUniform.value;
    for (let i = 0; i < MAX_WAKES; i++) {
      const v = wake[i] as THREE.Vector4;
      if (i < r.wakeCount) {
        const w = r.wakes[i] as WakeSource;
        const p = nearestImage(cameraPos, w);
        v.set(p.x, p.y, p.z, w.strength);
      } else {
        v.w = 0;
      }
    }
    windowWakeCountUniform.value = Math.min(r.wakeCount, MAX_WAKES);
    this.placeSmoke(cameraPos);
    return r;
  }

  /** O3: Low thins each smoke column; alarms, wake and responders stay. */
  setQuality(tier: QualityTier): void {
    const share = QUALITY_PROFILES[tier].smokeColumns;
    this.puffStride = Math.max(1, Math.round(1 / Math.max(share, 0.01)));
  }

  private placeSmoke(cameraPos: Vec3): void {
    const r = this.reactions;
    let n = 0;
    for (let s = 0; s < r.smokeCount; s++) {
      const site = r.smokes[s] as SmokeSite;
      const p = nearestImage(cameraPos, { x: site.x, y: site.base, z: site.z });
      // Fade the whole column over its last 10 s by shrinking the puffs.
      const tail = Math.min(1, (SMOKE_LIFE_MS - site.age) / 10_000);
      for (let i = 0; i < PUFFS; i += this.puffStride) {
        const u = puffPhase(site.age, i, site.t);
        if (u < 0) continue;
        const lean = u ** 1.3;
        const wobble = 2.5 + u * 6;
        this.positions.setXYZ(
          n,
          p.x + WIND_LEAN.x * lean + puffJitter(i, 1) * wobble,
          p.y + 2 + u * COLUMN_HEIGHT,
          p.z + WIND_LEAN.z * lean + puffJitter(i, 2) * wobble,
        );
        // Grow while rising; thin out over the top 15% of the climb.
        const grow = PUFF_MIN + (PUFF_MAX - PUFF_MIN) * Math.min(1, u / 0.85);
        const top = u > 0.85 ? 1 - (u - 0.85) / 0.15 : 1;
        this.sizes.setX(n, grow * top * tail);
        n++;
      }
    }
    this.drawnPuffs = n;
    this.points.geometry.setDrawRange(0, n);
    this.points.visible = n > 0;
    uploadPrefix([this.positions, this.sizes], n);
  }
}
