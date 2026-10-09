// F9 effortless assist (client/src/game/effortless.ts), flown through the
// real stepFlight: auto-level with no input on every path that has one,
// the idle latch, coordinated turns, the identity with the assist off, and
// that it never takes an intentional loop or split-S away. The novice-pilot
// sim (novice-pilot.test.ts) measures what it buys in the city.

import {
  BANK_ANGLE,
  BULLET_RANGE,
  MAX_SPEED,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  flightForward,
  handlingRates,
  realRoll,
  stepFlight,
  turnRateAt,
} from "@angels-bandits/common/flight";
import { describe, expect, it } from "vitest";
import {
  type EffortlessFrame,
  type EffortlessOut,
  FEEL_TUNING,
  IDLE_GAP,
  createEffortless,
  createEffortlessOut,
  effortlessCommand,
  effortlessError,
  effortlessStick,
  stepEffortless,
} from "../src/game/effortless";
import { AUTO_THROTTLE } from "../src/game/flight-input";
import {
  SHARP_TUNING,
  aimError,
  angleBetween,
  createInstructor,
  instructorInput,
} from "../src/game/instructor";
import {
  createAimDir,
  recentreAimDir,
  stepAimDir,
} from "../src/game/touch-aim-dir";

const DEG = Math.PI / 180;
const DT = 1 / 60;
const NORMAL = FEEL_TUNING.normal;

/** Level-ish flight at 300 m, mid-map, with a real roll of `roll` (no
 * cosmetic lean) and `pitch`. */
function plane(pitch = 0, roll = 0, y = 300): FlightState {
  return {
    pos: { x: 1000, y, z: 1000 },
    yaw: 0,
    pitch,
    roll,
    bank: 0,
    rollRate: 0,
    speed: MAX_SPEED,
    targetSpeed: MAX_SPEED,
  };
}

/** A frame with the pilot's hands off: idle may level everything. */
function frameFor(f: FlightState, over: Partial<EffortlessFrame> = {}) {
  const rates = handlingRates(f.speed, false);
  return {
    enabled: true,
    active: false,
    gap: 0,
    levelPitch: true,
    firing: false,
    threading: false,
    pilotTurn: 0,
    pilotPitch: 0,
    cornerCap: undefined,
    aim: null,
    turnRate: rates.turnRate,
    pitchRate: rates.pitchRate,
    ...over,
  } satisfies EffortlessFrame;
}

/** Fly the classic stick (or a touch thumb's stick) held at `stick` for
 * `secs`; `assist` on/off. Returns every pose. */
function flyStick(
  f0: FlightState,
  secs: number,
  stick: { turn: number; pitch: number; roll: number },
  assist = true,
): FlightState[] {
  const s = createEffortless();
  const out = createEffortlessOut();
  let f = f0;
  const poses: FlightState[] = [];
  for (let t = 0; t < secs; t += DT) {
    const active = stick.turn !== 0 || stick.pitch !== 0 || stick.roll !== 0;
    const frame = frameFor(f, {
      enabled: assist,
      active,
      pilotTurn: stick.turn,
      pilotPitch: stick.pitch,
    });
    stepEffortless(s, f, frame, null, DT, out);
    const cmd = { ...stick };
    effortlessStick(
      out,
      NORMAL,
      realRoll(f),
      frame.turnRate,
      frame.pitchRate,
      cmd,
    );
    f = stepFlight(f, { ...cmd, throttle: AUTO_THROTTLE }, DT);
    poses.push(f);
  }
  return poses;
}

const levelled = (f: FlightState): void => {
  expect(Math.abs(f.pitch)).toBeLessThan(2 * DEG);
  expect(Math.abs(realRoll(f))).toBeLessThan(2 * DEG);
  expect(Math.abs(f.bank ?? 0)).toBeLessThan(2 * DEG);
};

describe("auto-level (F9): no input → wings level, level flight within 2 s", () => {
  it("classic / touch stick at centre: from a 25° climb rolled 40°", () => {
    const poses = flyStick(plane(25 * DEG, 40 * DEG), 2, {
      turn: 0,
      pitch: 0,
      roll: 0,
    });
    levelled(poses[poses.length - 1] as FlightState);
  });

  it("classic stick at centre: from a 20° dive rolled −35°", () => {
    const poses = flyStick(plane(-20 * DEG, -35 * DEG), 2, {
      turn: 0,
      pitch: 0,
      roll: 0,
    });
    levelled(poses[poses.length - 1] as FlightState);
  });

  it("from inverted: rolls upright and levels within 3 s", () => {
    const poses = flyStick(plane(0, Math.PI), 3, {
      turn: 0,
      pitch: 0,
      roll: 0,
    });
    levelled(poses[poses.length - 1] as FlightState);
  });

  it("without the assist the climb is simply held (today's attitude hold)", () => {
    const poses = flyStick(
      plane(25 * DEG, 40 * DEG),
      2,
      { turn: 0, pitch: 0, roll: 0 },
      false,
    );
    expect((poses[poses.length - 1] as FlightState).pitch).toBeGreaterThan(
      20 * DEG,
    );
  });

  /** The instructor path as main.ts runs it: `presence` 0..1, the cursor
   * held on the pipper (no error), `levelPitch` as main decides it. */
  function flyInstructor(
    f0: FlightState,
    secs: number,
    presence: number,
    levelPitch: boolean,
  ): FlightState {
    const s = createEffortless();
    const out = createEffortlessOut();
    let ins = createInstructor();
    let f = f0;
    for (let t = 0; t < secs; t += DT) {
      const frame = frameFor(f, { levelPitch });
      stepEffortless(s, f, frame, null, DT, out);
      const err = { yaw: 0, pitch: 0 };
      effortlessError(out, NORMAL, frame.turnRate, frame.pitchRate, err);
      const none = { yaw: 0, pitch: 0 };
      const rates = { turnRate: frame.turnRate, pitchRate: frame.pitchRate };
      ins = instructorInput(err, none, false, DT, ins, rates, NORMAL);
      const cmd = {
        turn: ins.turn * presence + out.biasTurn * (1 - presence),
        pitch: ins.pitch * presence + out.biasPitch * (1 - presence),
        roll: 0,
      };
      effortlessCommand(out, realRoll(f), cmd);
      f = stepFlight(f, { ...cmd, throttle: AUTO_THROTTLE }, DT);
    }
    return f;
  }

  it("desktop instructor, pointer gone: levels nose and wings", () => {
    levelled(flyInstructor(plane(25 * DEG, 40 * DEG), 2, 0, true));
  });

  it("desktop instructor, still cursor on the pipper: wings level, the climb is kept", () => {
    const f = flyInstructor(plane(25 * DEG, 40 * DEG), 2, 1, false);
    expect(Math.abs(realRoll(f))).toBeLessThan(2 * DEG);
    expect(f.pitch).toBeGreaterThan(20 * DEG);
  });

  it("touch instructor, thumb lifted: the anchored aim follows the nose down", () => {
    // M7's world-anchored aim, recentred onto the gun line every frame the
    // assist levels (main.ts: touchControls.followNose()).
    const s = createEffortless();
    const out = createEffortlessOut();
    const dir = createAimDir();
    let f = plane(25 * DEG, 40 * DEG);
    recentreAimDir(dir, f);
    let ins = createInstructor();
    for (let t = 0; t < 2; t += DT) {
      if (s.weight > 0) recentreAimDir(dir, f);
      stepAimDir(dir, f, false, DT);
      const fw = flightForward(f);
      const pipper = {
        x: fw.x * BULLET_RANGE,
        y: fw.y * BULLET_RANGE,
        z: fw.z * BULLET_RANGE,
      };
      const err = aimError(f, dir.dir, pipper);
      const frame = frameFor(f, { gap: angleBetween(dir.dir, pipper) });
      stepEffortless(s, f, frame, null, DT, out);
      effortlessError(out, NORMAL, frame.turnRate, frame.pitchRate, err);
      const none = { yaw: 0, pitch: 0 };
      const rates = { turnRate: frame.turnRate, pitchRate: frame.pitchRate };
      ins = instructorInput(err, none, false, DT, ins, rates, NORMAL);
      const cmd = { turn: ins.turn, pitch: ins.pitch, roll: 0 };
      effortlessCommand(out, realRoll(f), cmd);
      f = stepFlight(f, { ...cmd, throttle: AUTO_THROTTLE }, DT);
    }
    levelled(f);
  });

  it("the guns firing hold it off", () => {
    const s = createEffortless();
    const out = createEffortlessOut();
    const f = plane(25 * DEG);
    for (let t = 0; t < 2; t += DT) {
      stepEffortless(s, f, frameFor(f, { firing: true }), null, DT, out);
    }
    expect(s.weight).toBe(0);
    expect(out.biasPitch).toBe(0);
  });
});

describe("idle latch (F9)", () => {
  it("enters only with the aim settled, then the gap its bias opens can't drop it", () => {
    const s = createEffortless();
    const out = createEffortlessOut();
    const f = plane(10 * DEG);
    // Quiet, but the aim is off the pipper: not idle.
    for (let t = 0; t < 1; t += DT) {
      stepEffortless(s, f, frameFor(f, { gap: 2 * IDLE_GAP }), null, DT, out);
    }
    expect(s.idle).toBe(false);
    // Settled: idle, and the weight ramps in.
    for (let t = 0; t < 1; t += DT) {
      stepEffortless(s, f, frameFor(f, { gap: 0 }), null, DT, out);
    }
    expect(s.idle).toBe(true);
    expect(s.weight).toBe(1);
    // The levelling opens a gap: still idle, weight held — no toggling.
    for (let t = 0; t < 1; t += DT) {
      stepEffortless(s, f, frameFor(f, { gap: 3 * IDLE_GAP }), null, DT, out);
      expect(s.idle).toBe(true);
      expect(s.weight).toBe(1);
    }
    // The pilot acts: it lets go at once (a 0.1 s fade, no cut).
    stepEffortless(s, f, frameFor(f, { active: true }), null, DT, out);
    expect(s.idle).toBe(false);
    expect(s.weight).toBeLessThan(1);
    expect(s.weight).toBeGreaterThan(0);
  });
});

describe("coordinated turns (F9)", () => {
  it("one turn input: lean and yaw rate agree within 10% from 0.6 s on", () => {
    // The mouse / thumb turn: the shared bank spring leans the plane into
    // exactly the turn it flies — normalised lean (bank / BANK_ANGLE) and
    // normalised yaw rate (yaw rate / full rate) agree once settled.
    const poses = flyStick(plane(), 1.5, { turn: 1, pitch: 0, roll: 0 });
    for (let i = 1; i < poses.length; i++) {
      if (i * DT < 0.6) continue;
      const a = poses[i - 1] as FlightState;
      const b = poses[i] as FlightState;
      const yawRate = -(b.yaw - a.yaw) / DT / turnRateAt(a.speed);
      const lean = -(b.bank ?? 0) / BANK_ANGLE;
      expect(Math.abs(lean - yawRate)).toBeLessThan(0.1);
    }
  });

  /** A/D held for `secs`, then released, stick centred. Returns the
   * normalised yaw rate and sin(real roll)'s coordinated share per frame. */
  function rollTurn(assist: boolean): { yawRate: number; banked: number }[] {
    const poses = flyStick(
      plane(),
      0.3,
      { turn: 0, pitch: 0, roll: -1 },
      assist,
    );
    const rest = flyStick(
      poses[poses.length - 1] as FlightState,
      1,
      { turn: 0, pitch: 0, roll: 0 },
      assist,
    );
    const all = [...poses, ...rest];
    const rows: { yawRate: number; banked: number }[] = [];
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1] as FlightState;
      const b = all[i] as FlightState;
      // Heading of the nose's horizontal part: + = right turn.
      const ha = Math.atan2(-flightForward(a).x, -flightForward(a).z);
      const hb = Math.atan2(-flightForward(b).x, -flightForward(b).z);
      const dh = Math.atan2(Math.sin(hb - ha), Math.cos(hb - ha));
      rows.push({
        yawRate: -dh / DT / turnRateAt(a.speed),
        banked: Math.min(1, -Math.sin(realRoll(a)) / Math.sin(BANK_ANGLE)),
      });
    }
    return rows;
  }

  it("A/D with assist: the plane turns the way it is banked (within 0.1)", () => {
    const rows = rollTurn(true);
    expect(Math.max(...rows.map((r) => r.banked))).toBeGreaterThan(0.5);
    for (const r of rows)
      expect(Math.abs(r.yawRate - r.banked)).toBeLessThan(0.1);
  });

  it("A/D without assist: a pure roll, no turn (F7, unchanged)", () => {
    for (const r of rollTurn(false))
      expect(Math.abs(r.yawRate)).toBeLessThan(0.02);
  });
});

describe("assist off and Sharp are today's controls exactly", () => {
  it("assist off: identity output, the stick untouched", () => {
    const s = createEffortless();
    const out = createEffortlessOut();
    const f = plane(-60 * DEG, 0.5, 20); // a dive at the ground, rolled
    stepEffortless(s, f, frameFor(f, { enabled: false }), null, DT, out);
    expect(out).toEqual(createEffortlessOut() satisfies EffortlessOut);
    const cmd = { turn: 0.37, pitch: -0.81, roll: 1 };
    effortlessStick(out, FEEL_TUNING.sharp, realRoll(f), 1, 1, cmd);
    expect(cmd).toEqual({ turn: 0.37, pitch: -0.81, roll: 1 });
  });

  it("Sharp's instructor loop is bit-identical to the default", () => {
    let a = createInstructor();
    let b = createInstructor();
    const rates = { turnRate: 0.9, pitchRate: 1 };
    for (let i = 0; i < 120; i++) {
      const err = {
        yaw: Math.sin(i * 0.1) * 0.4,
        pitch: Math.cos(i * 0.07) * 0.2,
      };
      const latch = { yaw: 0.001 * i, pitch: 0 };
      a = instructorInput(err, latch, i % 7 === 0, DT, a, rates);
      b = instructorInput(err, latch, i % 7 === 0, DT, b, rates, SHARP_TUNING);
      expect(b).toEqual(a);
    }
    expect(FEEL_TUNING.sharp.gain).toBe(SHARP_TUNING.gain);
  });
});

describe("experts keep full aerobatics (F7) with the assist on", () => {
  /** Total rotation of the nose, rad, over a run of poses. */
  function noseSwept(poses: FlightState[]): number {
    let swept = 0;
    for (let i = 1; i < poses.length; i++) {
      const a = flightForward(poses[i - 1] as FlightState);
      const b = flightForward(poses[i] as FlightState);
      swept += Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
    }
    return swept;
  }

  it("a held full pull flies a whole loop, exactly as without it", () => {
    const pull = { turn: 0, pitch: 1, roll: 0 };
    const on = flyStick(plane(), 8, pull, true);
    const off = flyStick(plane(), 8, pull, false);
    expect(noseSwept(on)).toBeGreaterThan(2 * Math.PI);
    const a = on[on.length - 1] as FlightState;
    const b = off[off.length - 1] as FlightState;
    expect(Math.abs(a.pos.y - b.pos.y)).toBeLessThan(0.5);
    expect(Math.abs(a.pitch - b.pitch)).toBeLessThan(0.01);
  });

  it("a split-S from 220 m completes: the ground floor never takes it away", () => {
    // Roll inverted (A/D — with assist on it also turns while banked: the
    // coordination), then pull through. The floor only acts when the dive
    // could no longer be recovered, and here it can.
    const run = (assist: boolean): FlightState[] => {
      const rolled = flyStick(
        plane(0, 0, 220),
        Math.PI / 2.5,
        { turn: 0, pitch: 0, roll: 1 },
        assist,
      );
      const pulled = flyStick(
        rolled[rolled.length - 1] as FlightState,
        3.3,
        { turn: 0, pitch: 1, roll: 0 },
        assist,
      );
      return [...rolled, ...pulled];
    };
    for (const assist of [true, false]) {
      const poses = run(assist);
      const end = poses[poses.length - 1] as FlightState;
      const start = flightForward(poses[0] as FlightState);
      const fin = flightForward(end);
      // Out the bottom heading back the way it came, wings level, upright.
      expect(start.x * fin.x + start.z * fin.z).toBeLessThan(-0.85);
      expect(Math.abs(realRoll(end))).toBeLessThan(10 * DEG);
      expect(Math.min(...poses.map((f) => f.pos.y))).toBeGreaterThan(10);
    }
  });

  it("a dive the pull-up can't recover from in time is pulled out", () => {
    // Full nose-down from 120 m at full speed: without the floor it meets
    // the ground; with it, the pull starts in time.
    const dive = { turn: 0, pitch: -1, roll: 0 };
    const floor = (assist: boolean) =>
      Math.min(
        ...flyStick(plane(-20 * DEG, 0, 120), 4, dive, assist).map(
          (f) => f.pos.y,
        ),
      );
    expect(floor(false)).toBeLessThan(0);
    expect(floor(true)).toBeGreaterThan(2);
  });
});
