// FC1: the novice pilot on three courses, before vs after — what the gun-sight
// zoom and the easy, agile controls are measured against.
//
//   node --import tsx tools/flight-courses.ts [--runs=N] [--json]
//        [--only=slalom|turns|chase] [--set=key:value,…]
//
// --set moves the AFTER arm's tuning (a Flight Lab session on the courses);
// FC_DEBUG=1 logs every crash (where, how fast, what the assists held).
//
// The pilot is client/test/novice-sim.ts's novice: the chase eye's view lags
// the nose at CAMERA_RESPONSE, and the hand puts the cursor where the mark
// sat in that view DELAY_S ago, plus Ornstein–Uhlenbeck tremor (σ 3°, τ 0.4
// s) clamped to the screen (zoomed, the tremor shrinks with the FOV: it is a
// hand on a screen, not an angle). 30 Hz, a phone's frame rate.
//
// The pipeline is main.ts's for the mouse-aim instructor (the default
// scheme): the H2 hole assist, the F5 corner manager, the F9 assist, the F10
// bank-and-pull and roll control, the instructor, the aim zoom's steering
// cost, stepFlight and the H3 hole save — and, in the AFTER arm, FC1's
// collision assist and its zoom steering (the mouse-aim keeps its full
// authority zoomed; before, a flat 0.6). Both arms see the chase as the
// novice-sim's eye at the plane. The BEFORE arm flies the "pre-fc1" tuning
// preset with every FC1 addition off: main as it was. Movers (airships included) are
// left out of both arms, as in novice-sim: they are time-dependent and the
// airship half of the collision assist is pinned by its unit tests.
//
// Courses, on the seed-42 city:
//   slalom  — down an avenue at 30–60 m, gates alternating ±10 m off the
//             centreline every 110 m;
//   turns   — street to street at 35–60 m, a 90° turn at every
//             intersection, left or right where the cross street is clear;
//   chase   — over the roofs at 350–410 m a target at 82 m/s jinks every
//             2–3.5 s (a new heading 35–80° off, ±12° of climb); the novice
//             holds the zoom and keeps the cursor on its lead point.
// A crash costs the kill-cam (not counted as flying time) and restarts the
// run at the last gate it passed, pointed at the next.
//
// Metrics: crashes per minute flown; time on target (chase: share of time the
// gun line is within the target's hit sphere at its lead point); time-to-aim
// (chase: from each jink to the gun line back inside the target's hit cone
// at its lead point — once the jink has thrown it LOST_K cones off; a jink
// tracked straight through takes 0, one never re-acquired its whole
// interval).

import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import { cityHoles } from "@angels-bandits/common/city";
import { natureFor } from "@angels-bandits/common/city/nature";
import { bridgeSpans } from "@angels-bandits/common/city/river";
import { TUNNELS } from "@angels-bandits/common/city/tunnels";
import {
  buildCityIndex,
  buildNatureIndex,
  collideCity,
  collideNature,
  hitsGround,
} from "@angels-bandits/common/collision";
import {
  BLOCK_PITCH,
  BULLET_RANGE,
  BULLET_SPEED,
  CAMERA_RESPONSE,
  CITY_SEED,
  HIT_RADIUS,
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
  DEFAULT_TUNING,
  type FlightTuning,
  TUNING_PRESETS,
  feelFromTuning,
  presetTuning,
} from "@angels-bandits/common/tuning";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import { detectCrash } from "../client/src/game/collision";
import {
  type CollisionAssistWorld,
  collisionAssistError,
  createCollisionAssist,
  resetCollisionAssist,
  stepCollisionAssist,
} from "../client/src/game/collision-assist";
import {
  type CornerWorld,
  cornerCapInput,
  cornerSpeed,
  holeCorridors,
  stepCornerCap,
  threadingCorridor,
} from "../client/src/game/corner-speed";
import {
  ASSIST_MAX_ROLL,
  type EffortlessWorld,
  arcSweep,
  createEffortless,
  createEffortlessOut,
  effortlessCommand,
  effortlessError,
  resetEffortless,
  stepEffortless,
} from "../client/src/game/effortless";
import { shapeInput } from "../client/src/game/freelook";
import {
  type AssistWorld,
  createHoleAssist,
  holeAssistTarget,
  stepHoleAssist,
} from "../client/src/game/hole-assist";
import {
  type SaveWorld,
  createHoleSave,
  holeSaveActive,
  stepHoleSave,
} from "../client/src/game/hole-save";
import {
  type AimError,
  aimError,
  angleBetween,
  createBankPull,
  createInstructor,
  instructorBankPull,
  instructorInput,
} from "../client/src/game/instructor";
import {
  createRollControl,
  resetRollControl,
  stepRollControl,
} from "../client/src/game/roll-control";
import { tuning as live } from "../client/src/game/tuning";
import {
  PRE_FC1_ZOOM_STEER,
  zoomFov,
  zoomSteer,
} from "../client/src/game/zoom";

const DEG = Math.PI / 180;
const DT = 1 / 30;
const RUN_S = 30;
const DELAY_S = 0.25;
const TREMOR = 3 * DEG;
const TREMOR_TAU = 0.4;
const SCREEN_YAW = 50 * DEG;
const SCREEN_PITCH = 32 * DEG;
/** Chase: a jink has thrown the aim off once the gun line is this many hit
 * cones off the lead point; it is back on aim inside one. */
const LOST_K = 2;
/** Kill-cam, s — not flying time. */
const KILL_CAM_S = 2.5;

// --- The world ---------------------------------------------------------------

const buildings = generateCity(CITY_SEED);
const index = buildCityIndex(buildings);
const nature = buildNatureIndex(natureFor(CITY_SEED, buildings));
const spans = [...cityHoles(buildings), ...bridgeSpans()];
const cornerWorld: CornerWorld = {
  buildings,
  index,
  nature,
  corridors: holeCorridors(spans),
  tunnels: true,
};
const assistWorld: AssistWorld = { spans, buildings, index };
const saveWorld: SaveWorld = {
  spans,
  tunnels: TUNNELS,
  buildings,
  index,
  nature,
};
const effWorld: EffortlessWorld = { buildings, index, nature };
const caWorld: CollisionAssistWorld = { buildings, index, nature };

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
const canon = (p: Vec3): Vec3 => ({
  x: ((p.x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE,
  y: p.y,
  z: ((p.z % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE,
});

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

// --- Courses -------------------------------------------------------------------

type CourseKind = "slalom" | "turns" | "chase";

interface Course {
  kind: CourseKind;
  start: Vec3;
  /** Gates / intersections, in order (slalom, turns). */
  points: Vec3[];
  /** Chase: the target's path, one pose every DT, and its jink frames. */
  target?: { pos: Vec3[]; vel: Vec3[]; jinks: number[] };
}

/** Down an avenue (a street line along z), gates ±10 m every 110 m. */
function slalom(rand: () => number): Course | null {
  const x = Math.floor(rand() * (WORLD_SIZE / BLOCK_PITCH)) * BLOCK_PITCH;
  const y = 30 + rand() * 30;
  const z0 = rand() * WORLD_SIZE;
  const dir = rand() < 0.5 ? -1 : 1;
  const start = canon({ x, y, z: z0 });
  const points: Vec3[] = [];
  let at = start;
  for (let i = 1; i <= 24; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const p = canon({ x: x + side * 10, y, z: z0 + dir * 110 * i });
    if (!clearSegment(at, p, 7)) break;
    points.push(p);
    at = p;
  }
  return points.length >= 6 ? { kind: "slalom", start, points } : null;
}

/** Street to street, a 90° turn at every intersection. */
function turns(rand: () => number): Course | null {
  const n = WORLD_SIZE / BLOCK_PITCH;
  let ix = Math.floor(rand() * n);
  let iz = Math.floor(rand() * n);
  const y = 35 + rand() * 25;
  const at = (i: number, j: number): Vec3 =>
    canon({ x: i * BLOCK_PITCH, y, z: j * BLOCK_PITCH });
  // Heading along one axis: 0 = +x, 1 = +z, 2 = −x, 3 = −z.
  let h = Math.floor(rand() * 4);
  const step = (hh: number): [number, number] =>
    [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ][hh] as [number, number];
  const [sx, sz] = step(h);
  const start = canon({
    x: (ix - sx * 0.6) * BLOCK_PITCH,
    y,
    z: (iz - sz * 0.6) * BLOCK_PITCH,
  });
  if (!clearSegment(start, at(ix, iz), 7)) return null;
  const points: Vec3[] = [at(ix, iz)];
  for (let k = 0; k < 14; k++) {
    // A 90° turn: one way or the other, whichever cross street is clear.
    const first = rand() < 0.5 ? 1 : 3;
    let moved = false;
    for (const t of [first, 4 - first]) {
      const nh = (h + t) % 4;
      const [dx, dz] = step(nh);
      const p = at(ix + dx, iz + dz);
      if (clearSegment(at(ix, iz), p, 7)) {
        ix += dx;
        iz += dz;
        h = nh;
        points.push(p);
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return points.length >= 5 ? { kind: "turns", start, points } : null;
}

/** Over the roofs: a jinking target and a chaser 160 m behind it. */
function chase(rand: () => number): Course | null {
  const total = Math.ceil(RUN_S / DT) + 1;
  const pos: Vec3[] = [];
  const vel: Vec3[] = [];
  const jinks: number[] = [];
  const speed = 82;
  let p = canon({ x: rand() * WORLD_SIZE, y: 370, z: rand() * WORLD_SIZE });
  let yaw = rand() * 2 * Math.PI;
  let climb = 0;
  let want = yaw;
  let wantClimb = 0;
  let next = Math.round(1.5 / DT);
  for (let i = 0; i < total; i++) {
    if (i === next) {
      // A jink whose next 3 s are clear air (else try the other way).
      let ok = false;
      for (let k = 0; k < 12 && !ok; k++) {
        const off = (35 + rand() * 45) * DEG * (rand() < 0.5 ? -1 : 1);
        const c = (rand() * 2 - 1) * 12 * DEG;
        const cy = p.y + Math.sin(c) * speed * 3;
        if (cy < 350 || cy > 410) continue;
        const ahead = canon({
          x: p.x - Math.sin(yaw + off) * speed * 3,
          y: cy,
          z: p.z - Math.cos(yaw + off) * speed * 3,
        });
        if (!clearSegment(p, ahead, 15)) continue;
        want = yaw + off;
        wantClimb = c;
        ok = true;
      }
      if (ok) jinks.push(i);
      next = i + Math.round((2 + rand() * 1.5) / DT);
    }
    // The target turns at 50°/s toward its new heading — a hard break.
    yaw += clamp(wrap(want - yaw), -50 * DEG * DT, 50 * DEG * DT);
    climb += clamp(wantClimb - climb, -30 * DEG * DT, 30 * DEG * DT);
    if (Math.abs(p.y - 380) > 25) wantClimb = 0;
    const cp = Math.cos(climb);
    const v = {
      x: -Math.sin(yaw) * cp * speed,
      y: Math.sin(climb) * speed,
      z: -Math.cos(yaw) * cp * speed,
    };
    pos.push(p);
    vel.push(v);
    p = canon({ x: p.x + v.x * DT, y: p.y + v.y * DT, z: p.z + v.z * DT });
  }
  const v0 = vel[0] as Vec3;
  const sp = Math.hypot(v0.x, v0.y, v0.z);
  const start = canon({
    x: (pos[0] as Vec3).x - (v0.x / sp) * 160,
    y: (pos[0] as Vec3).y,
    z: (pos[0] as Vec3).z - (v0.z / sp) * 160,
  });
  if (!clearSegment(start, pos[0] as Vec3, 15)) return null;
  return { kind: "chase", start, points: [], target: { pos, vel, jinks } };
}

function courses(kind: CourseKind, runs: number): Course[] {
  const out: Course[] = [];
  const rand = mulberry32(
    0xfc1 ^ (kind === "slalom" ? 1 : kind === "turns" ? 2 : 3),
  );
  const make = kind === "slalom" ? slalom : kind === "turns" ? turns : chase;
  while (out.length < runs) {
    const c = make(rand);
    if (c) out.push(c);
  }
  return out;
}

// --- Arms ----------------------------------------------------------------------

export interface Arm {
  name: string;
  tuning: Readonly<FlightTuning>;
  /** FC1's additions: the collision assist and the new zoom. */
  fc1: boolean;
}

const preFc1 = TUNING_PRESETS.find((p) => p.id === "pre-fc1");
if (!preFc1) throw new Error("no pre-fc1 preset");
export const BEFORE: Arm = {
  name: "before",
  tuning: presetTuning(preFc1),
  fc1: false,
};
export const AFTER: Arm = { name: "after", tuning: DEFAULT_TUNING, fc1: true };

export interface CourseResult {
  crashes: number;
  /** Seconds flown (kill-cams excluded). */
  flown: number;
  /** Gates / intersections reached. */
  reached: number;
  /** Chase only. */
  onTarget: number;
  aimTimes: number[];
}

function gauss(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** One run of `course` under `arm` — main's instructor pipeline. */
function fly(arm: Arm, course: Course, seed: number): CourseResult {
  Object.assign(live, arm.tuning);
  const model = live;
  const feel = feelFromTuning(live);
  const rand = mulberry32(seed ^ 0x0b1ce);
  const delaySteps = Math.round(DELAY_S / DT);
  const histYaw = new Float64Array(delaySteps + 1);
  const histPitch = new Float64Array(delaySteps + 1);
  const rollCtl = createRollControl();
  const bankPull = createBankPull();
  const ca = createCollisionAssist();
  let flight = createFlightState(course.start, 0, model);
  let instructor = createInstructor();
  const eff = createEffortless();
  const effOut = createEffortlessOut();
  const assist = createHoleAssist();
  const want = createHoleAssist();
  let save = createHoleSave();
  let cap = model.maxSpeed;
  let camYaw = 0;
  let camPitch = 0;
  let nYaw = 0;
  let nPitch = 0;
  let filled = 0;
  let wp = 0;
  const res: CourseResult = {
    crashes: 0,
    flown: 0,
    reached: 0,
    onTarget: 0,
    aimTimes: [],
  };
  const zoomed = course.kind === "chase";
  const z = zoomed ? 1 : 0;
  const tgt = course.target;
  let frame = 0;
  let jinkAt = -1;
  let jinkNext = 0;
  let lost = false;
  const cmd = { turn: 0, pitch: 0, roll: 0 };
  const lastCmd = { turn: 0, pitch: 0 };
  const zero: AimError = { yaw: 0, pitch: 0 };

  const spawn = (pos: Vec3, toward: Vec3, speed: number): void => {
    const d = wrapDelta(pos, toward);
    flight = createFlightState(pos, Math.atan2(-d.x, -d.z), model);
    flight = { ...flight, speed };
    instructor = createInstructor();
    resetEffortless(eff);
    resetRollControl(rollCtl);
    bankPull.engaged = false;
    resetCollisionAssist(ca);
    cap = model.maxSpeed;
    camYaw = flight.yaw;
    camPitch = 0;
    filled = 0;
    nYaw = nPitch = 0;
    assist.yaw = assist.pitch = 0;
    save = createHoleSave();
  };
  const first = tgt ? (tgt.pos[0] as Vec3) : (course.points[0] as Vec3);
  spawn(course.start, first, tgt ? 82 : model.maxSpeed * 0.8);

  while (res.flown < RUN_S) {
    // Where the novice is looking: the next gate, or the target's lead point.
    let mark: Vec3;
    if (tgt) {
      const tp = tgt.pos[Math.min(frame, tgt.pos.length - 1)] as Vec3;
      const tv = tgt.vel[Math.min(frame, tgt.vel.length - 1)] as Vec3;
      const range = Math.hypot(...Object.values(wrapDelta(flight.pos, tp)));
      const lead = range / BULLET_SPEED;
      mark = {
        x: tp.x + tv.x * lead,
        y: tp.y + tv.y * lead,
        z: tp.z + tv.z * lead,
      };
    } else {
      if (wp >= course.points.length) break;
      mark = course.points[wp] as Vec3;
      const d = wrapDelta(flight.pos, mark);
      const prev = wp > 0 ? (course.points[wp - 1] as Vec3) : course.start;
      const leg = wrapDelta(prev, mark);
      const legLen = Math.hypot(leg.x, leg.z) || 1;
      // A gate is passed once its line is behind the plane; an intersection
      // once the plane is within 25 m of its centre (or past it).
      const along = -(d.x * leg.x + d.z * leg.z) / legLen;
      const near = Math.hypot(d.x, d.z) < (course.kind === "turns" ? 25 : 0);
      if (along > 0 || near) {
        wp++;
        res.reached++;
        continue;
      }
    }
    const d = wrapDelta(flight.pos, mark);
    // The view lags the nose (the chase arm's own blend); zoomed, the view
    // axis is the gun line.
    const blend = 1 - Math.exp(-CAMERA_RESPONSE * DT);
    camYaw += wrap(flight.yaw - camYaw) * blend;
    camPitch += (flight.pitch - camPitch) * blend;
    const slot = filled % (delaySteps + 1);
    histYaw[slot] = wrap(Math.atan2(-d.x, -d.z) - camYaw);
    histPitch[slot] = Math.atan2(d.y, Math.hypot(d.x, d.z)) - camPitch;
    filled++;
    const old =
      filled > delaySteps ? (filled - delaySteps - 1) % (delaySteps + 1) : 0;
    const fovK = zoomFov(z) / zoomFov(0);
    const k = Math.sqrt((2 * DT) / TREMOR_TAU) * TREMOR;
    nYaw += (-nYaw / TREMOR_TAU) * DT + k * gauss(rand);
    nPitch += (-nPitch / TREMOR_TAU) * DT + k * gauss(rand);
    const offYaw = clamp(
      (histYaw[old] as number) + nYaw * fovK,
      -SCREEN_YAW * fovK,
      SCREEN_YAW * fovK,
    );
    const offPitch = clamp(
      (histPitch[old] as number) + nPitch * fovK,
      -SCREEN_PITCH * fovK,
      SCREEN_PITCH * fovK,
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
    rates.pitchRate *= bankPitchMult(roll, model);

    if (Math.abs(roll) > ASSIST_MAX_ROLL) want.yaw = want.pitch = 0;
    else holeAssistTarget(flight.pos, aimDir, assistWorld, want);
    stepHoleAssist(assist, want, DT);
    const assisting = assist.yaw !== 0 || assist.pitch !== 0;
    const pipper = {
      x: fwd.x * BULLET_RANGE,
      y: fwd.y * BULLET_RANGE,
      z: fwd.z * BULLET_RANGE,
    };
    const err = aimError(flight, aimDir, pipper);
    const pilot = instructorInput(
      err,
      zero,
      false,
      DT,
      instructor,
      rates,
      feel,
    );
    cap = stepCornerCap(
      cap,
      Math.abs(Math.sin(roll)) > Math.sin(60 * DEG)
        ? model.maxSpeed
        : cornerSpeed(
            flight,
            cornerWorld,
            pilot.turn * Math.cos(roll),
            null,
            arcSweep(flight, aimDir),
          ),
      DT,
    );
    const threading =
      assisting ||
      holeSaveActive(save) ||
      threadingCorridor(cornerWorld, flight, fwd.x, fwd.z) !== null;
    stepEffortless(
      eff,
      flight,
      {
        enabled: true,
        active: true,
        gap: angleBetween(aimDir, pipper),
        levelPitch: false,
        firing: zoomed,
        threading,
        pilotTurn: pilot.turn,
        pilotPitch: pilot.pitch,
        cornerCap: cornerCapInput(cap),
        aim: aimDir,
        turnRate: rates.turnRate,
        pitchRate: rates.pitchRate,
      },
      effWorld,
      DT,
      effOut,
    );
    effOut.roll = 0;
    // FC1 collision assist (AFTER arm): a nudge off a near-certain impact.
    stepCollisionAssist(
      ca,
      flight,
      caWorld,
      null,
      arm.fc1,
      threading,
      rates,
      lastCmd,
      DT,
    );
    const bankAuto = instructorBankPull(
      bankPull,
      flight,
      aimDir,
      fwd,
      effOut.pitch > 0 ||
        eff.guard >= 0 ||
        effOut.aimYaw !== 0 ||
        effOut.aimPitch !== 0 ||
        cap < model.maxSpeed ||
        assisting ||
        holeSaveActive(save) ||
        ca.turn !== 0 ||
        ca.pitch !== 0,
    );
    const biased = {
      yaw: err.yaw - assist.yaw,
      pitch: err.pitch + assist.pitch,
    };
    effortlessError(effOut, feel, rates.turnRate, rates.pitchRate, biased);
    collisionAssistError(ca, feel, rates, biased);
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
    cmd.roll = stepRollControl(
      rollCtl,
      {
        key: 0,
        auto: bankAuto,
        mode: "off",
        roll,
        pitch: flight.pitch,
      },
      DT,
    );
    // The zoom's steering cost: before FC1 a flat 0.6 in every mode; FC1
    // gives the mouse-aim its full authority (the cursor IS the aim).
    const steer = zoomed
      ? arm.fc1
        ? zoomSteer(z, "instructor")
        : PRE_FC1_ZOOM_STEER
      : 1;
    const shaped: FlightInput = {
      ...shapeInput(
        {
          turn: cmd.turn,
          pitch: cmd.pitch,
          roll: cmd.roll,
          throttle: live.autoThrottle,
        },
        { steer },
      ),
      cornerCap: cornerCapInput(cap),
    };
    flight = stepFlight(flight, shaped, DT, model);
    lastCmd.turn = shaped.turn;
    lastCmd.pitch = shaped.pitch;
    stepHoleSave(save, flight, shaped, DT, saveWorld, null, false);
    res.flown += DT;
    frame++;
    if (tgt) {
      // Time on target and time-to-aim, against the lead point.
      const tp = tgt.pos[Math.min(frame, tgt.pos.length - 1)] as Vec3;
      const range = Math.max(
        1,
        Math.hypot(...Object.values(wrapDelta(flight.pos, tp))),
      );
      const gap = angleBetween(
        flightForward(flight),
        wrapDelta(flight.pos, mark),
      );
      if (gap < Math.atan(HIT_RADIUS / range)) res.onTarget += DT;
      const cone = Math.atan(HIT_RADIUS / range);
      if (
        jinkNext < tgt.jinks.length &&
        frame >= (tgt.jinks[jinkNext] as number)
      ) {
        // The last jink never re-acquired: it counts its whole interval;
        // one tracked straight through (never lost) took no time at all.
        if (jinkAt >= 0) res.aimTimes.push(lost ? (frame - jinkAt) * DT : 0);
        jinkAt = frame;
        jinkNext++;
        lost = false;
      }
      if (jinkAt >= 0) {
        if (gap > LOST_K * cone) lost = true;
        else if (lost && gap < cone) {
          res.aimTimes.push((frame - jinkAt) * DT);
          jinkAt = -1;
        }
      }
    }
    if (detectCrash(flight, buildings, index, undefined, null, nature)) {
      res.crashes++;
      if (process.env.FC_DEBUG) {
        console.log(
          `${arm.name} ${course.kind} seed ${seed} street=${Math.min(Math.abs(((flight.pos.x + 100) % 200) - 100), Math.abs(((flight.pos.z + 100) % 200) - 100)).toFixed(0)} t=${res.flown.toFixed(1)} wp=${wp} spd=${flight.speed.toFixed(0)} cap=${cap.toFixed(0)} y=${flight.pos.y.toFixed(0)} roll=${(realRoll(flight) / DEG).toFixed(0)} pitch=${(flight.pitch / DEG).toFixed(0)} guard=${eff.guard} ca=${ca.turn.toFixed(2)},${ca.pitch.toFixed(2)} tHit=${ca.tHit.toFixed(2)} bank=${bankPull.engaged}`,
        );
      }
      if (tgt) {
        // Back in behind the target, as at the start.
        const tp = tgt.pos[Math.min(frame, tgt.pos.length - 1)] as Vec3;
        const tv = tgt.vel[Math.min(frame, tgt.vel.length - 1)] as Vec3;
        const sp = Math.hypot(tv.x, tv.y, tv.z) || 1;
        spawn(
          canon({
            x: tp.x - (tv.x / sp) * 160,
            y: tp.y,
            z: tp.z - (tv.z / sp) * 160,
          }),
          tp,
          82,
        );
        frame += Math.round(KILL_CAM_S / DT);
        jinkAt = -1;
      } else {
        const from = wp > 0 ? (course.points[wp - 1] as Vec3) : course.start;
        spawn(from, course.points[wp] as Vec3, model.maxSpeed * 0.8);
      }
    }
  }
  if (tgt && jinkAt >= 0 && lost) res.aimTimes.push((frame - jinkAt) * DT);
  return res;
}

export interface Summary {
  course: CourseKind;
  arm: string;
  runs: number;
  crashesPerMin: number;
  onTarget: number;
  timeToAim: number;
  secondsPerPoint: number;
}

export function flyCourse(kind: CourseKind, arm: Arm, runs: number): Summary {
  const list = courses(kind, runs);
  let crashes = 0;
  let flown = 0;
  let reached = 0;
  let onTarget = 0;
  const aims: number[] = [];
  list.forEach((c, i) => {
    const r = fly(arm, c, 1000 + i * 7919);
    crashes += r.crashes;
    flown += r.flown;
    reached += r.reached;
    onTarget += r.onTarget;
    aims.push(...r.aimTimes);
  });
  Object.assign(live, DEFAULT_TUNING);
  return {
    course: kind,
    arm: arm.name,
    runs,
    crashesPerMin: (crashes / flown) * 60,
    onTarget: onTarget / flown,
    timeToAim:
      aims.length > 0 ? aims.reduce((a, b) => a + b, 0) / aims.length : 0,
    secondsPerPoint: reached > 0 ? flown / reached : 0,
  };
}

const pct = (before: number, after: number): string =>
  before === 0 ? "—" : `${(((after - before) / before) * 100).toFixed(0)}%`;

function main(): void {
  const args = process.argv.slice(2);
  const runsArg = args.find((a) => a.startsWith("--runs="));
  const runs = runsArg ? Number(runsArg.slice(7)) : 40;
  // --set=key:value,… moves the AFTER arm's tuning (a Flight Lab session
  // on the courses); --only=<course> flies one course.
  const setArg = args.find((a) => a.startsWith("--set="));
  const after: Arm = { ...AFTER, tuning: { ...AFTER.tuning } };
  if (setArg) {
    for (const kv of setArg.slice(6).split(",")) {
      const [k, v] = kv.split(":");
      (after.tuning as Record<string, number>)[k as string] = Number(v);
    }
  }
  const only = args.find((a) => a.startsWith("--only="))?.slice(7);
  const rows: Summary[] = [];
  for (const kind of ["slalom", "turns", "chase"] as const) {
    if (only && only !== kind) continue;
    for (const arm of [BEFORE, after]) rows.push(flyCourse(kind, arm, runs));
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(i === 0 ? 7 : 12)).join(" | ")} |`;
  console.log(
    `FC1 flight courses — novice pilot, ${runs} runs × ${RUN_S} s per course and arm\n`,
  );
  console.log(
    line([
      "course",
      "arm",
      "crashes/min",
      "on target",
      "time-to-aim",
      "s/point",
    ]),
  );
  console.log(line(["---", "---", "---", "---", "---", "---"]));
  for (const r of rows) {
    console.log(
      line([
        r.course,
        r.arm,
        r.crashesPerMin.toFixed(3),
        r.course === "chase" ? `${(r.onTarget * 100).toFixed(1)}%` : "—",
        r.course === "chase" ? `${r.timeToAim.toFixed(2)} s` : "—",
        r.course === "chase" ? "—" : r.secondsPerPoint.toFixed(2),
      ]),
    );
  }
  // The totals the ticket's bar is set on.
  const sum = (arm: string, f: (r: Summary) => number) =>
    rows.filter((r) => r.arm === arm).reduce((a, r) => a + f(r), 0) / 3;
  const crashB = sum("before", (r) => r.crashesPerMin);
  const crashA = sum("after", (r) => r.crashesPerMin);
  const aimB =
    rows.find((r) => r.course === "chase" && r.arm === "before")?.timeToAim ??
    0;
  const aimA =
    rows.find((r) => r.course === "chase" && r.arm === "after")?.timeToAim ?? 0;
  console.log(
    `\ncrash rate (mean of the three courses): ${crashB.toFixed(3)} → ${crashA.toFixed(3)} /min (${pct(crashB, crashA)})`,
  );
  console.log(
    `time-to-aim (chase): ${aimB.toFixed(2)} → ${aimA.toFixed(2)} s (${pct(aimB, aimA)})`,
  );
}

main();
