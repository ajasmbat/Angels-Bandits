// F9 effortless controls, measured rather than guessed — the novice-pilot
// harness shared by novice-pilot.test.ts (the default scheme) and
// novice-classic.test.ts (the classic stick), two files so they run in
// parallel. Not a test file itself.
//
// A scripted novice flies the seed-42 city through waypoint routes — low
// legs between the towers with clear sight lines (the canyons), and every
// few legs a hole threaded mouth to mouth — for 30 s per seed, on 50 fixed
// seeds, at 30 Hz (a phone's frame rate; the pipeline is dt-aware).
//
// The hand: the chase eye's view direction lags the nose at the camera's
// own CAMERA_RESPONSE, and the novice puts the cursor (or, on a stick, the
// stick) where the waypoint appeared relative to that view 0.25 s ago — a
// visuomotor delay — plus Ornstein–Uhlenbeck tremor (σ 3°, τ 0.4 s),
// clamped to the screen. On the instructor the eye sits at the plane (no
// parallax) and the pipper is the gun line.
//
// Everything else is main.ts's pipeline: the H2 hole assist, the F5 corner
// manager (intent = the pilot's own command, assist excluded), the F9
// assist when the arm has it on, stepFlight, the H3 hole save, and
// detectCrash against the static solids (movers are left out of both arms:
// they are time-dependent, and F5, not F9, owns them). A crash costs what
// it costs in the game: the kill-cam, then a respawn at RESPAWN_ALTITUDE in
// U2's band around where the pilot was headed, flown back from there.

import {
  cityHoles,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
import { natureFor } from "@angels-bandits/common/city/nature";
import { bridgeSpans } from "@angels-bandits/common/city/river";
import {
  buildCityIndex,
  buildNatureIndex,
  collideCity,
  collideNature,
  hitsGround,
} from "@angels-bandits/common/collision";
import {
  BULLET_RANGE,
  CAMERA_RESPONSE,
  CITY_SEED,
  KILL_CAM_MS,
  MAX_SPEED,
  RESPAWN_ALTITUDE,
  RESPAWN_BAND_MAX,
  RESPAWN_BAND_MIN,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  createFlightState,
  flightForward,
  handlingRates,
  realRoll,
  stepFlight,
} from "@angels-bandits/common/flight";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import { detectCrash } from "../src/game/collision";
import {
  type CornerWorld,
  cornerCapInput,
  cornerSpeed,
  holeCorridors,
  stepCornerCap,
  threadingCorridor,
} from "../src/game/corner-speed";
import {
  ASSIST_MAX_ROLL,
  type EffortlessWorld,
  FEEL_TUNING,
  type Feel,
  arcSweep,
  createEffortless,
  createEffortlessOut,
  effortlessCommand,
  effortlessError,
  effortlessStick,
  resetEffortless,
  stepEffortless,
} from "../src/game/effortless";
import { AUTO_THROTTLE } from "../src/game/flight-input";
import {
  type AssistWorld,
  assistStick,
  createHoleAssist,
  holeAssistTarget,
  stepHoleAssist,
} from "../src/game/hole-assist";
import {
  type SaveWorld,
  createHoleSave,
  holeSaveActive,
  stepHoleSave,
} from "../src/game/hole-save";
import {
  type AimError,
  aimError,
  createInstructor,
  instructorInput,
} from "../src/game/instructor";

const DEG = Math.PI / 180;
const DT = 1 / 30;
/** Seconds flown per seed. */
const FLIGHT_S = 30;
/** Fixed seeds. */
export const SEEDS = Array.from({ length: 50 }, (_, i) => 1000 + i * 7919);
/** The novice: visuomotor delay, s; tremor σ (rad) and correlation time. */
const DELAY_S = 0.25;
const TREMOR = 3 * DEG;
const TREMOR_TAU = 0.4;
/** Where the hand can put the cursor: the screen's half-extents, rad. */
const SCREEN_YAW = 50 * DEG;
const SCREEN_PITCH = 32 * DEG;
/** A waypoint counts as reached inside this, m. */
const CAPTURE = 22;

// The real city, built once.
const buildings = generateCity(CITY_SEED);
const index = buildCityIndex(buildings);
const nature = buildNatureIndex(natureFor(CITY_SEED, buildings));
const spans = [...cityHoles(buildings), ...bridgeSpans()];
const cornerWorld: CornerWorld = {
  buildings,
  index,
  nature,
  corridors: holeCorridors(spans),
};
const assistWorld: AssistWorld = { spans, buildings, index };
const saveWorld: SaveWorld = { spans, buildings, index, nature };
const effWorld: EffortlessWorld = { buildings, index, nature };

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
const canon = (p: Vec3): Vec3 => ({
  x: ((p.x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE,
  y: p.y,
  z: ((p.z % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE,
});

/** Every sample along a→b is clear of a sphere of radius r. */
function clearSegment(a: Vec3, b: Vec3, r: number): boolean {
  const d = wrapDelta(a, b);
  const len = Math.hypot(d.x, d.y, d.z);
  const n = Math.max(1, Math.ceil(len / 3));
  const p: Vec3 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    p.x = a.x + d.x * t;
    p.y = a.y + d.y * t;
    p.z = a.z + d.z * t;
    if (hitsGround(p, r)) return false;
    if (collideCity(p, r, buildings, index) !== null) return false;
    if (collideNature(p, r, nature) !== null) return false;
  }
  return true;
}

export interface Route {
  start: Vec3;
  points: Vec3[];
  /** How many of its legs thread a hole. */
  holes: number;
}

/** A waypoint route for `seed`: low canyon legs with clear sight lines, and
 * every few legs a hole threaded mouth to mouth when one is reachable. */
function makeRoute(seed: number): Route {
  const rand = mulberry32(seed ^ 0x5eed_f9);
  let start: Vec3 | null = null;
  let heading = 0;
  while (start === null) {
    // A north–south street centreline, low.
    const p = {
      x: Math.floor(rand() * 10) * 200,
      y: 30 + rand() * 40,
      z: rand() * WORLD_SIZE,
    };
    heading = rand() < 0.5 ? 0 : Math.PI;
    const ahead = canon({
      x: p.x,
      y: p.y,
      z: p.z - Math.cos(heading) * 120,
    });
    if (clearSegment(p, ahead, 10)) start = p;
  }
  const points: Vec3[] = [];
  let holes = 0;
  let at = start;
  for (let n = 0; n < 40; n++) {
    let next: Vec3[] | null = null;
    if (n % 4 === 3) {
      // A hole: in through one mouth, out the other.
      for (const s of spans) {
        const d = wrapDelta(at, s.center);
        const dist = Math.hypot(d.x, d.z);
        if (dist < 200 || dist > 700) continue;
        const ax = s.hole.axis === "x" ? 1 : 0;
        const az = 1 - ax;
        const sign = ax * d.x + az * d.z > 0 ? 1 : -1;
        const near = sign > 0 ? s.entry : s.exit;
        const far = sign > 0 ? s.exit : s.entry;
        const a = canon({
          x: near.x - ax * sign * 70,
          y: s.center.y,
          z: near.z - az * sign * 70,
        });
        const b = canon({
          x: far.x + ax * sign * 70,
          y: s.center.y,
          z: far.z + az * sign * 70,
        });
        if (!clearSegment(a, b, 2.5)) continue;
        if (!clearSegment(at, a, 8)) continue;
        next = [a, b];
        holes++;
        break;
      }
    }
    if (next === null) {
      for (let k = 0; k < 600 && next === null; k++) {
        const spread = k < 300 ? 75 : 150;
        const h = heading + (rand() - 0.5) * 2 * spread * DEG;
        const dist = 150 + rand() * 250;
        const c = canon({
          x: at.x - Math.sin(h) * dist,
          y: 25 + rand() * 60,
          z: at.z - Math.cos(h) * dist,
        });
        if (clearSegment(at, c, 9)) next = [c];
      }
    }
    if (next === null) break;
    for (const p of next) {
      const d = wrapDelta(at, p);
      heading = Math.atan2(-d.x, -d.z);
      points.push(p);
      at = p;
    }
  }
  return { start, points, holes };
}

export const routes = SEEDS.map(makeRoute);

/** One arm of the comparison: the scheme the novice flies, the assist
 * setting and the feel. */
export interface Arm {
  scheme: "instructor" | "classic";
  assist: boolean;
  feel: Feel;
}

export interface Result {
  crashes: number;
  reached: number;
  seconds: number;
}

/** Gaussian from the seeded stream (Box–Muller). */
function gauss(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** The classic novice's hand: full stick at this much view offset, rad. */
const STICK_FULL = 30 * DEG;

/** Fly one route for FLIGHT_S (kill-cams included) — main.ts's pipeline
 * for the arm's scheme, with the novice's hand on it. */
function fly(arm: Arm, route: Route, seed: number): Result {
  const rand = mulberry32(seed ^ 0x0b1ce);
  const feel = FEEL_TUNING[arm.feel];
  const delaySteps = Math.round(DELAY_S / DT);
  const histYaw = new Float64Array(delaySteps + 1);
  const histPitch = new Float64Array(delaySteps + 1);
  let flight = createFlightState(route.start);
  let instructor = createInstructor();
  const eff = createEffortless();
  const effOut = createEffortlessOut();
  const assist = createHoleAssist();
  const want = createHoleAssist();
  const stickOut = { turn: 0, pitch: 0 };
  let save = createHoleSave();
  let cap = MAX_SPEED;
  let camYaw = 0;
  let camPitch = 0;
  let nYaw = 0;
  let nPitch = 0;
  let filled = 0;
  let wp = 0;
  let crashes = 0;
  let reached = 0;
  let t = 0;
  const cmd = { turn: 0, pitch: 0, roll: 0 };
  const zero = { yaw: 0, pitch: 0 };

  const spawn = (pos: Vec3, toward: Vec3, flying: boolean): void => {
    const d = wrapDelta(pos, toward);
    flight = createFlightState(pos, Math.atan2(-d.x, -d.z));
    // The route's start is a flying start; a respawn is the game's own
    // (RESPAWN_SPEED, createFlightState's).
    if (flying) flight = { ...flight, speed: MAX_SPEED };
    instructor = createInstructor();
    resetEffortless(eff);
    cap = MAX_SPEED;
    camYaw = flight.yaw;
    camPitch = 0;
    filled = 0;
    assist.yaw = assist.pitch = 0;
    save = createHoleSave();
  };
  /** The game's respawn (server/src/respawn.ts, U2): RESPAWN_ALTITUDE,
   * RESPAWN_BAND_MIN..MAX out from where the pilot was headed, nose on it. */
  const respawnNear = (target: Vec3): Vec3 => {
    const bearing = rand() * 2 * Math.PI;
    const r = RESPAWN_BAND_MIN + rand() * (RESPAWN_BAND_MAX - RESPAWN_BAND_MIN);
    return canon({
      x: target.x + Math.sin(bearing) * r,
      y: RESPAWN_ALTITUDE,
      z: target.z + Math.cos(bearing) * r,
    });
  };
  spawn(route.start, route.points[0] as Vec3, true);

  while (t < FLIGHT_S && wp < route.points.length) {
    const target = route.points[wp] as Vec3;
    const d = wrapDelta(flight.pos, target);
    if (Math.hypot(d.x, d.y, d.z) < CAPTURE) {
      wp++;
      reached++;
      continue;
    }
    // The view lags the nose (the chase arm's own blend).
    const blend = 1 - Math.exp(-CAMERA_RESPONSE * DT);
    camYaw += wrap(flight.yaw - camYaw) * blend;
    camPitch += (flight.pitch - camPitch) * blend;
    // Where the waypoint sits in the view, recorded; the hand acts on the
    // record from DELAY_S ago, plus tremor, within the screen.
    const slot = filled % (delaySteps + 1);
    histYaw[slot] = wrap(Math.atan2(-d.x, -d.z) - camYaw);
    histPitch[slot] = Math.atan2(d.y, Math.hypot(d.x, d.z)) - camPitch;
    filled++;
    const old =
      filled > delaySteps ? (filled - delaySteps - 1) % (delaySteps + 1) : 0;
    const k = Math.sqrt((2 * DT) / TREMOR_TAU) * TREMOR;
    nYaw += (-nYaw / TREMOR_TAU) * DT + k * gauss(rand);
    nPitch += (-nPitch / TREMOR_TAU) * DT + k * gauss(rand);
    const offYaw = clamp(
      (histYaw[old] as number) + nYaw,
      -SCREEN_YAW,
      SCREEN_YAW,
    );
    const offPitch = clamp(
      (histPitch[old] as number) + nPitch,
      -SCREEN_PITCH,
      SCREEN_PITCH,
    );
    const aimYaw = camYaw + offYaw;
    const aimPitch = camPitch + offPitch;
    const cp = Math.cos(aimPitch);
    const aimDir = {
      x: -Math.sin(aimYaw) * cp,
      y: Math.sin(aimPitch),
      z: -Math.cos(aimYaw) * cp,
    };
    const fwd = flightForward(flight);
    const roll = realRoll(flight);
    const rates = handlingRates(flight.speed, false);
    const instructorMode = arm.scheme === "instructor";
    // H2 hole assist, with main's roll stand-down; it reads where the
    // pilot means to go (the cursor, or the nose for a stick).
    if (Math.abs(roll) > ASSIST_MAX_ROLL) want.yaw = want.pitch = 0;
    else
      holeAssistTarget(
        flight.pos,
        instructorMode ? aimDir : fwd,
        assistWorld,
        want,
      );
    stepHoleAssist(assist, want, DT);
    const assisting = assist.yaw !== 0 || assist.pitch !== 0;
    // The pilot's own command, assist excluded: the corner manager's intent.
    let err: AimError = zero;
    if (instructorMode) {
      const pipper = {
        x: fwd.x * BULLET_RANGE,
        y: fwd.y * BULLET_RANGE,
        z: fwd.z * BULLET_RANGE,
      };
      err = aimError(flight, aimDir, pipper);
      const pilot = instructorInput(
        err,
        zero,
        false,
        DT,
        instructor,
        rates,
        feel,
      );
      cmd.turn = pilot.turn;
      cmd.pitch = pilot.pitch;
    } else {
      cmd.turn = clamp(-offYaw / STICK_FULL, -1, 1);
      cmd.pitch = clamp(offPitch / STICK_FULL, -1, 1);
    }
    cmd.roll = 0;
    cap = stepCornerCap(
      cap,
      cornerSpeed(
        flight,
        cornerWorld,
        cmd.turn * Math.cos(roll),
        null,
        arm.assist
          ? arcSweep(flight, instructorMode ? aimDir : null)
          : undefined,
      ),
      DT,
    );
    stepEffortless(
      eff,
      flight,
      {
        enabled: arm.assist,
        active: true,
        gap: 0,
        levelPitch: !instructorMode,
        firing: false,
        threading:
          assisting ||
          holeSaveActive(save) ||
          threadingCorridor(cornerWorld, flight, fwd.x, fwd.z) !== null,
        pilotTurn: cmd.turn,
        pilotPitch: cmd.pitch,
        cornerCap: cornerCapInput(cap),
        aim: instructorMode ? aimDir : null,
        turnRate: rates.turnRate,
        pitchRate: rates.pitchRate,
      },
      effWorld,
      DT,
      effOut,
    );
    if (instructorMode) {
      const biased = {
        yaw: err.yaw - assist.yaw,
        pitch: err.pitch + assist.pitch,
      };
      effortlessError(effOut, feel, rates.turnRate, rates.pitchRate, biased);
      instructor = instructorInput(
        biased,
        zero,
        false,
        DT,
        instructor,
        rates,
        feel,
      );
      cmd.turn = instructor.turn;
      cmd.pitch = instructor.pitch;
      effortlessCommand(effOut, roll, cmd);
    } else {
      if (assisting) {
        assistStick(assist, cmd, rates, stickOut);
        cmd.turn = stickOut.turn;
        cmd.pitch = stickOut.pitch;
      }
      effortlessStick(effOut, feel, roll, rates.turnRate, rates.pitchRate, cmd);
    }
    const shaped: FlightInput = {
      turn: cmd.turn,
      pitch: cmd.pitch,
      roll: cmd.roll,
      throttle: AUTO_THROTTLE,
      cornerCap: cornerCapInput(cap),
    };
    flight = stepFlight(flight, shaped, DT);
    stepHoleSave(save, flight, shaped, DT, saveWorld, null, !instructorMode);
    t += DT;
    if (detectCrash(flight, buildings, index, undefined, null, nature)) {
      crashes++;
      t += KILL_CAM_MS / 1000;
      spawn(respawnNear(target), target, false);
    }
  }
  return { crashes, reached, seconds: t };
}

export function flyAll(arm: Arm): Result {
  const total: Result = { crashes: 0, reached: 0, seconds: 0 };
  routes.forEach((route, i) => {
    const r = fly(arm, route, SEEDS[i] as number);
    total.crashes += r.crashes;
    total.reached += r.reached;
    total.seconds += r.seconds;
  });
  return total;
}

/** Mean time per waypoint reached, s — kill-cams and the flight back
 * from a respawn included. */
export const perWaypoint = (r: Result): number =>
  r.seconds / Math.max(1, r.reached);

export const report = (name: string, r: Result): string =>
  `${name}: ${r.crashes} crashes, ${r.reached} waypoints, ${perWaypoint(r).toFixed(2)} s/waypoint`;
