// F10 knife-edge flight and bank-and-pull turns, measured on the shared
// flight step with the player's DEFAULT_TUNING: a plane on its side holds
// its altitude at cruise (and sinks gently only when slow), a pull at 90°
// of bank is a flat, sharp turn — much sharper than the flat yaw — that
// bleeds speed, boost tightens it, and a released roll holds.

import {
  BANK_PULL,
  KNIFE_SINK,
  KNIFE_SPEED,
  MAX_SPEED,
  MIN_SPEED,
  PITCH_RATE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  bankPitchMult,
  createFlightState,
  flightForward,
  knifeSink,
  realRoll,
  stepFlight,
  turnRateAt,
} from "@angels-bandits/common/flight";
import { BOT_TUNING, DEFAULT_TUNING } from "@angels-bandits/common/tuning";
import { describe, expect, it } from "vitest";

const DEG = Math.PI / 180;
const DT = 1 / 60;
/** Cruise: full throttle, where the plane spends its life (F5). */
const CRUISE = MAX_SPEED;

/** Level flight at `speed`, heading 0, with a REAL roll of `roll` (no
 * cosmetic lean) and the throttle holding that speed. */
function rolled(roll: number, speed = CRUISE, y = 300): FlightState {
  return {
    ...createFlightState({ x: 1000, y, z: 1000 }, 0),
    roll,
    bank: 0,
    rollRate: 0,
    speed,
    targetSpeed: Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed)),
  };
}

const HANDS_OFF: FlightInput = { turn: 0, pitch: 0, roll: 0, throttle: 0 };

function fly(f0: FlightState, input: FlightInput, secs: number): FlightState {
  let f = f0;
  for (let t = 0; t < secs - 1e-9; t += DT) f = stepFlight(f, input, DT);
  return f;
}

/** Heading of the nose's horizontal part, rad. */
const heading = (f: FlightState): number => {
  const fw = flightForward(f);
  return Math.atan2(-fw.x, -fw.z);
};

/**
 * Pull at full stick from knife-edge until the nose has swept 180° of
 * heading: the time, the turn's radius (half the distance across the
 * half-circle), the altitude change and the speed at the end.
 */
function halfTurn(speed: number, boost = false) {
  let f = rolled(90 * DEG, speed);
  const start = { ...f.pos };
  let swept = 0;
  let h = heading(f);
  let t = 0;
  const pull: FlightInput = { turn: 0, pitch: 1, roll: 0, throttle: 1, boost };
  while (swept < Math.PI && t < 10) {
    f = stepFlight(f, pull, DT);
    t += DT;
    const h1 = heading(f);
    swept += Math.abs(Math.atan2(Math.sin(h1 - h), Math.cos(h1 - h)));
    h = h1;
  }
  const across = Math.hypot(f.pos.x - start.x, f.pos.z - start.z);
  return { t, radius: across / 2, dy: f.pos.y - start.y, speed: f.speed };
}

describe("F10 knife-edge: a plane on its side holds its altitude", () => {
  for (const roll of [90, -90]) {
    it(`at ${roll}° and cruise, hands off: within ±5 m over 5 s`, () => {
      const f0 = rolled(roll * DEG);
      const f = fly(f0, HANDS_OFF, 5);
      expect(Math.abs(f.pos.y - f0.pos.y)).toBeLessThanOrEqual(5);
      // …and still on its side: the bank holds (no self-levelling).
      expect(realRoll(f)).toBeCloseTo(roll * DEG, 6);
    });
  }

  it("holds from KNIFE_SPEED up; below it sinks gently, never faster than KNIFE_SINK", () => {
    expect(KNIFE_SPEED).toBe(55);
    for (const v of [KNIFE_SPEED, 65, CRUISE]) {
      expect(knifeSink(90 * DEG, v)).toBe(0);
    }
    const slow = fly(rolled(90 * DEG, 45), HANDS_OFF, 5);
    const drop = 300 - slow.pos.y;
    console.log(`knife-edge at 45 m/s: sank ${drop.toFixed(1)} m in 5 s`);
    expect(drop).toBeGreaterThan(1);
    expect(drop).toBeLessThanOrEqual(KNIFE_SINK * 5);
    expect(knifeSink(90 * DEG, MIN_SPEED)).toBe(KNIFE_SINK);
  });

  it("wings level or inverted: no sink at any speed", () => {
    for (const r of [0, Math.PI]) {
      for (const v of [MIN_SPEED, 50, CRUISE]) {
        expect(knifeSink(r, v)).toBeCloseTo(0, 12);
      }
    }
  });

  it("less knife-edge lift (the biplane's) sinks at cruise too", () => {
    const t = { ...DEFAULT_TUNING, knifeLift: 0.45 };
    let f = rolled(90 * DEG);
    for (let s = 0; s < 5; s += DT) f = stepFlight(f, HANDS_OFF, DT, t);
    expect(300 - f.pos.y).toBeGreaterThan(5);
  });
});

describe("F10 bank-and-pull: a pull on a wing is a flat, sharp turn", () => {
  for (const v of [CRUISE, 65]) {
    it(`at ${v} m/s: 180° in ≤ 2.2 s, radius ≤ 45 m, flat`, () => {
      const r = halfTurn(v);
      console.log(
        `knife-edge pull at ${v} m/s: 180° in ${r.t.toFixed(2)} s, ` +
          `radius ${r.radius.toFixed(1)} m, Δy ${r.dy.toFixed(2)} m, ` +
          `speed ${v} → ${r.speed.toFixed(1)} m/s`,
      );
      expect(r.t).toBeLessThanOrEqual(2.2);
      expect(r.radius).toBeLessThanOrEqual(45);
      // Flat: pitch rotates about the wing, which is vertical on its side.
      expect(Math.abs(r.dy)).toBeLessThan(2);
    });

    it(`at ${v} m/s: ≥ 1.4× the flat yaw's turn rate`, () => {
      const pullRate = PITCH_RATE * bankPitchMult(90 * DEG);
      expect(pullRate).toBeCloseTo(PITCH_RATE * (1 + BANK_PULL), 12);
      expect(pullRate).toBeGreaterThanOrEqual(1.4 * turnRateAt(v));
    });
  }

  it("holding the pull bleeds speed — max turn can't be held for ever", () => {
    let f = rolled(90 * DEG);
    const pull: FlightInput = { turn: 0, pitch: 1, roll: 0, throttle: 1 };
    f = fly(f, pull, 3);
    expect(f.speed).toBeLessThan(CRUISE - 15);
    // …more than the same pull wings-level (a loop) bleeds.
    let loop = rolled(0);
    loop = fly(loop, pull, 1);
    let knife = rolled(90 * DEG);
    knife = fly(knife, pull, 1);
    expect(knife.speed).toBeLessThan(loop.speed);
  });

  it("boost tightens it: the half-turn is quicker", () => {
    const plain = halfTurn(CRUISE);
    const boosted = halfTurn(CRUISE, true);
    console.log(`boosted knife-edge pull: 180° in ${boosted.t.toFixed(2)} s`);
    expect(boosted.t).toBeLessThan(plain.t);
  });

  it("wings level the pull is exactly the old loop rate", () => {
    expect(bankPitchMult(0)).toBe(1);
    expect(bankPitchMult(Math.PI)).toBeCloseTo(1, 12);
    expect(bankPitchMult(90 * DEG, BOT_TUNING)).toBe(1);
  });
});

describe("F10 a released roll holds", () => {
  it("rolled to 37° and let go: still 37° two seconds later", () => {
    const f = fly(rolled(37 * DEG), HANDS_OFF, 2);
    expect(realRoll(f)).toBeCloseTo(37 * DEG, 9);
  });

  it("the bots' model still levels a released roll (BOT_TUNING)", () => {
    let f = rolled(37 * DEG);
    for (let t = 0; t < 2; t += DT)
      f = stepFlight(f, HANDS_OFF, DT, BOT_TUNING);
    expect(Math.abs(realRoll(f))).toBeLessThan(1 * DEG);
  });

  it("a hair off level snaps back onto the exact wings-level path", () => {
    const f = stepFlight(rolled(0.0005), HANDS_OFF, DT);
    expect(realRoll(f)).toBe(0);
  });
});
