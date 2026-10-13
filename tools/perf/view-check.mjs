// D11: is a staged destruction view's subject on screen? The shared half of
// destruction-views.test.mjs (the committed check) — pure geometry over the
// seed city, no browser: the subject's sample points (the felled tower's
// pieces at the view's instant, the chewed facade, the downed prop's spot),
// projected through the view's camera, and their sight lines from the eye
// (losClear over every other generated building).

import {
  CollapseField,
  PANCAKE,
  TOPPLE,
  blankPose,
  collapseWire,
  collideCollapses,
  demolitionPlan,
  piecePose,
} from "../../common/src/city/collapse.ts";
import { generateCity, makeBuilding } from "../../common/src/city/index.ts";
import { generateTrains, trainBoxes } from "../../common/src/city/train.ts";
import {
  buildCityIndex,
  collideCity,
  losClear,
} from "../../common/src/collision.ts";
import { CITY_SEED } from "../../common/src/constants.ts";
import { wrapDeltaAxis } from "../../common/src/world/index.ts";

export const CITY = generateCity(CITY_SEED);
/** The game's base vertical FOV (game/zoom.ts BASE_FOV), and the aspect the
 * gallery and the time-lapse shoot at. */
export const FOV = 70;
export const ASPECT = 16 / 9;
/** A sample counts as framed inside this share of the frame (each axis). */
export const FRAME_INNER = 0.9;

/**
 * Collapse `f` (a staged `fell`: b, style, dir) as the client builds it,
 * felled at t0 = 0 on a fresh city.
 */
export function felledCollapse(f) {
  const city = CITY.map((b) => makeBuilding({ ...b, damage: undefined }));
  const field = new CollapseField();
  field.bind(city);
  const style = f.style === "pancake" ? PANCAKE : TOPPLE;
  const plan = demolitionPlan(city[f.b], f.b, style, f.dir);
  if (!plan) throw new Error(`building ${f.b} has nothing to fell`);
  return field.add(collapseWire(plan, f.b, 1, 0));
}

/**
 * Up to `max` sample points (canonical) of collapse `c` at `ageMs` after it
 * starts: its moving pieces' centres (`falling`), or its resting ones'.
 * Also whether any piece is still moving then.
 */
export function collapseSamples(c, ageMs, falling, max = 48) {
  const pose = blankPose();
  const all = [];
  let moving = 0;
  for (let i = 0; i < c.n; i++) {
    piecePose(c, i, ageMs, pose);
    if (!pose.rest) moving++;
    if (pose.rest === falling) continue;
    all.push({ x: c.x + pose.x, y: pose.y, z: c.z + pose.z });
  }
  const step = Math.max(1, Math.floor(all.length / max));
  return { points: all.filter((_, i) => i % step === 0), moving };
}

/** Normalised screen position of canonical point `p` from `eye` looking at
 * `at` (vertical FOV `fov`°): {x, y} in [-1, 1] when framed; null behind. */
export function project(eye, at, p, fov = FOV, aspect = ASPECT) {
  const d = (a, b) => ({
    x: wrapDeltaAxis(a.x, b.x),
    y: b.y - a.y,
    z: wrapDeltaAxis(a.z, b.z),
  });
  const norm = (v) => {
    const l = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  };
  const cross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const fwd = norm(d(eye, at));
  const right = norm(cross(fwd, { x: 0, y: 1, z: 0 }));
  const up = cross(right, fwd);
  const v = d(eye, p);
  const depth = dot(v, fwd);
  if (depth <= 1) return null;
  const t = Math.tan((fov * Math.PI) / 360);
  return {
    x: dot(v, right) / (depth * t * aspect),
    y: dot(v, up) / (depth * t),
  };
}

/**
 * How much of `points` the camera (eye → at) frames and sees: the share
 * inside the inner frame, and the share of those whose sight line from the
 * eye clears every building but `skip` (indices; the subject itself).
 */
export function framed(eye, at, points, skip = [], fov = FOV) {
  const others = CITY.filter((_, i) => !skip.includes(i));
  let inFrame = 0;
  let seen = 0;
  for (const p of points) {
    const s = project(eye, at, p, fov);
    if (!s || Math.abs(s.x) > FRAME_INNER || Math.abs(s.y) > FRAME_INNER) {
      continue;
    }
    inFrame++;
    if (losClear(eye, p, others)) seen++;
  }
  return {
    inFrame: points.length ? inFrame / points.length : 0,
    seen: inFrame ? seen / inFrame : 0,
  };
}

const INDEX = buildCityIndex(CITY);

/**
 * `points` less those inside a standing building other than `skip` — the
 * rubble a topple lays through its neighbours' lots (D10 rest boxes ignore
 * the towers they land in) can never be seen from anywhere.
 */
export function inOpen(points, skip = []) {
  return points.filter((p) => {
    const hit = collideCity(p, 0.5, CITY, INDEX);
    return hit === null || skip.some((i) => CITY[i] === hit);
  });
}

/** Clearance an eye keeps from debris and trains, m. */
export const EYE_CLEAR_M = 6;
export const EYE_TRAIN_M = 30;

/** Is `eye` clear of collapse `c`'s pieces at `ageMs` (and at rest)? */
export function eyeClearOfDebris(c, ageMs, eye) {
  return (
    collideCollapses(eye, EYE_CLEAR_M, [c], ageMs) === null &&
    collideCollapses(eye, EYE_CLEAR_M, [c], Number.POSITIVE_INFINITY) === null
  );
}

const TRAINS = generateTrains(CITY_SEED, CITY);

/** The nearest elevated-train car to `eye` over [tMs − spanMs, tMs +
 * spanMs] (a gallery's settle loop drifts a pinned clock a little), m. */
export function nearestTrain(eye, tMs, spanMs = 3000) {
  let best = Number.POSITIVE_INFINITY;
  for (let t = tMs - spanMs; t <= tMs + spanMs; t += 250) {
    for (const line of TRAINS) {
      for (const b of trainBoxes(line, t)) {
        // Plan distance to the car's bounding circle (its yaw ignored:
        // conservative), and the height gap to its box.
        const plan = Math.max(
          0,
          Math.hypot(wrapDeltaAxis(b.x, eye.x), wrapDeltaAxis(b.z, eye.z)) -
            Math.hypot(b.hx, b.hz),
        );
        const dy = Math.max(0, Math.abs(eye.y - b.y) - b.hy);
        best = Math.min(best, Math.hypot(plan, dy));
      }
    }
  }
  return best;
}

/** A view's [x, y, z] as a point. */
export const xyz = (a) => ({ x: a[0], y: a[1], z: a[2] });
