// The O5 flicker GRID: the views and world instants `flicker.mjs --grid`
// scores. Two kinds of view:
//
//  - every static gallery view (gallery-views.mjs), framed from just behind
//    and above its plane pose, the way the chase camera would see it;
//  - POSES seeded poses (mulberry32, so every build and every run scores the
//    SAME 20 places) at 10–300 m, skewed low, where the street, roof and hole
//    detail lives. A pose is kept only if the eye is in open air (clear of
//    the shared solids by EYE_CLEARANCE) and the first SIGHT_CLEAR m of the
//    view are unobstructed, so no view is a wall a metre from the lens.
//
// The dyn and train gallery views are left out: they frame a mover that
// flies through the shot, which is motion, not shimmer.
//
// Each view also gets its own world instant (`timeMs`), spread over the
// night so the grid samples different times as well as places, and each
// placed in a gap of the storm schedule (a pure function of seed and time)
// so no strike flash can land inside its capture.
//
// Imports the shared TypeScript through tsx, so the poses are checked
// against exactly the city the server generates.

import { register } from "tsx/esm/api";
import { VIEWS } from "./gallery-views.mjs";

register();
const { generateCity, mulberry32 } = await import(
  "../../common/src/city/index.ts"
);
const { natureFor } = await import("../../common/src/city/nature.ts");
const {
  buildCityIndex,
  buildNatureIndex,
  collideCity,
  collideNature,
  hitsGround,
  losClear,
} = await import("../../common/src/collision.ts");
const { strikesInWindow } = await import("../../common/src/storm.ts");
const { CITY_SEED, WORLD_SIZE } = await import("../../common/src/constants.ts");

/** Seeded poses per grid. */
export const POSES = 20;
/** Salt for the pose stream — change it and every pose moves. */
const POSE_SALT = 0x05f11c4e;
/** The eye stays this far from any solid. */
const EYE_CLEARANCE = 6;
/** The first this-many metres of every seeded view are unobstructed. */
const SIGHT_CLEAR = 60;
/** Chase-camera framing for a gallery pose: back along the heading, up. */
const CHASE_BACK = 14;
const CHASE_UP = 4;
/** The plane is held this far behind the eye (out of shot). */
const PLANE_BACK = 18;
/** Look-at distance, metres. */
const LOOK = 200;
/** World time one view's capture spans, generously (settle + frames). */
const VIEW_SPAN_MS = 2_000;
/** No strike within this long before a view's capture (its flash fades). */
const FLASH_FADE_MS = 4_500;

/** Unit view direction: yaw 0 faces -Z, pitch up positive. */
function dir(yaw, pitch) {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

function view(name, eye, yaw, pitch, extra = {}) {
  const d = dir(yaw, pitch);
  return {
    name,
    eye,
    at: { x: eye.x + d.x * LOOK, y: eye.y + d.y * LOOK, z: eye.z + d.z * LOOK },
    // Horizontal right vector — the pan slides along it.
    right: { x: Math.cos(yaw), z: -Math.sin(yaw) },
    ...extra,
  };
}

/**
 * Every grid view, in capture order, each with its world instant.
 * `startMs` is the earliest server time a capture can begin at.
 */
export function gridViews(startMs) {
  const buildings = generateCity(CITY_SEED);
  const index = buildCityIndex(buildings);
  const nature = buildNatureIndex(natureFor(CITY_SEED, buildings));
  const out = [];
  const open = (p) =>
    !hitsGround(p, EYE_CLEARANCE) &&
    collideCity(p, EYE_CLEARANCE, buildings, index) === null &&
    collideNature(p, EYE_CLEARANCE, nature) === null;
  /**
   * Where the plane is held for a view: PLANE_BACK m behind the eye at its
   * height — out of shot, but close, so the street (micro) tier streams
   * around the view and the atmosphere is the one at the eye's altitude —
   * else straight above it, else at the classic 330 m.
   */
  const planeFor = (eye, yaw) => {
    const d = dir(yaw, 0);
    const back = {
      x: eye.x - d.x * PLANE_BACK,
      y: eye.y,
      z: eye.z - d.z * PLANE_BACK,
    };
    if (open(back)) return back;
    const up = { x: eye.x, y: eye.y + 40, z: eye.z };
    if (open(up)) return up;
    return { x: eye.x, y: 330, z: eye.z };
  };
  for (const v of VIEWS) {
    if (v.dyn || v.train) continue;
    if (v.eye) {
      // A1/G1 views name their own eye and look-at.
      const [ex, ey, ez] = v.eye;
      const [ax, ay, az] = v.at;
      const yaw = Math.atan2(-(ax - ex), -(az - ez));
      const pitch = Math.atan2(ay - ey, Math.hypot(ax - ex, az - ez));
      const eye = { x: ex, y: ey, z: ez };
      out.push(
        view(v.name, eye, yaw, pitch, {
          sky: v.sky ?? "night",
          plane: planeFor(eye, yaw),
          // DT1: planes posed for the view (__ab.planeShowcase).
          ...(v.showcase ? { showcase: v.showcase } : {}),
        }),
      );
      continue;
    }
    const pitch = v.pitch ?? -0.08;
    const d = dir(v.yaw, 0);
    const eye = {
      x: v.x - d.x * CHASE_BACK,
      y: v.y + CHASE_UP,
      z: v.z - d.z * CHASE_BACK,
    };
    out.push(
      view(v.name, eye, v.yaw, pitch, {
        sky: v.sky ?? "night",
        plane: planeFor(eye, v.yaw),
      }),
    );
  }
  const rand = mulberry32(POSE_SALT);
  for (let k = 0, tries = 0; k < POSES && tries < 10_000; tries++) {
    const eye = {
      x: rand() * WORLD_SIZE,
      // Skewed low: half the poses sit under ~80 m.
      y: 10 + 290 * rand() ** 2,
      z: rand() * WORLD_SIZE,
    };
    const yaw = rand() * Math.PI * 2;
    // Mostly looking a little down, as a pilot does; low eyes look level.
    const pitch = eye.y < 40 ? -0.05 - 0.1 * rand() : -0.6 * rand() + 0.05;
    if (!open(eye)) continue;
    const d = dir(yaw, pitch);
    const near = {
      x: eye.x + d.x * SIGHT_CLEAR,
      y: eye.y + d.y * SIGHT_CLEAR,
      z: eye.z + d.z * SIGHT_CLEAR,
    };
    if (near.y < 2 || !losClear(eye, near, buildings)) continue;
    const r = (n) => Math.round(n * 10) / 10;
    out.push(
      view(
        `pose-${String(k).padStart(2, "0")}`,
        { x: r(eye.x), y: r(eye.y), z: r(eye.z) },
        yaw,
        pitch,
        {
          sky: "night",
          plane: planeFor(eye, yaw),
        },
      ),
    );
    k++;
  }
  // World instants: one storm-gap per view, marching forward.
  let t = startMs;
  for (const v of out) {
    for (;;) {
      const recent = strikesInWindow(
        CITY_SEED,
        t - FLASH_FADE_MS,
        t + VIEW_SPAN_MS,
      );
      if (recent.length === 0) break;
      t = (recent[recent.length - 1]?.timeMs ?? t) + FLASH_FADE_MS + 1;
    }
    v.timeMs = Math.round(t);
    // Spread the views through the night: ~37 s apart.
    t += 37_000;
  }
  return out;
}
