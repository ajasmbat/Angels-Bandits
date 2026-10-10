// F9 effortless controls, measured rather than guessed — the novice-pilot
// harness shared by novice-pilot.test.ts (the default scheme) and
// novice-classic.test.ts (the classic stick), two files so they run in
// parallel. Not a test file itself.
//
// A scripted novice flies the seed-42 city through waypoint routes — low
// legs between the towers with clear sight lines (the canyons), every few
// legs a hole threaded mouth to mouth, and (every third route, plus any
// that pass close) a U4 tunnel: down a plaza portal's cut or in at a river
// mouth, along the bore, out a portal — for 30 s per seed, on 50 fixed
// seeds, at 30 Hz (a phone's frame rate; the pipeline is dt-aware).
//
// The hand: the chase eye's view direction lags the nose at the camera's
// own CAMERA_RESPONSE, and the novice puts the cursor (or, on a stick, the
// stick) where the waypoint appeared relative to that view 0.25 s ago — a
// visuomotor delay — plus Ornstein–Uhlenbeck tremor (σ 3°, τ 0.4 s),
// clamped to the screen. On the instructor the eye sits at the plane (no
// parallax) and the pipper is the gun line.
//
// Everything else is main.ts's pipeline, U4 wiring included: the H2 hole
// assist, the F5 corner manager (intent = the pilot's own command, assist
// excluded; a bore never brakes), the F9
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
  TUNNELS,
  type Tunnel,
  type TunnelPoint,
  guideY,
  tunnelPointInto,
} from "@angels-bandits/common/city/tunnels";
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
  bankPitchMult,
  createFlightState,
  flightForward,
  handlingRates,
  realRoll,
  stepFlight,
} from "@angels-bandits/common/flight";
import {
  BOT_TUNING,
  DEFAULT_TUNING,
  type FlightTuning,
} from "@angels-bandits/common/tuning";
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
  createBankPull,
  createInstructor,
  instructorBankPull,
  instructorInput,
} from "../src/game/instructor";
import {
  createRollControl,
  resetRollControl,
  stepRollControl,
} from "../src/game/roll-control";

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
/** Waypoint spacing along a bore, m (its bends are 300 m radius). */
const TUNNEL_STEP = 120;
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
  tunnels: true, // U4, as main.ts: a bore's corridor never brakes
};
const assistWorld: AssistWorld = { spans, buildings, index };
const saveWorld: SaveWorld = {
  spans,
  tunnels: TUNNELS, // U4, as main.ts
  buildings,
  index,
  nature,
};
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
  /** How many of its legs thread a hole… */
  holes: number;
  /** …and how many U4 tunnels it flies through. */
  tunnels: number;
}

/** A waypoint route for `seed`: low canyon legs with clear sight lines, and
 * every few legs a hole threaded mouth to mouth when one is reachable. */
function makeRoute(seed: number, i: number): Route {
  const rand = mulberry32(seed ^ 0x5eed_f9);
  let start: Vec3 | null = null;
  let heading = 0;
  const points: Vec3[] = [];
  let holes = 0;
  let tunnels = 0;
  // Every third route opens with a U4 transit, so the bores are flown.
  const bore =
    i % 3 === 0 && TUNNEL_STARTS.length > 0
      ? (TUNNEL_STARTS[(i / 3) % TUNNEL_STARTS.length] as Vec3[])
      : null;
  if (bore !== null) {
    start = bore[0] as Vec3;
    points.push(...bore.slice(1));
    tunnels++;
    const d = wrapDelta(
      bore[bore.length - 2] as Vec3,
      bore[bore.length - 1] as Vec3,
    );
    heading = Math.atan2(-d.x, -d.z);
  }
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
  let at = points.length > 0 ? (points[points.length - 1] as Vec3) : start;
  for (let n = 0; n < 40; n++) {
    let next: Vec3[] | null = null;
    if (n === 2) {
      next = tunnelTransit(at);
      if (next !== null) tunnels++;
    }
    if (next === null && n % 4 === 3) {
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
  return { start, points, holes, tunnels };
}

/** A U4 transit from `at` when one is in reach: in through a plaza portal
 * (diving down its cut) or a river mouth, along the bore every
 * TUNNEL_STEP m at its guide height, and out a plaza portal's ramp. */
function tunnelTransit(at: Vec3): Vec3[] | null {
  for (const t of TUNNELS) {
    for (const dir of [1, -1] as const) {
      const legs = boreLegs(t, dir, 120);
      if (legs === null) continue;
      const d = wrapDelta(at, legs[0] as Vec3);
      const dist = Math.hypot(d.x, d.z);
      if (dist < 150 || dist > 700) continue;
      if (clearSegment(at, legs[0] as Vec3, 8)) return legs;
    }
  }
  return null;
}

const pt: TunnelPoint = { x: 0, z: 0, th: 0 };

/** Waypoints through `t` flying `dir` (+1: s = 0 → L): a clear approach
 * outside the entrance (up to `lead` m out — over the lawn for a plaza,
 * at the guide height for a river mouth), then along the guide line as far
 * apart as a straight leg stays clear (≤ TUNNEL_STEP), and out a plaza
 * portal; null unless the exit is a plaza and every leg clears a 4 m
 * sphere. */
function boreLegs(t: Tunnel, dir: 1 | -1, lead: number): Vec3[] | null {
  if (t.ends[dir > 0 ? 1 : 0].kind !== "plaza") return null;
  const point = (s: number, y: number): Vec3 => {
    tunnelPointInto(t, s, pt);
    return canon({ x: pt.x, y, z: pt.z });
  };
  const sIn = dir > 0 ? 0 : t.length;
  const sOut = dir > 0 ? t.length : 0;
  const plaza = t.ends[dir > 0 ? 0 : 1].kind === "plaza";
  // The guide line, every 30 m, from the entrance to past the exit lip.
  const line: Vec3[] = [];
  for (let u = 0; u <= t.length + 60; u += 30) {
    const sk = sIn + dir * u;
    line.push(point(sk, guideY(t, sk)));
  }
  line.push(point(sOut + dir * 120, 30));
  // A clear approach onto the first guide point.
  let approach: Vec3 | null = null;
  for (let out = lead; out >= 30 && approach === null; out -= 15) {
    const p = point(sIn - dir * out, plaza ? 30 : guideY(t, sIn));
    if (clearSegment(p, line[1] as Vec3, 4)) approach = p;
  }
  if (approach === null) return null;
  const legs: Vec3[] = [approach];
  let from = approach;
  let i = 1;
  while (i < line.length) {
    // The farthest guide point a straight leg still reaches clear.
    let j = i;
    let best = -1;
    while (j < line.length) {
      const d = wrapDelta(from, line[j] as Vec3);
      if (j > i && Math.hypot(d.x, d.z) > TUNNEL_STEP) break;
      if (clearSegment(from, line[j] as Vec3, 4)) best = j;
      j++;
    }
    if (best < 0) {
      // Only the climb-out beyond the lip may be dropped: the route goes
      // on from the lawn.
      if (i === line.length - 1) break;
      return null;
    }
    from = line[best] as Vec3;
    legs.push(from);
    i = best + 1;
  }
  return legs;
}

/** Every bore pass that ends out a plaza portal, from just outside its
 * entrance: the opening every third route flies (makeRoute). */
const TUNNEL_STARTS: Vec3[][] = TUNNELS.flatMap((t) =>
  ([1, -1] as const).flatMap((dir) => {
    const lead = t.ends[dir > 0 ? 0 : 1].kind === "plaza" ? 120 : 60;
    const legs = boreLegs(t, dir, lead);
    return legs === null ? [] : [legs];
  }),
);

export const routes = SEEDS.map((seed, i) => makeRoute(seed, i));

/** One arm of the comparison: the scheme the novice flies, the assist
 * setting and the feel. */
export interface Arm {
  scheme: "instructor" | "classic";
  assist: boolean;
  feel: Feel;
  /** F10's roll: the player's flight model (held bank, bank-and-pull,
   * knife-edge lift) through main's roll control (stray roll levelled,
   * the ROLL AUTO-LEVEL setting at `rollLevel`), the instructor's
   * bank-and-pull and the corner auto-slow's bank stand-down. Absent: the
   * pre-F10 roll model (BOT_TUNING's), exactly as main flew before F10. */
  f10?: { rollLevel: "off" | "gentle" | "strong" };
}

/** F10: past this |sin roll| (60°) the corner auto-slow stands down. */
const CORNER_BANK_OUT = Math.sin(60 * DEG);

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
  const f10 = arm.f10;
  const model: Readonly<FlightTuning> = f10 ? DEFAULT_TUNING : BOT_TUNING;
  const rollCtl = createRollControl();
  const bankPull = createBankPull();
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
    resetRollControl(rollCtl);
    bankPull.engaged = false;
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
    const rates = handlingRates(flight.speed, false, model);
    if (f10) rates.pitchRate *= bankPitchMult(roll, model);
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
      f10 && Math.abs(Math.sin(roll)) > CORNER_BANK_OUT
        ? MAX_SPEED
        : cornerSpeed(
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
    let bankAuto: number | null = null;
    if (f10) {
      // Main: roll control owns the wing levelling; the bank-and-pull.
      effOut.roll = 0;
      if (instructorMode) {
        bankAuto = instructorBankPull(
          bankPull,
          flight,
          aimDir,
          fwd,
          effOut.pitch > 0 ||
            eff.guard >= 0 ||
            effOut.aimYaw !== 0 ||
            effOut.aimPitch !== 0 ||
            cap < MAX_SPEED ||
            assisting ||
            holeSaveActive(save),
        );
      }
    }
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
    if (f10) {
      cmd.roll = stepRollControl(
        rollCtl,
        {
          key: 0,
          auto: bankAuto,
          mode: f10.rollLevel,
          roll,
          pitch: flight.pitch,
        },
        DT,
      );
    }
    const shaped: FlightInput = {
      turn: cmd.turn,
      pitch: cmd.pitch,
      roll: cmd.roll,
      throttle: AUTO_THROTTLE,
      cornerCap: cornerCapInput(cap),
    };
    flight = stepFlight(flight, shaped, DT, model);
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
