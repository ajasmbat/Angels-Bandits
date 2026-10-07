// The news helicopter (L10): a mover whose route is driven by kills.
//
// Every other mover is a pure function of (seed, server clock). This one also
// depends on WHERE people die, which only the server knows — so the server
// authors a small `NewsHeliTarget` when the heli takes a new story and
// broadcasts it (and hands the current one to late joiners in the welcome).
// From there the pose is a pure function of (target, server clock), evaluated
// identically by the client's renderer, the client's crash check and the
// server's bot probes. Nothing about the pose itself is ever streamed.
//
// A target carries where the heli WAS when it was issued (fx/fy/fz/fyaw), so
// the new route starts exactly where the old one left off: no teleport, and
// no history needed beyond the one message.
//
// The route, in heli time τ = t - target.t:
//   1. Turn-in: for NEWS_HELI_TURN_S the heading eases from `fyaw` onto the
//      new course, so the hull (and its collision box) never snaps around at
//      a retarget. The track itself turns at once; for those few seconds the
//      box points a little off its track, which is accepted.
//   2. Transit: a straight line to the TANGENT point of a counter-clockwise
//      orbit around the site, so it joins the circle already flying along it.
//      A start inside (or on) the circle flies radially out and joins there.
//      Altitude eases from fy to the orbit altitude under NEWS_HELI_CLIMB.
//   3. Orbit: counter-clockwise at NEWS_HELI_ORBIT_SPEED, forever, until the
//      server issues the next target.
//
// All horizontal math goes through wrapDeltaAxis, so a site across the seam
// is reached the short way round.

import {
  BLOCK_PITCH,
  HELI_HULL,
  NEWS_HELI_ALT_MAX,
  NEWS_HELI_ALT_MIN,
  NEWS_HELI_CLIMB,
  NEWS_HELI_DWELL_MS,
  NEWS_HELI_ORBIT_R,
  NEWS_HELI_ORBIT_SPEED,
  NEWS_HELI_TRANSIT_SPEED,
  NEWS_HELI_TURN_S,
  WORLD_SIZE,
} from "../constants";
import { canonicalize, wrapDeltaAxis } from "../world/index";
import { mulberry32 } from "./index";
import type { MoverBox } from "./movers";

/**
 * One story the heli is covering — the whole wire state of the news heli.
 * `x`/`z` are the orbit centre (canonical), `y` the orbit altitude, `t` the
 * server time the target was issued, and `fx`/`fy`/`fz`/`fyaw` the heli's
 * pose at `t` under the previous target.
 */
export interface NewsHeliTarget {
  x: number;
  y: number;
  z: number;
  t: number;
  fx: number;
  fy: number;
  fz: number;
  fyaw: number;
}

/**
 * The per-room news-heli state both sides hold. `prev` is kept because the
 * client renders a little BEHIND the server clock: a target issued at t is
 * received while the client still draws (and collides at) times before t,
 * and those times belong to the previous route.
 */
export interface NewsHeliSlot {
  target: NewsHeliTarget;
  prev: NewsHeliTarget | null;
}

/** Collision id of the news heli (one per room; the kind tells it apart). */
export const NEWS_HELI_ID = 0;

const TAU = Math.PI * 2;

/** Yaw for a heading in XZ: local +X maps to world (cos yaw, -sin yaw). */
const yawOf = (hx: number, hz: number): number => Math.atan2(-hz, hx);

/** Shortest signed angle from a to b, rad in (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

const smoothstep = (k: number): number => {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
};

/** The route's fixed geometry, derived from a target. */
interface Route {
  /** Start relative to the orbit centre, m. */
  vx: number;
  vz: number;
  /** Unit transit direction in XZ. */
  dx: number;
  dz: number;
  /** Transit length, m, and duration, s. */
  len: number;
  dur: number;
  /** Orbit angle where the transit joins the circle, rad. */
  theta: number;
}

function routeOf(target: NewsHeliTarget): Route {
  const R = NEWS_HELI_ORBIT_R;
  const vx = wrapDeltaAxis(target.x, target.fx);
  const vz = wrapDeltaAxis(target.z, target.fz);
  const d = Math.hypot(vx, vz);
  const phi = d > 1e-6 ? Math.atan2(vz, vx) : 0;
  let theta: number;
  let len: number;
  let dx: number;
  let dz: number;
  if (d > R) {
    // Tangent point for a counter-clockwise orbit (angle increasing, velocity
    // (-sin, cos)): theta = phi + acos(R / d). The line from the start to it
    // runs along the orbit's own direction of travel there.
    theta = phi + Math.acos(R / d);
    len = Math.sqrt(d * d - R * R);
    dx = -Math.sin(theta);
    dz = Math.cos(theta);
  } else {
    // Inside or on the circle: radially out, join where we cross it.
    theta = phi;
    len = R - d;
    dx = Math.cos(theta);
    dz = Math.sin(theta);
  }
  const dur = Math.max(
    len / NEWS_HELI_TRANSIT_SPEED,
    Math.abs(target.y - target.fy) / NEWS_HELI_CLIMB,
  );
  return { vx, vz, dx, dz, len, dur, theta };
}

/** Server time the heli reaches its orbit for this target, ms. */
export function newsHeliArrival(target: NewsHeliTarget): number {
  return target.t + routeOf(target).dur * 1000;
}

/**
 * THE news heli pose: writes the hull's MoverBox at server time `timeMs` into
 * `out` and returns it. Allocation-free, so the bot probes and the per-frame
 * crash check can call it freely; the renderer calls the very same function.
 * Times before `target.t` hold the start pose (callers should pick `prev`
 * for those — see newsTargetAt).
 */
export function newsHeliBoxInto(
  target: NewsHeliTarget,
  timeMs: number,
  out: MoverBox,
): MoverBox {
  const r = routeOf(target);
  const tau = Math.max(0, (timeMs - target.t) / 1000);
  let rx: number;
  let rz: number;
  let y: number;
  let hx: number;
  let hz: number;
  if (tau < r.dur) {
    const k = tau / r.dur;
    rx = r.vx + r.dx * r.len * k;
    rz = r.vz + r.dz * r.len * k;
    y = target.fy + (target.y - target.fy) * k;
    hx = r.dx;
    hz = r.dz;
  } else {
    const a =
      r.theta + ((tau - r.dur) * NEWS_HELI_ORBIT_SPEED) / NEWS_HELI_ORBIT_R;
    rx = Math.cos(a) * NEWS_HELI_ORBIT_R;
    rz = Math.sin(a) * NEWS_HELI_ORBIT_R;
    y = target.y;
    hx = -Math.sin(a);
    hz = Math.cos(a);
  }
  let yaw = yawOf(hx, hz);
  if (tau < NEWS_HELI_TURN_S) {
    yaw =
      target.fyaw +
      angleDelta(target.fyaw, yaw) * smoothstep(tau / NEWS_HELI_TURN_S);
  }
  const p = canonicalize({ x: target.x + rx, y: 0, z: target.z + rz });
  out.x = p.x;
  out.y = y;
  out.z = p.z;
  out.hx = HELI_HULL[0];
  out.hy = HELI_HULL[1];
  out.hz = HELI_HULL[2];
  out.yaw = yaw;
  out.kind = "newsHeli";
  out.id = NEWS_HELI_ID;
  return out;
}

/** The target that governs time `timeMs`: `prev` before the current target
 * was issued (the client renders behind the server clock), else `target`. */
export function newsTargetAt(
  slot: NewsHeliSlot,
  timeMs: number,
): NewsHeliTarget {
  return timeMs < slot.target.t && slot.prev ? slot.prev : slot.target;
}

/** Install a newly issued target, keeping the outgoing one as `prev`. */
export function setNewsTarget(
  slot: NewsHeliSlot,
  target: NewsHeliTarget,
): void {
  slot.prev = slot.target;
  slot.target = target;
}

/** Orbit altitude for a story, seeded from its issue time so it varies. */
const altitudeFor = (t: number): number =>
  NEWS_HELI_ALT_MIN +
  mulberry32(((Math.floor(t) % 4294967296) ^ 0x6e657773) >>> 0)() *
    (NEWS_HELI_ALT_MAX - NEWS_HELI_ALT_MIN);

/**
 * Before anyone has died: an idle orbit over a seeded block centre, issued at
 * t = 0 and starting ON the circle, so it is simply orbiting at every time.
 */
export function newsHeliIdle(seed: number): NewsHeliTarget {
  const rand = mulberry32((seed ^ 0x4e455753) >>> 0);
  const blocks = WORLD_SIZE / BLOCK_PITCH;
  const x = (Math.floor(rand() * blocks) + 0.5) * BLOCK_PITCH;
  const z = (Math.floor(rand() * blocks) + 0.5) * BLOCK_PITCH;
  const y = Math.round(
    NEWS_HELI_ALT_MIN + rand() * (NEWS_HELI_ALT_MAX - NEWS_HELI_ALT_MIN),
  );
  const fx = canonicalize({ x: x + NEWS_HELI_ORBIT_R, y: 0, z }).x;
  return { x, y, z, t: 0, fx, fy: y, fz: z, fyaw: yawOf(0, 1) };
}

/** A fresh slot for a seed: the idle orbit, no previous route. */
export const newsHeliSlot = (seed: number): NewsHeliSlot => ({
  target: newsHeliIdle(seed),
  prev: null,
});

/** May the heli take a new story at `nowMs`? Only once it has arrived on
 * station and dwelt NEWS_HELI_DWELL_MS — a pending kill waits until then. */
export function canRetarget(target: NewsHeliTarget, nowMs: number): boolean {
  return nowMs >= newsHeliArrival(target) + NEWS_HELI_DWELL_MS;
}

const scratch: MoverBox = {
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  yaw: 0,
  kind: "newsHeli",
  id: NEWS_HELI_ID,
};

/**
 * The next target: orbit over the kill site (x, z), starting from wherever
 * the current route has the heli at `nowMs`. Pure; the server calls it and
 * broadcasts the result.
 */
export function retargetNewsHeli(
  current: NewsHeliTarget,
  site: { x: number; z: number },
  nowMs: number,
): NewsHeliTarget {
  const from = newsHeliBoxInto(current, nowMs, scratch);
  const c = canonicalize({ x: site.x, y: 0, z: site.z });
  return {
    x: c.x,
    y: Math.round(altitudeFor(nowMs)),
    z: c.z,
    t: nowMs,
    fx: from.x,
    fy: from.y,
    fz: from.z,
    fyaw: from.yaw,
  };
}

/**
 * How far the news heli's spotlight has to throw to reach the ground under
 * the orbit, m: the slant from the lamp at the TOP of the band on the orbit
 * radius to the site, plus a margin so the cone ends in a pool, not a tip.
 */
export const NEWS_SPOT_REACH =
  Math.hypot(NEWS_HELI_ORBIT_R, NEWS_HELI_ALT_MAX) + 40;
