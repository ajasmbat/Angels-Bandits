import {
  BANK_ANGLE,
  BOOST_MAX_SPEED,
  CORNER_BRAKE_DECEL,
  MAX_SPEED,
  MIN_SPEED,
  RESPAWN_ALTITUDE,
  RESPAWN_SPEED,
  SOFT_CEILING,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  createFlightState,
  handlingRates,
  realRoll,
  speedForRadius,
  stepFlight,
  turnRadius,
  turnRateAt,
} from "@angels-bandits/common/flight";
import { describe, expect, it } from "vitest";

// Expected values are worked examples from PLAN.md / the ticket plan (speeds,
// distances, clamps), never recomputed via the implementation.

const NEUTRAL: FlightInput = { pitch: 0, turn: 0, roll: 0, throttle: 0 };

/** Run the sim for `seconds` at a fixed 60 Hz step. */
function fly(
  state: FlightState,
  input: FlightInput,
  seconds: number,
): FlightState {
  const dt = 1 / 60;
  let s = state;
  for (let i = 0; i < Math.round(seconds * 60); i++)
    s = stepFlight(s, input, dt);
  return s;
}

/** Level cruise at an exact speed, facing -Z (yaw 0), for worked examples. */
function cruiseAt(
  speed: number,
  pos: { x: number; y: number; z: number },
): FlightState {
  return { pos, yaw: 0, pitch: 0, roll: 0, speed, targetSpeed: speed };
}

describe("createFlightState (spawn)", () => {
  it("spawns level at mid altitude and combat speed at FULL throttle (F5), position canonicalized", () => {
    const s = createFlightState({ x: -5, y: RESPAWN_ALTITUDE, z: 2005 });
    expect(s.pos).toEqual({ x: 1995, y: RESPAWN_ALTITUDE, z: 5 });
    expect(s.pitch).toBe(0);
    expect(s.roll).toBe(0);
    expect(s.speed).toBe(RESPAWN_SPEED);
    expect(s.targetSpeed).toBe(MAX_SPEED);
  });
});

describe("stepFlight: throttle", () => {
  it("W held raises target speed, clamped to MAX_SPEED (90 per PLAN.md)", () => {
    const end = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, throttle: 1 },
      5,
    );
    expect(end.targetSpeed).toBe(MAX_SPEED);
    expect(end.speed).toBeGreaterThan(65);
    expect(end.speed).toBeLessThanOrEqual(MAX_SPEED);
  });

  it("S held lowers target speed, clamped to MIN_SPEED (40 per PLAN.md)", () => {
    const end = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, throttle: -1 },
      5,
    );
    expect(end.targetSpeed).toBe(MIN_SPEED);
    expect(end.speed).toBeLessThan(65);
    expect(end.speed).toBeGreaterThanOrEqual(MIN_SPEED);
  });
});

describe("stepFlight: energy rule", () => {
  it("diving adds speed beyond the throttle target", () => {
    // 40° nose-down at cruise: level flight would hold 60, the dive must not.
    const start: FlightState = {
      ...cruiseAt(60, { x: 500, y: 500, z: 500 }),
      pitch: -0.7,
    };
    const end = fly(start, NEUTRAL, 3);
    expect(end.speed).toBeGreaterThan(62);
  });

  it("never exceeds MAX_SPEED even in a sustained full-throttle dive", () => {
    let s: FlightState = {
      ...cruiseAt(MAX_SPEED, { x: 500, y: 3000, z: 500 }),
      pitch: -1.2,
    };
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 20; i++) {
      s = stepFlight(s, { ...NEUTRAL, throttle: 1 }, dt);
      expect(s.speed).toBeLessThanOrEqual(MAX_SPEED);
    }
  });

  it("climbing bleeds speed toward MIN_SPEED and never below it (mush, no stall)", () => {
    // 45° climb at min throttle from cruise speed.
    let s: FlightState = {
      ...cruiseAt(65, { x: 500, y: 100, z: 500 }),
      pitch: 0.78,
    };
    s.targetSpeed = MIN_SPEED;
    const dt = 1 / 60;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 60 * 30; i++) {
      s = stepFlight(s, NEUTRAL, dt);
      min = Math.min(min, s.speed);
      expect(s.speed).toBeGreaterThanOrEqual(MIN_SPEED);
    }
    expect(min).toBeLessThan(48); // it really did bleed most of the way down
  });

  it("a hard flat turn bleeds speed below the throttle target", () => {
    const end = fly(
      cruiseAt(MAX_SPEED, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, turn: 1 },
      10,
    );
    expect(end.speed).toBeLessThan(MAX_SPEED - 5);
    expect(end.speed).toBeGreaterThanOrEqual(MIN_SPEED);
  });
});

describe("stepFlight: steering", () => {
  it("full right deflection turns right (yaw decreases) at a capped, finite rate", () => {
    const end = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, turn: 1 },
      2,
    );
    expect(end.yaw).toBeLessThan(-1); // really turning
    expect(end.yaw).toBeGreaterThan(-2.5); // ...but nowhere near instant
  });

  it("holding full pull-up loops over the top: pitch reads within ±90°, inverted past vertical (F7)", () => {
    // F7: no pitch cap — a held pull goes through vertical; YXZ stores that
    // as pitch coming back down with yaw and roll flipped by π.
    let s = cruiseAt(65, { x: 500, y: 300, z: 500 });
    let peak = 0;
    let inverted = false;
    for (let i = 0; i < 4 * 60; i++) {
      s = stepFlight(s, { ...NEUTRAL, pitch: 1 }, 1 / 60);
      peak = Math.max(peak, s.pitch);
      expect(Math.abs(s.pitch)).toBeLessThanOrEqual(Math.PI / 2);
      if (Math.abs(realRoll(s)) > 3) inverted = true;
    }
    expect(peak).toBeGreaterThan(1.5); // reached vertical
    expect(inverted).toBe(true); // and went over the top
  });

  it("a right turn auto-banks into the turn, and the bank levels out after release", () => {
    const banked = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, turn: 1 },
      2,
    );
    expect(banked.roll).toBeLessThan(-0.3);
    const leveled = fly(banked, NEUTRAL, 3);
    expect(Math.abs(leveled.roll)).toBeLessThan(0.1);
  });

  it("A/D roll assist rolls the plane directly", () => {
    const end = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, roll: 1 },
      0.5,
    );
    expect(end.roll).toBeGreaterThan(0.4);
  });

  it("turn plus same-side A/D caps the cosmetic lean at 1.4 rad, never past (F7)", () => {
    // Left turn (turn −1 banks left = +roll) with left A/D. Since F7 (loops)
    // A/D roll the airframe for real, so only the cosmetic lean (`bank`) is
    // capped; it leans the full BANK_ANGLE into the turn.
    for (const fps of [30, 60, 144]) {
      let s = cruiseAt(65, { x: 500, y: 300, z: 500 });
      let peak = 0;
      for (let i = 0; i < 3 * fps; i++) {
        s = stepFlight(s, { ...NEUTRAL, turn: -1, roll: 1 }, 1 / fps);
        peak = Math.max(peak, Math.abs(s.bank ?? 0));
      }
      expect(peak).toBeLessThanOrEqual(1.4);
      expect(s.bank).toBeCloseTo(1, 3); // it does get there
    }
  });

  it("flipping turn + A/D side to side at the bank spring's period never leans past 1.4 rad", () => {
    // The worst case for a spring is a target reversed while it is moving:
    // flip every half period of BANK_FREQ (7 rad/s ⇒ ~0.45 s).
    for (const fps of [30, 60, 144]) {
      let s = cruiseAt(65, { x: 500, y: 300, z: 500 });
      let peak = 0;
      const half = Math.round((Math.PI / 7) * fps);
      for (let i = 0; i < 6 * fps; i++) {
        const side = Math.floor(i / half) % 2 === 0 ? 1 : -1;
        s = stepFlight(s, { ...NEUTRAL, turn: -side, roll: side }, 1 / fps);
        peak = Math.max(peak, Math.abs(s.bank ?? 0));
      }
      expect(peak).toBeLessThanOrEqual(1.4 + 1e-9);
      // It really swung hard: the old bound was > 1 of a 1.4 target (71%); the
      // lean now only follows the turn, so its target is BANK_ANGLE.
      expect(peak).toBeGreaterThan(0.7 * BANK_ANGLE);
    }
  });

  it("attitude holds when input is neutral (mouse-aim: no auto-level of pitch)", () => {
    const start: FlightState = {
      ...cruiseAt(65, { x: 500, y: 500, z: 500 }),
      pitch: 0.3,
    };
    const end = fly(start, NEUTRAL, 2);
    expect(end.pitch).toBeCloseTo(0.3, 6);
  });
});

describe("stepFlight: soft ceiling", () => {
  it("a sustained full-power climb tops out within 150 m above SOFT_CEILING (600 m)", () => {
    let s: FlightState = {
      ...cruiseAt(MAX_SPEED, { x: 500, y: 550, z: 500 }),
      pitch: 1.2,
    };
    const dt = 1 / 60;
    let apex = 0;
    for (let i = 0; i < 60 * 120; i++) {
      s = stepFlight(s, { ...NEUTRAL, throttle: 1, pitch: 1 }, dt);
      apex = Math.max(apex, s.pos.y);
    }
    expect(apex).toBeLessThanOrEqual(SOFT_CEILING + 150);
    expect(apex).toBeGreaterThan(SOFT_CEILING); // it's a soft fade, not a wall at 600
  });

  it("mushes back down: pinned nose-up above the ceiling, the plane still descends", () => {
    const start: FlightState = {
      ...cruiseAt(MIN_SPEED, { x: 500, y: 780, z: 500 }),
      pitch: 1.2,
    };
    const end = fly(start, { ...NEUTRAL, pitch: 1 }, 20);
    expect(end.pos.y).toBeLessThan(700);
  });

  it("does not touch normal climbs below the ceiling", () => {
    // 30° climb at 60 m/s for 5 s gains sin(30°)·60·5 = 150 m.
    const start: FlightState = {
      ...cruiseAt(60, { x: 500, y: 100, z: 500 }),
      pitch: Math.PI / 6,
    };
    const end = fly(start, NEUTRAL, 5);
    expect(end.pos.y).toBeGreaterThan(230);
  });
});

describe("stepFlight: purity", () => {
  it("mutates neither the state nor the input it is given", () => {
    const state = cruiseAt(65, { x: 500, y: 300, z: 500 });
    const input: FlightInput = {
      pitch: 0.5,
      turn: -0.5,
      roll: 0.2,
      throttle: 1,
    };
    Object.freeze(state);
    Object.freeze(state.pos);
    Object.freeze(input);
    expect(() => stepFlight(state, input, 1 / 60)).not.toThrow();
  });
});

describe("stepFlight: level cruise kinematics", () => {
  it("covers 100 m in 2 s at 50 m/s, facing -Z", () => {
    const end = fly(cruiseAt(50, { x: 100, y: 300, z: 300 }), NEUTRAL, 2);
    expect(end.pos.z).toBeCloseTo(200, 4);
    expect(end.pos.x).toBeCloseTo(100, 4);
    expect(end.pos.y).toBeCloseTo(300, 4);
    expect(end.speed).toBeCloseTo(50, 4);
  });

  it("wraps across the north seam: z=100 minus 150 m of flight lands at z=1950", () => {
    const end = fly(cruiseAt(50, { x: 100, y: 300, z: 100 }), NEUTRAL, 3);
    expect(end.pos.z).toBeCloseTo(1950, 4);
  });

  it("keeps the position canonical in [0, WORLD_SIZE) on every single step", () => {
    let s = cruiseAt(90, { x: 100, y: 300, z: 30 });
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 30; i++) {
      s = stepFlight(s, NEUTRAL, dt);
      expect(s.pos.z).toBeGreaterThanOrEqual(0);
      expect(s.pos.z).toBeLessThan(WORLD_SIZE);
      expect(s.pos.x).toBeGreaterThanOrEqual(0);
      expect(s.pos.x).toBeLessThan(WORLD_SIZE);
    }
  });
});

describe("F5: speed-dependent turn rate", () => {
  it("is TURN_RATE_SLOW (1.35) at MIN_SPEED easing to TURN_RATE (0.9) at MAX_SPEED", () => {
    expect(turnRateAt(MIN_SPEED)).toBeCloseTo(1.35, 12);
    expect(turnRateAt(MAX_SPEED)).toBeCloseTo(0.9, 12);
    expect(turnRateAt(65)).toBeCloseTo(1.125, 12); // halfway
    expect(turnRateAt(BOOST_MAX_SPEED)).toBeCloseTo(0.9, 12); // flat above
    expect(turnRateAt(0)).toBeCloseTo(1.35, 12); // flat below
  });

  it("full-deflection radius: 29.6 m at MIN_SPEED (was 44.4), still 100 m at MAX_SPEED", () => {
    expect(turnRadius(MIN_SPEED)).toBeCloseTo(29.63, 2);
    expect(turnRadius(MAX_SPEED)).toBeCloseTo(100, 9);
  });

  it("speedForRadius inverts turnRadius and clamps to [MIN_SPEED, MAX_SPEED]", () => {
    for (const v of [40, 47.5, 55, 65, 80, 90]) {
      expect(speedForRadius(turnRadius(v))).toBeCloseTo(v, 9);
    }
    expect(speedForRadius(5)).toBe(MIN_SPEED);
    expect(speedForRadius(1e6)).toBe(MAX_SPEED);
  });

  it("stepFlight turns at the slow rate when slow: 90° in ~1.16 s at MIN_SPEED", () => {
    const end = fly(
      cruiseAt(MIN_SPEED, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, turn: 1, throttle: -1 },
      1,
    );
    // At least 1.3 rad in 1 s (the old flat 0.9 rad/s gave 0.9).
    expect(end.yaw).toBeLessThan(-1.3);
  });

  it("leaves every boost number alone: the burn's rates are unchanged", () => {
    expect(handlingRates(MAX_SPEED, true).turnRate).toBeCloseTo(0.9 * 1.6, 12);
    expect(handlingRates(BOOST_MAX_SPEED, false).turnRate).toBeCloseTo(
      0.9 * 1.6,
      12,
    );
  });
});

describe("F5: cornerCap airbrake", () => {
  it("absent is bit-identical to no cap at all (bots, remotes)", () => {
    const s = cruiseAt(70, { x: 500, y: 300, z: 500 });
    const input = { ...NEUTRAL, turn: 0.4, pitch: -0.2, throttle: 1 };
    expect(stepFlight(s, { ...input, cornerCap: undefined }, 1 / 60)).toEqual(
      stepFlight(s, input, 1 / 60),
    );
  });

  it("brakes at CORNER_BRAKE_DECEL down to the cap, never below it", () => {
    let s = cruiseAt(MAX_SPEED, { x: 500, y: 300, z: 500 });
    const dt = 1 / 60;
    s = stepFlight(s, { ...NEUTRAL, throttle: 1, cornerCap: 50 }, dt);
    // At least the airbrake (the ordinary pull toward the lower command,
    // SPEED_RESPONSE × 40 m/s, is even stronger on this first step).
    expect(MAX_SPEED - s.speed).toBeGreaterThanOrEqual(
      CORNER_BRAKE_DECEL * dt - 1e-9,
    );
    // Near the cap the pull fades, but the airbrake still holds 22 m/s².
    const near = stepFlight(
      cruiseAt(55, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, throttle: 1, cornerCap: 50 },
      dt,
    );
    expect(55 - near.speed).toBeCloseTo(CORNER_BRAKE_DECEL * dt, 9);
    s = fly(s, { ...NEUTRAL, throttle: 1, cornerCap: 50 }, 3);
    expect(s.speed).toBeCloseTo(50, 9);
    expect(s.targetSpeed).toBe(MAX_SPEED); // the throttle stays the pilot's
  });

  it("holds the cap even in a full dive (the brake outweighs ENERGY_GAIN)", () => {
    let s = cruiseAt(70, { x: 500, y: 600, z: 500 });
    s = { ...s, pitch: -1.4 };
    s = fly(s, { ...NEUTRAL, throttle: 1, cornerCap: 50 }, 2);
    expect(s.speed).toBeLessThanOrEqual(50 + 1e-9);
  });

  it("boost ignores the cap — a burn is the pilot overriding", () => {
    const s = fly(
      cruiseAt(MAX_SPEED, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, boost: true, cornerCap: 45 },
      1,
    );
    expect(s.speed).toBeGreaterThan(MAX_SPEED);
  });

  it("never lets a cap below MIN_SPEED stall the plane", () => {
    const s = fly(
      cruiseAt(60, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, cornerCap: 0 },
      3,
    );
    expect(s.speed).toBe(MIN_SPEED);
  });
});
