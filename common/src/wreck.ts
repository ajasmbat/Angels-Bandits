// D4 downed planes: a shot-down plane falls as a burning WRECK on a spiral,
// shared verbatim by client and server.
//
// The path is a closed-form pure function of the death event — position,
// velocity, server time and a spin sign — so every client draws (and
// collides with) the same wreck at the same server time. Where it ENDS is
// not recomputed anywhere: the SERVER sweeps the path once, at the death,
// against its room's city as it stands (wreckImpact), and ships the result
// as `end` with the rest of the params. Clients only replay the path up to
// `end`; the server settles the impact there, exactly once.

import type { Building } from "./city/index";
import { type MoverField, type MoverKind, collideMovers } from "./city/movers";
import { overChannel } from "./city/river";
import {
  type CityIndex,
  type NatureIndex,
  collideCity,
  collideNature,
  hitsGround,
} from "./collision";
import {
  WRECK_DRIFT_TAU_S,
  WRECK_GRAVITY,
  WRECK_MAX_MS,
  WRECK_RADIUS,
  WRECK_SPIN_RATE,
  WRECK_SPIRAL_RADIUS,
  WRECK_SPIRAL_TAU_S,
  WRECK_STEP_MS,
  WRECK_TERMINAL,
} from "./constants";
import { type Vec3, wrapCoord, wrapDistance } from "./world/index";

/** What a wreck came down on ("air": nothing by WRECK_MAX_MS). */
export type WreckHit = "city" | "ground" | "river" | "tree" | "mover" | "air";

/** One falling wreck, exactly as it crosses the wire. */
export interface WreckParams {
  /** Server-minted, unique within the room. */
  id: number;
  /** Death position (canonical) and velocity, m and m/s. */
  p: Vec3;
  v: Vec3;
  /** Server time of the death, ms — the path's t = 0. */
  t: number;
  /** Corkscrew direction. */
  spin: 1 | -1;
  /** When it hits, ms after `t` (server-computed, ≤ WRECK_MAX_MS). */
  end: number;
  hit: WreckHit;
}

/** The part of a wreck its path depends on. */
export type WreckPath = Pick<WreckParams, "p" | "v" | "t" | "spin" | "end">;

const TAU_FALL_S = WRECK_TERMINAL / WRECK_GRAVITY;

/** Seconds along the path at server time `ms`, clamped to [0, end]. */
const pathSeconds = (w: WreckPath, ms: number): number =>
  Math.min(Math.max(ms - w.t, 0), w.end) / 1000;

/** The corkscrew's start phase: square to the death heading, toward `spin`. */
const spiralPhase = (w: WreckPath): number =>
  (w.v.x === 0 && w.v.z === 0 ? 0 : Math.atan2(w.v.z, w.v.x)) +
  (w.spin * Math.PI) / 2;

/**
 * Where the wreck is at server time `ms` (clamped to [t, t + end]):
 * horizontal drift that bleeds off, a fall toward WRECK_TERMINAL under
 * linear drag, and a corkscrew whose radius grows from 0. Canonical x/z.
 */
export function wreckPosAt(w: WreckPath, ms: number, out: Vec3): Vec3 {
  const s = pathSeconds(w, ms);
  const drift = WRECK_DRIFT_TAU_S * (1 - Math.exp(-s / WRECK_DRIFT_TAU_S));
  const r = WRECK_SPIRAL_RADIUS * (1 - Math.exp(-s / WRECK_SPIRAL_TAU_S));
  const a = spiralPhase(w) + w.spin * WRECK_SPIN_RATE * s;
  out.x = wrapCoord(w.p.x + w.v.x * drift + r * Math.cos(a));
  out.z = wrapCoord(w.p.z + w.v.z * drift + r * Math.sin(a));
  out.y =
    w.p.y -
    WRECK_TERMINAL * s +
    (w.v.y + WRECK_TERMINAL) * TAU_FALL_S * (1 - Math.exp(-s / TAU_FALL_S));
  return out;
}

/** The wreck's velocity at server time `ms` (the derivative of wreckPosAt;
 * zero outside the fall). */
export function wreckVelAt(w: WreckPath, ms: number, out: Vec3): Vec3 {
  if (ms < w.t || ms > w.t + w.end) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  const s = pathSeconds(w, ms);
  const decay = Math.exp(-s / WRECK_DRIFT_TAU_S);
  const grow = Math.exp(-s / WRECK_SPIRAL_TAU_S);
  const r = WRECK_SPIRAL_RADIUS * (1 - grow);
  const dr = (WRECK_SPIRAL_RADIUS / WRECK_SPIRAL_TAU_S) * grow;
  const omega = w.spin * WRECK_SPIN_RATE;
  const a = spiralPhase(w) + omega * s;
  const c = Math.cos(a);
  const n = Math.sin(a);
  out.x = w.v.x * decay + dr * c - r * omega * n;
  out.z = w.v.z * decay + dr * n + r * omega * c;
  out.y =
    -WRECK_TERMINAL + (w.v.y + WRECK_TERMINAL) * Math.exp(-s / TAU_FALL_S);
  return out;
}

/** What the sweep tests: the room's city as it stands, its trees, and the
 * movers at their future server times. Leave the room's news heli OUT of
 * `movers` — its future route depends on kills that have not happened. */
export interface WreckWorld {
  buildings: readonly Building[];
  index?: CityIndex;
  nature?: NatureIndex;
  movers?: MoverField;
}

export interface WreckImpact {
  /** ms after the death. */
  end: number;
  hit: WreckHit;
  /** The mover struck, when `hit` is "mover". */
  mover?: MoverKind;
}

/** What a WRECK_RADIUS sphere at `pos` touches at server time `ms`. */
function solidAt(
  pos: Vec3,
  ms: number,
  world: WreckWorld,
): { hit: WreckHit; mover?: MoverKind } | null {
  if (hitsGround(pos, WRECK_RADIUS)) {
    // Below the street over the channel: the water or its walls.
    return { hit: pos.y < 0 && overChannel(pos.z) ? "river" : "ground" };
  }
  if (collideCity(pos, WRECK_RADIUS, world.buildings, world.index)) {
    return { hit: "city" };
  }
  if (world.nature && collideNature(pos, WRECK_RADIUS, world.nature)) {
    return { hit: "tree" };
  }
  if (world.movers) {
    const m = collideMovers(pos, WRECK_RADIUS, world.movers, ms);
    if (m) return { hit: "mover", mover: m.kind };
  }
  return null;
}

/** Bisection rounds after the step that hit (20 ms → ~0.3 ms). */
const BISECT = 6;

/**
 * Sweep a fresh wreck's path (`end` ignored) for its first solid: fixed
 * WRECK_STEP_MS steps, then bisection between the last clear step and the
 * first touching one. Deterministic in its inputs. Nothing by WRECK_MAX_MS
 * → it explodes in the air there.
 */
export function wreckImpact(
  path: Omit<WreckPath, "end">,
  world: WreckWorld,
): WreckImpact {
  const full: WreckPath = { ...path, end: WRECK_MAX_MS };
  const pos: Vec3 = { x: 0, y: 0, z: 0 };
  const at = (ms: number) =>
    solidAt(wreckPosAt(full, path.t + ms, pos), path.t + ms, world);
  const first = at(0);
  if (first) return { end: 0, ...first };
  let lo = 0;
  for (let ms = WRECK_STEP_MS; ms <= WRECK_MAX_MS; ms += WRECK_STEP_MS) {
    let hit = at(ms);
    if (!hit) {
      lo = ms;
      continue;
    }
    let hi = ms;
    for (let i = 0; i < BISECT; i++) {
      const mid = (lo + hi) / 2;
      const h = at(mid);
      if (h) {
        hi = mid;
        hit = h;
      } else lo = mid;
    }
    return { end: Math.round(hi * 10) / 10, ...hit };
  }
  return { end: WRECK_MAX_MS, hit: "air" };
}

/** Is the wreck falling (solid) at server time `ms`? */
export const wreckFalling = (w: WreckPath, ms: number): boolean =>
  ms >= w.t && ms < w.t + w.end;

/** Does a sphere at `pos` touch the falling wreck at server time `ms`? */
export function wreckTouches(
  w: WreckPath,
  pos: Vec3,
  radius: number,
  ms: number,
  scratch: Vec3 = { x: 0, y: 0, z: 0 },
): boolean {
  if (!wreckFalling(w, ms)) return false;
  return wrapDistance(wreckPosAt(w, ms, scratch), pos) <= WRECK_RADIUS + radius;
}

/** Sample spacing of wreckNear, ms. */
const NEAR_STEP_MS = 25;

/** Did the falling wreck come within `reach` of `pos` at any server time in
 * [fromMs, toMs]? (Credit: a crash on a delayed render clock.) */
export function wreckNear(
  w: WreckPath,
  pos: Vec3,
  reach: number,
  fromMs: number,
  toMs: number,
): boolean {
  const from = Math.max(fromMs, w.t);
  const to = Math.min(toMs, w.t + w.end);
  const at: Vec3 = { x: 0, y: 0, z: 0 };
  for (let ms = from; ms <= to; ms += NEAR_STEP_MS) {
    if (wrapDistance(wreckPosAt(w, ms, at), pos) <= reach) return true;
  }
  return to >= from && wrapDistance(wreckPosAt(w, to, at), pos) <= reach;
}

const HITS: readonly WreckHit[] = [
  "city",
  "ground",
  "river",
  "tree",
  "mover",
  "air",
];
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isVec = (v: unknown): v is Vec3 =>
  typeof v === "object" &&
  v !== null &&
  finite((v as Vec3).x) &&
  finite((v as Vec3).y) &&
  finite((v as Vec3).z);

/** Shape check for a wreck off the wire (a client never trusts a NaN). */
export function isWreckParams(w: unknown): w is WreckParams {
  if (typeof w !== "object" || w === null) return false;
  const o = w as Record<string, unknown>;
  return (
    finite(o.id) &&
    isVec(o.p) &&
    isVec(o.v) &&
    finite(o.t) &&
    (o.spin === 1 || o.spin === -1) &&
    finite(o.end) &&
    (o.end as number) >= 0 &&
    (o.end as number) <= WRECK_MAX_MS &&
    HITS.includes(o.hit as WreckHit)
  );
}
