// F10 mouse-aim bank-and-pull, measured: a target far off the nose is
// reached by the instructor rolling toward it, pulling and rolling out —
// against main's flat re-aim (no bank, the pre-F10 roll model). The aim is
// a fixed world direction from the plane (the novice sim's convention: the
// eye at the plane, the pipper along the nose), the loop the Normal feel's.

import { MAX_SPEED } from "@angels-bandits/common/constants";
import {
  type FlightState,
  bankPitchMult,
  createFlightState,
  flightForward,
  handlingRates,
  realRoll,
  stepFlight,
} from "@angels-bandits/common/flight";
import { BOT_TUNING, DEFAULT_TUNING } from "@angels-bandits/common/tuning";
import type { Vec3 } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { FEEL_TUNING } from "../src/game/effortless";
import {
  BANK_EXIT,
  aimError,
  angleBetween,
  createBankPull,
  createInstructor,
  instructorBankPull,
  instructorInput,
} from "../src/game/instructor";
import { createRollControl, stepRollControl } from "../src/game/roll-control";

const DEG = Math.PI / 180;
const DT = 1 / 60;
const NORMAL = FEEL_TUNING.normal;

/** A level target `deg` to the right of heading 0 (or left, negative). */
function target(deg: number): Vec3 {
  const h = -deg * DEG; // yaw decreases to the right
  return { x: -Math.sin(h), y: 0, z: -Math.cos(h) };
}

interface Run {
  /** Time until the nose is within 5° of the target, s. */
  t: number;
  /** Most bank flown, rad. */
  maxBank: number;
  /** Bank 1.5 s after arrival, rad. */
  bankAfter: number;
  /** Altitude change over the run, m. */
  dy: number;
}

/** Fly to `aim` from level cruise: F10 (bank-and-pull, the player's flight
 * model) or main (a flat re-aim on the pre-F10 model). */
function fly(aim: Vec3, f10: boolean): Run {
  const tuning = f10 ? DEFAULT_TUNING : BOT_TUNING;
  let f: FlightState = {
    ...createFlightState({ x: 1000, y: 300, z: 1000 }, 0),
    speed: MAX_SPEED,
  };
  const y0 = f.pos.y;
  let ins = createInstructor();
  const bp = createBankPull();
  const rc = createRollControl();
  const none = { yaw: 0, pitch: 0 };
  let t = 0;
  let arrived = Number.NaN;
  let maxBank = 0;
  let bankAfter = Number.NaN;
  while (t < 8) {
    const fwd = flightForward(f);
    const roll = realRoll(f);
    const rates = handlingRates(f.speed, false, tuning);
    rates.pitchRate *= bankPitchMult(roll, tuning);
    const err = aimError(f, aim, fwd);
    ins = instructorInput(err, none, false, DT, ins, rates, NORMAL);
    let rollCmd = 0;
    if (f10) {
      const auto = instructorBankPull(bp, f, aim, fwd, false);
      rollCmd = stepRollControl(
        rc,
        { key: 0, auto, mode: "off", roll, pitch: f.pitch },
        DT,
      );
    }
    f = stepFlight(
      f,
      { turn: ins.turn, pitch: ins.pitch, roll: rollCmd, throttle: 1 },
      DT,
      tuning,
    );
    t += DT;
    maxBank = Math.max(maxBank, Math.abs(realRoll(f)));
    if (
      Number.isNaN(arrived) &&
      angleBetween(flightForward(f), aim) < 5 * DEG
    ) {
      arrived = t;
    }
    if (!Number.isNaN(arrived) && t >= arrived + 1.5) {
      bankAfter = realRoll(f);
      break;
    }
  }
  return { t: arrived, maxBank, bankAfter, dy: f.pos.y - y0 };
}

describe("F10 mouse aim: the instructor banks and pulls for a far target", () => {
  for (const deg of [120, -120]) {
    it(`a target ${deg}° off the nose: reached faster than main, banked ≤ 80°, rolled out`, () => {
      const main = fly(target(deg), false);
      const f10 = fly(target(deg), true);
      console.log(
        `${deg}° target: main ${main.t.toFixed(2)} s (flat), F10 ${f10.t.toFixed(2)} s ` +
          `(bank ${(f10.maxBank / DEG).toFixed(0)}°, Δy ${f10.dy.toFixed(1)} m)`,
      );
      expect(f10.t).toBeLessThan(main.t * 0.8);
      expect(main.maxBank).toBeLessThan(1 * DEG); // main: a flat yaw
      expect(f10.maxBank).toBeGreaterThan(60 * DEG);
      expect(f10.maxBank).toBeLessThanOrEqual(
        DEFAULT_TUNING.instructorBankMax + 3 * DEG,
      );
      expect(Math.abs(f10.bankAfter)).toBeLessThan(3 * DEG); // rolled out
      expect(Math.abs(f10.dy)).toBeLessThan(25); // a level turn, near enough
    });
  }

  it("a target 40° off (just past the threshold): no slower than main, and level after", () => {
    const main = fly(target(40), false);
    const f10 = fly(target(40), true);
    console.log(
      `40° target: main ${main.t.toFixed(2)} s, F10 ${f10.t.toFixed(2)} s (bank ${(f10.maxBank / DEG).toFixed(0)}°)`,
    );
    expect(f10.t).toBeLessThanOrEqual(main.t + 0.05);
    expect(Math.abs(f10.bankAfter)).toBeLessThan(3 * DEG);
  });

  it("a target 25° off (under the threshold): no bank at all — today's re-aim", () => {
    const f10 = fly(target(25), true);
    expect(f10.maxBank).toBeLessThan(1 * DEG);
  });

  it("hysteresis: engaged past the threshold, released only under BANK_EXIT", () => {
    const s = createBankPull();
    const f = createFlightState({ x: 0, y: 300, z: 0 }, 0);
    const nose = flightForward(f);
    expect(instructorBankPull(s, f, target(30), nose, false)).toBeNull();
    expect(instructorBankPull(s, f, target(40), nose, false)).not.toBeNull();
    // Back down to 20°: still engaged (above BANK_EXIT)…
    expect(BANK_EXIT).toBeLessThan(20 * DEG);
    expect(instructorBankPull(s, f, target(20), nose, false)).not.toBeNull();
    // …released under it.
    expect(instructorBankPull(s, f, target(10), nose, false)).toBeNull();
    // An assist owning the line stands it down.
    expect(instructorBankPull(s, f, target(120), nose, true)).toBeNull();
    expect(s.engaged).toBe(false);
  });
});
