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
//      A start inside (or on) the circle has no tangent: it spirals out onto
//      the circle instead, already flying the orbit's direction.
//      Altitude eases from fy to the orbit altitude under NEWS_HELI_CLIMB.
//   3. Orbit: counter-clockwise at NEWS_HELI_ORBIT_SPEED, forever, until the
//      server issues the next target.
//
// K1: the lowered deck brings the heli down to the landmark spires' height,
// so the server only takes a story whose whole route keeps clear of them
// (newsRouteClear); the idle orbit is chosen clear the same way. T1: the
// cores' supertalls rise into its band too — a room's heli is kept off
// every tower of its city (newsSpiresOf), so stories down in the cores'
// canyons go uncovered.
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
import { type Building, mulberry32 } from "./index";
import { landmarkProfile } from "./landmarks";
import { LANDMARK_BLOCKS } from "./layout";
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
  /** Orbit angle where the transit joins the circle, rad — or, for a
   * spiral (start inside the circle), the angle the spiral starts at. */
  theta: number;
  spiral: boolean;
  /** Start's distance from the centre, m. */
  d: number;
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
    // Inside or on the circle: spiral out from the start's own angle.
    theta = phi;
    len = R - d;
    dx = Math.cos(theta);
    dz = Math.sin(theta);
  }
  const dur = Math.max(
    len / NEWS_HELI_TRANSIT_SPEED,
    Math.abs(target.y - target.fy) / NEWS_HELI_CLIMB,
  );
  return { vx, vz, dx, dz, len, dur, theta, spiral: d <= R, d };
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
  const omega = NEWS_HELI_ORBIT_SPEED / NEWS_HELI_ORBIT_R;
  if (r.spiral) {
    // Angle advances at orbit rate from the start; radius eases out to R.
    const k = r.dur > 0 ? Math.min(1, tau / r.dur) : 1;
    const a = r.theta + tau * omega;
    const rad = r.d + r.len * k;
    rx = Math.cos(a) * rad;
    rz = Math.sin(a) * rad;
    y = target.fy + (target.y - target.fy) * k;
    hx = -Math.sin(a);
    hz = Math.cos(a);
  } else if (tau < r.dur) {
    const k = tau / r.dur;
    rx = r.vx + r.dx * r.len * k;
    rz = r.vz + r.dz * r.len * k;
    y = target.fy + (target.y - target.fy) * k;
    hx = r.dx;
    hz = r.dz;
  } else {
    const a = r.theta + (tau - r.dur) * omega;
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
 * K1: a block whose orbit would meet a spire is passed over for the next.
 * T1: `spires` is the room city's (newsSpiresOf).
 */
export function newsHeliIdle(
  seed: number,
  spires: readonly NewsSpire[] = NEWS_SPIRES,
): NewsHeliTarget {
  const rand = mulberry32((seed ^ 0x4e455753) >>> 0);
  const blocks = WORLD_SIZE / BLOCK_PITCH;
  let x = (Math.floor(rand() * blocks) + 0.5) * BLOCK_PITCH;
  let z = (Math.floor(rand() * blocks) + 0.5) * BLOCK_PITCH;
  const y = Math.round(
    NEWS_HELI_ALT_MIN + rand() * (NEWS_HELI_ALT_MAX - NEWS_HELI_ALT_MIN),
  );
  const at = (cx: number, cz: number): NewsHeliTarget => {
    const fx = canonicalize({ x: cx + NEWS_HELI_ORBIT_R, y: 0, z: cz }).x;
    return { x: cx, y, z: cz, t: 0, fx, fy: y, fz: cz, fyaw: yawOf(0, 1) };
  };
  for (
    let n = 0;
    n < blocks * blocks && !newsRouteClear(at(x, z), spires);
    n++
  ) {
    x = (x + BLOCK_PITCH) % WORLD_SIZE;
    if (x < BLOCK_PITCH) z = (z + BLOCK_PITCH) % WORLD_SIZE;
  }
  return at(x, z);
}

// --- K1: the spires ------------------------------------------------------------

/** How far, plan view, the heli's track keeps off a spire's widest tier in
 * its band, m: its hull's half-length and a margin. */
export const NEWS_SPIRE_GAP = HELI_HULL[0] + 12;

/** A tower as the heli's band sees it: its centre and a plan radius. */
export interface NewsSpire {
  x: number;
  z: number;
  r: number;
}

/** The plan radius (half-diagonal) of the widest of `tiers` (stacked from
 * the ground, each centred) reaching over the heli's lowest belly, or 0. */
function spireReach(
  tiers: readonly { width: number; depth: number; height: number }[],
): number {
  const belly = NEWS_HELI_ALT_MIN - HELI_HULL[1];
  let base = 0;
  let r = 0;
  for (const t of tiers) {
    if (base + t.height > belly) {
      r = Math.max(r, Math.hypot(t.width, t.depth) / 2);
    }
    base += t.height;
  }
  return r;
}

/** K1: the landmark spires as the heli's band sees them: each one's centre
 * and the plan radius (half-diagonal) of its widest tier reaching over the
 * heli's lowest belly. Pure in the fixed landmark layout. T1: the cores'
 * supertalls reach the band too — newsSpiresOf a city is what a room's
 * heli is kept off; these are the default for callers without one. */
export const NEWS_SPIRES: readonly NewsSpire[] = LANDMARK_BLOCKS.map(
  ([bx, bz], i) => ({
    x: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
    z: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
    r: spireReach(landmarkProfile(i).tiers),
  }),
).filter((s) => s.r > 0);

/** T1: every building of `buildings` (as generated: a broken tower is only
 * ever smaller) that reaches the heli's band, roof structures included —
 * the landmarks and the cores' supertalls. Pure. */
export function newsSpiresOf(buildings: readonly Building[]): NewsSpire[] {
  const out: NewsSpire[] = [];
  const belly = NEWS_HELI_ALT_MIN - HELI_HULL[1];
  for (const b of buildings) {
    let r = spireReach(b.tiers);
    // Only its roof structures reach: they stand on the top tier.
    const top = b.tiers[b.tiers.length - 1];
    if (
      r === 0 &&
      top &&
      (b.roof ?? []).some((s) => s.baseY + s.height > belly)
    ) {
      r = Math.hypot(top.width, top.depth) / 2;
    }
    if (r > 0) out.push({ x: b.x, z: b.z, r });
  }
  return out;
}

/**
 * K1: does the route `target` sets — the transit (or the spiral out) and
 * the orbit — keep NEWS_SPIRE_GAP off every spire? The server only sends
 * the heli on a story whose route does; one that would meet a spire is
 * not taken. Pure. T1: `spires` is the room city's (newsSpiresOf).
 */
export function newsRouteClear(
  target: NewsHeliTarget,
  spires: readonly NewsSpire[] = NEWS_SPIRES,
): boolean {
  const r = routeOf(target);
  for (const sp of spires) {
    const reach = sp.r + NEWS_SPIRE_GAP;
    // The spire relative to the orbit centre.
    const sx = wrapDeltaAxis(target.x, sp.x);
    const sz = wrapDeltaAxis(target.z, sp.z);
    const d = Math.hypot(sx, sz);
    // The orbit is a ring of radius R about the centre.
    if (Math.abs(d - NEWS_HELI_ORBIT_R) < reach) return false;
    if (r.spiral) {
      // Out from the start's radius to the ring: the annulus between.
      if (d > r.d - reach && d < NEWS_HELI_ORBIT_R + reach) return false;
      continue;
    }
    // The straight transit, from the start to the tangent point.
    const ex = sx - r.vx;
    const ez = sz - r.vz;
    const k = Math.min(r.len, Math.max(0, ex * r.dx + ez * r.dz));
    if (Math.hypot(ex - r.dx * k, ez - r.dz * k) < reach) return false;
  }
  return true;
}

/** A fresh slot for a seed: the idle orbit, no previous route. */
export const newsHeliSlot = (
  seed: number,
  spires: readonly NewsSpire[] = NEWS_SPIRES,
): NewsHeliSlot => ({
  target: newsHeliIdle(seed, spires),
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
